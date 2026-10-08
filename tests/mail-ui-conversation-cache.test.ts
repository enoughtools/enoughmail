import { describe, expect, it, vi } from 'vitest';
import { MailConversationCache } from '../apps/mail/src/ui/conversation-cache';
import type { Email, MailClient } from '../apps/mail/src/ui/jmap';

const scope = 'verified:organization:workspace:actor';
const message = (id: string, threadId = id, body = `Full ${id}`): Email => ({
    id, threadId, blobId: `blob-${id}`, mailboxIds: { inbox: true }, keywords: {}, from: [{ email: 'sender@example.test' }],
    to: [{ email: 'reader@example.test' }], subject: id, receivedAt: '2026-10-08T12:00:00Z', preview: id, hasAttachment: false,
    htmlBody: [{ partId: 'html', blobId: `html-${id}`, type: 'text/html', size: body.length }], bodyValues: { html: { value: body } },
});
type Reply = Record<string, Record<string, any>>;
const reply = (messages: Email[], threadIds = [...new Set(messages.map(message => message.threadId))]): Reply => ({
    threads: { list: threadIds.map(id => ({ id, emailIds: messages.filter(message => message.threadId === id).map(message => message.id) })) },
    emails: { list: messages },
});
async function flush(): Promise<void> { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); }
function controlled() {
    const requests: { calls: [string, Record<string, unknown>, string][]; accountId: string; resolve: (value: Reply) => void; reject: (error: unknown) => void }[] = [];
    const readBatch = vi.fn((calls: [string, Record<string, unknown>, string][], accountId: string) => new Promise<Reply>((resolve, reject) => requests.push({ calls, accountId, resolve, reject })));
    const cache = new MailConversationCache({ readBatch } as Pick<MailClient, 'readBatch'>);
    return { cache, readBatch, requests };
}
const ids = (request: ReturnType<typeof controlled>['requests'][number]) => request.calls[0][1].ids;

