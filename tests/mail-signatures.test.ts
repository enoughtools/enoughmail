import { describe, expect, it } from 'vitest';
import { validateSignatures, validateSignatureReference, validateSignatureRemoval } from '../apps/mail/src/domain/signatures';
import { validateWritable } from '../apps/mail/src/domain/validation';
const signature = { id: 'work', name: 'Work', text: 'Russell\nEnough', html: '<table><tr><td><strong>Russell</strong><br><a href="https://example.com">Enough</a></td></tr></table>' };
describe('Mail reusable signatures', () => {
  it('retains named HTML and plain-text alternatives without interpreting content', () => { expect(validateSignatures([signature])).toEqual([signature]); });
  it('rejects duplicate IDs, oversized libraries, unsafe IDs and unknown schema fields', () => {
    for (const value of [[signature, signature], [{ ...signature, id: '__proto__' }], [{ ...signature, name: '' }], [{ ...signature, other: true }], [{ ...signature, html: 'x'.repeat(200001) }], Array.from({ length: 101 }, (_,id) => ({ ...signature, id: String(id) }))]) expect(() => validateSignatures(value)).toThrow();
  });
  it('binds defaults to this inbox and prevents deleting a referenced default', () => {
    expect(() => validateSignatureReference('work', [signature])).not.toThrow(); expect(() => validateSignatureReference(null, [])).not.toThrow();
    expect(() => validateSignatureReference('foreign', [signature])).toThrow('this inbox');
    expect(() => validateSignatureRemoval([], [{ id: 'identity', signatureId: 'work' }])).toThrow();
    expect(() => validateSignatureRemoval([], [{ id: 'legacy' }])).not.toThrow();
  });
  it('requires current management authority for signature defaults and library updates', () => {
    expect(() => validateWritable('Identity', { signatureId: 'work' }, 'update', ['mail.read'])).toThrow('mail.manage');
    expect(() => validateWritable('Settings', { signatures: [signature] }, 'update', ['mail.read'])).toThrow('mail.manage');
    expect(() => validateWritable('Identity', { signatureId: null }, 'update', ['mail.manage'])).not.toThrow();
  });
});

import { DatabaseSync } from 'node:sqlite';
import { MailAccount } from '../apps/mail/src/server/account';
it('enforces signature references through actual persisted account commands and receipts', async () => {
  const db = new DatabaseSync(':memory:');
  const storage = { sql: { exec<T>(sql: string, ...bindings: unknown[]): Iterable<T> { const statement = db.prepare(sql); return (statement.columns().length ? statement.all(...bindings as any[]) : [statement.run(...bindings as any[])]) as T[]; } }, transactionSync<T>(task: () => T): T { db.exec('SAVEPOINT test'); try { const result = task(); db.exec('RELEASE test'); return result; } catch (error) { db.exec('ROLLBACK TO test; RELEASE test'); throw error; } }, async setAlarm() {}, async deleteAlarm() {} };
  const account = new MailAccount({ storage }, { MAIL_BLOBS: { async put() {}, async get() { return null; }, async delete() {} } });
  const call = async (name: string, args: Record<string, unknown> = {}, actions = ['mail.read', 'mail.manage']) => {
    const result = await account.fetch(new Request('https://account/jmap', { method: 'POST', body: JSON.stringify({ accountId: 'account', organizationId: 'org', workspaceId: 'workspace', actor: { id: 'owner', actions, workspaceRole: 'owner' }, request: { using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: [[name, { accountId: 'account', ...args }, 'call']] } }) }));
    return (await result.json() as any).methodResponses[0][1];
  };
  try {
    const initial = await call('Settings/get');
    const command = { settings: { signatures: [signature] }, ifInState: initial.state, operationId: crypto.randomUUID() };
    const saved = await call('Settings/set', command); expect(saved.type).toBeUndefined();
    expect((await call('Settings/set', command)).newState).toBe(saved.newState);
    const created = await call('Identity/set', { create: { sender: { email: 'me@example.com', signatureId: 'work' } }, ifInState: saved.newState, operationId: crypto.randomUUID() });
    const id = created.created.sender.id; expect(created.created.sender.signatureId).toBe('work');
    const rejected = await call('Settings/set', { settings: { signatures: [] }, ifInState: created.newState, operationId: crypto.randomUUID() }); expect(rejected.type).toBeDefined();
    expect((await call('Settings/get')).settings.signatures).toEqual([signature]);
    const cleared = await call('Identity/set', { update: { [id]: { signatureId: null } }, ifInState: created.newState, operationId: crypto.randomUUID() });
    const removed = await call('Settings/set', { settings: { signatures: [] }, ifInState: cleared.newState, operationId: crypto.randomUUID() }); expect(removed.type).toBeUndefined();
    const foreign = await call('Identity/set', { update: { [id]: { signatureId: 'work' } }, ifInState: removed.newState, operationId: crypto.randomUUID() }); expect(foreign.notUpdated[id]).toBeDefined();
    const denied = await call('Settings/set', { settings: { signatures: [signature] }, ifInState: removed.newState, operationId: crypto.randomUUID() }, ['mail.read']); expect(denied.type).toBe('forbidden');
  } finally { db.close(); }
});
