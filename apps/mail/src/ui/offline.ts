import type { MailClient, MailSession } from './jmap';
import { matchesFilter, validateFilter, type RuleEmail } from '../domain/rules';

const PREFIX = 'enough-mail:offline:v1:';
const MAX_ROWS = 100;
const MAX_BYTES = 2_000_000;
const MAX_QUEUE = 100;
type Mutation = { id: string; accountId: string; args: Record<string, unknown>; expectedState: string };
export type QueuedMutation = Readonly<Omit<Mutation, 'args'>> & { readonly args: Readonly<Record<string, unknown>> };
const activeReplays = new Map<string, Promise<void>>();

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, nested]) => [name, canonical(nested)]));
  return value;
}
// Display names and email addresses are mutable: only Core identity scopes caches.
export function cacheScope(session: MailSession): string {
  const identity = session as MailSession & { actorId?: string; organizationId?: string; workspaceId?: string };
  if (!identity.actorId || !identity.organizationId || !identity.workspaceId) throw new Error('Verified mail session identity is required for offline storage.');
  const admission = Object.entries(session.accounts).sort(([a], [b]) => a.localeCompare(b)).map(([id, account]) => [id, account.isReadOnly, canonical(account.accountCapabilities)]);
  return encodeURIComponent(JSON.stringify([session.apiUrl, identity.organizationId, identity.workspaceId, identity.actorId, admission]));
}
function key(scope: string, kind: 'rows' | 'queue') { return `${PREFIX}${scope}:${kind}`; }
function read<T>(scope: string, kind: 'rows' | 'queue'): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(key(scope, kind)) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
export function readMailCache(scope: string): any[] { return read(scope, 'rows').slice(0, MAX_ROWS); }
// JSON parsing gives callers independent snapshots, never mutable queue storage.
export function readQueuedMutations(scope: string): readonly QueuedMutation[] { return read<Mutation>(scope, 'queue'); }
export function discardQueuedMutation(scope: string, id: string): void {
  if (activeReplays.has(scope)) throw new Error('Wait for mail synchronization to finish before discarding a queued change.');
  const remaining = read<Mutation>(scope, 'queue').filter(mutation => mutation.id !== id);
  localStorage.setItem(key(scope, 'queue'), JSON.stringify(remaining));
}
export function matchesCached(row: RuleEmail, filter: Record<string, unknown> | null | undefined): boolean {
  return matchesFilter(row, filter == null ? filter : validateFilter(filter));
}
export function saveMailCache(scope: string, rows: any[]): void {
  const recent = [...rows].sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || ''))).slice(0, MAX_ROWS);
  const safe = recent.map(row => {
    const { htmlBody: _html, headers: _headers, bodyValues: _values, ...rest } = row;
    const bodyValues: Record<string, unknown> = {};
    for (const part of row.textBody || []) {
      const id = part.partId;
      const body = row.bodyValues?.[id];
      if (id && typeof body?.value === 'string') {
        bodyValues[id] = { value: body.value.slice(0, 64_000), isTruncated: !!body.isTruncated || body.value.length > 64_000 };
      }
    }
    return { ...rest, bodyValues };
  });
  let encoded = JSON.stringify(safe);
  while (encoded.length * 2 > MAX_BYTES && safe.length) { safe.pop(); encoded = JSON.stringify(safe); }
  try { localStorage.setItem(key(scope, 'rows'), encoded); } catch { /* Reading live mail still works if browser storage is unavailable. */ }
}
export function clearMailCaches(): void {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const name = localStorage.key(i);
    if (name?.startsWith(PREFIX)) localStorage.removeItem(name);
  }
}
export function queueMutation(scope: string, accountId: string, args: Record<string, unknown>, expectedState: string): void {
  if (!expectedState) throw new Error('A mailbox state is required before queuing an offline change.');
  if (!accountId) throw new Error('An account is required before queuing an offline change.');
  if ('create' in args || 'destroy' in args || !args.update || typeof args.update !== 'object' || Array.isArray(args.update) || !Object.keys(args.update).length) {
    throw new Error('Only updates to existing messages can be queued offline.');
  }
  const queue = read<Mutation>(scope, 'queue');
  if (queue.length >= MAX_QUEUE) throw new Error('The offline queue is full. Reconnect before making more changes.');
  // JSON copying prevents later UI edits from changing an already queued command.
  const mutation: Mutation = { id: crypto.randomUUID(), accountId, args: JSON.parse(JSON.stringify(args)), expectedState };
  localStorage.setItem(key(scope, 'queue'), JSON.stringify([...queue, mutation]));
}
export function replayMutations(scope: string, client: MailClient): Promise<void> {
  const active = activeReplays.get(scope);
  if (active) return active;
  const replay = (async () => {
    if (cacheScope(client.session) !== scope) throw new Error('Offline changes belong to a different mail session.');
    for (const mutation of read<Mutation>(scope, 'queue')) {
      if (!client.session.accounts[mutation.accountId] || client.session.accounts[mutation.accountId].isReadOnly) throw new Error('This account is no longer writable. Offline changes were retained.');
      // Never rebase a queued change onto a newer server state without user review.
      await client.call('Email/set', { ...mutation.args, ifInState: mutation.expectedState, operationId: mutation.id }, mutation.accountId);
      // Re-read so a command queued while this request was pending is preserved.
      const remaining = read<Mutation>(scope, 'queue').filter(item => item.id !== mutation.id);
      localStorage.setItem(key(scope, 'queue'), JSON.stringify(remaining));
    }
  })();
  activeReplays.set(scope, replay);
  void replay.finally(() => { activeReplays.delete(scope); }).catch(() => {});
  return replay;
}

/** Remove only downloaded mail copies; queued commands remain recoverable. */
export function clearCachedMailCopies(scope:string):void{localStorage.removeItem(key(scope,'rows'));}
