import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discardComposeDraft, chooseSendingIdentity, chooseSendingAddress, resolveComposeIdentity, draftReplacementArgs, createComposeOperation, isConfirmedDraftConflict, isConfirmedRejection, isConfirmedSubmissionRejection, recoverNewDraftConflict, saveComposeDraft } from '../apps/mail/src/ui/compose-operations';
import { MailClient, type MailSession } from '../apps/mail/src/ui/jmap';
const session: MailSession = { username: 'actor', actorId: 'actor', organizationId: 'org', workspaceId: 'workspace', apiUrl: '/apps/mail/jmap/api', uploadUrl: '/upload/{accountId}', downloadUrl: '/blob/{blobId}', capabilities: {}, primaryAccounts: {}, accounts: {} };

describe('Compose mutation recovery', () => {
  beforeEach(() => vi.stubGlobal('window', { location: { origin: 'https://enough.example' } }));
  afterEach(() => vi.unstubAllGlobals());

  for (const entity of ['Email', 'EmailSubmission']) {
    it(`recovers one committed ${entity} create after a lost response and browser reload`, async () => {
      const input: { create: { compose: Record<string, unknown> } } = { create: { compose: entity === 'Email' ? { subject: 'Original draft', bodyValues: { text: { value: 'Original content' } } } : { emailId: 'email-1', identityId: 'identity-1', sendAt: '2026-10-09T12:00:00.000Z', undoSeconds: 10 } } };
      const operation = createComposeOperation(input, 'content-snapshot', 'original-state', '00000000-0000-4000-8000-000000000001');
      // Subsequent edits must not mutate the request already sent to the server.
      input.create.compose = { ...input.create.compose, subject: 'Later edit' };
      let committed = 0;
      let priorRequest: string | undefined;
      vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        const args = JSON.parse(options.body).methodCalls[0][1];
        const exact = JSON.stringify(args);
        if (!priorRequest) { priorRequest = exact; committed++; throw new TypeError('Connection lost after commit'); }
        expect(exact).toBe(priorRequest);
        return new Response(JSON.stringify({ methodResponses: [[`${entity}/set`, { created: { compose: { id: 'existing-object' } }, newState: 'committed-state' }, 'ui']] }));
      }));
      const originalClient = new MailClient(); originalClient.session = session;
      await expect(originalClient.call(`${entity}/set`, operation.args, 'account')).rejects.toThrow('Connection lost');
      // Reload recovery preserves operation ID, original revision, and exact request.
      const recovered = JSON.parse(JSON.stringify(operation));
      const reloadedClient = new MailClient(); reloadedClient.session = session;
      reloadedClient.states.set(`account:${entity}`, 'newer-state-after-reload');
      const result = await reloadedClient.call<{ created: { compose: { id: string } } }>(`${entity}/set`, recovered.args, 'account');
      expect(result.created.compose.id).toBe('existing-object');
      expect(committed).toBe(1);
      expect(recovered.args.ifInState).toBe('original-state');
    });
  }

  it('revises immutable draft content using one create-and-destroy command', () => {
    const content = { subject: 'New content', bodyValues: { text: { value: 'Changed' } } };
    const operation = createComposeOperation(draftReplacementArgs(content, 'previous-draft'), 'changed-content', 'revision-8', '00000000-0000-4000-8000-000000000002');
    expect(operation.args).toEqual({ create: { compose: content }, destroy: ['previous-draft'], operationId: '00000000-0000-4000-8000-000000000002', ifInState: 'revision-8' });
    expect(operation.args).not.toHaveProperty('update');
    content.subject = 'Later edit';
    expect((operation.args.create as { compose: { subject: string } }).compose.subject).toBe('New content');
    expect(draftReplacementArgs({}, undefined)).not.toHaveProperty('destroy');
  });

  it('replies from the authorized delivered alias rather than the first identity', () => {
    const identities = [{ id: 'first', email: 'main@example.com' }, { id: 'alias', email: 'alias@example.com' }];
    expect(chooseSendingIdentity(identities, undefined, { to: [{ email: 'main@example.com' }], deliveryRecipient: 'ALIAS@example.com', headers: [{ name: 'Delivered-To', value: '<main@example.com>' }] })?.id).toBe('alias');
    expect(chooseSendingIdentity(identities, undefined, { to: [], cc: [{ email: 'alias@example.com' }] })?.id).toBe('alias');
    expect(chooseSendingIdentity(identities, undefined, { to: [{ email: 'alias@example.com' }] })?.id).toBe('alias');
  });

  it('requires explicit choice for ambiguous or unauthorized reply aliases', () => {
    const identities = [{ id: 'first', email: 'main@example.com' }, { id: 'alias', email: 'alias@example.com' }];
    expect(chooseSendingIdentity(identities, undefined, { to: [{ email: 'main@example.com' }, { email: 'alias@example.com' }] })).toBeUndefined();
    expect(chooseSendingIdentity(identities, undefined, { to: [{ email: 'unknown@example.com' }] })).toBeUndefined();
    expect(chooseSendingIdentity(identities, { from: [{ email: 'unknown@example.com' }] })).toBeUndefined();
    expect(chooseSendingIdentity(identities, { from: [{ email: 'ALIAS@example.com' }] })?.id).toBe('alias');
  });

  it('persists absence of a known revision so a later cached state cannot change a retry', () => {
    const operation = createComposeOperation({ create: { compose: {} } }, 'snapshot', undefined, '00000000-0000-4000-8000-000000000003');
    expect(JSON.parse(JSON.stringify(operation)).args).toEqual({ create: { compose: {} }, operationId: '00000000-0000-4000-8000-000000000003', ifInState: null });
  });

  it('pauses editing for confirmed revision conflicts, but never reclassifies an uncertain transport error', () => {
    expect(isConfirmedDraftConflict(Object.assign(new Error('Draft changed elsewhere'), { confirmed: true, errorType: 'stateMismatch' }))).toBe(true);
    expect(isConfirmedDraftConflict(Object.assign(new Error('stateMismatch'), { confirmed: true }))).toBe(true);
    expect(isConfirmedDraftConflict(new Error('stateMismatch'))).toBe(false);
    expect(isConfirmedDraftConflict(Object.assign(new Error('forbidden'), { confirmed: true }))).toBe(false);
  });

  it('only releases pending operations for a confirmed server rejection', () => {
    expect(isConfirmedRejection(new TypeError('Network lost'))).toBe(false);
    expect(isConfirmedRejection(new Error('Mail request failed (503).'))).toBe(false);
    expect(isConfirmedRejection(Object.assign(new Error('Identity is not verified'), { confirmed: true }))).toBe(true);
  });

  it('recovers a legacy false new-draft conflict without losing content or backups', () => {
    const recovery = { conflicted: true, fields: { subject: 'Test email', body: 'Keep my text', attachments: [] }, conflictBackup: { body: 'Previous text' } };
    const restored = recoverNewDraftConflict(recovery);
    expect(restored).toEqual({ ...recovery, conflicted: false });
    expect(restored.fields).toBe(recovery.fields);
    expect(restored.conflictBackup).toBe(recovery.conflictBackup);
    expect(recovery.conflicted).toBe(true);
  });

  it('never clears recovery conflicts with server references or uncertain commands', () => {
    const recovery = { conflicted: true, fields: { body: 'Preserve this edit' } };
    const pending = createComposeOperation(draftReplacementArgs({ subject: 'Pending' }), 'pending', 'original');
    for (const reference of [
      { emailId: 'existing' }, { sourceEmailId: 'existing' }, { sourceBlobId: 'existing-bytes' },
      { draftBaseline: { id: 'existing', blobId: 'bytes', mailboxIds: {}, keywords: {} } },
      { pendingDraft: pending }, { pendingSubmission: pending }, { pendingDiscard: pending },
    ]) {
      const value = { ...recovery, ...reference };
      expect(recoverNewDraftConflict(value)).toBe(value);
    }
    expect(recoverNewDraftConflict(recovery, 'existing')).toBe(recovery);
  });

  it('saves a new draft after another entity advances the account revision', async () => {
    const client = new MailClient(); client.session = session;
    client.states.set('account:Email', 'old-email-read');
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const [method, args] = JSON.parse(options.body).methodCalls[0]; requests.push([method, args]);
      if (method === 'Email/get') return new Response(JSON.stringify({ methodResponses: [[method, { state: 'after-contact-change', list: [] }, 'ui']] }));
      expect(args.ifInState).toBe('after-contact-change');
      return new Response(JSON.stringify({ methodResponses: [[method, { created: { compose: { id: 'draft' } }, newState: 'saved' }, 'ui']] }));
    }));
    const persisted: any[] = [];
    const result = await saveComposeDraft<any>(client, 'account', createComposeOperation(draftReplacementArgs({ subject: 'Hello' }), 'hello', 'old-email-read'), next => persisted.push(next));
    expect(result.result.created.compose.id).toBe('draft');
    expect(requests.map(([method]) => method)).toEqual(['Email/get', 'Email/set']);
    expect({ ...persisted[0].args, accountId: 'account' }).toEqual(requests[1][1]);
  });

  it('retries a confirmed new-create revision race with a new receipt and fence', async () => {
    let state = 'before-arrival'; const mutations: any[] = [];
    const client = { call: vi.fn(async (method: string, args: any) => {
      if (method === 'Email/get') return { state };
      mutations.push(structuredClone(args));
      if (mutations.length === 1) { state = 'after-arrival'; throw Object.assign(new Error('stateMismatch'), { confirmed: true }); }
      return { created: { compose: { id: 'saved' } } };
    }) };
    const persisted = vi.fn();
    const result = await saveComposeDraft<any>(client as any, 'account', createComposeOperation(draftReplacementArgs({ subject: 'Hello' }), 'hello', 'stale'), persisted);
    expect(result.result.created.compose.id).toBe('saved');
    expect(mutations.map(args => args.ifInState)).toEqual(['before-arrival', 'after-arrival']);
    expect(mutations[0].operationId).not.toBe(mutations[1].operationId);
    expect(mutations[0].create).toEqual(mutations[1].create);
    expect(persisted).toHaveBeenCalledTimes(2);
  });

  it('never rebases an existing draft replacement or an uncertain new-create replay', async () => {
    const conflict = Object.assign(new Error('stateMismatch'), { confirmed: true });
    const existing = createComposeOperation(draftReplacementArgs({ subject: 'Edit' }, 'old-draft'), 'edit', 'original');
    const call = vi.fn().mockRejectedValue(conflict);
    await expect(saveComposeDraft({ call }, 'account', existing, vi.fn())).rejects.toBe(conflict);
    expect(call).toHaveBeenCalledExactlyOnceWith('Email/set', existing.args, 'account');
    call.mockReset().mockResolvedValue({ created: { compose: { id: 'already-saved' } } });
    const recovered = createComposeOperation(draftReplacementArgs({ subject: 'Hello' }), 'hello', 'original');
    const persisted = vi.fn();
    await saveComposeDraft({ call }, 'account', recovered, persisted, true);
    expect(call).toHaveBeenCalledExactlyOnceWith('Email/set', recovered.args, 'account');
    expect(persisted).toHaveBeenCalledWith(recovered);
  });

  it('retains a lost new-create response unchanged and bounds busy-account retries', async () => {
    const lost = new TypeError('Response lost');
    const operation = createComposeOperation(draftReplacementArgs({ subject: 'Hello' }), 'hello', 'original');
    const call = vi.fn().mockRejectedValue(lost);
    await expect(saveComposeDraft({ call }, 'account', operation, vi.fn(), true)).rejects.toBe(lost);
    expect(call).toHaveBeenCalledTimes(1);
    call.mockReset().mockImplementation(async (method: string) => {
      if (method === 'Email/get') return { state: 'busy' };
      throw Object.assign(new Error('stateMismatch'), { confirmed: true });
    });
    await expect(saveComposeDraft({ call }, 'account', operation, vi.fn())).rejects.toThrow('stateMismatch');
    expect(call.mock.calls.map(([method]) => method)).toEqual(['Email/get', 'Email/set', 'Email/get', 'Email/set']);
  });

  it('refreshes an unchanged existing draft after unrelated account activity', async () => {
    const baseline = { id: 'draft', blobId: 'original-bytes', mailboxIds: { drafts: true, label: true }, keywords: { $draft: true, $seen: true } };
    const operation = createComposeOperation(draftReplacementArgs({ subject: 'Edited text' }, 'draft'), 'edit', 'old');
    const call = vi.fn(async (method: string, args: any) => {
      if (method === 'Email/get') { expect(args.ids).toEqual(['draft']); return { state: 'after-incoming-mail', list: [{ ...baseline, mailboxIds: { label: true, drafts: true }, keywords: { $seen: true, $draft: true } }] }; }
      expect(args.ifInState).toBe('after-incoming-mail');
      return { created: { compose: { id: 'replacement', blobId: 'new-bytes' } } };
    });
    const result = await saveComposeDraft<any>({ call } as any, 'account', operation, vi.fn(), false, baseline);
    expect(result.result.created.compose.id).toBe('replacement');
  });

  it.each(['body', 'metadata', 'sent', 'removed'])('preserves a real %s conflict even with a refreshed global cache', async kind => {
    const baseline = { id: 'draft', blobId: 'original-bytes', mailboxIds: { drafts: true }, keywords: { $draft: true } };
    const current = { ...baseline, ...(kind === 'body' ? { blobId: 'other-editor-bytes' } : kind === 'metadata' ? { mailboxIds: { archive: true } } : kind === 'sent' ? { keywords: {} } : {}) };
    const operation = createComposeOperation(draftReplacementArgs({ subject: 'My edits' }, 'draft'), 'edit', 'fresh-global-cache');
    const call = vi.fn(async () => ({ state: 'fresh-global-cache', list: kind === 'removed' ? [] : [current] }));
    const persist = vi.fn();
    await expect(saveComposeDraft({ call } as any, 'account', operation, persist, false, baseline)).rejects.toMatchObject({ confirmed: true, errorType: 'stateMismatch' });
    expect(call).toHaveBeenCalledExactlyOnceWith('Email/get', { ids: ['draft'] }, 'account');
    expect(persist).not.toHaveBeenCalled();
  });

  it('revalidates an existing draft before retrying a concurrent account change', async () => {
    const baseline = { id: 'draft', blobId: 'original-bytes', mailboxIds: { drafts: true }, keywords: { $draft: true } };
    let changed = false;
    const call = vi.fn(async (method: string) => {
      if (method === 'Email/get') return { state: changed ? 'newer' : 'current', list: [{ ...baseline, blobId: changed ? 'other-editor-bytes' : baseline.blobId }] };
      changed = true;
      throw Object.assign(new Error('stateMismatch'), { confirmed: true });
    });
    const operation = createComposeOperation(draftReplacementArgs({ subject: 'My edits' }, 'draft'), 'edit', 'old');
    await expect(saveComposeDraft({ call } as any, 'account', operation, vi.fn(), false, baseline)).rejects.toMatchObject({ errorType: 'stateMismatch' });
    expect(call.mock.calls.map(([method]) => method)).toEqual(['Email/get', 'Email/set', 'Email/get']);
  });

  it('replays an uncertain existing replacement exactly before inspecting a newer baseline', async () => {
    const baseline = { id: 'draft', blobId: 'old-bytes', mailboxIds: { drafts: true }, keywords: { $draft: true } };
    const operation = createComposeOperation(draftReplacementArgs({ subject: 'My edits' }, 'draft'), 'edit', 'original-fence');
    const call = vi.fn().mockResolvedValue({ created: { compose: { id: 'already-created', blobId: 'new-bytes' } } });
    const result = await saveComposeDraft<any>({ call }, 'account', operation, vi.fn(), true, baseline);
    expect(result.result.created.compose.id).toBe('already-created');
    expect(call).toHaveBeenCalledExactlyOnceWith('Email/set', operation.args, 'account');
    expect(result.operation.operationId).toBe(operation.operationId);
    expect(result.operation.args.ifInState).toBe('original-fence');
  });

  it('does not discard a newer draft even if a background read refreshed the shared account state', async () => {
    const baseline = { id: 'draft', blobId: 'my-version', mailboxIds: { drafts: true }, keywords: { $draft: true } };
    const call = vi.fn().mockResolvedValue({ state: 'fresh-account-state', list: [{ ...baseline, blobId: 'another-editors-version' }] });
    const persist = vi.fn();
    await expect(discardComposeDraft({ call }, 'account', baseline, persist)).rejects.toMatchObject({ confirmed: true, errorType: 'stateMismatch' });
    expect(call).toHaveBeenCalledExactlyOnceWith('Email/get', { ids: ['draft'] }, 'account');
    expect(persist).not.toHaveBeenCalled();
  });

  it('persists a discard before deleting and replays its exact receipt after a lost response and reload', async () => {
    const baseline = { id: 'draft', blobId: 'my-version', mailboxIds: { drafts: true }, keywords: { $draft: true } };
    let persisted: ReturnType<typeof createComposeOperation> | undefined;
    let commits = 0; let originalRequest: string | undefined;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const [method, args] = JSON.parse(options.body).methodCalls[0]; calls.push(method);
      if (method === 'Email/get') return Response.json({ methodResponses: [[method, { state: 'fence-before-discard', list: [baseline] }, 'ui']] });
      expect({ ...persisted?.args, accountId: 'account' }).toEqual(args);
      const exact = JSON.stringify(args);
      if (!originalRequest) { originalRequest = exact; commits++; throw new TypeError('Response lost after delete'); }
      expect(exact).toBe(originalRequest);
      return Response.json({ methodResponses: [[method, { destroyed: ['draft'], newState: 'after-delete' }, 'ui']] });
    }));
    const original = new MailClient(); original.session = session;
    await expect(discardComposeDraft(original, 'account', baseline, next => { persisted = next; })).rejects.toThrow('Response lost');
    const recovered = JSON.parse(JSON.stringify(persisted));
    const reloaded = new MailClient(); reloaded.session = session; reloaded.states.set('account:Email', 'newer-after-reload');
    await discardComposeDraft(reloaded, 'account', undefined, next => { persisted = next; }, recovered);
    expect(calls).toEqual(['Email/get', 'Email/set', 'Email/set']); expect(commits).toBe(1);
    expect(persisted!.args.ifInState).toBe('fence-before-discard');
  });

  it('keeps an unconfirmed discard request instead of assuming a missing destruction receipt means success', async () => {
    const baseline = { id: 'draft', blobId: 'my-version', mailboxIds: { drafts: true }, keywords: { $draft: true } };
    const pending = createComposeOperation({ destroy: ['draft'] }, 'discard:draft', 'original');
    const call = vi.fn().mockResolvedValue({}); const persist = vi.fn();
    await expect(discardComposeDraft({ call }, 'account', baseline, persist, pending)).rejects.toThrow('Discarding is unconfirmed');
    expect(persist).toHaveBeenCalledWith(pending);
    expect(call).toHaveBeenCalledExactlyOnceWith('Email/set', pending.args, 'account');
  });
});

