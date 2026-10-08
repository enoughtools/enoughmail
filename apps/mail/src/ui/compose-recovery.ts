import { draftCacheKey, type MailSession } from './jmap';
export interface DraftRecoverySummary { id: string; subject: string; updatedAt?: string; pendingSend?: boolean; emailId?: string; }
/** Return only chooser metadata from the current actor/account's local draft store. */
export function listDraftRecoveries(session: MailSession, accountId: string): DraftRecoverySummary[] {
  try {
    const entries = JSON.parse(localStorage.getItem(draftCacheKey(session, accountId)) || '{}');
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return [];
    return Object.entries(entries).flatMap(([id, value]) => {
      if (id.endsWith(':conflict-backup') || !value || typeof value !== 'object') return [];
      const entry = value as { fields?: { subject?: unknown; body?: unknown; attachments?: unknown }; emailId?: unknown; updatedAt?: unknown; pendingSubmission?: unknown };
      if (typeof entry.fields?.body !== 'string' || typeof entry.fields.subject !== 'string' || !Array.isArray(entry.fields.attachments)) return [];
      return [{ id, subject: entry.fields.subject, ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}), ...(typeof entry.emailId === 'string' ? { emailId: entry.emailId } : {}), pendingSend: !!entry.pendingSubmission }];
    }).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  } catch { return []; }
}
