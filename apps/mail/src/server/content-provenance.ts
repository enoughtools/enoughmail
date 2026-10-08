import type { MailSqlStorage } from './store';

/** Private authority evidence; none of these records are projected as JMAP Email properties. */
export const MAIL_CONTENT_PROVENANCE_TABLES = ['mail_content_sources', 'mail_prepared_email'] as const;

const identifier = (value: string, label: string) => {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`invalidArguments: Invalid ${label}`);
};

/** Read authority admits use of existing content; upload ownership requires an explicit immutable source receipt. */
export class MailContentProvenance {
  constructor(private readonly storage: MailSqlStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_content_sources (blob_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_prepared_email (email_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,blob_id TEXT NOT NULL)');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_prepared_blob ON mail_prepared_email(blob_id,email_id)');
  }

  assertSource(blobId: string, actorId: string, hasRead: boolean): void {
    identifier(blobId, 'blob ID'); identifier(actorId, 'actor ID');
    if (typeof hasRead !== 'boolean') throw new Error('invalidArguments: Invalid read authority');
    const source = [...this.storage.sql.exec<{actor_id:string}>('SELECT actor_id FROM mail_content_sources WHERE blob_id=?',blobId)][0];
    if (!hasRead && source?.actor_id !== actorId) throw new Error('forbidden: Content source requires current read authority or upload ownership');
  }

  /** Account calls this only after it has accepted a new uploaded/derived immutable R2 object. */
  recordSource(blobId: string, actorId: string): void {
    identifier(blobId, 'blob ID'); identifier(actorId, 'actor ID');
    this.storage.transactionSync(() => {
      const source = [...this.storage.sql.exec<{actor_id:string}>('SELECT actor_id FROM mail_content_sources WHERE blob_id=?',blobId)][0];
      if (source && source.actor_id !== actorId) throw new Error('forbidden: Immutable content source belongs to another actor');
      if (!source) this.storage.sql.exec('INSERT INTO mail_content_sources(blob_id,actor_id) VALUES(?,?)',blobId,actorId);
    });
  }

  /** Bind only after every transitive source has been admitted by the account's current authority. */
  recordPrepared(emailId: string, actorId: string, blobId: string): void {
    identifier(emailId, 'email ID'); identifier(actorId, 'actor ID'); identifier(blobId, 'blob ID');
    this.storage.sql.exec('INSERT INTO mail_prepared_email(email_id,actor_id,blob_id) VALUES(?,?,?) ON CONFLICT(email_id) DO UPDATE SET actor_id=excluded.actor_id,blob_id=excluded.blob_id',emailId,actorId,blobId);
  }

  prepared(emailId: string, actorId: string, blobId: string): boolean {
    identifier(emailId, 'email ID'); identifier(actorId, 'actor ID'); identifier(blobId, 'blob ID');
    return [...this.storage.sql.exec('SELECT 1 FROM mail_prepared_email WHERE email_id=? AND actor_id=? AND blob_id=?',emailId,actorId,blobId)].length > 0;
  }

  invalidate(emailId: string): void {
    identifier(emailId, 'email ID');
    this.storage.sql.exec('DELETE FROM mail_prepared_email WHERE email_id=?',emailId);
  }

  forgetBlob(blobId: string): void {
    identifier(blobId, 'blob ID');
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM mail_prepared_email WHERE blob_id=?',blobId);
      this.storage.sql.exec('DELETE FROM mail_content_sources WHERE blob_id=?',blobId);
    });
  }
}