describe('Authenticated conversation preloading', () => {
    it('batches unique visible threads per account with full body reads and shares an opening read', async () => {
        const { cache, requests, readBatch } = controlled();
        cache.prefetch(scope, [{ accountId: 'a', threadId: 'one' }, { accountId: 'a', threadId: 'one' }, { accountId: 'a', threadId: 'two' }, { accountId: 'b', threadId: 'one' }]);
        await flush();
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ accountId: 'a', calls: [
            ['Thread/get', { ids: ['one', 'two'] }, 'threads'],
            ['Email/get', { '#ids': { resultOf: 'threads', name: 'Thread/get', path: '/list/*/emailIds/*' }, fetchAllBodyValues: true, maxBodyValueBytes: 0 }, 'emails'],
        ] });
        const opened = cache.load(scope, 'a', 'one');
        await flush();
        expect(readBatch).toHaveBeenCalledOnce();
        const oldest = message('oldest', 'one', '<p>Original <img src="https://remote.example.test/image.png"></p>');
        const newest = message('newest', 'one');
        requests[0].resolve(reply([oldest, message('other', 'two'), newest]));
        expect(await opened).toEqual([oldest, newest]);
        expect(cache.get(scope, 'a', 'two')).toEqual([message('other', 'two')]);
        await flush();
        expect(requests[1].accountId).toBe('b');
        requests[1].resolve(reply([message('private-b', 'one')]));
        await flush();
        expect(cache.get(scope, 'a', 'one')?.map(message => message.id)).toEqual(['oldest', 'newest']);
        expect(cache.get(scope, 'b', 'one')?.map(message => message.id)).toEqual(['private-b']);
        expect(readBatch.mock.calls.flatMap(([calls]) => calls).every(([name]) => name.endsWith('/get'))).toBe(true);
    });

    it('reserves foreground capacity and prioritizes clicks over queued speculative batches', async () => {
        const { cache, requests } = controlled();
        cache.prefetch(scope, Array.from({ length: 8 }, (_, index) => ({ accountId: 'a', threadId: String(index) })));
        await flush();
        expect(ids(requests[0])).toEqual(['0', '1', '2', '3', '4']);
        const selected = cache.load(scope, 'a', '7');
        await flush();
        expect(ids(requests[1])).toEqual(['7']);
        const laterClick = cache.load(scope, 'a', 'clicked');
        await flush();
        expect(requests).toHaveLength(2);
        requests[1].resolve(reply([message('7')]));
        await selected;
        await flush();
        expect(ids(requests[2])).toEqual(['clicked']);
        requests[2].resolve(reply([message('clicked')]));
        await laterClick;
        cache.prefetch(scope, []);
        requests[0].resolve(reply(Array.from({ length: 5 }, (_, index) => message(String(index)))));
        await flush();
        expect(requests).toHaveLength(3);
        expect(cache.isBusy()).toBe(false);
    });

    it('replaces speculative queued targets when scrolling or pausing without abandoning an explicit open', async () => {
        const { cache, requests } = controlled();
        cache.prefetch(scope, Array.from({ length: 7 }, (_, index) => ({ accountId: 'a', threadId: String(index) })));
        await flush();
        const selected = cache.load(scope, 'a', '6');
        cache.prefetch(scope, []);
        await flush();
        expect(ids(requests[1])).toEqual(['6']);
        requests[1].resolve(reply([message('6')]));
        expect(await selected).toEqual([message('6')]);
        requests[0].resolve(reply(Array.from({ length: 5 }, (_, index) => message(String(index)))));
        await flush();
        expect(requests).toHaveLength(2);
        expect(cache.isBusy()).toBe(false);
    });

    it('does not retain a failed prefetch or incomplete bodies as a poisoned future click', async () => {
        const { cache, requests } = controlled();
        cache.prefetch(scope, [{ accountId: 'a', threadId: 'one' }]);
        await flush();
        requests[0].reject(new Error('Temporary transport failure'));
        await flush();
        const retried = cache.load(scope, 'a', 'one');
        await flush();
        expect(requests).toHaveLength(2);
        const truncated = message('one'); truncated.bodyValues!.html.isTruncated = true;
        requests[1].resolve(reply([truncated]));
        await expect(retried).rejects.toThrow('incomplete conversation');
        expect(cache.get(scope, 'a', 'one')).toBeUndefined();
        const complete = cache.load(scope, 'a', 'one');
        await flush(); requests[2].resolve(reply([message('one')]));
        expect(await complete).toEqual([message('one')]);
    });

    it('does not cache a partially missing conversation', async () => {
        const { cache, requests } = controlled();
        const opened = cache.load(scope, 'a', 'one');
        await flush();
        requests[0].resolve({ threads: { list: [{ id: 'one', emailIds: ['present', 'missing'] }] }, emails: { list: [message('present', 'one')], notFound: ['missing'] } });
        await expect(opened).rejects.toThrow('no longer available');
        expect(cache.get(scope, 'a', 'one')).toBeUndefined();
    });

    it('splits an oversized speculative batch once and preserves a joined foreground click', async () => {
        const { cache, requests } = controlled();
        cache.prefetch(scope, Array.from({ length: 6 }, (_, index) => ({ accountId: 'a', threadId: String(index) })));
        await flush();
        const opened = cache.load(scope, 'a', '1');
        requests[0].reject(Object.assign(new Error('Request fewer threads'), { errorType: 'tooManyObjects' }));
        await flush();
        expect(ids(requests[1])).toEqual(['1']);
        expect(ids(requests[2])).toEqual(['0']);
        requests[1].resolve(reply([message('1')]));
        expect(await opened).toEqual([message('1')]);
        cache.prefetch(scope, []);
        requests[2].resolve(reply([message('0')]));
        await flush();
        expect(requests).toHaveLength(3);
        const huge = cache.load(scope, 'a', 'huge');
        await flush();
        requests[3].reject(Object.assign(new Error('Thread is too large'), { errorType: 'tooManyObjects' }));
        await expect(huge).rejects.toMatchObject({ errorType: 'tooManyObjects' });
        await flush();
        expect(requests).toHaveLength(4);
    });
});

