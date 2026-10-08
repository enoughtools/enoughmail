import type { MailSession } from './jmap';
export interface ImportCheckpoint {
  version: 1; fingerprint: string; size: number; name: string; mailboxId: string; total: number; position: number;
  restoreLabels?: boolean; duplicatePolicy?: 'skipIdentical' | 'keep'; skipped?: number;
  labelMap?: Record<string, string>; labelOperations?: Record<string, string>; pendingLabel?: { sourceId: string; args: Record<string, unknown> };
  operationIds: string[]; pendingBlobId?: string; pendingArgs?: Record<string, unknown>;
}
const PREFIX = 'enough-mail:import:v1:';
const MAX_BYTES = 1_000_000;
export function importCheckpointKey(session: Pick<MailSession, 'actorId' | 'organizationId' | 'workspaceId'>, accountId: string): string {
  if (![session.actorId, session.organizationId, session.workspaceId, accountId].every(value => typeof value === 'string' && value.length)) throw new Error('Verified identity is required to resume imports.');
  return PREFIX + encodeURIComponent(JSON.stringify([session.organizationId, session.workspaceId, session.actorId, accountId]));
}
export async function fileFingerprint(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function readImportCheckpoint(key: string): ImportCheckpoint | null {
  const text = localStorage.getItem(key); if (!text) return null;
  if (text.length > MAX_BYTES) throw new Error('The saved import checkpoint is too large. Cancel it before starting another import.');
  let value: ImportCheckpoint;
  try { value = JSON.parse(text); } catch { throw new Error('The saved import checkpoint is invalid. Cancel it before starting another import.'); }
  if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.fingerprint) || !Number.isInteger(value.total) || value.total < 1 || value.total > 10000 || !Number.isInteger(value.position) || value.position < 0 || value.position > value.total || !Array.isArray(value.operationIds) || value.operationIds.length !== value.total || value.operationIds.some(id => typeof id !== 'string' || id.length > 100) || typeof value.mailboxId !== 'string' || typeof value.name !== 'string' || !Number.isFinite(value.size)) throw new Error('The saved import checkpoint is invalid. Cancel it before starting another import.');
  if (value.pendingArgs) {
    const message = (value.pendingArgs.emails as { message?: Record<string, unknown> } | undefined)?.message;
    if (value.position >= value.total || value.pendingArgs.operationId !== value.operationIds[value.position] || !message || message.blobId !== value.pendingBlobId || !value.pendingBlobId || typeof message.mailboxIds !== 'object' || !message.mailboxIds || typeof message.keywords !== 'object' || !message.keywords) throw new Error('The pending import checkpoint is invalid. Cancel it before starting another import.');
  }
  return value;
}
/** Explicit whitelist: a checkpoint never contains the source file or MIME content. */
export function saveImportCheckpoint(key: string, value: ImportCheckpoint): void {
  const pending = value.pendingArgs;
  const input = (pending?.emails as { message?: Record<string, unknown> } | undefined)?.message;
  const pendingArgs = pending && input ? { operationId: pending.operationId, ...(pending.duplicatePolicy ? { duplicatePolicy: pending.duplicatePolicy } : {}), ...(pending.ifInState ? { ifInState: pending.ifInState } : {}), emails: { message: { blobId: input.blobId, mailboxIds: input.mailboxIds, keywords: input.keywords, ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}) } } } : undefined;
  const encoded = JSON.stringify({ version: 1, fingerprint: value.fingerprint, size: value.size, name: value.name, mailboxId: value.mailboxId, total: value.total, position: value.position, operationIds: value.operationIds, ...(value.restoreLabels !== undefined ? { restoreLabels: value.restoreLabels } : {}), ...(value.duplicatePolicy ? { duplicatePolicy: value.duplicatePolicy } : {}), ...(value.skipped ? { skipped: value.skipped } : {}), ...(value.labelMap ? { labelMap: value.labelMap } : {}), ...(value.labelOperations ? { labelOperations: value.labelOperations } : {}), ...(value.pendingLabel ? { pendingLabel: value.pendingLabel } : {}), ...(value.pendingBlobId ? { pendingBlobId: value.pendingBlobId } : {}), ...(pendingArgs ? { pendingArgs } : {}) });
  if (encoded.length > MAX_BYTES) throw new Error('The import checkpoint exceeds the browser storage limit. Split this archive first.');
  try { localStorage.setItem(key, encoded); } catch { throw new Error('Browser storage is unavailable. Enable it before importing so progress can survive a reload.'); }
}
export function clearImportCheckpoint(key: string): void { localStorage.removeItem(key); }
