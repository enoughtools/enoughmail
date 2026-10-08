import { afterEach, describe, expect, it, vi } from 'vitest';
import { listDraftRecoveries } from '../apps/mail/src/ui/compose-recovery';
import { draftCacheKey, type MailSession } from '../apps/mail/src/ui/jmap';
const actor = (username: string) => ({ username, actorId: username, organizationId: 'org', workspaceId: 'workspace' } as MailSession);
const draft = (subject: string, updatedAt: string) => ({ fields: { subject, body: 'Private message body', attachments: [] }, updatedAt });
describe('Draft recovery chooser', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('shows only actor/account scoped metadata and permits pending send recovery selection', () => {
    const storage = new Map<string, string>();
    storage.set(draftCacheKey(actor('alice'), 'a'), JSON.stringify({
      older: { ...draft('Earlier', '2026-10-05T12:00:00Z'), emailId: 'old-email' },
      pending: { ...draft('Pending confirmation', '2026-10-05T13:00:00Z'), pendingSubmission: { operationId: 'secret-operation', args: { privateBody: 'hidden' } } },
      'older:conflict-backup': draft('Previous local edits', '2026-10-05T14:00:00Z'),
      corrupt: { fields: { subject: 'Missing body and attachments' } },
    }));
    storage.set(draftCacheKey(actor('bob'), 'a'), JSON.stringify({ wrongActor: draft('Bob draft', '2026-10-05T14:00:00Z') }));
    storage.set(draftCacheKey(actor('alice'), 'b'), JSON.stringify({ wrongAccount: draft('Other mailbox', '2026-10-05T14:00:00Z') }));
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null });
    expect(listDraftRecoveries(actor('alice'), 'a')).toEqual([
      { id: 'pending', subject: 'Pending confirmation', updatedAt: '2026-10-05T13:00:00Z', pendingSend: true },
      { id: 'older', subject: 'Earlier', updatedAt: '2026-10-05T12:00:00Z', emailId: 'old-email', pendingSend: false },
    ]);
    expect(JSON.stringify(listDraftRecoveries(actor('alice'), 'a'))).not.toContain('Private message body');
    expect(JSON.stringify(listDraftRecoveries(actor('alice'), 'a'))).not.toContain('secret-operation');
  });
  it('tolerates unavailable or malformed browser storage without losing server access', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'not-json' });
    expect(listDraftRecoveries(actor('alice'), 'a')).toEqual([]);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage disabled'); } });
    expect(listDraftRecoveries(actor('alice'), 'a')).toEqual([]);
  });
});