describe('Conversation memory and authorization fences', () => {
    it('fences old in-flight responses when verified scope changes or authorization is cleared', async () => {
        const { cache, requests } = controlled();
        const original = cache.load(scope, 'a', 'one');
        await flush();
        const replacement = cache.load('other-verified-actor', 'a', 'one');
        await expect(original).rejects.toMatchObject({ conversationInvalidated: true });
        await flush();
        requests[0].resolve(reply([message('old-private', 'one')]));
        requests[1].resolve(reply([message('new-private', 'one')]));
        expect(await replacement).toEqual([message('new-private', 'one')]);
        expect(cache.get('other-verified-actor', 'a', 'one')).toEqual([message('new-private', 'one')]);
        const late = cache.load('other-verified-actor', 'a', 'late');
        await flush(); cache.clear();
        await expect(late).rejects.toMatchObject({ conversationInvalidated: true });
        requests[2].resolve(reply([message('late')]));
        await flush();
        expect(cache.get('other-verified-actor', 'a', 'late')).toBeUndefined();
    });

    it('invalidates only the changed account and rejects its old in-flight copy', async () => {
        const { cache, requests } = controlled();
        const first = cache.load(scope, 'a', 'one'); const second = cache.load(scope, 'b', 'one');
        await flush(); requests[0].resolve(reply([message('a-copy', 'one')])); requests[1].resolve(reply([message('b-copy', 'one')]));
        await Promise.all([first, second]);
        const changing = cache.load(scope, 'a', 'two');
        await flush(); cache.invalidate('a');
        await expect(changing).rejects.toMatchObject({ conversationInvalidated: true });
        requests[2].resolve(reply([message('stale', 'two')]));
        await flush();
        expect(cache.get(scope, 'a', 'one')).toBeUndefined();
        expect(cache.get(scope, 'a', 'two')).toBeUndefined();
        expect(cache.get(scope, 'b', 'one')).toEqual([message('b-copy', 'one')]);
    });

    it('patches known local read status while preserving bodies and independent returned copies', async () => {
        const { cache, requests } = controlled();
        const opened = cache.load(scope, 'a', 'one');
        await flush(); requests[0].resolve(reply([message('one')])); await opened;
        const returned = cache.get(scope, 'a', 'one')!; returned[0].bodyValues!.html.value = 'Mutated caller copy';
        cache.patch(scope, 'a', { one: { keywords: { $seen: true, $flagged: true } } });
        expect(cache.get(scope, 'a', 'one')?.[0]).toMatchObject({ keywords: { $seen: true, $flagged: true }, bodyValues: { html: { value: 'Full one' } } });
        expect(await cache.load(scope, 'a', 'one')).toEqual(cache.get(scope, 'a', 'one'));
        expect(requests).toHaveLength(1);
    });

    it('expires and evicts least recently used conversations within entry and byte bounds', async () => {
        let now = 0;
        const readBatch = vi.fn(async (calls: [string, Record<string, unknown>, string][]) => reply((calls[0][1].ids as string[]).map(id => message(id))));
        const cache = new MailConversationCache({ readBatch } as Pick<MailClient, 'readBatch'>, { ttlMs: 100, maxEntries: 2, now: () => now });
        await cache.load(scope, 'a', 'one'); await cache.load(scope, 'a', 'two'); cache.get(scope, 'a', 'one'); await cache.load(scope, 'a', 'three');
        expect(cache.get(scope, 'a', 'two')).toBeUndefined();
        expect(cache.get(scope, 'a', 'one')).toBeDefined();
        now = 100;
        expect(cache.get(scope, 'a', 'one')).toBeUndefined();
        await cache.load(scope, 'a', 'one');
        expect(readBatch).toHaveBeenCalledTimes(4);
        const budget = JSON.stringify([message('one')]).length * 2 + 64;
        const bounded = new MailConversationCache({ readBatch } as Pick<MailClient, 'readBatch'>, { maxBytes: budget });
        await bounded.load(scope, 'a', 'one'); await bounded.load(scope, 'a', 'two');
        expect(bounded.get(scope, 'a', 'one')).toBeUndefined();
        expect(bounded.get(scope, 'a', 'two')).toBeDefined();
    });

    it('opens oversized mail in full without retaining it or truncating later loads', async () => {
        const full = message('large', 'large', '<p>' + 'a'.repeat(8192) + '</p>');
        const readBatch = vi.fn(async () => reply([full]));
        const cache = new MailConversationCache({ readBatch } as Pick<MailClient, 'readBatch'>, { maxBytes: 2048 });
        expect(await cache.load(scope, 'a', 'large')).toEqual([full]);
        expect(cache.get(scope, 'a', 'large')).toBeUndefined();
        expect(await cache.load(scope, 'a', 'large')).toEqual([full]);
        expect(readBatch).toHaveBeenCalledTimes(2);
    });
});