it('handles RFC nullable recipients on saved drafts and replies without an identity',()=>{
 expect(chooseSendingIdentity([], {from:null})).toBeUndefined();
 expect(chooseSendingIdentity([],undefined,{to:null,cc:null})).toBeUndefined();
 expect(chooseSendingIdentity([{id:'a',email:'a@example.com'}],{from:null})).toBeUndefined();
 expect(chooseSendingIdentity([{id:'a',email:'a@example.com'}],undefined,{to:null,cc:null,headers:[{name:'Delivered-To',value:'a@example.com'}]})).toBeUndefined();
});

it('only clears a non-dispatched submission on its first attempt, preserving uncertain replays', () => {
  const failure = Object.assign(new Error('Authorization unavailable'), { confirmed: false, submissionNotDispatched: true });
  expect(isConfirmedSubmissionRejection(failure, true)).toBe(true);
  expect(isConfirmedSubmissionRejection(failure, false)).toBe(false);
  expect(isConfirmedSubmissionRejection(new TypeError('Lost response'), true)).toBe(false);
});


describe('Catch-all sender selection and recovery', () => {
  const identities = [{ id: 'main', email: 'main@example.test' }];
  it('keeps the exact trusted recipient even before a catch-all identity exists', () => {
    const reply = { to: [{ email: 'main@example.test' }], deliveryRecipient: 'orders@example.test' };
    expect(chooseSendingAddress(identities, undefined, reply)).toBe('orders@example.test');
    expect(chooseSendingIdentity(identities, undefined, reply)).toBeUndefined();
  });
  it('ignores forged delivery headers and requires an unambiguous historical local recipient', () => {
    expect(chooseSendingAddress(identities, undefined, { to: null, headers: [{ name: 'X-Original-To', value: 'forged@example.test' }] }, ['example.test'])).toBe('');
    expect(chooseSendingAddress(identities, undefined, { to: [{ email: 'orders@example.test' }, { email: 'external@elsewhere.test' }] }, ['example.test'])).toBe('orders@example.test');
    expect(chooseSendingAddress(identities, undefined, { to: [{ email: 'orders@example.test' }], cc: [{ email: 'team@example.test' }] }, ['example.test'])).toBe('');
  });
  it('keeps raw saved sender text and never substitutes the reply recipient for a draft', () => {
    const reply = { to: null, deliveryRecipient: 'orders@example.test' };
    expect(chooseSendingAddress(identities, { from: [{ email: 'saved@example.test' }] }, reply)).toBe('saved@example.test');
    expect(chooseSendingAddress(identities, { from: null, draftFrom: 'unfinished@' }, reply)).toBe('unfinished@');
    expect(chooseSendingAddress(identities, { from: [{ email: 'saved@example.test' }], draftFrom: '' }, reply)).toBe('');
  });
  it('replays the same sender reservation after a lost result without issuing another create', async () => {
    let pending: ReturnType<typeof createComposeOperation> | undefined;
    const original = vi.fn(async (method: string) => {
      if (method === 'Identity/get') return { state: 'identity-state' };
      throw new TypeError('Connection lost after reservation');
    });
    await expect(resolveComposeIdentity({ call: original } as any, 'account', 'orders@example.test', operation => { pending = operation; })).rejects.toThrow('Connection lost');
    const recovered = JSON.parse(JSON.stringify(pending));
    const replay = vi.fn(async () => ({ identity: { id: 'reserved', email: 'orders@example.test' } }));
    expect(await resolveComposeIdentity({ call: replay } as any, 'account', 'orders@example.test', operation => { pending = operation; }, recovered)).toEqual({ id: 'reserved', email: 'orders@example.test' });
    expect(replay).toHaveBeenCalledExactlyOnceWith('Identity/resolve', recovered.args, 'account');
    expect(pending).toBeUndefined();
  });
  it('rechecks the revision after one confirmed race but preserves ownership rejections', async () => {
    let reads = 0, attempts = 0;
    const call = vi.fn(async (method: string) => {
      if (method === 'Identity/get') return { state: 'state-' + ++reads };
      if (++attempts === 1) throw Object.assign(new Error('stateMismatch'), { confirmed: true, errorType: 'stateMismatch' });
      throw Object.assign(new Error('This address belongs to another inbox.'), { confirmed: true, errorType: 'forbidden' });
    });
    let pending: unknown;
    await expect(resolveComposeIdentity({ call } as any, 'account', 'reserved@example.test', operation => { pending = operation; })).rejects.toThrow('another inbox');
    expect(call.mock.calls.map(([method]) => method)).toEqual(['Identity/get', 'Identity/resolve', 'Identity/get', 'Identity/resolve']);
    expect(pending).toBeUndefined();
  });
});
