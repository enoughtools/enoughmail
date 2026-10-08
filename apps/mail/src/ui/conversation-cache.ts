import type { Email, MailClient } from './jmap';

export interface ConversationTarget { accountId: string; threadId: string }
export interface ConversationCacheOptions {
    ttlMs?: number;
    maxEntries?: number;
    maxBytes?: number;
    prefetchBatchSize?: number;
    now?: () => number;
}

type Reader = Pick<MailClient, 'readBatch'>;
type Entry = ConversationTarget & { messages: Email[]; at: number; bytes: number };
type Pending = ConversationTarget & {
    key: string;
    scope: string;
    generation: number;
    foreground: boolean;
    single: boolean;
    running: boolean;
    settled: boolean;
    promise: Promise<Email[]>;
    resolve: (messages: Email[]) => void;
    reject: (error: unknown) => void;
};

function targetKey(target: ConversationTarget): string { return JSON.stringify([target.accountId, target.threadId]); }
function invalidated(): Error { return Object.assign(new Error('The conversation changed. Open it again to load the latest copy.'), { conversationInvalidated: true }); }
function bytes(messages: Email[]): number { return JSON.stringify(messages).length * 2; }

/** Full conversation bodies stay in bounded, authenticated memory; reads never mark mail as seen. */
export class MailConversationCache {
    private scope = '';
    private generation = 0;
    private entries = new Map<string, Entry>();
    private pending = new Map<string, Pending>();
    private activeRequests = 0;
    private activePrefetch = 0;
    private totalBytes = 0;
    private scheduled = false;
    private readonly ttlMs: number;
    private readonly maxEntries: number;
    private readonly maxBytes: number;
    private readonly prefetchBatchSize: number;
    private readonly now: () => number;

    constructor(private client: Reader, options: ConversationCacheOptions = {}) {
        this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
        this.maxEntries = Math.max(1, options.maxEntries ?? 128);
        this.maxBytes = Math.max(1, options.maxBytes ?? 32 * 1024 * 1024);
        this.prefetchBatchSize = Math.max(1, Math.min(10, options.prefetchBatchSize ?? 5));
        this.now = options.now ?? Date.now;
    }

    get(scope: string, accountId: string, threadId: string): Email[] | undefined {
        this.useScope(scope);
        const key = targetKey({ accountId, threadId });
        const entry = this.entries.get(key);
        if (!entry) return;
        if (this.now() - entry.at >= this.ttlMs) { this.deleteEntry(key); return; }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return structuredClone(entry.messages);
    }

    /** Explicit opens jump ahead of queued speculation and share any matching active read. */
    load(scope: string, accountId: string, threadId: string): Promise<Email[]> {
        const cached = this.get(scope, accountId, threadId);
        if (cached) return Promise.resolve(cached);
        const target = { accountId, threadId };
        const pending = this.pending.get(targetKey(target)) ?? this.enqueue(target, true);
        pending.foreground = true;
        this.schedule();
        return pending.promise.then(messages => structuredClone(messages));
    }

    /** Replace the visible speculative queue. An empty set pauses it without cancelling an open. */
    prefetch(scope: string, targets: ConversationTarget[]): void {
        this.useScope(scope);
        const desired = new Map(targets.filter(target => target.accountId && target.threadId).map(target => [targetKey(target), target]));
        while (desired.size > this.maxEntries) desired.delete([...desired.keys()].at(-1)!);
        for (const pending of this.pending.values()) {
            if (!pending.running && !pending.foreground && !desired.has(pending.key)) this.finish(pending, undefined, invalidated());
        }
        for (const target of desired.values()) {
            if (!this.get(scope, target.accountId, target.threadId) && !this.pending.has(targetKey(target))) this.enqueue(target, false);
        }
        this.schedule();
    }

    isBusy(): boolean { return this.activeRequests > 0 || this.pending.size > 0; }

    /** Known local metadata edits retain full cached bodies. Unknown account changes invalidate instead. */
    patch(scope: string, accountId: string, updates: Record<string, Partial<Email>>): void {
        this.useScope(scope);
        for (const [key, entry] of [...this.entries]) {
            if (entry.accountId !== accountId || !entry.messages.some(message => updates[message.id])) continue;
            const messages = entry.messages.map(message => updates[message.id] ? { ...message, ...structuredClone(updates[message.id]) } : message);
            this.deleteEntry(key);
            this.store(entry, messages, entry.at);
        }
        // A read that started before an edit must not overwrite that confirmed metadata later.
        for (const pending of this.pending.values()) {
            if (pending.accountId === accountId) this.finish(pending, undefined, invalidated());
        }
    }

    invalidate(accountId?: string): void {
        for (const [key, entry] of this.entries) if (!accountId || entry.accountId === accountId) this.deleteEntry(key);
        for (const pending of this.pending.values()) if (!accountId || pending.accountId === accountId) this.finish(pending, undefined, invalidated());
    }

