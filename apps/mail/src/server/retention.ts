import type { MailActor, MailObject } from '../domain/model';
import type { MailSqlStorage } from './store';

const DAY = 86_400_000;
export interface RetentionSettings { trashRetentionDays?: number; junkRetentionDays?: number }
/** Membership is checked as well as the timestamp: restoring mail cancels its purge. */
export function planRetention(emails: MailObject[], settings: RetentionSettings = {}, now = Date.now()): { expiredIds: string[]; nextDeadline: number | null } {
  if (!Number.isFinite(now)) throw new Error('Invalid retention time');
  const days = (value: number | undefined) => { const n = value ?? 30; if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error('Invalid retention days'); return n; };
  const trash = days(settings.trashRetentionDays), junk = days(settings.junkRetentionDays);
  const expiredIds: string[] = []; let nextDeadline: number | null = null;
  for (const email of emails) {
    const deadlines = [['folder-trash', 'trashAt', trash], ['folder-junk', 'junkAt', junk]].flatMap(([folder, field, duration]) => {
      if (!email.mailboxIds?.[String(folder)] || typeof email[String(field)] !== 'string') return [];
      const at = Date.parse(email[String(field)]); return Number.isFinite(at) ? [at + Number(duration) * DAY] : [];
    });
    if (!deadlines.length) continue;
    const deadline = Math.min(...deadlines);
    if (deadline <= now) expiredIds.push(email.id); else nextDeadline = nextDeadline === null ? deadline : Math.min(nextDeadline, deadline);
  }
  return { expiredIds, nextDeadline };
}
export type BlobKind = 'raw' | 'attachment' | 'body' | 'upload';
export interface MailQuota { id: string; used: number; reserved: number; blobCount: number; hardLimit: number | null; scope: 'account'; resourceType: 'octets'; name: string }
/** One registry row per physical account R2 key; repeated Email/import references do not double count. */
export class MailQuotaManager {
  constructor(private readonly storage: MailSqlStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_blob_registry (id TEXT PRIMARY KEY,size INTEGER NOT NULL CHECK(size>=0),kind TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN (\'reserved\',\'committed\')),created_at INTEGER NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_quota (id INTEGER PRIMARY KEY CHECK(id=1),hard_limit INTEGER)');
    storage.sql.exec('INSERT OR IGNORE INTO mail_quota(id,hard_limit) VALUES(1,NULL)');
  }
  get(): MailQuota {
    const row = [...this.storage.sql.exec<{ used: number; reserved: number; blobCount: number }>("SELECT COALESCE(sum(CASE WHEN status='committed' THEN size ELSE 0 END),0) AS used,COALESCE(sum(CASE WHEN status='reserved' THEN size ELSE 0 END),0) AS reserved,count(*) AS blobCount FROM mail_blob_registry")][0];
    const limit = [...this.storage.sql.exec<{ hard_limit: number | null }>('SELECT hard_limit FROM mail_quota WHERE id=1')][0];
    return { id: 'storage', used: Number(row.used), reserved: Number(row.reserved), blobCount: Number(row.blobCount), hardLimit: limit.hard_limit, scope: 'account', resourceType: 'octets', name: 'Mail storage' };
  }
  set(hardLimit: number | null, actor: MailActor): MailQuota {
    if (!actor.actions.includes('mail.manage')) throw new Error('forbidden: mail.manage required');
    if (hardLimit !== null && (!Number.isSafeInteger(hardLimit) || hardLimit < 1)) throw new Error('invalidArguments: Invalid storage limit');
    this.storage.sql.exec('UPDATE mail_quota SET hard_limit=? WHERE id=1', hardLimit); return this.get();
  }
  reserveBlob(id: string, size: number, kind: BlobKind, now = Date.now()): boolean {
    if (!/^[\w.-]{1,200}$/.test(id) || !Number.isSafeInteger(size) || size < 0 || !['raw','attachment','body','upload'].includes(kind) || !Number.isFinite(now)) throw new Error('invalidArguments: Invalid blob reservation');
    return this.storage.transactionSync(() => {
      const previous = [...this.storage.sql.exec<{ size: number; kind: string }>('SELECT size,kind FROM mail_blob_registry WHERE id=?', id)][0];
      if (previous) { if (previous.size !== size || previous.kind !== kind) throw new Error('invalidArguments: Blob identity reused'); return false; }
      const quota = this.get();
      if (quota.hardLimit !== null && size > Math.max(0, quota.hardLimit - quota.used - quota.reserved)) throw new Error('overQuota: Account storage limit reached');
      this.storage.sql.exec("INSERT INTO mail_blob_registry(id,size,kind,status,created_at) VALUES(?,?,?,'reserved',?)", id, size, kind, now); return true;
    });
  }
  /** Migration only: account authority has already verified this existing physical R2 object. */
  reconcileBlob(id: string, size: number, kind: BlobKind, now = Date.now()): void {
    if (!/^[\w.-]{1,200}$/.test(id) || !Number.isSafeInteger(size) || size < 0 || !['raw','attachment','body','upload'].includes(kind) || !Number.isFinite(now)) throw new Error('invalidArguments: Invalid existing blob');
    this.storage.transactionSync(() => {
      const previous = [...this.storage.sql.exec<{size:number}>('SELECT size FROM mail_blob_registry WHERE id=?',id)][0];
      if (previous && previous.size !== size) throw new Error('invalidArguments: Existing blob size changed');
      if (!previous) this.storage.sql.exec("INSERT INTO mail_blob_registry(id,size,kind,status,created_at) VALUES(?,?,?,'committed',?)",id,size,kind,now);
      else this.commitBlob(id);
    });
  }
  commitBlob(id: string): void {
    if (![...this.storage.sql.exec('SELECT id FROM mail_blob_registry WHERE id=?', id)].length) throw new Error('notFound: Blob reservation missing');
    this.storage.sql.exec("UPDATE mail_blob_registry SET status='committed' WHERE id=?", id);
  }
  /** Rollback only reservations: an existing committed blob must never be released on a retried upload. */
  rollbackBlob(id: string): void { this.storage.sql.exec("DELETE FROM mail_blob_registry WHERE id=? AND status='reserved'", id); }
  forgetBlob(id: string): void { this.storage.sql.exec('DELETE FROM mail_blob_registry WHERE id=?', id); }
  listBlobs(limit = 100): string[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid purge batch');
    return [...this.storage.sql.exec<{ id: string }>('SELECT id FROM mail_blob_registry ORDER BY id LIMIT ?', limit)].map(row => row.id);
  }
}
export type AccountStatus = 'active' | 'suspended' | 'deletionRequested' | 'purging' | 'deleted';
export interface AccountLifecycleState { status: AccountStatus; revision: number; purgeAfter: number | null }
export class MailAccountLifecycle {
  constructor(private readonly storage: MailSqlStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_lifecycle (id INTEGER PRIMARY KEY CHECK(id=1),status TEXT NOT NULL,revision INTEGER NOT NULL,purge_after INTEGER)');
    storage.sql.exec("INSERT OR IGNORE INTO mail_lifecycle VALUES(1,'active',0,NULL)");
    storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_lifecycle_receipts (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_lifecycle_history (revision INTEGER PRIMARY KEY,actor_id TEXT NOT NULL,command TEXT NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL)');
  }
  get(): AccountLifecycleState {
    const row = [...this.storage.sql.exec<{status:AccountStatus;revision:number;purge_after:number|null}>('SELECT status,revision,purge_after FROM mail_lifecycle WHERE id=1')][0];
    return {status:row.status,revision:row.revision,purgeAfter:row.purge_after};
  }
  command(input: { id: string; expectedRevision: number; action: 'suspend' | 'resume' | 'requestDeletion' | 'cancelDeletion'; actor: MailActor; now?: number }): AccountLifecycleState {
    if (!input.actor.actions.includes('mail.manage')) throw new Error('forbidden: mail.manage required');
    if (!input.id || input.id.length > 200 || !Number.isSafeInteger(input.expectedRevision)) throw new Error('invalidArguments: Invalid lifecycle command');
    const now = input.now ?? Date.now(); if (!Number.isFinite(now)) throw new Error('Invalid lifecycle time');
    const fingerprint = JSON.stringify([input.actor.id,input.action,input.expectedRevision]);
    return this.storage.transactionSync(() => {
      const receipt = [...this.storage.sql.exec<{fingerprint:string;response:string}>('SELECT fingerprint,response FROM mail_lifecycle_receipts WHERE id=?',input.id)][0];
      if (receipt) { if (receipt.fingerprint !== fingerprint) throw new Error('invalidArguments: Lifecycle command ID reused'); return JSON.parse(receipt.response); }
      const current = this.get();
      if (current.revision !== input.expectedRevision) throw new Error('revisionConflict: Account lifecycle changed');
      const allowed = { suspend:['active'], resume:['suspended'], requestDeletion:['active','suspended'], cancelDeletion:['deletionRequested'] };
      if (!Object.hasOwn(allowed,input.action) || !allowed[input.action].includes(current.status) || (input.action === 'cancelDeletion' && current.purgeAfter !== null && now >= current.purgeAfter)) throw new Error('invalidArguments: Invalid lifecycle transition');
      const status: AccountStatus = input.action === 'suspend' ? 'suspended' : input.action === 'requestDeletion' ? 'deletionRequested' : 'active';
      const result = {status,revision:current.revision+1,purgeAfter:status === 'deletionRequested' ? now+30*DAY : null};
      this.storage.sql.exec('UPDATE mail_lifecycle SET status=?,revision=?,purge_after=? WHERE id=1',result.status,result.revision,result.purgeAfter);
      this.storage.sql.exec('INSERT INTO mail_lifecycle_history VALUES(?,?,?,?,?)',result.revision,input.actor.id,input.action,now,status);
      this.storage.sql.exec('INSERT INTO mail_lifecycle_receipts VALUES(?,?,?)',input.id,fingerprint,JSON.stringify(result)); return result;
    });
  }
  assertActive(): void { if (this.get().status !== 'active') throw new Error('accountNotFound: Mail account is disabled'); }
  /** R2 deletion precedes registry removal so interruption can safely retry the same bounded batch. */
  async purgeBatch(quota: MailQuotaManager, deleteBlob: (id: string) => Promise<void>, now = Date.now()): Promise<{ done: boolean; deleted: number }> {
    const state = this.get();
    if (state.status === 'deleted') return {done:true,deleted:0};
    if (!['deletionRequested','purging'].includes(state.status) || state.purgeAfter === null || state.purgeAfter > now) throw new Error('forbidden: Account purge is not due');
    if (state.status !== 'purging') this.storage.transactionSync(() => { const revision=state.revision+1;this.storage.sql.exec("UPDATE mail_lifecycle SET status='purging',revision=? WHERE id=1",revision);this.storage.sql.exec('INSERT INTO mail_lifecycle_history VALUES(?,?,?,?,?)',revision,'system','purgeStarted',now,'purging'); });
    const ids = quota.listBlobs(); let deleted = 0;
    for (const id of ids) { await deleteBlob(id); quota.forgetBlob(id); deleted++; }
    const done = quota.listBlobs(1).length === 0;
    // Metadata/content purge and final lifecycle transition are finalized by the account command,
    // after all R2 keys (including unregistered legacy keys) have also been enumerated.
    return {done,deleted};
  }
  finishPurge(now = Date.now()): void {
    const state = this.get(); if (state.status !== 'purging') throw new Error('Invalid purge finalization');
    if ([...this.storage.sql.exec('SELECT id FROM mail_blob_registry LIMIT 1')].length) throw new Error('Invalid purge finalization: Physical blobs remain');
    this.storage.transactionSync(() => { const revision=state.revision+1;this.storage.sql.exec("UPDATE mail_lifecycle SET status='deleted',revision=? WHERE id=1",revision);this.storage.sql.exec('INSERT INTO mail_lifecycle_history VALUES(?,?,?,?,?)',revision,'system','purgeCompleted',now,'deleted'); });
  }
}
