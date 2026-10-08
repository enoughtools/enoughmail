import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MailContentProvenance, MAIL_CONTENT_PROVENANCE_TABLES } from '../apps/mail/src/server/content-provenance';
import type { MailSqlStorage } from '../apps/mail/src/server/store';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture() {
  const database = new DatabaseSync(':memory:'); databases.push(database); let counter = 0;
  const storage: MailSqlStorage = {
    sql: { exec<T>(sql: string, ...bindings: unknown[]): Iterable<T> {
      const statement = database.prepare(sql);
      return (statement.columns().length ? statement.all(...bindings as any[]) : [statement.run(...bindings as any[])]) as T[];
    } },
    transactionSync<T>(task: () => T): T {
      const savepoint = `provenance_${++counter}`; database.exec(`SAVEPOINT ${savepoint}`);
      try { const result = task(); database.exec(`RELEASE ${savepoint}`); return result; }
      catch (error) { database.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
    },
  };
  return { database, storage, provenance: new MailContentProvenance(storage) };
}

describe('Private mail content provenance (actual SQLite)', () => {
  it('admits explicitly owned uploads and denies foreign and unproven legacy sources without read authority', () => {
    const f = fixture(); f.provenance.recordSource('owned-upload', 'alice'); f.provenance.recordSource('foreign-upload', 'bob');
    expect(() => f.provenance.assertSource('owned-upload', 'alice', false)).not.toThrow();
    expect(() => f.provenance.assertSource('foreign-upload', 'alice', false)).toThrow('forbidden');
    expect(() => f.provenance.assertSource('legacy-blob', 'alice', false)).toThrow('forbidden');
    expect(() => f.provenance.assertSource('legacy-blob', 'alice', true)).not.toThrow();
    expect(() => f.provenance.assertSource('foreign-upload', 'alice', true)).not.toThrow();
    expect(() => f.provenance.assertSource('legacy-blob', 'alice', false)).toThrow('forbidden');
  });
  it('preserves immutable upload ownership through retries, conflicts and restart', () => {
    const f = fixture(); f.provenance.recordSource('upload', 'alice'); f.provenance.recordSource('upload', 'alice');
    expect(() => f.provenance.recordSource('upload', 'bob')).toThrow('another actor');
    const restarted = new MailContentProvenance(f.storage);
    expect(() => restarted.assertSource('upload', 'alice', false)).not.toThrow();
    expect(() => restarted.assertSource('upload', 'bob', false)).toThrow('forbidden');
  });
  it('binds prepared evidence to the exact actor and immutable raw blob and invalidates edits', () => {
    const f = fixture(); f.provenance.recordPrepared('email', 'alice', 'raw-v1');
    expect(f.provenance.prepared('email', 'alice', 'raw-v1')).toBe(true);
    expect(f.provenance.prepared('email', 'bob', 'raw-v1')).toBe(false);
    expect(f.provenance.prepared('email', 'alice', 'raw-v2')).toBe(false);
    f.provenance.invalidate('email'); expect(f.provenance.prepared('email', 'alice', 'raw-v1')).toBe(false);
    f.provenance.recordPrepared('email', 'bob', 'raw-v2');
    expect(f.provenance.prepared('email', 'alice', 'raw-v1')).toBe(false);
    expect(new MailContentProvenance(f.storage).prepared('email', 'bob', 'raw-v2')).toBe(true);
  });
  it('forgets physically removed sources and all preparations for the exact blob', () => {
    const f = fixture(); f.provenance.recordSource('raw', 'alice'); f.provenance.recordPrepared('e1', 'alice', 'raw'); f.provenance.recordPrepared('e2', 'alice', 'raw'); f.provenance.recordPrepared('other', 'bob', 'other-raw');
    f.provenance.forgetBlob('raw'); expect(f.provenance.prepared('e1', 'alice', 'raw')).toBe(false); expect(f.provenance.prepared('e2', 'alice', 'raw')).toBe(false);
    expect(f.provenance.prepared('other', 'bob', 'other-raw')).toBe(true);
    expect(() => f.provenance.assertSource('raw', 'alice', false)).toThrow('forbidden');
  });
  it('rolls back provenance evidence with the enclosing canonical transaction', () => {
    const f = fixture();
    expect(() => f.storage.transactionSync(() => { f.provenance.recordSource('upload', 'alice'); f.provenance.recordPrepared('email', 'alice', 'raw'); throw new Error('canonical failure'); })).toThrow('canonical failure');
    expect(() => f.provenance.assertSource('upload', 'alice', false)).toThrow('forbidden'); expect(f.provenance.prepared('email', 'alice', 'raw')).toBe(false);
  });
  it('validates authority inputs, safely binds identifiers and exports exact purge table names', () => {
    const f = fixture();
    expect(() => f.provenance.recordSource('', 'alice')).toThrow('invalidArguments'); expect(() => f.provenance.recordSource('blob', 'alice\n')).toThrow('invalidArguments');
    expect(() => f.provenance.assertSource('blob', 'alice', 'yes' as any)).toThrow('invalidArguments');
    f.provenance.recordSource("quoted'blob", 'alice'); expect(() => f.provenance.assertSource("quoted'blob", 'alice', false)).not.toThrow();
    expect(MAIL_CONTENT_PROVENANCE_TABLES).toEqual(['mail_content_sources', 'mail_prepared_email']);
  });
});