    /** Call on authorization loss/unmount; late responses cannot repopulate a cleared scope. */
    clear(): void {
        this.generation++;
        this.invalidate();
        this.scope = '';
    }

    private useScope(scope: string): void {
        if (this.scope !== scope) { this.clear(); this.scope = scope; }
    }

    private enqueue(target: ConversationTarget, foreground: boolean): Pending {
        let resolve!: Pending['resolve'];
        let reject!: Pending['reject'];
        const promise = new Promise<Email[]>((yes, no) => { resolve = yes; reject = no; });
        // Speculative failures are silent, while foreground callers still receive the rejection.
        void promise.catch(() => {});
        const pending = { ...target, key: targetKey(target), scope: this.scope, generation: this.generation, foreground, single: false, running: false, settled: false, promise, resolve, reject };
        this.pending.set(pending.key, pending);
        return pending;
    }

    private schedule(): void {
        if (this.scheduled) return;
        this.scheduled = true;
        queueMicrotask(() => { this.scheduled = false; this.pump(); });
    }

    private pump(): void {
        // At most one speculative envelope leaves a second slot available for an explicit open.
        while (this.activeRequests < 2) {
            const queued = [...this.pending.values()].filter(pending => !pending.running && !pending.settled);
            const foreground = queued.find(pending => pending.foreground);
            if (foreground) { this.run([foreground], false); continue; }
            if (this.activePrefetch) return;
            const first = queued[0];
            if (!first) return;
            this.run(first.single ? [first] : queued.filter(pending => !pending.single && pending.accountId === first.accountId).slice(0, this.prefetchBatchSize), true);
        }
    }

    private run(batch: Pending[], speculative: boolean): void {
        for (const pending of batch) pending.running = true;
        this.activeRequests++;
        if (speculative) this.activePrefetch++;
        const accountId = batch[0].accountId;
        void this.client.readBatch([
            ['Thread/get', { ids: batch.map(pending => pending.threadId) }, 'threads'],
            ['Email/get', { '#ids': { resultOf: 'threads', name: 'Thread/get', path: '/list/*/emailIds/*' }, fetchAllBodyValues: true, maxBodyValueBytes: 0 }, 'emails'],
        ], accountId).then(results => {
            const threads = results.threads?.list as { id: string; emailIds: string[] }[] | undefined;
            const messages = results.emails?.list as Email[] | undefined;
            if (!Array.isArray(threads) || !Array.isArray(messages)) throw new Error('Mail server returned an incomplete conversation.');
            const byId = new Map(messages.map(message => [message.id, message]));
            for (const pending of batch) {
                if (pending.settled || pending.generation !== this.generation || pending.scope !== this.scope) continue;
                const thread = threads.find(thread => thread.id === pending.threadId);
                if (!thread || !Array.isArray(thread.emailIds) || thread.emailIds.some(id => !byId.has(id))) {
                    this.finish(pending, undefined, new Error('This conversation is no longer available. Refresh the mailbox and try again.'));
                    continue;
                }
                const conversation = thread.emailIds.map(id => byId.get(id)!);
                if (conversation.some(message => message.threadId !== pending.threadId || Object.values(message.bodyValues || {}).some(value => value.isTruncated))) {
                    this.finish(pending, undefined, new Error('Mail server returned an incomplete conversation.'));
                    continue;
                }
                this.store(pending, conversation);
                this.finish(pending, conversation);
            }
        }).catch(error => {
            // Several individually valid threads may exceed the server's combined membership bound.
            // Split once, retaining a click's waiter and foreground priority; never loop on a huge thread.
            if (batch.length > 1 && (error as { errorType?: string }).errorType === 'tooManyObjects') {
                for (const pending of batch) if (!pending.settled) { pending.running = false; pending.single = true; }
                return;
            }
            for (const pending of batch) this.finish(pending, undefined, error);
        })
            .finally(() => { this.activeRequests--; if (speculative) this.activePrefetch--; this.schedule(); });
    }

    private finish(pending: Pending, messages?: Email[], error?: unknown): void {
        if (pending.settled) return;
        pending.settled = true;
        if (this.pending.get(pending.key) === pending) this.pending.delete(pending.key);
        if (messages) pending.resolve(messages); else pending.reject(error);
    }

    private store(target: ConversationTarget, messages: Email[], at = this.now()): void {
        const size = bytes(messages);
        if (size > this.maxBytes) return; // Large mail still opens in full without staying resident.
        const key = targetKey(target);
        this.deleteEntry(key);
        this.entries.set(key, { ...target, messages: structuredClone(messages), at, bytes: size });
        this.totalBytes += size;
        while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) this.deleteEntry(this.entries.keys().next().value!);
    }

    private deleteEntry(key: string): void {
        const entry = this.entries.get(key);
        if (entry) this.totalBytes -= entry.bytes;
        this.entries.delete(key);
    }
}
