import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheScope, clearMailCaches, discardQueuedMutation, matchesCached, queueMutation, readMailCache, readQueuedMutations, replayMutations, saveMailCache } from '../apps/mail/src/ui/offline';
import type { MailClient, MailSession } from '../apps/mail/src/ui/jmap';

const session = (actorId = 'alice', apiUrl = '/workspaces/a/apps/mail/jmap'): MailSession => ({ actorId, organizationId: 'org-a', workspaceId: 'workspace-a', username: 'shared@example.com', apiUrl, uploadUrl: '', downloadUrl: '', capabilities: {}, primaryAccounts: {}, accounts: { a: { name: 'Personal', isReadOnly: false, accountCapabilities: {} } } } as MailSession);
const patch = { update: { message: { keywords: { '$flagged': true } } } };
describe('Mail browser offline storage', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('isolates actors, workspace endpoints and changed account admission', () => {
    const scope = cacheScope(session());
    saveMailCache(scope, [{ id: 'private' }]);
    expect(readMailCache(scope)).toHaveLength(1);
    expect(readMailCache(cacheScope(session('bob')))).toEqual([]);
    expect(readMailCache(cacheScope(session('alice', '/workspaces/b/apps/mail/jmap')))).toEqual([]);
    expect(cacheScope({ ...session(), accounts: {} })).not.toBe(scope);
    expect(cacheScope({ ...session(), workspaceId: 'workspace-b' } as MailSession)).not.toBe(scope);
    expect(cacheScope({ ...session(), organizationId: 'org-b' } as MailSession)).not.toBe(scope);
    expect(cacheScope({ ...session(), username: 'renamed@example.com' })).toBe(scope);
    expect(cacheScope({ ...session(), accounts: { a: { ...session().accounts.a, isReadOnly: true } } })).not.toBe(scope);
    expect(() => cacheScope({ ...session(), actorId: undefined } as unknown as MailSession)).toThrow('Verified');
    const admitted = (rights: Record<string, unknown>) => ({ ...session(), accounts: { a: { ...session().accounts.a, accountCapabilities: { native: rights } } } });
    expect(cacheScope(admitted({ read: true, write: true }))).toBe(cacheScope(admitted({ write: true, read: true })));
    expect(cacheScope(admitted({ read: true, write: true }))).not.toBe(cacheScope(admitted({ read: true, write: false })));
  });
  it('bounds recent rows and retains text for offline reading without HTML or headers', () => {
    const scope = cacheScope(session());
    saveMailCache(scope, Array.from({ length: 120 }, (_, i) => ({ id: String(i), receivedAt: new Date(i * 1000).toISOString(), headers: [{ name: 'Authorization', value: 'secret' }], htmlBody: [{ partId: 'html' }], textBody: [{ partId: 'text' }], bodyValues: { text: { value: 'Readable offline' }, html: { value: '<img src="https://remote">' } } })));
    const rows = readMailCache(scope);
    expect(rows).toHaveLength(100);
    expect(rows[0].id).toBe('119');
    expect(rows[0].bodyValues.text.value).toBe('Readable offline');
    expect(rows[0]).not.toHaveProperty('htmlBody');
    expect(rows[0]).not.toHaveProperty('headers');
    expect(rows[0].bodyValues).not.toHaveProperty('html');
  });
  it('replays immutable message updates with the original state and preserves conflicting commands', async () => {
    const scope = cacheScope(session());
    const args = structuredClone(patch);
    queueMutation(scope, 'a', args, 'original');
    args.update.message.keywords.$flagged = false;
    const call = vi.fn().mockRejectedValueOnce(new Error('stateMismatch')).mockResolvedValueOnce({ newState: 'new' });
    const client = { session: session(), call } as unknown as MailClient;
    await expect(replayMutations(scope, client)).rejects.toThrow('stateMismatch');
    expect(call).toHaveBeenCalledWith('Email/set', { ...patch, ifInState: 'original', operationId: expect.any(String) }, 'a');
    await replayMutations(scope, client);
    await replayMutations(scope, client);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][1].operationId).toBe(call.mock.calls[0][1].operationId);
  });
  it('rejects another actor replay and prevents duplicate concurrent replay', async () => {
    const scope = cacheScope(session());
    queueMutation(scope, 'a', patch, 'original');
    const wrong = { session: session('bob'), call: vi.fn() } as unknown as MailClient;
    await expect(replayMutations(scope, wrong)).rejects.toThrow('different mail session');
    expect(wrong.call).not.toHaveBeenCalled();
    let finish!: () => void;
    const call = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const client = { session: session(), call } as unknown as MailClient;
    const first = replayMutations(scope, client);
    expect(replayMutations(scope, client)).toBe(first);
    finish(); await first;
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('retains commands queued while a previous replay is pending', async () => {
    const scope = cacheScope(session());
    queueMutation(scope, 'a', patch, 'one');
    let finish!: () => void;
    const call = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue({});
    const client = { session: session(), call } as unknown as MailClient;
    const pending = replayMutations(scope, client);
    queueMutation(scope, 'a', { update: { other: { keywords: {} } } }, 'two');
    finish(); await pending;
    await replayMutations(scope, client);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][1]).toEqual({ update: { other: { keywords: {} } }, ifInState: 'two', operationId: expect.any(String) });
  });
  it('filters cached text, addresses, mailbox membership, flags, dates and compound queries', () => {
    const row = { id: 'message', mailboxIds: { inbox: true }, keywords: { '$flagged': true }, from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ email: 'bob@example.com' }], subject: 'Budget', bodyValues: { text: { value: 'Meeting tomorrow' } }, receivedAt: '2026-10-05T12:00:00Z', size: 1000, hasAttachment: false };
    expect(matchesCached(row, { inMailbox: 'inbox', hasKeyword: '$flagged', from: 'ALICE', to: 'bob', subject: 'budget', text: 'tomorrow', minSize: 1000, maxSize: 1001, before: '2026-10-06T00:00:00Z', after: '2026-10-05T00:00:00Z' })).toBe(true);
    expect(matchesCached(row, { inMailbox: 'trash' })).toBe(false);
    expect(matchesCached(row, { operator: 'AND', conditions: [{ text: 'meeting' }, { operator: 'NOT', conditions: [{ hasKeyword: '$seen' }] }] })).toBe(true);
    expect(matchesCached(row, { operator: 'OR', conditions: [{ subject: 'invoice' }, { to: 'bob' }] })).toBe(true);
    expect(matchesCached(row, { header: ['Delivered-To', 'alice'] })).toBe(false);
    expect(() => matchesCached(row, { unsupported: true })).toThrow('Unsupported filter');
  });
  it('exposes independent queue snapshots and discards only the explicitly selected command', () => {
    const scope = cacheScope(session());
    queueMutation(scope, 'a', patch, 'original');
    queueMutation(scope, 'a', { update: { other: { 'keywords/$seen': true } } }, 'original');
    const snapshot = readQueuedMutations(scope);
    const firstId = snapshot[0].id;
    (snapshot[0].args.update as Record<string, unknown>).message = { keywords: {} };
    expect(readQueuedMutations(scope)[0].args).toEqual(patch);
    expect(snapshot[0].expectedState).toBe('original');
    discardQueuedMutation(scope, firstId);
    const remaining = readQueuedMutations(scope);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(snapshot[1].id);
    expect(remaining[0].args).toEqual({ update: { other: { 'keywords/$seen': true } } });
    expect(readQueuedMutations(cacheScope(session('bob')))).toEqual([]);
  });
  it('refuses queue discard while a request is in flight', async () => {
    const scope = cacheScope(session());
    queueMutation(scope, 'a', patch, 'original');
    const id = readQueuedMutations(scope)[0].id;
    let finish!: () => void;
    const client = { session: session(), call: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) } as unknown as MailClient;
    const pending = replayMutations(scope, client);
    expect(() => discardQueuedMutation(scope, id)).toThrow('synchronization');
    finish(); await pending;
  });
  it('clears all offline actor caches while leaving unrelated browser data intact', () => {
    localStorage.setItem('other-app', 'keep');
    saveMailCache(cacheScope(session()), [{ id: 'private' }]);
    queueMutation(cacheScope(session('bob')), 'a', patch, 'one');
    clearMailCaches();
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('other-app')).toBe('keep');
    expect(() => queueMutation(cacheScope(session()), 'a', { create: { draft: {} } }, 'one')).toThrow('existing messages');
    expect(() => queueMutation(cacheScope(session()), 'a', patch, '')).toThrow('state');
  });
});
