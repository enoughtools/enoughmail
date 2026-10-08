import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { SqliteMailStore, type MailSqlStorage } from '../apps/mail/src/server/store';
import { initialMailState, type MailObject } from '../apps/mail/src/domain/model';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  let nesting = 0, writes = 0;
  let fault: ((sql: string) => boolean) | undefined;
  const storage: MailSqlStorage = {
    sql: { exec<T>(sql: string, ...bindings: unknown[]): Iterable<T> {
      if (fault?.(sql)) throw new Error('Injected storage failure');
      if (/^(INSERT|DELETE|UPDATE)/.test(sql)) writes++;
      const statement = db.prepare(sql);
      return (statement.columns().length ? statement.all(...bindings as any[]) : [statement.run(...bindings as any[])]) as T[];
    } },
    transactionSync<T>(task: () => T): T {
      const name = `mail_test_${++nesting}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const result = task(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
    },
  };
  const state = initialMailState({ accountId: 'account', organizationId: 'org', workspaceId: 'workspace', actor: { id: 'actor', actions: ['mail.read'] } });
  return { db, storage, state, store: new SqliteMailStore(storage), get writes() { return writes; }, failWhen(match?: (sql: string) => boolean) { fault = match; } };
}
function email(id: string, extra: Record<string, unknown> = {}): MailObject {
  return { id, threadId: 'thread', subject: 'Flight reservation', from: [{ name: 'Agent', email: 'agent@example.com' }], to: [{ email: 'reader@example.net' }], bodyValues: { plain: { value: 'Dinner booking confirmed' } }, receivedAt: '2026-10-05T12:00:00Z', size: 123, keywords: {}, mailboxIds: { 'folder-inbox': true }, hasAttachment: false, ...extra };
}
describe('Mail normalized SQLite authority (actual SQLite and FTS5)', () => {
  it('preserves arbitrary product objects and history across restart', () => {
    const f = fixture();
    f.state.objects.Settings = { singleton: { id: 'singleton', remoteImages: false } };
    f.state.objects.Email.a = email('a'); f.state.sequence = 1;
    f.state.changes = [{ sequence: 1, type: 'Email', id: 'a', destroyed: false, created: true }];
    f.state.receipts.operation = { fingerprint: 'request', response: { newState: 'm1' } };
    f.state.querySnapshots.m1 = ['a']; f.store.commit(f.state);
    expect(new SqliteMailStore(f.storage).load()).toEqual(f.state);
  });
  it('migrates legacy account bytes atomically and retains their original archive', () => {
    const f = fixture(); const bytes = JSON.stringify(f.state);
    f.db.exec('CREATE TABLE mail_account(id INTEGER PRIMARY KEY,data TEXT NOT NULL)');
    f.db.prepare('INSERT INTO mail_account VALUES(1,?)').run(bytes);
    expect(f.store.load()).toEqual(f.state);
    expect(f.db.prepare('SELECT data FROM mail_account_legacy_archive').get()?.data).toBe(bytes);
    expect(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='mail_account'").get()?.n).toBe(0);
    expect(new SqliteMailStore(f.storage).load()).toEqual(f.state);
  });
  it('rolls back the entire migration and retries after an archive failure', () => {
    const f = fixture(); f.state.objects.Email.a = email('a');
    f.db.exec('CREATE TABLE mail_account(id INTEGER PRIMARY KEY,data TEXT NOT NULL)');
    f.db.prepare('INSERT INTO mail_account VALUES(1,?)').run(JSON.stringify(f.state));
    f.failWhen(sql => sql.startsWith('ALTER TABLE'));
    expect(() => f.store.load()).toThrow('Injected storage failure');
    expect(f.db.prepare('SELECT count(*) n FROM mail_metadata').get()?.n).toBe(0);
    expect(f.db.prepare('SELECT count(*) n FROM mail_objects').get()?.n).toBe(0);
    f.failWhen(); expect(f.store.load()).toEqual(f.state);
    expect(f.store.queryEmails({ filter: { text: 'booking' } }).ids).toEqual(['a']);
  });
  it('writes only changed rows and keeps SQL, indexes and diff baseline consistent after failures', () => {
    const f = fixture(); f.state.objects.Email.a = email('a'); f.store.commit(f.state);
    const before = f.writes; f.store.commit(f.state); expect(f.writes - before).toBe(1);
    f.state.objects.Email.a.subject = 'Changed subject'; f.failWhen(sql => sql.startsWith('INSERT INTO mail_email_index'));
    expect(() => f.store.commit(f.state)).toThrow('Injected storage failure');
    expect(f.store.queryEmails({ filter: { text: 'Changed' } }).total).toBe(0);
    expect(new SqliteMailStore(f.storage).load()?.objects.Email.a.subject).toBe('Flight reservation');
    f.failWhen(); f.store.commit(f.state);
    expect(f.store.queryEmails({ filter: { text: 'Changed' } }).ids).toEqual(['a']);
    delete f.state.objects.Email.a; f.store.commit(f.state);
    expect(f.store.queryEmails({ filter: { text: 'Changed' } }).total).toBe(0);
    expect(f.db.prepare('SELECT count(*) n FROM mail_search').get()?.n).toBe(0);
  });
  it('uses real FTS5 while treating query punctuation and SQL wildcard characters literally', () => {
    const f = fixture(); f.state.objects.Email.a = email('a', { subject: 'Discount 20%_sale' }); f.store.commit(f.state);
    expect(f.store.queryEmails({ filter: { text: 'booking confirmed' } }).ids).toEqual(['a']);
    expect(f.store.queryEmails({ filter: { text: '" OR *' } }).total).toBe(0);
    expect(f.store.queryEmails({ filter: { subject: '%_sale' } }).ids).toEqual(['a']);
    expect(f.store.queryEmails({ filter: { subject: '20X_sale' } }).total).toBe(0);
    expect(() => f.store.queryEmails({ filter: { imaginary: true } as any })).toThrow('Unsupported filter');
  });
  it('combines boolean, membership, date, size, attachment and header filters', () => {
    const f = fixture();
    f.state.objects.Email.a = email('a', { keywords: { '$seen': true }, hasAttachment: true, attachments: [{ name: 'ticket.pdf' }], headers: [{ name: 'Delivered-To', value: 'alias@example.org' }] });
    f.state.objects.Email.b = email('b'); f.store.commit(f.state);
    expect(f.store.queryEmails({ filter: { operator: 'NOT', conditions: [{ hasKeyword: '$seen' }] } }).ids).toEqual(['b']);
    expect(f.store.queryEmails({ filter: { inMailbox: 'folder-inbox', notInMailbox: ['folder-trash'], after: '2026-10-05T00:00:00Z', before: '2026-10-06T00:00:00Z', minSize: 123, maxSize: 124 } }).total).toBe(2);
    expect(f.store.queryEmails({ filter: { attachmentName: '.pdf', header: ['delivered-to', 'alias@'], hasAttachment: true } }).ids).toEqual(['a']);
    expect(f.store.queryEmails({ filter: { operator: 'OR', conditions: [{ from: 'Agent' }, { to: 'missing' }] } }).total).toBe(2);
    expect(f.store.queryEmails({ filter: { maxSize: 123 } }).total).toBe(0);
  });
  it('supports stable keyword and thread keyword sorting with bounded negative-position pages', () => {
    const f = fixture(); f.state.objects.Email.a = email('a', { keywords: { '$seen': true } });
    f.state.objects.Email.b = email('b'); f.state.objects.Email.c = email('c', { threadId: 'other' }); f.store.commit(f.state);
    expect(f.store.queryEmails({ sort: [{ property: 'hasKeyword', keyword: '$seen', isAscending: false }] }).ids).toEqual(['a', 'b', 'c']);
    expect(f.store.queryEmails({ sort: [{ property: 'someInThreadHaveKeyword', keyword: '$seen', isAscending: false }] }).ids).toEqual(['a', 'b', 'c']);
    expect(f.store.queryEmails({ sort: [{ property: 'allInThreadHaveKeyword', keyword: '$seen', isAscending: false }] }).ids).toEqual(['a', 'b', 'c']);
    expect(f.store.queryEmails({ position: -1, limit: 1 })).toEqual({ ids: ['c'], position: 2, total: 3 });
    expect(f.store.queryEmails({ limit: 0 }).ids).toEqual([]);
    expect(() => f.store.queryEmails({ sort: [{ property: 'size; DROP TABLE mail_objects' }] })).toThrow('Unsupported sort');
  });
  it('bounds retained history, receipts and query snapshots across reload', () => {
    const f = fixture();
    for (let index = 1; index <= 10001; index++) { f.state.changes.push({ sequence: index, type: 'Email', id: `${index}`, destroyed: false }); f.state.receipts[`op${index}`] = { fingerprint: `${index}`, response: index }; }
    for (let index = 1; index <= 101; index++) f.state.querySnapshots[`q${index}`] = [`${index}`];
    f.state.sequence = 10001; f.store.commit(f.state);
    const loaded = new SqliteMailStore(f.storage).load()!;
    expect(loaded.changes).toHaveLength(10000); expect(loaded.changes[0].sequence).toBe(2);
    expect(Object.keys(loaded.receipts)).toHaveLength(10000); expect(loaded.receipts.op1).toBeUndefined();
    expect(Object.keys(loaded.querySnapshots)).toHaveLength(100); expect(loaded.querySnapshots.q1).toBeUndefined();
  });
  it('rejects stale revisions before writing any object or index state', () => {
    const f = fixture(); f.store.commit(f.state);
    const stale = new SqliteMailStore(f.storage); const staleState = stale.load()!;
    f.state.objects.Email.a = email('a'); f.state.sequence = 1; f.store.commit(f.state, 0);
    staleState.objects.Email.b = email('b'); staleState.sequence = 1;
    expect(() => stale.commit(staleState, 0)).toThrow('revisionConflict');
    expect(new SqliteMailStore(f.storage).load()?.objects.Email).toEqual({ a: f.state.objects.Email.a });
    expect(f.store.queryEmails().ids).toEqual(['a']);
  });
  it('hydrates bounded pages and commits partial changes without deleting unloaded mail', () => {
    const f = fixture();
    for(let index=0;index<1200;index++) f.state.objects.Email[`e${index}`]=email(`e${index}`,{threadId:`t${index%3}`,messageId:[`<msg${index}>`],references:['<root>'],...(index===0?{snooze:{until:'2026-10-04T12:00:00Z'}}:{})});
    f.store.commit(f.state);
    const partial = new SqliteMailStore(f.storage);const state=partial.load({includeEmails:false})!;
    expect(state.objects.Email).toEqual({});
    expect(partial.readEmails({limit:100000})).toHaveLength(1000);
    expect(partial.readEmails({ids:['e0','e1']})).toHaveLength(2);
    expect(partial.readEmails({threadIds:['t1']})).toHaveLength(400);
    expect(partial.readEmails({messageReference:'<msg0>'}).map(email=>email.id)).toEqual(['e0']);
    expect(partial.readEmails({dueBefore:Date.parse('2026-10-05T12:00:00Z')}).map(email=>email.id)).toEqual(['e0']);
    expect(partial.nextEmailAlarm()).toBe(Date.parse('2026-10-04T12:00:00Z'));
    expect(partial.mailboxCounts('folder-inbox')).toEqual({totalEmails:1200,unreadEmails:1200,totalThreads:3,unreadThreads:3});
    state.objects.Email.e1={...partial.readEmails({ids:['e1']})[0],subject:'Edited'};
    state.sequence=2;state.changes=[{sequence:1,type:'Email',id:'e1',destroyed:false},{sequence:2,type:'Email',id:'e0',destroyed:true}];partial.commit(state,0);
    expect(partial.queryEmails().total).toBe(1199);expect(partial.readEmails({ids:['e1']})[0].subject).toBe('Edited');
    state.objects.Email={};partial.commit(state,2);expect(partial.queryEmails().total).toBe(1199);
  });
  it('bounds persisted body metadata while indexing full body text', () => {
    const f=fixture();f.state.objects.Email.a=email('a',{blobId:'raw-blob',bodyValues:{body:{value:'prefix '.repeat(1000)+'uniquefinalword'}}});f.store.commit(f.state);
    const stored=f.store.readEmails({ids:['a']})[0];expect(stored.bodyValues.body.value).toHaveLength(4096);expect(stored.bodyValues.body.isTruncated).toBe(true);
    expect(f.store.queryEmails({filter:{text:'uniquefinalword'}}).ids).toEqual(['a']);
    const partial=new SqliteMailStore(f.storage),state=partial.load({includeEmails:false})!;state.objects.Email.a={...stored,keywords:{'$seen':true}};partial.commit(state);
    expect(partial.queryEmails({filter:{text:'uniquefinalword'}}).ids).toEqual(['a']);
    const restarted=new SqliteMailStore(f.storage);restarted.load({includeEmails:false});expect(restarted.queryEmails({filter:{text:'uniquefinalword'}}).ids).toEqual(['a']);
  });
  it('backfills indexed references and alarm dates from an earlier normalized schema', () => {
    const f=fixture();f.state.objects.Email.a=email('a',{messageId:['<old-message>'],references:['<older-reference>'],snooze:{until:'2026-10-04T12:00:00Z'}});f.store.commit(f.state);
    f.db.exec('DELETE FROM mail_schema_version; DELETE FROM mail_email_references; UPDATE mail_email_index SET snooze_at=NULL');
    const upgraded=new SqliteMailStore(f.storage);upgraded.load({includeEmails:false});
    expect(upgraded.readEmails({messageReference:'<old-message>'}).map(email=>email.id)).toEqual(['a']);
    expect(upgraded.readEmails({messageReference:'<older-reference>'}).map(email=>email.id)).toEqual(['a']);
    expect(upgraded.nextEmailAlarm()).toBeCloseTo(Date.parse('2026-10-04T12:00:00Z'),0);
    expect(upgraded.readEmails({dueBefore:Date.parse('2026-10-05T12:00:00Z')}).map(email=>email.id)).toEqual(['a']);
  });
  it('snapshots 100,000 messages in SQL and pages original metadata after live edits and deletes', () => {
    const f=fixture();f.store.commit(f.state);
    f.db.exec(`WITH RECURSIVE n(value) AS (VALUES(0) UNION ALL SELECT value+1 FROM n WHERE value<99999) INSERT INTO mail_objects(type,id,json) SELECT 'Email',printf('m%06d',value),json_object('id',printf('m%06d',value),'blobId',printf('blob%d',value),'threadId',printf('t%d',value),'receivedAt','2026-10-05T12:00:00Z','keywords',json_object('$seen',CASE WHEN value%2=0 THEN json('true') ELSE json('false') END),'mailboxIds',json_object('folder-inbox',json('true'))) FROM n`);
    f.db.exec(`INSERT INTO mail_email_index(id,received_at,sent_at,size,subject,sender,recipients,cc,bcc,body,has_attachment,thread_id) SELECT id,1,1,1,'','','','','','',0,json_extract(json,'$.threadId') FROM mail_objects WHERE type='Email'`);
    const started=performance.now();expect(f.store.createExport('export','actor')).toEqual({total:100000});console.info(`100,000-message SQL export snapshot: ${(performance.now()-started).toFixed(1)}ms`);
    f.db.exec(`DELETE FROM mail_objects WHERE type='Email' AND id='m000001'; UPDATE mail_objects SET json=json_set(json,'$.blobId','replacement','$.mailboxIds',json('{}')) WHERE type='Email' AND id='m000000'`);
    const restarted=new SqliteMailStore(f.storage);expect(restarted.load({includeEmails:false})?.objects.Email).toEqual({});
    const page=restarted.exportPage('export',0,10000);expect(page.list).toHaveLength(100);expect(page.total).toBe(100000);expect(page.nextPosition).toBe(100);expect(page.hasMore).toBe(true);
    expect(page.list[0]).toMatchObject({id:'m000000',blobId:'blob0',mailboxIds:{'folder-inbox':true}});expect(page.list[1].id).toBe('m000001');
    expect(restarted.exportPage('export',99998,100)).toMatchObject({total:100000,nextPosition:100000,hasMore:false,list:[{id:'m099998'},{id:'m099999'}]});
    expect(restarted.createExport('export','actor')).toEqual({total:100000});expect(()=>restarted.createExport('export','other')).toThrow('already used');
    expect(restarted.createExport('seen','actor',{hasKeyword:'$seen'})).toEqual({total:50000});expect(()=>restarted.createExport('third','actor')).toThrow('tooManyExportJobs');
    restarted.cancelExport('seen');expect(restarted.createExport('third','actor',{inMailbox:'folder-inbox'})).toEqual({total:99998});
    const readStarted=performance.now();expect(restarted.readEmails({ids:['m099999','m000000']}).map(item=>item.id)).toEqual(['m099999','m000000']);console.info(`100,000-message SQL two-ID lookup: ${(performance.now()-readStarted).toFixed(1)}ms`);
    restarted.cancelExport('export');expect(()=>restarted.exportPage('export')).toThrow('notFound');
  });
  it('rolls back export snapshot rows if creating its metadata fails', () => {
    const f=fixture();f.state.objects.Email.a=email('a',{blobId:'blob-a'});f.store.commit(f.state);
    f.failWhen(sql=>sql.startsWith('INSERT INTO mail_export_jobs'));expect(()=>f.store.createExport('export','actor')).toThrow('Injected storage failure');
    expect(f.db.prepare('SELECT count(*) AS n FROM mail_export_items').get()?.n).toBe(0);
    f.failWhen();expect(f.store.createExport('export','actor')).toEqual({total:1});
  });
  it('indexes multi-megabyte bodies in bounded UTF-8 chunks and preserves boundary phrases after flags and restart', () => {
    const f=fixture();const large='a '.repeat(131067)+'boundaryphrase secondword '+'😀 '.repeat(450000)+'z '.repeat(400000)+' uniqueaftertwo megabytes';
    f.state.objects.Email.large=email('large',{blobId:'large-raw',bodyValues:{body:{value:large}}});f.store.commit(f.state);
    expect(new TextEncoder().encode(large).length).toBeGreaterThan(2*1024*1024);
    expect(f.db.prepare('SELECT max(length(CAST(body AS BLOB))) AS n FROM mail_body_chunks').get()?.n).toBeLessThanOrEqual(256*1024);
    expect(f.db.prepare('SELECT length(CAST(body AS BLOB)) AS n FROM mail_email_index WHERE id=?').get('large')?.n).toBeLessThanOrEqual(4096);
    expect(f.store.queryEmails({filter:{text:'boundaryphrase secondword'}}).ids).toEqual(['large']);
    expect(f.store.queryEmails({filter:{text:'uniqueaftertwo megabytes'}}).ids).toEqual(['large']);
    expect(f.store.queryEmails({filter:{body:'uniqueaftertwo megabytes'}}).ids).toEqual(['large']);
    const partial=new SqliteMailStore(f.storage),state=partial.load({includeEmails:false})!;state.objects.Email.large={...partial.readEmails({ids:['large']})[0],keywords:{'$flagged':true}};partial.commit(state);
    const restarted=new SqliteMailStore(f.storage);restarted.load({includeEmails:false});
    expect(restarted.queryEmails({filter:{text:'uniqueaftertwo megabytes'}}).ids).toEqual(['large']);
    expect(restarted.queryEmails({filter:{body:'boundaryphrase secondword'}}).ids).toEqual(['large']);
    expect(f.db.prepare('SELECT count(*) AS n FROM mail_body_chunks WHERE instr(body,?)>0').get('�')?.n).toBe(0);
  });
  it('limits persisted body values to a combined 8KiB even for many Unicode parts', () => {
    const f=fixture();const bodyValues=Object.fromEntries(Array.from({length:80},(_,index)=>[`p${index}`,{value:'😀'.repeat(2000)}]));f.state.objects.Email.a=email('a',{bodyValues});f.store.commit(f.state);
    const stored=f.store.readEmails({ids:['a']})[0];expect(Object.keys(stored.bodyValues)).toHaveLength(64);
    expect(Object.values(stored.bodyValues).reduce((total:number,part:any)=>total+new TextEncoder().encode(part.value).length,0)).toBeLessThanOrEqual(8192);
    expect(stored.bodyValues.p0.value).not.toContain('�');expect(stored.bodyValues.p63.isTruncated).toBe(true);
  });
  it('preserves both thread-hydrated emails across a later partial one-email edit', () => {
    const f=fixture();f.state.objects.Email.a=email('a');f.state.objects.Email.b=email('b');f.store.commit(f.state);
    const partial=new SqliteMailStore(f.storage),state=partial.load({includeEmails:false})!;
    state.objects.Email=Object.fromEntries(partial.readEmails({threadIds:['thread']}).map(item=>[item.id,item]));partial.commit(state,0);
    state.objects.Email={};state.objects.Email.b={...partial.readEmails({ids:['b']})[0],keywords:{'$seen':true}};state.sequence=1;state.changes.push({sequence:1,type:'Email',id:'b',destroyed:false});partial.commit(state,0);
    expect(partial.readEmails({ids:['a','b']}).map(item=>item.id)).toEqual(['a','b']);expect(partial.mailboxCounts('folder-inbox').totalEmails).toBe(2);
  });
  it('commits staged security SQL with content and rolls all writes back on failure', () => {
    const f=fixture();f.store.commit(f.state);f.db.exec('CREATE TABLE mail_blob_security(blob_id TEXT PRIMARY KEY,status TEXT NOT NULL)');
    f.state.objects.Email.a=email('a');f.state.sequence=1;f.failWhen(sql=>sql.startsWith('INSERT INTO mail_body_chunks'));
    const stage=()=>{f.storage.sql.exec("INSERT INTO mail_blob_security VALUES('blob-a','clean')");};expect(()=>f.store.commit(f.state,0,stage)).toThrow('Injected storage failure');
    expect(f.db.prepare('SELECT count(*) AS n FROM mail_blob_security').get()?.n).toBe(0);expect(new SqliteMailStore(f.storage).load()?.sequence).toBe(0);
    f.failWhen();f.store.commit(f.state,0,stage);expect(f.db.prepare('SELECT status FROM mail_blob_security').get()?.status).toBe('clean');
  });
  it('finds retention batches across the full account and cancels deadlines when restored', () => {
    const f=fixture(),now=Date.parse('2026-10-05T00:00:00Z');
    for(let index=0;index<201;index++)f.state.objects.Email[`trash${index}`]=email(`trash${index}`,{mailboxIds:{'folder-trash':true},trashAt:'2026-08-01T00:00:00Z'});
    f.state.objects.Email.restored=email('restored',{trashAt:'2026-01-01T00:00:00Z'});
    f.state.objects.Email.junk=email('junk',{mailboxIds:{'folder-junk':true},junkAt:'2026-09-20T00:00:00Z'});f.store.commit(f.state);
    expect(f.store.readRetentionDue({},now,10000)).toHaveLength(100);expect(f.store.readRetentionDue({},now,10000).some(item=>item.id==='restored')).toBe(false);
    expect(f.store.nextRetentionDeadline()).toBe(Date.parse('2026-08-31T00:00:00Z'));
    f.state.objects.Email.trash0.mailboxIds={'folder-inbox':true};f.store.commit(f.state);expect(f.store.readRetentionDue({},now).some(item=>item.id==='trash0')).toBe(false);
    expect(()=>f.store.nextRetentionDeadline({trashRetentionDays:0})).toThrow('Invalid retention days');
  });
  it('purges bounded content batches and archive bytes while retaining lifecycle finalization evidence', () => {
    const f=fixture();for(let index=0;index<25;index++)f.state.objects.Email[`e${index}`]=email(`e${index}`,{blobId:`blob${index}`});f.store.commit(f.state);f.store.createExport('export','actor');
    f.db.exec("CREATE TABLE mail_account_legacy_archive(id INTEGER PRIMARY KEY,data TEXT); INSERT INTO mail_account_legacy_archive VALUES(1,'original bytes'); CREATE TABLE mail_lifecycle(id INTEGER PRIMARY KEY,status TEXT); INSERT INTO mail_lifecycle VALUES(1,'purging'); CREATE TABLE mail_lifecycle_history(revision INTEGER PRIMARY KEY,status TEXT); INSERT INTO mail_lifecycle_history VALUES(1,'purging')");
    let calls=0,result;do{result=f.store.purgeBatchRows(10);expect(result.deleted).toBeLessThanOrEqual(10);calls++;}while(!result.done&&calls<100);
    expect(result.done).toBe(true);expect(calls).toBeGreaterThan(1);expect(f.db.prepare('SELECT count(*) AS n FROM mail_account_legacy_archive').get()?.n).toBe(0);
    expect(f.db.prepare('SELECT status FROM mail_lifecycle').get()?.status).toBe('purging');expect(f.db.prepare('SELECT count(*) AS n FROM mail_lifecycle_history').get()?.n).toBe(1);expect(f.store.load({includeEmails:false})).toBeNull();
  });
  it('freezes resumable rule targets and atomically checkpoints bounded batches with content changes', () => {
    const f=fixture();for(let index=0;index<201;index++)f.state.objects.Email[`e${index}`]=email(`e${index}`);f.store.commit(f.state);
    expect(f.store.createRuleApplyJob('job','actor','[]')).toMatchObject({total:201,cursor:0});const page=f.store.ruleApplyPage('job','actor',10000);expect(page.ids).toHaveLength(100);expect(page.nextCursor).toBe(100);
    f.state.objects.Email.later=email('later');f.state.sequence=1;f.store.commit(f.state,0,()=>f.store.advanceRuleApplyJob('job','actor',0,100));
    expect(f.store.ruleApplyPage('job','actor').total).toBe(201);expect(f.store.ruleApplyPage('job','actor').cursor).toBe(100);expect(()=>f.store.ruleApplyPage('job','other')).toThrow('notFound');expect(()=>f.store.advanceRuleApplyJob('job','actor',0,100)).toThrow('revisionConflict');
    const restarted=new SqliteMailStore(f.storage);restarted.load({includeEmails:false});expect(restarted.ruleApplyPage('job','actor').cursor).toBe(100);restarted.cancelRuleApplyJob('job','actor');expect(()=>restarted.ruleApplyPage('job','actor')).toThrow('notFound');
  });
  it('tracks bounded blob references through shared mail, submission snapshots and export snapshots', () => {
    const f=fixture();f.state.objects.Email.a=email('a',{blobId:'raw',attachments:[{blobId:'attachment'}],bodyStructure:{subParts:[{blobId:'body'}]}});f.state.objects.Email.b=email('b',{blobId:'raw'});
    f.state.objects.EmailSubmission.s={id:'s',status:'pending',emailSnapshot:{blobId:'submission-raw'}};f.store.commit(f.state);
    expect(new Set(f.store.referencedBlobs(['raw','attachment','body','submission-raw','unused']))).toEqual(new Set(['raw','attachment','body','submission-raw']));
    f.store.createExport('snapshot','actor');delete f.state.objects.Email.a;f.store.commit(f.state);
    expect(f.store.referencedBlobs(['raw','attachment','body'])).toEqual(['raw']);delete f.state.objects.Email.b;f.store.commit(f.state);expect(f.store.referencedBlobs(['raw'])).toEqual(['raw']);
    f.store.cancelExport('snapshot');expect(f.store.referencedBlobs(['raw'])).toEqual([]);
    const restarted=new SqliteMailStore(f.storage);restarted.load({includeEmails:false});expect(restarted.referencedBlobs(['submission-raw'])).toEqual(['submission-raw']);expect(()=>restarted.referencedBlobs(Array.from({length:101},(_,index)=>`blob${index}`))).toThrow('Invalid blob reference batch');
  });
  it('backfills blob reference indexes and retires completed rule jobs before starting another', () => {
    const f=fixture();f.state.objects.Email.a=email('a',{blobId:'raw-a'});f.store.commit(f.state);f.db.exec('DELETE FROM mail_object_blob_refs; UPDATE mail_schema_version SET version=2');
    const upgraded=new SqliteMailStore(f.storage);upgraded.load({includeEmails:false});expect(upgraded.referencedBlobs(['raw-a'])).toEqual(['raw-a']);
    for(let index=0;index<5;index++){expect(upgraded.createRuleApplyJob(`job${index}`,'actor','[]').total).toBe(1);upgraded.advanceRuleApplyJob(`job${index}`,'actor',0,1);}
    expect(f.db.prepare('SELECT count(*) AS n FROM mail_rule_apply_jobs').get()?.n).toBe(1);expect(f.db.prepare('SELECT count(*) AS n FROM mail_rule_apply_items').get()?.n).toBe(1);
  });
  it('moves private ingress and vacation histories out of hydrated canonical state', () => {
    const f=fixture(),at=new Date().toISOString();f.state.objects.IngestReceipt={delivery:{id:'delivery',emailId:'a',blobId:'raw-a',receivedAt:at}};f.state.objects.AutoCooldown={'Sender@Example.com':{id:'Sender@Example.com',at}};f.store.commit(f.state);
    expect(f.state.objects.IngestReceipt).toBeUndefined();expect(f.state.objects.AutoCooldown).toBeUndefined();
    const restarted=new SqliteMailStore(f.storage),state=restarted.load({includeEmails:false})!;expect(state.objects.IngestReceipt).toBeUndefined();expect(restarted.ingestReceipt('delivery')).toEqual({emailId:'a',blobId:'raw-a',receivedAt:at});expect(restarted.vacationCooldown('sender@example.com')).toBe(at);
    expect(f.db.prepare("SELECT count(*) AS n FROM mail_objects WHERE type IN ('IngestReceipt','AutoCooldown')").get()?.n).toBe(0);
  });
  it('atomically stages immutable ingress receipts and independent arrival state', () => {
    const f=fixture(),at=new Date().toISOString();f.store.commit(f.state);f.state.objects.Email.a=email('a');f.state.sequence=1;
    f.failWhen(sql=>sql.startsWith('INSERT INTO mail_body_chunks'));expect(()=>f.store.commit(f.state,0,()=>{f.store.recordIngestReceipt('delivery',{emailId:'a',blobId:'raw-a',receivedAt:at});f.store.recordEmailDelivery();})).toThrow('Injected storage failure');
    expect(f.store.ingestReceipt('delivery')).toBeNull();expect(f.store.emailDeliveryState()).toBe('d0');f.failWhen();f.store.commit(f.state,0,()=>{f.store.recordIngestReceipt('delivery',{emailId:'a',blobId:'raw-a',receivedAt:at});f.store.recordEmailDelivery();});expect(f.store.emailDeliveryState()).toBe('d1');
    expect(()=>f.store.recordIngestReceipt('delivery',{emailId:'different',blobId:'raw-a',receivedAt:at})).toThrow('reused');f.store.commit(f.state,1);expect(f.store.emailDeliveryState()).toBe('d1');expect(new SqliteMailStore(f.storage).emailDeliveryState()).toBe('d1');
  });
  it('bounds private receipt history while retaining valid year-long vacation intervals', () => {
    const f=fixture(),now=Date.now(),at=new Date(now-100*86400000).toISOString();f.store.recordVacationCooldown('Sender@example.com',at);expect(f.store.vacationCooldown('sender@example.com',now)).toBe(at);expect(f.store.vacationCooldown('sender@example.com',now+300*86400000)).toBeNull();
    f.db.exec(`WITH RECURSIVE n(value) AS (VALUES(0) UNION ALL SELECT value+1 FROM n WHERE value<10000) INSERT INTO mail_ingest_receipts SELECT printf('id%d',value),'email','blob','2026-01-01T00:00:00Z',value FROM n`);
    f.store.recordIngestReceipt('newest',{emailId:'new',blobId:'new',receivedAt:new Date(now).toISOString()});expect(f.db.prepare('SELECT count(*) AS n FROM mail_ingest_receipts').get()?.n).toBe(10000);expect(f.store.ingestReceipt('id0')).toBeNull();expect(f.store.ingestReceipt('newest')?.emailId).toBe('new');
  });
  it('indexes completed streamed leaf caches beyond previews with distant AND terms and decoder-boundary phrases', () => {
    const f=fixture(),prefix='leadingunique ',boundary=192*1024-4;
    const source=prefix+' '.repeat(boundary-prefix.length)+'alpha beta '+'middleword '.repeat(150000)+' terminalunique';
    let index=0;for(let start=0;start<source.length;start+=192*1024)f.store.appendBlobTextChunk('body-leaf',index++,source.slice(start,start+192*1024));
    f.store.finalizeBlobText('body-leaf',createHash('sha256').update(source).digest('hex'));
    f.state.objects.Email.large=email('large',{blobId:'raw-large',textBody:[{partId:'plain',blobId:'body-leaf'}],bodyValues:{plain:{value:source.slice(0,1024*1024),isTruncated:true}}});f.store.commit(f.state);
    expect(f.store.queryEmails({filter:{text:'terminalunique'}}).ids).toEqual(['large']);
    expect(f.store.queryEmails({filter:{operator:'AND',conditions:[{text:'leadingunique'},{text:'terminalunique'}]}}).ids).toEqual(['large']);
    expect(f.store.queryEmails({filter:{text:'alpha beta'}}).ids).toEqual(['large']);
    expect(f.store.queryEmails({filter:{body:'alpha beta'}}).ids).toEqual(['large']);
    expect(f.db.prepare('SELECT max(length(CAST(body AS BLOB))) AS n FROM mail_blob_text_chunks').get()?.n).toBeLessThanOrEqual(256*1024);
    const partial=new SqliteMailStore(f.storage),state=partial.load({includeEmails:false})!;state.objects.Email.large={...partial.readEmails({ids:['large']})[0],keywords:{'$seen':true}};partial.commit(state);
    const restarted=new SqliteMailStore(f.storage);restarted.load({includeEmails:false});expect(restarted.queryEmails({filter:{text:'terminalunique'}}).ids).toEqual(['large']);
    expect(()=>restarted.queryEmails({filter:{body:'x'.repeat(4097)}})).toThrow('4096 characters');
  });
  it('keeps incomplete text caches invisible and completed leaves immutable until physical GC', () => {
    const f=fixture();f.store.appendBlobTextChunk('pending-leaf',0,'pendinguniqueword');
    f.state.objects.Email.a=email('a',{blobId:'raw-a',textBody:[{blobId:'pending-leaf'}],bodyValues:{plain:{value:'visible preview'}}});f.store.commit(f.state);
    expect(f.store.queryEmails({filter:{text:'pendinguniqueword'}}).total).toBe(0);expect(f.store.blobTextComplete('pending-leaf')).toBe(false);
    f.store.finalizeBlobText('pending-leaf','actual-checksum');expect(f.store.blobTextComplete('pending-leaf')).toBe(true);f.store.finalizeBlobText('pending-leaf','actual-checksum');
    expect(()=>f.store.finalizeBlobText('pending-leaf','changed-checksum')).toThrow('checksum mismatch');expect(()=>f.store.appendBlobTextChunk('pending-leaf',1,'more')).toThrow('immutable');expect(()=>f.store.appendBlobTextChunk('too-large',0,'😀'.repeat(65537))).toThrow('Invalid text cache chunk');
    f.store.deleteBlobText('pending-leaf');expect(f.store.blobTextComplete('pending-leaf')).toBe(false);expect(f.db.prepare('SELECT count(*) AS n FROM mail_blob_text_chunks').get()?.n).toBe(0);
  });
  it('filters snooze and follow-up presence without confusing missing and null values', () => {
    const f = fixture(); f.state.objects.Email.a = email('a', { snooze: { until: '2026-10-06T00:00:00Z' } });
    f.state.objects.Email.b = email('b', { followUp: { until: '2026-10-06T00:00:00Z' } });
    f.state.objects.Email.c = email('c', { snooze: null, followUp: null }); f.store.commit(f.state);
    expect(f.store.queryEmails({ filter: { isSnoozed: true } as any }).ids).toEqual(['a']);
    expect(f.store.queryEmails({ filter: { isSnoozed: false } as any }).ids).toEqual(['b', 'c']);
    expect(f.store.queryEmails({ filter: { isFollowUp: true } as any }).ids).toEqual(['b']);
    expect(f.store.queryEmails({ filter: { isFollowUp: false } as any }).ids).toEqual(['a', 'c']);
  });
});
