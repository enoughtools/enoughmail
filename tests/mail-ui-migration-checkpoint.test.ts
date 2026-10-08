import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { clearImportCheckpoint, fileFingerprint, importCheckpointKey, readImportCheckpoint, saveImportCheckpoint, type ImportCheckpoint } from '../apps/mail/src/ui/migration-checkpoint';
const identity = { actorId: 'actor', organizationId: 'org', workspaceId: 'space' };
const value: ImportCheckpoint = { version: 1, fingerprint: 'a'.repeat(64), size: 20, name: 'source.mbox', mailboxId: 'inbox', total: 2, position: 1, operationIds: ['first', 'second'], pendingBlobId: 'blob', pendingArgs: { operationId: 'second', ifInState: '6', emails: { message: { blobId: 'blob', mailboxIds: { inbox: true }, keywords: { '$seen': true }, receivedAt: '2024-01-01T00:00:00Z' } } } };
describe('import durable checkpoints', () => {
  const storage = new Map<string, string>();
  beforeEach(() => { storage.clear(); vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, data: string) => storage.set(key, data), removeItem: (key: string) => storage.delete(key) }); });
  afterEach(() => vi.unstubAllGlobals());
  it('isolates actor, organization, workspace and account identities', () => {
    const key = importCheckpointKey(identity, 'account');
    for (const session of [{ ...identity, actorId: 'other' }, { ...identity, organizationId: 'other' }, { ...identity, workspaceId: 'other' }]) expect(importCheckpointKey(session, 'account')).not.toBe(key);
    expect(importCheckpointKey(identity, 'other')).not.toBe(key);
    expect(() => importCheckpointKey({ ...identity, actorId: '' }, 'account')).toThrow(/identity/);
  });
  it('restores exact uncertain operation and progress across reload without MIME bytes', () => {
    const key = importCheckpointKey(identity, 'account');
    saveImportCheckpoint(key, { ...value, messages: ['PRIVATE MESSAGE BODY'], bytes: new Uint8Array([1, 2]), pendingArgs: { ...value.pendingArgs, textBody: 'PRIVATE MESSAGE BODY' } } as ImportCheckpoint);
    expect(storage.get(key)).not.toContain('PRIVATE MESSAGE BODY');
    expect(readImportCheckpoint(key)).toEqual(value);
    clearImportCheckpoint(key); expect(readImportCheckpoint(key)).toBeNull();
  });
  it('detects changed source content and refuses oversized checkpoints', async () => {
    expect(await fileFingerprint(new Uint8Array([1, 2]))).not.toBe(await fileFingerprint(new Uint8Array([1, 3])));
    const key = importCheckpointKey(identity, 'account');
    storage.set(key, 'x'.repeat(1_000_001)); expect(() => readImportCheckpoint(key)).toThrow(/too large/);
    storage.set(key, JSON.stringify({ ...value, position: 3 })); expect(() => readImportCheckpoint(key)).toThrow(/invalid/);
  });
});
