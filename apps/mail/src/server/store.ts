import { type MailState, type MailObject } from '../domain/model';
import { validateFilter, type EmailFilter, type EmailSort } from '../domain/rules';

export interface MailSqlStorage {
  sql: { exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T> };
  transactionSync<T>(closure: () => T): T;
}
export interface EmailQuery {
  filter?: EmailFilter;
  sort?: EmailSort[];
  position?: number;
  anchor?:string;
  anchorOffset?:number;
  limit?: number;
}
const flatten = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(flatten).join(' ') : value && typeof value === 'object' ? Object.values(value).map(flatten).join(' ') : '';
const encode = JSON.stringify;
const utf8Prefix = (value:string,maxBytes:number): string => {
  const bytes=new TextEncoder().encode(value.slice(0,maxBytes));let end=Math.min(bytes.length,maxBytes);
  while(end>0 && end<bytes.length && (bytes[end]&0xc0)===0x80)end--;
  return new TextDecoder().decode(bytes.subarray(0,end));
};
function* bodyChunks(value:string): Generator<string> {
  const bytes=new TextEncoder().encode(value);const maximum=256*1024,overlap=16*1024;let start=0;
  if(!bytes.length){yield '';return;}
  while(start<bytes.length){let end=Math.min(start+maximum,bytes.length);while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
    yield new TextDecoder().decode(bytes.subarray(start,end));if(end===bytes.length)return;
    start=end-overlap;while(start>0&&(bytes[start]&0xc0)===0x80)start--;
  }
}
const emailMetadata = (email: MailObject): MailObject => {
  let remaining=8192;
  const bodyValues=Object.fromEntries(Object.entries(email.bodyValues??{}).slice(0,64).map(([id,part])=>{
    if(!part||typeof part!=='object')return [id,part];
    const value=(part as {value?:unknown}).value;
    if(typeof value!=='string')return [id,part];
    const prefix=utf8Prefix(value,Math.min(4096,remaining));remaining-=new TextEncoder().encode(prefix).length;
    return [id,prefix===value?part:{...part,value:prefix,isTruncated:true}];
  }));
  const result:MailObject={...email,...(email.bodyValues?{bodyValues}:{}),...(email.textBody?{textBody:email.textBody.slice(0,64)}:{}),...(email.htmlBody?{htmlBody:email.htmlBody.slice(0,64)}:{})};
  for(const field of ['body','text'])if(typeof result[field]==='string'){result[field]=utf8Prefix(result[field],remaining);remaining-=new TextEncoder().encode(result[field]).length;}
  return result;
};
const like = (value: string) => `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;

/** Product-owned normalized SQLite authority. Baselines are copied strings, never mutable object references. */
export class SqliteMailStore {
  private partialEmails = false;
  private persistedSequence = 0;
  private objects = new Map<string, string>();
  private changes = new Map<number, string>();
  private receipts = new Map<string, string>();
  private queries = new Map<string, string>();
  constructor(private readonly storage: MailSqlStorage) {
    storage.transactionSync(() => {
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_metadata (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, context TEXT NOT NULL, sequence INTEGER NOT NULL, object_types TEXT NOT NULL)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_object_blob_refs (type TEXT NOT NULL,object_id TEXT NOT NULL,blob_id TEXT NOT NULL,PRIMARY KEY(type,object_id,blob_id))');
      storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_object_blob_lookup ON mail_object_blob_refs(blob_id,type,object_id)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_objects (type TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(type,id))');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_changes (sequence INTEGER PRIMARY KEY, json TEXT NOT NULL)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_email_delivery (id INTEGER PRIMARY KEY CHECK(id=1),sequence INTEGER NOT NULL)');
      storage.sql.exec('INSERT OR IGNORE INTO mail_email_delivery(id,sequence) VALUES(1,0)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_ingest_receipts (id TEXT PRIMARY KEY,email_id TEXT NOT NULL,blob_id TEXT NOT NULL,received_at TEXT NOT NULL,created_at INTEGER NOT NULL)');
      storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_ingest_recent ON mail_ingest_receipts(created_at DESC,id)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_vacation_cooldowns (address TEXT PRIMARY KEY,at TEXT NOT NULL,at_ms INTEGER NOT NULL)');
      storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_vacation_recent ON mail_vacation_cooldowns(at_ms DESC,address)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_receipts (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_export_jobs (id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,filter_json TEXT NOT NULL,total INTEGER NOT NULL,created_at INTEGER NOT NULL)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_export_items (job_id TEXT NOT NULL,position INTEGER NOT NULL,id TEXT NOT NULL,blob_id TEXT NOT NULL,received_at TEXT NOT NULL,keywords_json TEXT NOT NULL,mailboxes_json TEXT NOT NULL,PRIMARY KEY(job_id,position))');
      storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_export_blob_lookup ON mail_export_items(blob_id)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_queries (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_email_index (id TEXT PRIMARY KEY, received_at REAL NOT NULL, sent_at REAL NOT NULL, size INTEGER NOT NULL, subject TEXT NOT NULL, sender TEXT NOT NULL, recipients TEXT NOT NULL, cc TEXT NOT NULL, bcc TEXT NOT NULL, body TEXT NOT NULL, has_attachment INTEGER NOT NULL, thread_id TEXT NOT NULL, snooze_at REAL, followup_at REAL, trash_at REAL, junk_at REAL)');
      const columns = new Set([...storage.sql.exec<{name:string}>('PRAGMA table_info(mail_email_index)')].map(row=>row.name));
      for (const column of ['snooze_at','followup_at','trash_at','junk_at']) if (!columns.has(column)) storage.sql.exec(`ALTER TABLE mail_email_index ADD COLUMN ${column} REAL`);
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_email_references (email_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(email_id,value))');
      storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_email_reference_value ON mail_email_references(value,email_id)');
      storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_email_snooze ON mail_email_index(snooze_at)');
      storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_email_followup ON mail_email_index(followup_at)');
      storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_email_trash ON mail_email_index(trash_at)');
      storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_email_junk ON mail_email_index(junk_at)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_rule_apply_jobs (id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,rules_json TEXT NOT NULL,cursor INTEGER NOT NULL,total INTEGER NOT NULL,status TEXT NOT NULL)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_rule_apply_items (job_id TEXT NOT NULL,position INTEGER NOT NULL,email_id TEXT NOT NULL,PRIMARY KEY(job_id,position))');
      storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_email_received ON mail_email_index(received_at DESC,id)');
      storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_email_thread ON mail_email_index(thread_id)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_blob_text_cache (blob_id TEXT PRIMARY KEY,status TEXT NOT NULL,next_index INTEGER NOT NULL,tail TEXT NOT NULL,checksum TEXT)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_blob_text_chunks (blob_id TEXT NOT NULL,position INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(blob_id,position))');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_body_chunks (email_id TEXT NOT NULL,position INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(email_id,position))');
      storage.sql.exec('CREATE VIRTUAL TABLE IF NOT EXISTS mail_search USING fts5(email_id UNINDEXED, subject, body, sender, recipients)');
      storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_schema_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)');
      if (![...storage.sql.exec('SELECT version FROM mail_schema_version WHERE id=1')].length) {
        storage.sql.exec("UPDATE mail_email_index SET snooze_at=(SELECT (julianday(json_extract(e.json,'$.snooze.until'))-2440587.5)*86400000 FROM mail_objects e WHERE e.type='Email' AND e.id=mail_email_index.id),followup_at=(SELECT (julianday(json_extract(e.json,'$.followUp.until'))-2440587.5)*86400000 FROM mail_objects e WHERE e.type='Email' AND e.id=mail_email_index.id)");
        for (const field of ['messageId','references','inReplyTo']) storage.sql.exec(`INSERT OR IGNORE INTO mail_email_references(email_id,value) SELECT e.id,reference.value FROM mail_objects e,json_each(e.json,'$.${field}') reference WHERE e.type='Email' AND reference.type='text'`);
        storage.sql.exec('INSERT INTO mail_schema_version(id,version) VALUES(1,1)');
      }
      const version=[...storage.sql.exec<{version:number}>('SELECT version FROM mail_schema_version WHERE id=1')][0]?.version??1;
      if(version<2){storage.sql.exec("UPDATE mail_email_index SET trash_at=(SELECT CASE WHEN json_extract(e.json,'$.mailboxIds.\"folder-trash\"')=1 THEN (julianday(json_extract(e.json,'$.trashAt'))-2440587.5)*86400000 END FROM mail_objects e WHERE e.type='Email' AND e.id=mail_email_index.id),junk_at=(SELECT CASE WHEN json_extract(e.json,'$.mailboxIds.\"folder-junk\"')=1 THEN (julianday(json_extract(e.json,'$.junkAt'))-2440587.5)*86400000 END FROM mail_objects e WHERE e.type='Email' AND e.id=mail_email_index.id)");storage.sql.exec('UPDATE mail_schema_version SET version=2 WHERE id=1');}
      if(version<3){storage.sql.exec("INSERT OR IGNORE INTO mail_object_blob_refs(type,object_id,blob_id) SELECT e.type,e.id,part.value FROM mail_objects e,json_tree(e.json) part WHERE part.key='blobId' AND part.type='text' AND part.value!=''");storage.sql.exec('UPDATE mail_schema_version SET version=3 WHERE id=1');}
      this.migrateStoredPrivateHistory();
    });
  }
  load(options: {includeEmails?: boolean} = {}): MailState | null {
    this.partialEmails = options.includeEmails === false;
    const row = [...this.storage.sql.exec<{version: 1; context: string; sequence: number; object_types: string}>('SELECT * FROM mail_metadata WHERE id=1')][0];
    if (!row) {
      const legacy = [...this.storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name='mail_account'")][0];
      if (!legacy) return null;
      const snapshot = [...this.storage.sql.exec<{data:string}>('SELECT data FROM mail_account WHERE id=1')][0];
      if (!snapshot) return null;
      const state = JSON.parse(snapshot.data) as MailState;
      // Archive original bytes before retiring the active whole-account snapshot.
      const baseline = {objects:this.objects,changes:this.changes,receipts:this.receipts,queries:this.queries};
      try {
        this.storage.transactionSync(() => {
          this.commit(state);
          this.storage.sql.exec('ALTER TABLE mail_account RENAME TO mail_account_legacy_archive');
        });
      } catch (error) {
        this.objects=baseline.objects;this.changes=baseline.changes;this.receipts=baseline.receipts;this.queries=baseline.queries;
        throw error;
      }
      if (this.partialEmails) return this.load(options);
      return state;
    }
    this.persistedSequence = row.sequence;
    const state: MailState = {version:row.version,context:JSON.parse(row.context),sequence:row.sequence,objects:Object.fromEntries((JSON.parse(row.object_types) as string[]).filter(type=>!['IngestReceipt','AutoCooldown'].includes(type)).map(type=>[type,{}])),changes:[],receipts:{},querySnapshots:{}};
    this.objects.clear(); this.changes.clear(); this.receipts.clear(); this.queries.clear();
    for (const item of this.storage.sql.exec<{type:string;id:string;json:string}>(this.partialEmails ? "SELECT type,id,json FROM mail_objects WHERE type!='Email'" : 'SELECT type,id,json FROM mail_objects')) {
      state.objects[item.type] ??= {};
      Object.defineProperty(state.objects[item.type], item.id, {value:JSON.parse(item.json),enumerable:true,writable:true,configurable:true});
      this.objects.set(encode([item.type,item.id]),item.json);
    }
    for (const item of this.storage.sql.exec<{sequence:number;json:string}>('SELECT sequence,json FROM mail_changes ORDER BY sequence')) {state.changes.push(JSON.parse(item.json));this.changes.set(item.sequence,item.json);}
    for (const item of this.storage.sql.exec<{id:string;json:string}>('SELECT id,json FROM mail_receipts')) {Object.defineProperty(state.receipts,item.id,{value:JSON.parse(item.json),enumerable:true,writable:true,configurable:true});this.receipts.set(item.id,item.json);}
    for (const item of this.storage.sql.exec<{id:string;json:string}>('SELECT id,json FROM mail_queries')) {Object.defineProperty(state.querySnapshots,item.id,{value:JSON.parse(item.json),enumerable:true,writable:true,configurable:true});this.queries.set(item.id,item.json);}
    return state;
  }
  commit(state: MailState, expectedSequence?: number, beforeCommit?: () => void): void {
    const objects = new Map<string,string>();
    for (const [type, values] of Object.entries(state.objects)) if(!['IngestReceipt','AutoCooldown'].includes(type)) for (const [id, object] of Object.entries(values)) objects.set(encode([type,id]),encode(type==='Email'?emailMetadata(object):object));
    const changes = new Map(state.changes.slice(-10000).map(change=>[change.sequence,encode(change)]));
    const receipts = new Map(Object.entries(state.receipts).slice(-10000).map(([id,value])=>[id,encode(value)]));
    const queries = new Map(Object.entries(state.querySnapshots).slice(-100).map(([id,value])=>[id,encode(value)]));
    this.storage.transactionSync(() => {
      if (expectedSequence !== undefined) {
        const persisted = [...this.storage.sql.exec<{sequence:number}>('SELECT sequence FROM mail_metadata WHERE id=1')][0];
        if (persisted?.sequence !== expectedSequence) throw new Error('revisionConflict: Mail account state changed');
      }
      beforeCommit?.();
      this.migratePrivateHistory(state);
      this.storage.sql.exec('INSERT INTO mail_metadata(id,version,context,sequence,object_types) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,context=excluded.context,sequence=excluded.sequence,object_types=excluded.object_types',state.version,encode(state.context),state.sequence,encode(Object.keys(state.objects).filter(type=>!['IngestReceipt','AutoCooldown'].includes(type))));
      if (this.partialEmails) for (const change of state.changes) if (change.type==='Email' && change.destroyed && change.sequence>this.persistedSequence) { this.storage.sql.exec("DELETE FROM mail_objects WHERE type='Email' AND id=?",change.id);this.storage.sql.exec("DELETE FROM mail_object_blob_refs WHERE type='Email' AND object_id=?",change.id);this.deleteEmailIndex(change.id); }
      for (const key of this.objects.keys()) if (!objects.has(key)) {const [type,id]=JSON.parse(key);if(this.partialEmails&&type==='Email')continue;this.storage.sql.exec('DELETE FROM mail_objects WHERE type=? AND id=?',type,id);this.storage.sql.exec('DELETE FROM mail_object_blob_refs WHERE type=? AND object_id=?',type,id);if(type==='Email')this.deleteEmailIndex(id);}
      for (const [key,json] of objects) if (this.objects.get(key)!==json) {const [type,id]=JSON.parse(key);if(type==='Email')this.indexEmail(state.objects[type][id]);this.storage.sql.exec('INSERT INTO mail_objects(type,id,json) VALUES(?,?,?) ON CONFLICT(type,id) DO UPDATE SET json=excluded.json',type,id,json);this.storage.sql.exec('DELETE FROM mail_object_blob_refs WHERE type=? AND object_id=?',type,id);this.storage.sql.exec("INSERT OR IGNORE INTO mail_object_blob_refs(type,object_id,blob_id) SELECT ?,?,part.value FROM json_tree(?) part WHERE part.key='blobId' AND part.type='text' AND part.value!=''",type,id,json);}
      this.sync('mail_changes','sequence',this.changes,changes);
      this.sync('mail_receipts','id',this.receipts,receipts);
      this.sync('mail_queries','id',this.queries,queries);
    });
    delete state.objects.IngestReceipt;delete state.objects.AutoCooldown;
    this.persistedSequence=state.sequence;
    this.objects=this.partialEmails ? new Map([...objects].filter(([key])=>JSON.parse(key)[0]!=='Email')) : objects;this.changes=changes;this.receipts=receipts;this.queries=queries;
  }
  private sync(table:string,column:string,previous:Map<string|number,string>,next:Map<string|number,string>) {
    for (const id of previous.keys()) if (!next.has(id)) this.storage.sql.exec(`DELETE FROM ${table} WHERE ${column}=?`,id);
    for (const [id,json] of next) if (previous.get(id)!==json) this.storage.sql.exec(`INSERT INTO ${table}(${column},json) VALUES(?,?) ON CONFLICT(${column}) DO UPDATE SET json=excluded.json`,id,json);
  }
  private deleteEmailIndex(id:string) {this.storage.sql.exec('DELETE FROM mail_email_index WHERE id=?',id);this.storage.sql.exec('DELETE FROM mail_search WHERE email_id=?',id);this.storage.sql.exec('DELETE FROM mail_email_references WHERE email_id=?',id);this.storage.sql.exec('DELETE FROM mail_body_chunks WHERE email_id=?',id);}
  private indexEmail(email:MailObject) {
    const subject=flatten(email.subject).toLowerCase(),sender=flatten(email.from).toLowerCase(),recipients=flatten(email.to).toLowerCase(),cc=flatten(email.cc).toLowerCase(),bcc=flatten(email.bcc).toLowerCase(),body=flatten([email.preview,email.body,email.text,email.textBody,email.htmlBody,email.bodyValues]).toLowerCase();
    const previous=[...this.storage.sql.exec<{json:string}>("SELECT json FROM mail_objects WHERE type='Email' AND id=?",email.id)][0];
    const sameBlob=typeof email.blobId==='string' && previous && JSON.parse(previous.json).blobId===email.blobId;
    const preserveBody=(sameBlob || Object.values(email.bodyValues??{}).some(part=>!!(part as {isTruncated?:boolean})?.isTruncated)) && [...this.storage.sql.exec<{id:string}>('SELECT id FROM mail_email_index WHERE id=?',email.id)].length>0;
    this.storage.sql.exec('DELETE FROM mail_email_references WHERE email_id=?',email.id);
    this.storage.sql.exec('INSERT INTO mail_email_index(id,received_at,sent_at,size,subject,sender,recipients,cc,bcc,body,has_attachment,thread_id,snooze_at,followup_at,trash_at,junk_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET received_at=excluded.received_at,sent_at=excluded.sent_at,size=excluded.size,subject=excluded.subject,sender=excluded.sender,recipients=excluded.recipients,cc=excluded.cc,bcc=excluded.bcc,body=CASE WHEN ? THEN mail_email_index.body ELSE excluded.body END,has_attachment=excluded.has_attachment,thread_id=excluded.thread_id,snooze_at=excluded.snooze_at,followup_at=excluded.followup_at,trash_at=excluded.trash_at,junk_at=excluded.junk_at',email.id,Date.parse(email.receivedAt)||0,Date.parse(email.sentAt)||0,email.size||0,subject,sender,recipients,cc,bcc,utf8Prefix(body,4096),Number(Boolean(email.hasAttachment)),email.threadId||email.id,Number.isFinite(Date.parse(email.snooze?.until))?Date.parse(email.snooze.until):null,Number.isFinite(Date.parse(email.followUp?.until))?Date.parse(email.followUp.until):null,email.mailboxIds?.['folder-trash']===true&&Number.isFinite(Date.parse(email.trashAt))?Date.parse(email.trashAt):null,email.mailboxIds?.['folder-junk']===true&&Number.isFinite(Date.parse(email.junkAt))?Date.parse(email.junkAt):null,Number(preserveBody));
    for (const reference of new Set([...(Array.isArray(email.messageId)?email.messageId:typeof email.messageId==='string'?[email.messageId]:[]),...(Array.isArray(email.references)?email.references:[]),...(Array.isArray(email.inReplyTo)?email.inReplyTo:[])])) if(typeof reference==='string') this.storage.sql.exec('INSERT INTO mail_email_references(email_id,value) VALUES(?,?)',email.id,reference);
    if(preserveBody)this.storage.sql.exec('UPDATE mail_search SET subject=?,sender=?,recipients=? WHERE email_id=?',subject,sender,[recipients,cc,bcc].join(' '),email.id);
    else {
      this.storage.sql.exec('DELETE FROM mail_search WHERE email_id=?',email.id);this.storage.sql.exec('DELETE FROM mail_body_chunks WHERE email_id=?',email.id);
      const leaves=[...new Set([...(email.textBody??[]),...(email.htmlBody??[])].map(part=>part.blobId).filter(id=>typeof id==='string'))];
      const finished=leaves.length?Number([...this.storage.sql.exec<{total:number}>("SELECT count(*) AS total FROM mail_blob_text_cache WHERE status='complete' AND blob_id IN (SELECT value FROM json_each(?))",encode(leaves))][0]?.total??0):0;
      if(finished){
        this.storage.sql.exec("INSERT INTO mail_body_chunks(email_id,position,body) SELECT ?,row_number() OVER (ORDER BY c.blob_id,c.position)-1,c.body FROM mail_blob_text_chunks c JOIN mail_blob_text_cache m ON m.blob_id=c.blob_id AND m.status='complete' WHERE c.blob_id IN (SELECT value FROM json_each(?))",email.id,encode(leaves));
        this.storage.sql.exec("INSERT INTO mail_search(email_id,subject,body,sender,recipients) SELECT ?,CASE WHEN position=0 THEN ? ELSE '' END,body,CASE WHEN position=0 THEN ? ELSE '' END,CASE WHEN position=0 THEN ? ELSE '' END FROM mail_body_chunks WHERE email_id=?",email.id,subject,sender,[recipients,cc,bcc].join(' '),email.id);
      } else {
        let position=0;for(const chunk of bodyChunks(body)){
          this.storage.sql.exec('INSERT INTO mail_body_chunks(email_id,position,body) VALUES(?,?,?)',email.id,position,chunk);
          this.storage.sql.exec('INSERT INTO mail_search(email_id,subject,body,sender,recipients) VALUES(?,?,?,?,?)',email.id,position===0?subject:'',chunk,position===0?sender:'',position===0?[recipients,cc,bcc].join(' '):'');position++;
        }
      }
    }
  }
  /** Fetches at most 1,000 emails; a partial authority never hydrates the whole account. */
  readEmails(input: {ids?:string[];threadIds?:string[];messageReference?:string;dueBefore?:number;limit?:number;offset?:number} = {}): MailObject[] {
    const terms = ["e.type='Email'"]; const bindings:unknown[]=[];
    if (input.ids) { if(input.ids.length>1000)throw new Error('Too many email IDs');terms.push('e.id IN (SELECT value FROM json_each(?))');bindings.push(JSON.stringify(input.ids)); }
    if (input.threadIds) { if(input.threadIds.length>1000)throw new Error('Too many thread IDs');terms.push('i.thread_id IN (SELECT value FROM json_each(?))');bindings.push(JSON.stringify(input.threadIds)); }
    if (input.messageReference!==undefined) {terms.push('e.id IN (SELECT email_id FROM mail_email_references WHERE value=?)');bindings.push(input.messageReference);}
    if (input.dueBefore!==undefined) {if(!Number.isFinite(input.dueBefore))throw new Error('Invalid due time');terms.push('(i.snooze_at<=? OR i.followup_at<=?)');bindings.push(input.dueBefore,input.dueBefore);}
    const limit=input.limit??1000,offset=input.offset??0;
    if(!Number.isSafeInteger(limit)||limit<0||!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid email page');
    if(input.ids && !input.threadIds && input.messageReference===undefined && input.dueBefore===undefined) {
      const rank=new Map(input.ids.map((id,index)=>[id,index]));
      return [...this.storage.sql.exec<{json:string}>("SELECT json FROM mail_objects WHERE type='Email' AND id IN (SELECT value FROM json_each(?))",JSON.stringify(input.ids))].map(row=>JSON.parse(row.json) as MailObject).sort((a,b)=>(rank.get(a.id)??0)-(rank.get(b.id)??0)).slice(offset,offset+Math.min(limit,1000));
    }
    return [...this.storage.sql.exec<{json:string}>(`SELECT e.json FROM mail_objects e JOIN mail_email_index i ON i.id=e.id WHERE ${terms.join(' AND ')} ORDER BY ${input.dueBefore===undefined?'i.received_at DESC':"min(COALESCE(i.snooze_at,1e300),COALESCE(i.followup_at,1e300)) ASC"},e.id ASC LIMIT ? OFFSET ?`,...bindings,Math.min(limit,1000),offset)].map(row=>JSON.parse(row.json));
  }
  liveThreadIds(ids:string[]):string[]{
    if(ids.length>1000)throw new Error('Too many threads');if(!ids.length)return [];
    return [...this.storage.sql.exec<{thread_id:string}>('SELECT DISTINCT thread_id FROM mail_email_index WHERE thread_id IN (SELECT value FROM json_each(?))',JSON.stringify(ids))].map(row=>row.thread_id);
  }
  nextEmailAlarm(): number | null {
    const row=[...this.storage.sql.exec<{deadline:number|null}>("SELECT min(deadline) AS deadline FROM (SELECT min(snooze_at) AS deadline FROM mail_email_index UNION ALL SELECT min(followup_at) AS deadline FROM mail_email_index)")][0];
    return row?.deadline??null;
  }
  mailboxCounts(id:string): {totalEmails:number;unreadEmails:number;totalThreads:number;unreadThreads:number} {
    const row=[...this.storage.sql.exec<{totalEmails:number;unreadEmails:number;totalThreads:number;unreadThreads:number}>(`SELECT count(*) AS totalEmails, COALESCE(sum(CASE WHEN NOT EXISTS (SELECT 1 FROM json_each(e.json,'$.keywords') k WHERE k.key='$seen' AND k.value=1) THEN 1 ELSE 0 END),0) AS unreadEmails, count(DISTINCT i.thread_id) AS totalThreads, count(DISTINCT CASE WHEN NOT EXISTS (SELECT 1 FROM json_each(e.json,'$.keywords') k WHERE k.key='$seen' AND k.value=1) THEN i.thread_id END) AS unreadThreads FROM mail_objects e JOIN mail_email_index i ON i.id=e.id WHERE e.type='Email' AND EXISTS (SELECT 1 FROM json_each(e.json,'$.mailboxIds') m WHERE m.key=? AND m.value=1)`,id)][0];
    return row??{totalEmails:0,unreadEmails:0,totalThreads:0,unreadThreads:0};
  }
  /** SQL snapshot preserves original blob and membership while concurrent mail changes continue. */
  createExport(jobId:string,actorId:string,filter?:EmailFilter): {total:number} {
    if(!jobId||!actorId)throw new Error('Export job and actor are required');
    const {where,bindings}=this.filterSql(filter);const filterJson=encode(filter??{});
    return this.storage.transactionSync(()=>{
      const existing=[...this.storage.sql.exec<{actor_id:string;filter_json:string;total:number}>('SELECT actor_id,filter_json,total FROM mail_export_jobs WHERE id=?',jobId)][0];
      if(existing){if(existing.actor_id!==actorId||existing.filter_json!==filterJson)throw new Error('Export job ID already used');return {total:existing.total};}
      const count=Number([...this.storage.sql.exec<{total:number}>('SELECT count(*) AS total FROM mail_export_jobs')][0]?.total??0);
      if(count>=2)throw new Error('tooManyExportJobs: Cancel an existing export before starting another');
      this.storage.sql.exec(`INSERT INTO mail_export_items(job_id,position,id,blob_id,received_at,keywords_json,mailboxes_json) SELECT ?,row_number() OVER (ORDER BY i.received_at DESC,e.id ASC)-1,e.id,COALESCE(json_extract(e.json,'$.blobId'),''),COALESCE(json_extract(e.json,'$.receivedAt'),''),COALESCE(json_extract(e.json,'$.keywords'),'{}'),COALESCE(json_extract(e.json,'$.mailboxIds'),'{}') FROM mail_objects e JOIN mail_email_index i ON i.id=e.id WHERE e.type='Email' AND ${where}`,jobId,...bindings);
      const total=Number([...this.storage.sql.exec<{total:number}>('SELECT count(*) AS total FROM mail_export_items WHERE job_id=?',jobId)][0]?.total??0);
      this.storage.sql.exec('INSERT INTO mail_export_jobs(id,actor_id,filter_json,total,created_at) VALUES(?,?,?,?,?)',jobId,actorId,filterJson,total,Date.now());
      return {total};
    });
  }
  exportPage(jobId:string,position=0,limit=100): {list:{id:string;blobId:string;receivedAt:string;keywords:Record<string,boolean>;mailboxIds:Record<string,boolean>}[];total:number;nextPosition:number;hasMore:boolean} {
    if(!Number.isSafeInteger(position)||position<0||!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid export page');
    const job=[...this.storage.sql.exec<{total:number}>('SELECT total FROM mail_export_jobs WHERE id=?',jobId)][0];
    if(!job)throw new Error('notFound: Export job does not exist');
    const list=[...this.storage.sql.exec<{id:string;blob_id:string;received_at:string;keywords_json:string;mailboxes_json:string}>('SELECT id,blob_id,received_at,keywords_json,mailboxes_json FROM mail_export_items WHERE job_id=? AND position>=? ORDER BY position LIMIT ?',jobId,position,Math.min(limit,100))].map(row=>({id:row.id,blobId:row.blob_id,receivedAt:row.received_at,keywords:JSON.parse(row.keywords_json),mailboxIds:JSON.parse(row.mailboxes_json)}));
    const nextPosition=Math.min(job.total,position+list.length);
    return {list,total:job.total,nextPosition,hasMore:nextPosition<job.total};
  }
  cancelExport(jobId:string): void {
    this.storage.transactionSync(()=>{this.storage.sql.exec('DELETE FROM mail_export_items WHERE job_id=?',jobId);this.storage.sql.exec('DELETE FROM mail_export_jobs WHERE id=?',jobId);});
  }
  private retentionDays(settings:{trashRetentionDays?:number;junkRetentionDays?:number}): [number,number] {
    const days=[settings.trashRetentionDays??30,settings.junkRetentionDays??30];
    if(days.some(value=>!Number.isInteger(value)||value<1||value>3650))throw new Error('Invalid retention days');
    return [days[0]*86400000,days[1]*86400000];
  }
  readRetentionDue(settings:{trashRetentionDays?:number;junkRetentionDays?:number}={},now=Date.now(),limit=100): MailObject[] {
    if(!Number.isFinite(now)||!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid retention batch');
    const [trash,junk]=this.retentionDays(settings);
    return [...this.storage.sql.exec<{json:string}>("SELECT e.json FROM mail_objects e JOIN mail_email_index i ON i.id=e.id WHERE e.type='Email' AND (i.trash_at<=? OR i.junk_at<=?) ORDER BY min(COALESCE(i.trash_at+?,1e300),COALESCE(i.junk_at+?,1e300)),e.id LIMIT ?",now-trash,now-junk,trash,junk,Math.min(limit,100))].map(row=>JSON.parse(row.json));
  }
  nextRetentionDeadline(settings:{trashRetentionDays?:number;junkRetentionDays?:number}={}): number|null {
    const [trash,junk]=this.retentionDays(settings);
    return [...this.storage.sql.exec<{deadline:number|null}>('SELECT min(deadline) AS deadline FROM (SELECT min(trash_at)+? AS deadline FROM mail_email_index UNION ALL SELECT min(junk_at)+? AS deadline FROM mail_email_index)',trash,junk)][0]?.deadline??null;
  }
  /** Account lifecycle calls this only after deleting every R2 key. Lifecycle audit remains available. */
  purgeBatchRows(maxRows=100): {deleted:number;done:boolean} {
    if(!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>100)throw new Error('Invalid metadata purge batch');
    const tables=['mail_pending_automations','mail_content_sources','mail_prepared_email','mail_object_blob_refs','mail_blob_text_chunks','mail_blob_text_cache','mail_body_chunks','mail_search','mail_email_references','mail_email_index','mail_objects','mail_ingest_receipts','mail_vacation_cooldowns','mail_email_delivery','mail_changes','mail_receipts','mail_queries','mail_export_items','mail_export_jobs','mail_rule_apply_items','mail_rule_apply_jobs','mail_scan_jobs','mail_gc_jobs','mail_forward_status','mail_blob_security','mail_migration_receipts','mail_migration_item_results','mail_migration_jobs','mail_blob_registry','mail_quota','mail_account_legacy_archive','mail_account','mail_metadata'];
    const present=new Set([...this.storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table'")].map(row=>row.name));
    const result=this.storage.transactionSync(()=>{
      let deleted=0;
      for(const table of tables)if(present.has(table)&&deleted<maxRows){const ids=[...this.storage.sql.exec<{purge_rowid:number}>(`SELECT rowid AS purge_rowid FROM ${table} LIMIT ?`,maxRows-deleted)].map(row=>row.purge_rowid);if(ids.length){this.storage.sql.exec(`DELETE FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?))`,encode(ids));deleted+=ids.length;}}
      const done=!tables.some(table=>present.has(table)&&[...this.storage.sql.exec(`SELECT 1 FROM ${table} LIMIT 1`)].length>0);
      return {deleted,done};
    });
    if(result.done){this.objects.clear();this.changes.clear();this.receipts.clear();this.queries.clear();this.persistedSequence=0;}
    return result;
  }
  createRuleApplyJob(id:string,actor:string,serializedRules:string): {total:number;cursor:number;status:string} {
    if(!id||!actor||!Array.isArray(JSON.parse(serializedRules)))throw new Error('Invalid rule job');
    return this.storage.transactionSync(()=>{
      const previous=[...this.storage.sql.exec<{actor_id:string;rules_json:string;total:number;cursor:number;status:string}>('SELECT * FROM mail_rule_apply_jobs WHERE id=?',id)][0];
      if(previous){if(previous.actor_id!==actor||previous.rules_json!==serializedRules)throw new Error('Rule job ID reused');return {total:previous.total,cursor:previous.cursor,status:previous.status};}
      this.storage.sql.exec("DELETE FROM mail_rule_apply_items WHERE job_id IN (SELECT id FROM mail_rule_apply_jobs WHERE status='complete')");this.storage.sql.exec("DELETE FROM mail_rule_apply_jobs WHERE status='complete'");
      if(Number([...this.storage.sql.exec<{total:number}>('SELECT count(*) AS total FROM mail_rule_apply_jobs')][0]?.total??0)>=2)throw new Error('tooManyRuleJobs');
      this.storage.sql.exec("INSERT INTO mail_rule_apply_items(job_id,position,email_id) SELECT ?,row_number() OVER (ORDER BY i.received_at DESC,e.id)-1,e.id FROM mail_objects e JOIN mail_email_index i ON i.id=e.id WHERE e.type='Email'",id);
      const total=Number([...this.storage.sql.exec<{total:number}>('SELECT count(*) AS total FROM mail_rule_apply_items WHERE job_id=?',id)][0]?.total??0);
      this.storage.sql.exec("INSERT INTO mail_rule_apply_jobs VALUES(?,?,?,0,?,?)",id,actor,serializedRules,total,total?'pending':'complete');return {total,cursor:0,status:total?'pending':'complete'};
    });
  }
  ruleApplyPage(id:string,actor:string,limit=100): {ids:string[];rules:unknown[];cursor:number;nextCursor:number;total:number;hasMore:boolean} {
    if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid rule batch');
    const job=[...this.storage.sql.exec<{rules_json:string;cursor:number;total:number}>('SELECT rules_json,cursor,total FROM mail_rule_apply_jobs WHERE id=? AND actor_id=?',id,actor)][0];if(!job)throw new Error('notFound: Rule job');
    const ids=[...this.storage.sql.exec<{email_id:string}>('SELECT email_id FROM mail_rule_apply_items WHERE job_id=? AND position>=? ORDER BY position LIMIT ?',id,job.cursor,Math.min(limit,100))].map(row=>row.email_id);
    const nextCursor=job.cursor+ids.length;return {ids,rules:JSON.parse(job.rules_json),cursor:job.cursor,nextCursor,total:job.total,hasMore:nextCursor<job.total};
  }
  advanceRuleApplyJob(id:string,actor:string,expectedCursor:number,nextCursor:number): void {
    const job=[...this.storage.sql.exec<{cursor:number;total:number}>('SELECT cursor,total FROM mail_rule_apply_jobs WHERE id=? AND actor_id=?',id,actor)][0];
    if(!job)throw new Error('notFound: Rule job');if(job.cursor!==expectedCursor)throw new Error('revisionConflict: Rule cursor changed');if(!Number.isSafeInteger(nextCursor)||nextCursor<expectedCursor||nextCursor>Math.min(job.total,expectedCursor+100))throw new Error('Invalid rule cursor');
    this.storage.sql.exec('UPDATE mail_rule_apply_jobs SET cursor=?,status=? WHERE id=? AND actor_id=? AND cursor=?',nextCursor,nextCursor===job.total?'complete':'pending',id,actor,expectedCursor);
  }
  cancelRuleApplyJob(id:string,actor:string): void {
    this.storage.transactionSync(()=>{if(![...this.storage.sql.exec('SELECT id FROM mail_rule_apply_jobs WHERE id=? AND actor_id=?',id,actor)].length)throw new Error('notFound: Rule job');this.storage.sql.exec('DELETE FROM mail_rule_apply_items WHERE job_id=?',id);this.storage.sql.exec('DELETE FROM mail_rule_apply_jobs WHERE id=? AND actor_id=?',id,actor);});
  }
  /** Includes submission snapshots and export snapshots, so draft edits/deletion cannot collect their bytes. */
  referencedBlobs(ids:string[]): string[] {
    if(ids.length>100||ids.some(id=>typeof id!=='string'||!id))throw new Error('Invalid blob reference batch');
    if(!ids.length)return [];
    const requested=encode(ids);const bindings:unknown[]=[requested,requested];
    const sources=['SELECT blob_id FROM mail_object_blob_refs WHERE blob_id IN (SELECT value FROM json_each(?))','SELECT blob_id FROM mail_export_items WHERE blob_id IN (SELECT value FROM json_each(?))'];
    if([...this.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_scan_jobs'")].length){sources.push("SELECT blob_id FROM mail_scan_jobs WHERE status='pending' AND blob_id IN (SELECT value FROM json_each(?))");bindings.push(requested);}
    return [...this.storage.sql.exec<{blob_id:string}>(sources.join(' UNION '),...bindings)].map(row=>row.blob_id);
  }
  private prunePrivateHistory(now=Date.now()): void {
    this.storage.sql.exec('DELETE FROM mail_ingest_receipts WHERE id IN (SELECT id FROM mail_ingest_receipts ORDER BY created_at DESC,id LIMIT -1 OFFSET 10000)');
    // Vacation settings permit an interval as long as 365 days; retaining fewer days would send early replies.
    this.storage.sql.exec('DELETE FROM mail_vacation_cooldowns WHERE at_ms<?',now-365*86400000);
    this.storage.sql.exec('DELETE FROM mail_vacation_cooldowns WHERE address IN (SELECT address FROM mail_vacation_cooldowns ORDER BY at_ms DESC,address LIMIT -1 OFFSET 10000)');
  }
  private migrateStoredPrivateHistory(): void {
    this.storage.sql.exec("INSERT OR IGNORE INTO mail_ingest_receipts(id,email_id,blob_id,received_at,created_at) SELECT id,json_extract(json,'$.emailId'),json_extract(json,'$.blobId'),json_extract(json,'$.receivedAt'),COALESCE(unixepoch(json_extract(json,'$.receivedAt'))*1000,0) FROM mail_objects WHERE type='IngestReceipt' AND json_type(json,'$.emailId')='text' AND json_type(json,'$.blobId')='text' AND json_type(json,'$.receivedAt')='text'");
    this.storage.sql.exec("INSERT INTO mail_vacation_cooldowns(address,at,at_ms) SELECT lower(id),json_extract(json,'$.at'),unixepoch(json_extract(json,'$.at'))*1000 FROM mail_objects WHERE type='AutoCooldown' AND unixepoch(json_extract(json,'$.at')) IS NOT NULL ON CONFLICT(address) DO UPDATE SET at=excluded.at,at_ms=excluded.at_ms WHERE excluded.at_ms>mail_vacation_cooldowns.at_ms");
    this.storage.sql.exec("DELETE FROM mail_object_blob_refs WHERE type IN ('IngestReceipt','AutoCooldown')");
    this.storage.sql.exec("DELETE FROM mail_objects WHERE type IN ('IngestReceipt','AutoCooldown')");
    this.prunePrivateHistory();
  }
  /** Call only within commit's transaction. The canonical state collections are no longer persisted. */
  migratePrivateHistory(state:MailState): void {
    const ingest=Object.values(state.objects.IngestReceipt??{}),cooldowns=Object.values(state.objects.AutoCooldown??{});
    for(const item of ingest){if(!item.id||!item.emailId||!item.blobId||!Number.isFinite(Date.parse(item.receivedAt)))throw new Error('Invalid historical ingress receipt');this.storage.sql.exec('INSERT OR IGNORE INTO mail_ingest_receipts(id,email_id,blob_id,received_at,created_at) VALUES(?,?,?,?,?)',item.id,item.emailId,item.blobId,item.receivedAt,Date.parse(item.receivedAt));}
    for(const item of cooldowns){const timestamp=Date.parse(item.at);if(!item.id||!Number.isFinite(timestamp))throw new Error('Invalid historical vacation cooldown');this.storage.sql.exec('INSERT INTO mail_vacation_cooldowns(address,at,at_ms) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET at=excluded.at,at_ms=excluded.at_ms WHERE excluded.at_ms>mail_vacation_cooldowns.at_ms',item.id.toLowerCase(),item.at,timestamp);}
    if(ingest.length||cooldowns.length)this.prunePrivateHistory();
  }
  ingestReceipt(id:string): {emailId:string;blobId:string;receivedAt:string}|null {
    const row=[...this.storage.sql.exec<{email_id:string;blob_id:string;received_at:string}>('SELECT email_id,blob_id,received_at FROM mail_ingest_receipts WHERE id=?',id)][0];
    return row?{emailId:row.email_id,blobId:row.blob_id,receivedAt:row.received_at}:null;
  }
  /** Stage this call in beforeCommit so ingress content and replay receipt have one durable outcome. */
  recordIngestReceipt(id:string,receipt:{emailId:string;blobId:string;receivedAt:string}): void {
    if(!id||id.length>200||!receipt.emailId||!receipt.blobId||!Number.isFinite(Date.parse(receipt.receivedAt)))throw new Error('Invalid ingress receipt');
    const previous=this.ingestReceipt(id);
    if(previous){if(previous.emailId!==receipt.emailId||previous.blobId!==receipt.blobId)throw new Error('Ingress delivery ID reused');return;}
    this.storage.sql.exec('INSERT INTO mail_ingest_receipts(id,email_id,blob_id,received_at,created_at) VALUES(?,?,?,?,?)',id,receipt.emailId,receipt.blobId,receipt.receivedAt,Date.now());
    this.storage.sql.exec('DELETE FROM mail_ingest_receipts WHERE id IN (SELECT id FROM mail_ingest_receipts ORDER BY created_at DESC,id LIMIT -1 OFFSET 10000)');
  }
  vacationCooldown(address:string,now=Date.now()): string|null {
    if(!Number.isFinite(now))throw new Error('Invalid cooldown time');
    return [...this.storage.sql.exec<{at:string}>('SELECT at FROM mail_vacation_cooldowns WHERE address=? AND at_ms>=?',address.toLowerCase(),now-365*86400000)][0]?.at??null;
  }
  recordVacationCooldown(address:string,at:string): void {
    const timestamp=Date.parse(at);if(!address||address.length>320||!Number.isFinite(timestamp))throw new Error('Invalid vacation cooldown');
    this.storage.sql.exec('INSERT INTO mail_vacation_cooldowns(address,at,at_ms) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET at=excluded.at,at_ms=excluded.at_ms WHERE excluded.at_ms>mail_vacation_cooldowns.at_ms',address.toLowerCase(),at,timestamp);
    this.prunePrivateHistory();
  }
  /** Opaque delivery state has its own baseline; historical imports cannot identify actual arrivals. */
  emailDeliveryState(): string {
    const sequence=[...this.storage.sql.exec<{sequence:number}>('SELECT sequence FROM mail_email_delivery WHERE id=1')][0]?.sequence??0;
    return `d${sequence.toString(36)}`;
  }
  /** Call via beforeCommit only for a newly accepted ingress, never imports, edits or replayed delivery IDs. */
  recordEmailDelivery(): string {
    this.storage.sql.exec('UPDATE mail_email_delivery SET sequence=sequence+1 WHERE id=1');return this.emailDeliveryState();
  }
  /** Private immutable leaf cache. Parse writes are staged before the canonical Email transaction. */
  appendBlobTextChunk(blobId:string,index:number,text:string): void {
    if(!/^[\w.:-]{1,200}$/.test(blobId)||!Number.isSafeInteger(index)||index<0||new TextEncoder().encode(text).length>256*1024)throw new Error('Invalid text cache chunk');
    this.storage.transactionSync(()=>{
      let cache=[...this.storage.sql.exec<{status:string;next_index:number;tail:string}>('SELECT status,next_index,tail FROM mail_blob_text_cache WHERE blob_id=?',blobId)][0];
      if(!cache){if(index!==0)throw new Error('Text cache chunks must be sequential');this.storage.sql.exec("INSERT INTO mail_blob_text_cache(blob_id,status,next_index,tail,checksum) VALUES(?,'pending',0,'',NULL)",blobId);cache={status:'pending',next_index:0,tail:''};}
      if(cache.status!=='pending'||cache.next_index!==index)throw new Error('Text cache is immutable or chunk is out of sequence');
      let part=0;for(const body of bodyChunks(cache.tail+text))this.storage.sql.exec('INSERT INTO mail_blob_text_chunks(blob_id,position,body) VALUES(?,?,?)',blobId,index*2+part++,body);
      // At least 4096 Unicode characters overlap between parent decoder chunks, bounded to 16KiB.
      const codepoints=Array.from(text.length>=8192?text.slice(-8192):cache.tail+text);const tail=codepoints.slice(-4096).join('');
      this.storage.sql.exec('UPDATE mail_blob_text_cache SET next_index=?,tail=? WHERE blob_id=?',index+1,tail,blobId);
    });
  }
  finalizeBlobText(blobId:string,checksum:string): void {
    if(!/^[\w.:-]{1,200}$/.test(blobId)||!checksum||checksum.length>200)throw new Error('Invalid text cache checksum');
    this.storage.transactionSync(()=>{
      const existing=[...this.storage.sql.exec<{status:string;checksum:string|null}>('SELECT status,checksum FROM mail_blob_text_cache WHERE blob_id=?',blobId)][0];
      if(!existing){this.appendBlobTextChunk(blobId,0,'');}
      else if(existing.status==='complete'){if(existing.checksum!==checksum)throw new Error('Immutable text cache checksum mismatch');return;}
      this.storage.sql.exec("UPDATE mail_blob_text_cache SET status='complete',checksum=?,tail='' WHERE blob_id=?",checksum,blobId);
    });
  }
  blobTextComplete(blobId:string): boolean {
    return [...this.storage.sql.exec("SELECT 1 FROM mail_blob_text_cache WHERE blob_id=? AND status='complete'",blobId)].length>0;
  }
  deleteBlobText(blobId:string): void {
    this.storage.transactionSync(()=>{this.storage.sql.exec('DELETE FROM mail_blob_text_chunks WHERE blob_id=?',blobId);this.storage.sql.exec('DELETE FROM mail_blob_text_cache WHERE blob_id=?',blobId);});
  }
  private filterSql(input?:EmailFilter): {where:string;bindings:unknown[]} {
    validateFilter(input||{});
    const checkText=(filter:EmailFilter):void=>{for(const field of ['text','body'])if(typeof filter[field as keyof EmailFilter]==='string'&&Array.from(filter[field as keyof EmailFilter] as string).length>4096)throw new Error('Search text exceeds 4096 characters');for(const nested of filter.conditions??[])checkText(nested);};checkText(input??{});
    const bindings:unknown[]=[];
    const bind=(value:unknown)=>{bindings.push(value);return '?';};
    const mapFlag=(field:string,key:string,alias='e')=>`EXISTS (SELECT 1 FROM json_each(${alias}.json, '$.${field}') flag WHERE flag.key=${bind(key)} AND flag.value=1)`;
    const filter=(input:EmailFilter):string=>{
      if(input.operator){const parts=input.conditions!.map(filter);return input.operator==='NOT'?`NOT (${parts.join(' OR ')})`:`(${parts.join(input.operator==='AND'?' AND ':' OR ')})`;}
      const terms:string[]=[];
      for(const [key,value] of Object.entries(input)) {
        const fields:Record<string,string>={from:'sender',to:'recipients',cc:'cc',bcc:'bcc',subject:'subject'};
        if(fields[key])terms.push(`i.${fields[key]} LIKE ${bind(like(String(value).toLowerCase()))} ESCAPE '\\'`);
        else if(key==='body')terms.push(`(EXISTS (SELECT 1 FROM mail_body_chunks chunk WHERE chunk.email_id=e.id AND chunk.body LIKE ${bind(like(String(value).toLowerCase()))} ESCAPE '\\') OR i.body LIKE ${bind(like(String(value).toLowerCase()))} ESCAPE '\\')`);
        else if(key==='text')terms.push(`e.id IN (SELECT email_id FROM mail_search WHERE mail_search MATCH ${bind('"'+String(value).replaceAll('"','""')+'"')})`);
        else if(key==='inMailbox')terms.push(mapFlag('mailboxIds',String(value)));
        else if(key==='notInMailbox')for(const id of value as string[])terms.push(`NOT ${mapFlag('mailboxIds',id)}`);
        else if(key==='hasKeyword')terms.push(mapFlag('keywords',String(value)));
        else if(key==='notKeyword')terms.push(`NOT ${mapFlag('keywords',String(value))}`);
        else if(key==='before'||key==='after')terms.push(`i.received_at ${key==='before'?'<':'>='} ${bind(Date.parse(String(value)))}`);
        else if(key==='minSize'||key==='maxSize')terms.push(`i.size ${key==='minSize'?'>=':'<'} ${bind(value)}`);
        else if(key==='isSnoozed'||key==='isFollowUp')terms.push(`COALESCE(json_type(e.json, '$.${key==='isSnoozed'?'snooze':'followUp'}')='object',0) IS ${bind(Number(value))}`);
        else if(key==='hasAttachment')terms.push(`i.has_attachment=${bind(Number(value))}`);
        else if(key==='attachmentName')terms.push(`EXISTS (SELECT 1 FROM json_each(e.json,'$.attachments') attachment WHERE lower(json_extract(attachment.value,'$.name')) LIKE ${bind(like(String(value).toLowerCase()))} ESCAPE '\\')`);
        else if(key==='header'){const [name,needle]=value as [string,string?];terms.push(`EXISTS (SELECT 1 FROM json_each(e.json,'$.headers') header WHERE lower(json_extract(header.value,'$.name'))=${bind(name.toLowerCase())}${needle===undefined?'':` AND lower(json_extract(header.value,'$.value')) LIKE ${bind(like(needle.toLowerCase()))} ESCAPE '\\'`})`);}
      }
      return terms.length?`(${terms.join(' AND ')})`:'1';
    };
    return {where:filter(input||{}),bindings};
  }
  /** Indexed, bounded query seam. Text uses literal FTS phrases; field filters use literal substring matches. */
  queryEmails(query:EmailQuery = {}): {ids:string[];total:number;position:number} {
    const {where,bindings}=this.filterSql(query.filter);
    const bind=(value:unknown)=>{bindings.push(value);return '?';};
    const mapFlag=(field:string,key:string,alias='e')=>`EXISTS (SELECT 1 FROM json_each(${alias}.json, '$.${field}') flag WHERE flag.key=${bind(key)} AND flag.value=1)`;
    const base=`FROM mail_objects e JOIN mail_email_index i ON i.id=e.id WHERE e.type='Email' AND ${where}`;
    const total=Number([...this.storage.sql.exec<{total:number}>(`SELECT count(*) AS total ${base}`,...bindings)][0]?.total||0);
    const sortBindingsStart=bindings.length;
    const orders=(query.sort?.length?query.sort:[{property:'receivedAt',isAscending:false}]).map(comparator=>{
      if(comparator.isAscending!==undefined&&typeof comparator.isAscending!=='boolean')throw new Error('Invalid sort direction');
      const fields:Record<string,string>={receivedAt:'i.received_at',sentAt:'i.sent_at',size:'i.size',subject:'i.subject',from:'i.sender',to:'i.recipients',cc:'i.cc',id:'e.id'};
      let expression=fields[comparator.property];
      if(['hasKeyword','someInThreadHaveKeyword','allInThreadHaveKeyword'].includes(comparator.property)){
        if(!comparator.keyword)throw new Error('Keyword sorting requires a keyword');
        const has=mapFlag('keywords',comparator.keyword,comparator.property==='hasKeyword'?'e':'member');
        expression=comparator.property==='hasKeyword'?`(${has})`:comparator.property==='someInThreadHaveKeyword'?`EXISTS (SELECT 1 FROM mail_objects member JOIN mail_email_index mi ON mi.id=member.id WHERE member.type='Email' AND mi.thread_id=i.thread_id AND ${has})`:`NOT EXISTS (SELECT 1 FROM mail_objects member JOIN mail_email_index mi ON mi.id=member.id WHERE member.type='Email' AND mi.thread_id=i.thread_id AND NOT ${has})`;
      }
      if(!expression)throw new Error(`Unsupported sort property: ${comparator.property}`);
      return `${expression} ${comparator.isAscending===false?'DESC':'ASC'}`;
    });
    let position=query.position??0;
    if(!Number.isSafeInteger(position))throw new Error('Invalid query position');
    if(position<0)position=Math.max(0,total+position);
    if(query.anchor){const found=[...this.storage.sql.exec<{position:number}>(`SELECT position FROM (SELECT e.id,row_number() OVER (ORDER BY ${[...orders,'e.id ASC'].join(',')})-1 AS position ${base}) WHERE id=?`,...bindings.slice(sortBindingsStart),...bindings.slice(0,sortBindingsStart),query.anchor)][0];if(!found)throw new Error('anchorNotFound');position=Math.max(0,found.position+(query.anchorOffset??0));}
    const limit=query.limit??100;
    if(!Number.isSafeInteger(limit)||limit<0)throw new Error('Invalid query limit');
    // WHERE bindings precede ORDER bindings in the generated statement.
    const ids=[...this.storage.sql.exec<{id:string}>(`SELECT e.id ${base} ORDER BY ${[...orders,'e.id ASC'].join(',')} LIMIT ? OFFSET ?`,...bindings.slice(0,sortBindingsStart),...bindings.slice(sortBindingsStart),Math.min(limit,1000),position)].map(row=>row.id);
    return {ids,total,position};
  }
}
