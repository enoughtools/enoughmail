import type { MailSqlStorage } from './store';

export interface MigrationMailbox { id:string; name:string; parentId?:string|null; role?:string|null; }
export interface MailMigrationJob { id:string; actorId:string; sourceUrl:string; state:'pending'|'running'|'failed'|'completed'|'cancelled'; phase:'discover'|'mailboxes'|'emails'|'done'; cursor:number; imported:number; duplicates:number; total:number|null; createdAt:number; updatedAt:number; error?:string; }
interface SavedJob extends MailMigrationJob { secret?:{iv:number[]; ciphertext:number[]}; sourceAccountId?:string; apiUrl?:string; downloadUrl?:string; queryState?:string; mapping:Record<string,string>; lease?:string; leaseUntil?:number; }
export interface MigrationCallbacks {
  importRaw(raw:Uint8Array, metadata:{sourceEmailId:string; operationId:string; mailboxIds:Record<string,boolean>; keywords:Record<string,boolean>; receivedAt?:string}):Promise<{id:string;isDuplicate?:boolean}>;
  createMailbox(box:MigrationMailbox, parentId:string|null, operationId:string):Promise<string>;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const coreCapability='urn:ietf:params:jmap:core',mailCapability='urn:ietf:params:jmap:mail';
/** Strict origin confinement: neither discovery, API, downloads nor redirects may move credentials. */
export function migrationSourceUrl(value:string, origin?:string):URL {
  let url:URL;try{url=new URL(value);}catch{throw new Error('Use a public HTTPS JMAP session URL.');}
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')||!host.includes('.')||host.endsWith('.')||/^[\d.]+$/.test(host)||host.includes(':')||/(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(host)|| (origin&&url.origin!==origin))throw new Error('Use a public HTTPS JMAP URL on the same source origin.');
  return url;
}
async function bytes(response:Response,limit:number):Promise<Uint8Array>{
  if(!response.ok||response.status>=300)throw new Error('The source rejected the request. Check source access and credentials.');
  const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>limit))throw new Error('The source response exceeds the migration size limit.');
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let count=0;
  try{if(reader)while(true){const next=await reader.read();if(next.done)break;count+=next.value.byteLength;if(count>limit){await reader.cancel();throw new Error('The source response exceeds the migration size limit.');}chunks.push(next.value);}}finally{reader?.releaseLock();}
  const value=new Uint8Array(count);let offset=0;for(const chunk of chunks){value.set(chunk,offset);offset+=chunk.byteLength;}return value;
}
async function digest(value:string){return new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));}
async function operationId(value:string){const hash=await digest(value);hash[6]=(hash[6]&15)|80;hash[8]=(hash[8]&63)|128;const s=[...hash.subarray(0,16)].map(x=>x.toString(16).padStart(2,'0')).join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
const safeMap=(value:unknown):Record<string,boolean>=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>1000)throw new Error('Source message metadata is invalid.');const result:Record<string,boolean>=Object.create(null);for(const [key,on] of Object.entries(value)){if(key.length>255||['__proto__','constructor','prototype'].includes(key)||on!==true)throw new Error('Source message metadata is invalid.');result[key]=true;}return result;};
export class SqliteMailMigration {
  constructor(private storage:MailSqlStorage,private env:{MAIL_MIGRATION_KEY?:string;MAIL_MIGRATION_ALLOWED_ORIGINS?:string},private callbacks:MigrationCallbacks,private fetcher:typeof fetch=fetch){
    storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_migration_jobs(id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(actor_id,operation_id))');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_migration_receipts(job_id TEXT NOT NULL,source_id TEXT NOT NULL,email_id TEXT NOT NULL,PRIMARY KEY(job_id,source_id))');
  }
  private trustedSource(value:string):URL {
    const url=migrationSourceUrl(value);
    // Administrator-owned origins are the trust boundary. Arbitrary hostname
    // resolution is deliberately unsupported: a DNS preflight cannot pin fetch
    // to the checked address or prevent rebinding on Cloudflare Workers.
    const configured=this.env.MAIL_MIGRATION_ALLOWED_ORIGINS;
    if(!configured?.trim())throw new Error('Server migration is unavailable until trusted source origins are configured.');
    const origins=configured.split(',').map(origin=>{const parsed=migrationSourceUrl(origin.trim());if(parsed.pathname!=='/'||parsed.search)throw new Error('Server migration trusted source configuration is invalid.');return parsed.origin;});
    if(!origins.includes(url.origin))throw new Error('Source origin is not approved for migration by the workspace administrator.');
    return url;
  }
  private async key(){if(!this.env.MAIL_MIGRATION_KEY||this.env.MAIL_MIGRATION_KEY.length<32)throw new Error('Server migration is unavailable until MAIL_MIGRATION_KEY is configured.');return crypto.subtle.importKey('raw',await digest(this.env.MAIL_MIGRATION_KEY),'AES-GCM',false,['encrypt','decrypt']);}
  private save(job:SavedJob){job.updatedAt=Date.now();this.storage.sql.exec('UPDATE mail_migration_jobs SET data=? WHERE id=?',JSON.stringify(job),job.id);}
  private load(id:string,actorId:string):SavedJob{const row=[...this.storage.sql.exec<{data:string}>('SELECT data FROM mail_migration_jobs WHERE id=? AND actor_id=?',id,actorId)][0];if(!row)throw new Error('Migration not found.');return JSON.parse(row.data);}
  private public(job:SavedJob):MailMigrationJob{const {secret,sourceAccountId,apiUrl,downloadUrl,queryState,mapping,lease,leaseUntil,...publicJob}=job;return publicJob;}
  get(id:string,actorId:string){return this.public(this.load(id,actorId));}
  list(actorId:string){return [...this.storage.sql.exec<{data:string}>('SELECT data FROM mail_migration_jobs WHERE actor_id=? ORDER BY rowid DESC LIMIT 100',actorId)].map(row=>this.public(JSON.parse(row.data)));}
  async start(input:{sessionUrl:string;credential:string;sourceAccountId?:string;operationId:string},actorId:string){
    const key=await this.key();if(!uuid.test(input.operationId)||!actorId||typeof input.credential!=='string'||!input.credential.trim()||input.credential.length>8192||/[\r\n]/.test(input.credential))throw new Error('A source credential and unique operation ID are required.');
    const sourceUrl=this.trustedSource(input.sessionUrl).href;
    const fingerprint=[...await digest(JSON.stringify({...input,sessionUrl:sourceUrl}))].map(x=>x.toString(16).padStart(2,'0')).join('');
    const existing=[...this.storage.sql.exec<{fingerprint:string;data:string}>('SELECT fingerprint,data FROM mail_migration_jobs WHERE actor_id=? AND operation_id=?',actorId,input.operationId)][0];if(existing){if(existing.fingerprint!==fingerprint)throw new Error('Migration operation conflict.');return this.public(JSON.parse(existing.data));}
    const id=crypto.randomUUID(),iv=crypto.getRandomValues(new Uint8Array(12));const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(id+':'+actorId)},key,new TextEncoder().encode(input.credential)));
    const job:SavedJob={id,actorId,sourceUrl,state:'pending',phase:'discover',cursor:0,imported:0,duplicates:0,total:null,createdAt:Date.now(),updatedAt:Date.now(),mapping:Object.create(null),sourceAccountId:input.sourceAccountId,secret:{iv:[...iv],ciphertext:[...ciphertext]}};
    this.storage.sql.exec('INSERT INTO mail_migration_jobs(id,actor_id,operation_id,fingerprint,data) VALUES(?,?,?,?,?)',id,actorId,input.operationId,fingerprint,JSON.stringify(job));return this.public(job);
  }
  cancel(id:string,actorId:string){const job=this.load(id,actorId);if(job.state==='completed')return this.public(job);job.state='cancelled';delete job.secret;delete job.lease;delete job.leaseUntil;this.save(job);return this.public(job);}
  async step(id:string,actorId:string){
    const job=this.load(id,actorId);if(['completed','cancelled'].includes(job.state))return this.public(job);
    if(job.leaseUntil&&job.leaseUntil>Date.now())return this.public(job);
    const lease=crypto.randomUUID();job.lease=lease;job.leaseUntil=Date.now()+120000;job.state='running';delete job.error;this.save(job);
    const assertActive=()=>{const current=this.load(id,actorId);if(current.state==='cancelled'||current.lease!==lease)throw new Error('Migration cancelled or another step is running.');};
    try{
      this.trustedSource(job.sourceUrl);if(!job.secret)throw new Error('Source credentials are unavailable.');const credential=new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(job.secret.iv),additionalData:new TextEncoder().encode(id+':'+actorId)},await this.key(),new Uint8Array(job.secret.ciphertext)));
      const request=async(url:string,body?:unknown)=>{migrationSourceUrl(url,new URL(job.sourceUrl).origin);const fetcher=this.fetcher;const response=await fetcher(url,{method:body?'POST':'GET',redirect:'manual',headers:{Authorization:`Bearer ${credential}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});assertActive();if(response.status>=300&&response.status<400)throw new Error('Source redirects are not allowed during migration.');return response;};
      const api=async(method:string,args:Record<string,unknown>)=>{const response=await request(job.apiUrl!,{using:[coreCapability,mailCapability],methodCalls:[[method,{accountId:job.sourceAccountId,...args},'migration']]});const value=JSON.parse(new TextDecoder().decode(await bytes(response,2*1024*1024)));const tuple=value.methodResponses?.find((item:unknown[])=>item[2]==='migration');if(!tuple||tuple[0]!==method)throw new Error('Source JMAP method failed.');return tuple[1];};
      if(job.phase==='discover'){
        const session=JSON.parse(new TextDecoder().decode(await bytes(await request(job.sourceUrl),1024*1024)));
        const accountId=job.sourceAccountId??session.primaryAccounts?.[mailCapability];if(typeof accountId!=='string'||!session.accounts?.[accountId]?.accountCapabilities?.[mailCapability]||!session.capabilities?.[mailCapability])throw new Error('The source does not provide a readable JMAP Mail account.');
        job.sourceAccountId=accountId;job.apiUrl=migrationSourceUrl(session.apiUrl,new URL(job.sourceUrl).origin).href;
        if(typeof session.downloadUrl!=='string'||!session.downloadUrl.includes('{blobId}'))throw new Error('Source download URL is invalid.');migrationSourceUrl(session.downloadUrl.replace(/\{[^}]+\}/g,'value'),new URL(job.sourceUrl).origin);job.downloadUrl=session.downloadUrl;job.phase='mailboxes';assertActive();this.save(job);
      }
      if(job.phase==='mailboxes'){
        const result=await api('Mailbox/get',{});if(!Array.isArray(result.list)||result.list.length>1000)throw new Error('Source mailbox list is invalid.');
        const boxes:MigrationMailbox[]=result.list;const pending=new Map(boxes.map(box=>[box.id,box]));if(pending.size!==boxes.length)throw new Error('Source mailbox IDs are duplicated.');
        let created=0;while(pending.size&&created<25){let advanced=false;for(const [sourceId,box] of pending){if(typeof sourceId!=='string'||!sourceId||sourceId.length>255||['__proto__','constructor','prototype'].includes(sourceId)||typeof box.name!=='string'||!box.name||box.name.length>255)throw new Error('Source mailbox is invalid.');if(job.mapping[sourceId]){pending.delete(sourceId);advanced=true;continue;}if(box.parentId&&!job.mapping[box.parentId])continue;assertActive();job.mapping[sourceId]=await this.callbacks.createMailbox(box,box.parentId?job.mapping[box.parentId]:null,await operationId(id+':mailbox:'+sourceId));assertActive();this.save(job);pending.delete(sourceId);advanced=true;if(++created>=25)break;}if(!advanced)throw new Error('Source mailbox hierarchy is cyclic or missing parents.');}
        if(!pending.size){job.phase='emails';this.save(job);}else return this.public(job);
      }
      if(job.phase==='emails'){
        const query=await api('Email/query',{position:job.cursor,limit:25,calculateTotal:true,sort:[{property:'receivedAt',isAscending:true}]});
        if(!Array.isArray(query.ids)||query.ids.length>25||!query.ids.every((value:unknown)=>typeof value==='string')||typeof query.queryState!=='string'||!Number.isSafeInteger(query.total)||query.total<0||query.position!==job.cursor)throw new Error('Source email page is invalid.');
        if(job.queryState&&job.queryState!==query.queryState)throw new Error('Source mailbox changed during migration. Start a new migration to safely reconcile new mail.');job.queryState=query.queryState;job.total=query.total;this.save(job);
        if(query.ids.length){const got=await api('Email/get',{ids:query.ids,properties:['id','blobId','mailboxIds','keywords','receivedAt']});if(!Array.isArray(got.list)||got.list.length!==query.ids.length)throw new Error('Some source messages are unavailable.');const emailMap=new Map(got.list.map((email:any)=>[email.id,email]));
          for(const sourceId of query.ids){assertActive();if([...this.storage.sql.exec('SELECT email_id FROM mail_migration_receipts WHERE job_id=? AND source_id=?',id,sourceId)].length)continue;
            const email:any=emailMap.get(sourceId);if(!email||typeof email.blobId!=='string')throw new Error('Source message is invalid.');const sourceBoxes=safeMap(email.mailboxIds),mailboxIds:Record<string,boolean>=Object.create(null);for(const box of Object.keys(sourceBoxes)){if(!job.mapping[box])throw new Error('Source message references an unavailable mailbox.');mailboxIds[job.mapping[box]]=true;}
            const keywords=safeMap(email.keywords);if(typeof email.receivedAt!=='string'||!Number.isFinite(Date.parse(email.receivedAt)))throw new Error('Source received date is invalid.');
            const url=job.downloadUrl!.replace(/\{accountId\}/g,encodeURIComponent(job.sourceAccountId!)).replace(/\{blobId\}/g,encodeURIComponent(email.blobId)).replace(/\{name\}/g,'message.eml').replace(/\{type\}/g,'message%2Frfc822');if(/\{/.test(url))throw new Error('Source download URL contains unsupported placeholders.');
            const raw=await bytes(await request(url),25*1024*1024);assertActive();const imported=await this.callbacks.importRaw(raw,{sourceEmailId:sourceId,operationId:await operationId(id+':email:'+sourceId),mailboxIds,keywords,receivedAt:email.receivedAt});assertActive();
            this.storage.transactionSync(()=>{this.storage.sql.exec('INSERT INTO mail_migration_receipts(job_id,source_id,email_id) VALUES(?,?,?)',id,sourceId,imported.id);if(imported.isDuplicate)job.duplicates++;else job.imported++;this.save(job);});
          }
        }
        job.cursor+=query.ids.length;if(!query.ids.length||job.cursor>=query.total){job.state='completed';job.phase='done';delete job.secret;}assertActive();this.save(job);
      }
    }catch(error){const current=this.load(id,actorId);if(current.state==='cancelled'||current.lease!==lease)return this.public(current);job.state='failed';job.error=error instanceof Error&&/^(Use a public|Server migration|Source |The source |Some source |Migration |The source response)/.test(error.message)?error.message:'Migration paused because the source request failed. Retry to resume.';this.save(job);
    }finally{const current=this.load(id,actorId);if(current.lease===lease){delete current.lease;delete current.leaseUntil;this.save(current);}}
    return this.get(id,actorId);
  }
}
