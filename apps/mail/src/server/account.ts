import {MailPushWakeups} from './push-wakeup';
import { transferParticipant, IdentityTransferError, type IdentityTransferRecord, type IdentityTransferCommand, type IdentityTransferParticipant } from './identity-transfer';
import { mailAuthority, type MailAuthorityEnvironment } from './authority';
import { MAIL_EVENT_TYPES } from '../domain/events';
import { MailEventWakeup } from './event-wakeup';
import { initialMailState, token, parseToken, clone, patchObject, stateError, MAIL_CAPABILITY, type MailContext, type MailState, type MailObject } from '../domain/model';
import { matchesFilter, sortEmails, applyRules, validateRule, validateFilter, parseSearchQuery } from '../domain/rules';
import { buildMime } from '../domain/mime';
import { parseMimeStream, prepareMimeStream, type MimeStreamSource } from '../domain/mime-stream';
import { createHash } from 'node:crypto';
import { reviewDomainSetup, validateReviewedDomainSetup, applyReviewedDomainSetup, connectReviewedDomainRouting, type DomainSetupProposal, prepareSendingDomain, connectDomainRouting, DomainProviderError, inspectDomainRouting, verifyDomainRouting, verifySendingDomain, fetchDomainDnsPlan, applyDomainDns, verifyDomainDnsWithSpf, listDomainDns } from './domains';
import { sendRawMail } from './delivery';
import { requestForwardingVerification, checkForwardingVerification } from './forwarding';
import { validateWritable } from '../domain/validation';
import { validateSignatures, validateSignatureReference, validateSignatureRemoval } from '../domain/signatures';
import { extendedMethod } from './jmap-extended';
import { SqliteMailStore } from './store';
import { MailContentProvenance } from './content-provenance';
import { renewAutomationAuthority, type AutomationProof } from './automation-renewal';
import { SqliteMailMigration } from './migration';
import { MailQuotaManager, MailAccountLifecycle, planRetention } from './retention';
import { validateSubmissionEnvelope } from '../domain/submission';
import { initialRecipientDelivery, mergeRecipientDelivery } from './provider-events';
import { scanMail } from './scanner';
import { projectEmail } from '../domain/jmap-email';
import { validateSettings, applyMailPreferences, applyFollowUp, reconcileFollowUps, buildAutoResponses } from '../domain/workflows';

interface Bucket { put(key: string, value: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>, options?: unknown): Promise<unknown>; get(key: string,options?:{range?:{offset:number;length:number}}): Promise<{ arrayBuffer(): Promise<ArrayBuffer>;body?:ReadableStream<Uint8Array>;size?:number } | null>; delete(key: string): Promise<unknown> }
interface Storage { sql: { exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T> }; transactionSync<T>(closure: () => T): T; setAlarm(time: number): Promise<void>; deleteAlarm(): Promise<void> }
export interface MailAccountEnvironment extends MailAuthorityEnvironment {
  MAIL_BLOBS: Bucket;
  MAIL_MIGRATION_KEY?:string;
  MAIL_MIGRATION_ALLOWED_ORIGINS?:string;
  MAIL_SENDER?: { send(message: { from: string; to: string[]; raw: string }): Promise<{ id?: string }> };
  CF_ACCOUNT_ID?: string;
  MAIL_INGRESS_WORKER?: string;
  CF_API_TOKEN?: string;
  MAIL_SCANNER?: {fetch(request:Request):Promise<Response>};
  MAIL_CREDENTIALS?: {idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}};
  MAIL_PUSH_REGISTRY?: {idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}};
  MAIL_DIRECTORY?: {idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}};
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
class DispatchAuthorizationDenied extends Error {}
const capabilities = new Set(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission', MAIL_CAPABILITY]);
const writableTypes = new Set(['Mailbox','Email','Identity','EmailSubmission','Rule','Contact','Domain','Template','VacationResponse']);
export class MailAccount {
  private readonly pushWakeups:MailPushWakeups;
  private readonly eventWakeup = new MailEventWakeup();
  private state: MailState | null = null;
  private readonly repository:SqliteMailStore;
  private readonly quota:MailQuotaManager;
  private readonly provenance:MailContentProvenance;
  private readonly lifecycle:MailAccountLifecycle;
  private persistedRevision:number|null=null;
  private pendingActions:(()=>void)[]=[];
  private pendingSql:{query:string;bindings:unknown[]}[]=[];
  private stageSql(query:string,...bindings:unknown[]){this.pendingSql.push({query,bindings});}
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly ctx: { storage: Storage; waitUntil?(promise:Promise<unknown>):void }, private readonly env: MailAccountEnvironment) {
    this.pushWakeups=new MailPushWakeups(ctx.storage,env.MAIL_PUSH_REGISTRY);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_identity_transfer_lock(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_identity_transfer_receipts(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_pending_automations(id TEXT PRIMARY KEY,email_id TEXT NOT NULL,blob_id TEXT NOT NULL,recipient_address TEXT NOT NULL,next_attempt INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0)');ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_gc_jobs(id TEXT PRIMARY KEY)');ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_forward_status(id TEXT PRIMARY KEY,email_id TEXT NOT NULL,status TEXT NOT NULL,error TEXT NOT NULL,at INTEGER NOT NULL)');ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_migration_item_results(id TEXT PRIMARY KEY,response TEXT NOT NULL)');this.provenance=new MailContentProvenance(ctx.storage);this.quota=new MailQuotaManager(ctx.storage);this.lifecycle=new MailAccountLifecycle(ctx.storage);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_scan_jobs(id TEXT PRIMARY KEY,email_id TEXT NOT NULL,blob_id TEXT NOT NULL,size INTEGER NOT NULL,desired_mailboxes TEXT NOT NULL,next_attempt INTEGER NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0)');ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_blob_security(blob_id TEXT PRIMARY KEY,email_id TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT)');if(![...ctx.storage.sql.exec<{name:string}>('PRAGMA table_info(mail_scan_jobs)')].some(column=>column.name==='recipient_address'))ctx.storage.sql.exec('ALTER TABLE mail_scan_jobs ADD COLUMN recipient_address TEXT');this.repository=new SqliteMailStore(ctx.storage);this.state=this.repository.load({includeEmails:false});this.persistedRevision=this.state?.sequence??null;
    if(this.state){let changed=false;for(const submission of Object.values(this.state.objects.EmailSubmission))if(submission.status==='sending'){submission.status='uncertain';submission.error='providerOutcomeUnknownAfterRestart';changed=true;}if(changed)this.save();}
  }
  private save() { this.repository.commit(this.state!,this.persistedRevision??undefined,()=>{this.pushWakeups.mark(this.state!.sequence);for(const action of this.pendingActions)action();for(const statement of this.pendingSql)this.ctx.storage.sql.exec(statement.query,...statement.bindings);});this.pendingSql=[];this.pendingActions=[];this.persistedRevision=this.state!.sequence;this.state!.objects.Email={};this.eventWakeup.notify();this.flushPushWakeups(); }


  private flushPushWakeups(){if(!this.env.MAIL_PUSH_REGISTRY)return;const task=this.pushWakeups.flush().then(()=>this.scheduleAlarm()).catch(()=>{});this.ctx.waitUntil?.(task);}

  private identityTransferLock():IdentityTransferRecord|null {
    const row=[...this.ctx.storage.sql.exec<{json:string}>('SELECT json FROM mail_identity_transfer_lock WHERE id=1')][0];return row?JSON.parse(row.json):null;
  }
  private writeIdentityTransferLock(record:IdentityTransferRecord|null){if(record)this.ctx.storage.sql.exec('INSERT OR REPLACE INTO mail_identity_transfer_lock(id,json) VALUES(1,?)',JSON.stringify({...record,repairAt:record.repairAt??Date.now()+30_000}));else this.ctx.storage.sql.exec('DELETE FROM mail_identity_transfer_lock WHERE id=1');}
  private async identityTransferDirectory(action:string,command:IdentityTransferCommand){
    if(!this.env.MAIL_DIRECTORY)throw new IdentityTransferError('directory_unavailable','Address management is unavailable.',503);
    const context=this.state!.context;
    const response=await this.env.MAIL_DIRECTORY.get(this.env.MAIL_DIRECTORY.idFromName('directory')).fetch(new Request('https://mail-directory/identity-transfer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,command,account:{accountId:context.accountId,organizationId:context.organizationId,workspaceId:context.workspaceId,ownerActorId:context.actor.id}})}));
    if(!response.ok)throw new IdentityTransferError('transfer_unavailable','The address move could not be checked.',503);
    return (await response.json() as {record:IdentityTransferRecord|null}).record;
  }
  private identityTransferAdapter():IdentityTransferParticipant{return {state:this.state!,readLock:()=>this.identityTransferLock(),writeLock:record=>this.writeIdentityTransferLock(record),readReceipt:id=>{const row=[...this.ctx.storage.sql.exec<{json:string}>('SELECT json FROM mail_identity_transfer_receipts WHERE id=?',id)][0];return row?JSON.parse(row.json):null;},writeReceipt:(id,receipt)=>this.stageSql('INSERT OR REPLACE INTO mail_identity_transfer_receipts(id,json) VALUES(?,?)',id,JSON.stringify(receipt)),directory:(action,command)=>this.identityTransferDirectory(action,command),authorizeZone:(domain,scope)=>this.authorizeZone(domain,scope),storeIdentity:identity=>{this.store('Identity',identity);if(identity.transferredTo){const change=this.state!.changes.at(-1);if(change)change.destroyed=true;}},save:()=>this.save()};}
  private async runIdentityTransferParticipant(context:MailContext,body:Record<string,any>){
    try{return await transferParticipant(this.identityTransferAdapter(),context,body);}
    catch(error){this.pendingSql=[];this.pendingActions=[];this.state=this.repository.load({includeEmails:false});this.persistedRevision=this.state?.sequence??null;throw error;}
  }
  private async activeIdentityTransfer(){
    const lock=this.identityTransferLock();if(!lock)return null;
    const latest=await this.identityTransferDirectory('read',lock.command);
    if(latest?.status==='aborted'){this.writeIdentityTransferLock(null);return null;}
    if(latest&&['committed','complete'].includes(latest.status)){
      // Repair only this already-prepared participant of an irreversible directory decision.
      // This cannot initiate a transfer, change its payload, or grant new authority.
      const context:MailContext={...this.state!.context,actor:{id:latest.actorId,actions:['mail.manage']}};
      await this.runIdentityTransferParticipant(context,{action:'finish',command:lock.command});return null;
    }
    return latest||lock;
  }
  private async ownsTransferredAddress(identity:MailObject,requireEnabled=true):Promise<boolean>{
    if(identity.transferredTo||(requireEnabled&&identity.enabled===false))return false;
    if(!this.env.MAIL_DIRECTORY)return true;
    const context=this.state!.context;
    const response=await this.env.MAIL_DIRECTORY.get(this.env.MAIL_DIRECTORY.idFromName('directory')).fetch(new Request('https://mail-directory/identity-transfer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'owner',address:identity.email,account:{accountId:context.accountId,organizationId:context.organizationId,workspaceId:context.workspaceId,ownerActorId:context.actor.id}})}));
    if(!response.ok)return false;
    const value=await response.json() as {owner:string|null;enabled?:boolean};return (value.owner==null||value.owner===context.accountId)&&(!requireEnabled||value.enabled!==false);
  }
  private key(blobId: string) { return `${this.state!.context.accountId}/blobs/${blobId}`; }
  private serial<T>(task: () => Promise<T>): Promise<T> { const result = this.queue.then(task); this.queue = result.catch(() => undefined); return result; }
  private bind(context: MailContext) {
    if (!context?.actor?.id || !Array.isArray(context.actor.actions) || !context.accountId || !context.organizationId || !context.workspaceId) throw new Error('Invalid account context');
    if (!this.state) {this.state=initialMailState({organizationId:context.organizationId,workspaceId:context.workspaceId,accountId:context.accountId,actor:{...context.actor}});if(['purging','deleted'].includes(this.lifecycle.get().status)){this.state.objects=Object.fromEntries(Object.keys(this.state.objects).map(type=>[type,{}]));}else this.save();}
    const expected = this.state.context;
    if (expected.accountId !== context.accountId || expected.organizationId !== context.organizationId || expected.workspaceId !== context.workspaceId) throw new Error('Account context mismatch');
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/event-wait' && request.method === 'POST') {
      // Register under the account queue, then release it before awaiting a
      // commit. Holding serial() here would prevent incoming mail waking us.
      try {
        const context = JSON.parse(request.headers.get('x-mail-account-context') || '{}') as MailContext;
        const input = await request.json() as { after?: unknown };
        const registered = await this.serial(async () => {
          this.bind(context); this.lifecycle.assertActive();
          if (!context.actor.actions.includes('mail.read')) return { response: Promise.resolve(json({ type: 'forbidden' },403)) };
          if (typeof input.after !== 'string') return { response: Promise.resolve(json({ type: 'invalidArguments' },400)) };
          const response = input.after !== token(this.state!.sequence)
            ? Promise.resolve(json({ changed: true }))
            : this.eventWakeup.wait(request.signal).then(changed => json({ changed }));
          return { response };
        });
        return registered.response;
      } catch { return json({ type:'invalidArguments' },400); }
    }
    return this.serial(async () => {
      try {
        const path = new URL(request.url).pathname;
        if (path === '/jmap' && request.method === 'POST') {
          const envelope: any = await request.json();
          const header = request.headers.get('x-mail-account-context');
          const context: MailContext = envelope.actor ? envelope : JSON.parse(header || '{}');
          this.bind(context);context.enoughFeatures=(envelope.request?.using||envelope.using||[]).includes(MAIL_CAPABILITY);
          if (!context.actor.actions.length) return json({ type: 'forbidden' },403);
          return json(await this.execute(envelope.request ?? envelope, context));
        }
        const header = request.headers.get('x-mail-account-context');
        const raw: any = header ? JSON.parse(header) : { accountId:request.headers.get('x-mail-account-id'),organizationId:request.headers.get('x-mail-organization-id'),workspaceId:request.headers.get('x-mail-workspace-id'),actor:{id:request.headers.get('x-mail-actor-id'),actions:(request.headers.get('x-mail-actions')||'').split(',')} };
        const context: MailContext = raw.actor ? raw : { ...raw,actor:{id:raw.actorId,actions:raw.actions||[]} };
        this.bind(context);
        if(path==='/identity-transfer'&&request.method==='POST'){
          this.lifecycle.assertActive();
          const body=await request.json() as Record<string,any>;
          if(body.action==='prepare')await this.ctx.storage.setAlarm(Date.now()+30_000);
          const result=await this.runIdentityTransferParticipant(context,body);
          if(body.action==='prepare'){const deadline=this.identityTransferLock()?.repairAt;if(deadline)await this.ctx.storage.setAlarm(deadline);}
          return json(result);
        }
        if(path==='/push-watch'&&request.method==='POST'){this.lifecycle.assertActive();if(!context.actor.actions.includes('mail.read'))return json({type:'forbidden'},403);const input:any=await request.json();if(typeof input.registryId!=='string'||input.registryId.length>256||!Number.isSafeInteger(input.expiresAt)||input.expiresAt<=Date.now()||input.expiresAt>Date.now()+32*86400000)return json({type:'invalidArguments'},400);this.pushWakeups.watch(input.registryId,input.expiresAt);return json({watched:true});}
        if(path==='/event-state'&&request.method==='POST'){this.lifecycle.assertActive();if(!context.actor.actions.includes('mail.read'))return json({type:'forbidden'},403);const input:any=await request.json();const types=input.types||MAIL_EVENT_TYPES;if(!Array.isArray(types)||types.length>20||types.some(type=>!MAIL_EVENT_TYPES.includes(type)))throw new Error('Unsupported event-state type');const delivery=this.repository.emailDeliveryState();return json({cursor:token(this.state!.sequence),states:Object.fromEntries(types.map(type=>[type,type==='EmailDelivery'?delivery:token(this.state!.sequence)]))});}
        if(path==='/credential-admission'&&request.method==='POST'){const status=this.lifecycle.get().status;const allowed=status==='active'&&context.actor.actions.length>0;return json({allowed,status,generation:this.lifecycle.get().revision},allowed?200:403);}
        if (path === '/upload' && request.method === 'POST') {this.lifecycle.assertActive();
          if (!context.actor.actions.some(action=>['mail.draft','mail.send','mail.edit'].includes(action))) return json({type:'forbidden'},403);
          const contentLength=request.headers.get('content-length');const length=contentLength===null?null:Number(contentLength);const maximum=64*1024*1024;
          if(length!==null&&(!Number.isSafeInteger(length)||length<0||length>maximum))return json({type:'tooLarge'},413);
          const blobId=crypto.randomUUID();let size:number;
          const FixedLength=(globalThis as any).FixedLengthStream;
          if(length!==null&&FixedLength&&request.body){
            await this.putStreamBlob(blobId,request.body,length,'upload');size=length;
          }else{
            // Requests without a declared size use a small bounded fallback. A large
            // client upload must supply Content-Length so R2 can stream exact bytes.
            const reader=request.body?.getReader(),chunks:Uint8Array[]=[];size=0;
            if(reader)while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>8*1024*1024){await reader.cancel();return json({type:'lengthRequired',description:'Large uploads require Content-Length'},411);}chunks.push(next.value);}
            const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}await this.putBlob(blobId,bytes,bytes.length,'raw');
          }
          this.provenance.recordSource(blobId,context.actor.id);return json({accountId:context.accountId,blobId,type:request.headers.get('content-type')||'application/octet-stream',size});
        }

        if (path.startsWith('/blob/') && request.method === 'GET') {this.lifecycle.assertActive();
          if (!context.actor.actions.includes('mail.read')) return json({type:'forbidden'},403);
          const blobId = decodeURIComponent(path.slice(6));
          if (!/^[\w.-]+$/.test(blobId)) return json({type:'notFound'},404);
          const quarantined=[...this.ctx.storage.sql.exec<{status:string}>('SELECT status FROM mail_blob_security WHERE blob_id=?',blobId)][0];if(quarantined&&quarantined.status!=='clean')return json({type:'quarantined',description:'Attachment is awaiting a clean scanner receipt'},403);
          const object = await this.env.MAIL_BLOBS.get(this.key(blobId));
          if(object&&!object.body&&(object.size===undefined||object.size>1024*1024))throw new Error('Streaming blob body is required');return object ? new Response(object.body||await object.arrayBuffer(),{headers:{'content-type':'application/octet-stream','content-disposition':'attachment','x-content-type-options':'nosniff'}}) : json({type:'notFound'},404);
        }
        if (path === '/ingest' && request.method === 'POST') {this.lifecycle.assertActive();
          if (!context.actor.actions.includes('mail.ingest')) return json({type:'forbidden'},403);
          const input: any = await request.json();
          const deliveryKey=await this.hash(JSON.stringify([input.deliveryId||input.blobId,input.from||'',input.to||'']));const previous=this.repository.ingestReceipt(deliveryKey);if(previous)return json({id:previous.emailId,state:token(this.state!.sequence),replayed:true});
          const imported = await this.importEmail({blobId:input.blobId,mailboxIds:{'folder-inbox':true},keywords:{},receivedAt:input.receivedAt});
          // SMTP ingress owns this fact. MIME To/Delivered-To headers are not proof
          // of the address that actually accepted delivery (notably for Bcc).
          if(typeof input.to==='string'&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.to.trim()))imported.deliveryRecipient=input.to.trim().toLowerCase();
          const email = applyMailPreferences(applyRules({...imported,mailboxIds:{'folder-inbox':true}} as any,this.getRules() as any,{allowForwarding:true,verifiedForwardingAddresses:Object.values(this.state!.objects.ForwardingVerification||{}).filter(item=>item.verified).map(item=>item.address)}),this.settings()) as MailObject;
          // Arrival notifications belong to accepted inbox ingress, not generic Email creation.
          if(email.hasAttachment)this.queueScan(email,input.to);this.store('Email',email);if(email.mailboxIds?.['folder-inbox']&&!email.mailboxIds?.['folder-junk']&&!email.mailboxIds?.['folder-trash']&&!email.keywords?.['$draft']&&!email.keywords?.['$junk'])this.pendingActions.push(()=>{this.repository.recordEmailDelivery();});this.pendingActions.push(()=>this.repository.recordIngestReceipt(deliveryKey,{emailId:email.id,blobId:input.blobId,receivedAt:email.receivedAt}));this.save();if(email.hasAttachment)await this.processScans(email.id,false);const ready=this.repository.readEmails({ids:[email.id],limit:1})[0]||email;if(ready.quarantine&&ready.quarantine.status!=='clean'&&(this.settings().forwarding?.enabled||ready.ruleForwards?.length)){this.stageSql('INSERT OR REPLACE INTO mail_forward_status(id,email_id,status,error,at) VALUES(?,?,?,?,?)',email.id,email.id,'blocked','scannerUnavailableDuringIncomingForwarding',Date.now());this.stageSql('DELETE FROM mail_forward_status WHERE id NOT IN (SELECT id FROM mail_forward_status ORDER BY at DESC LIMIT 1000)');}const forwarding=await this.queueAutomations(ready,input.to);if(forwarding!==null)this.stageSql('DELETE FROM mail_pending_automations WHERE email_id=?',ready.id);this.store('Email',ready);this.save();await this.scheduleAlarm();return json({id:email.id,state:token(this.state!.sequence),forwarding:forwarding?.[0]||null,forwardingJobs:forwarding||[]});
        }
        if(path==='/transfer/read'&&request.method==='POST'){
          if(!context.actor.actions.includes('mail.read'))return json({type:'forbidden'},403);this.lifecycle.assertActive();const input:any=await request.json();if(!Array.isArray(input.ids)||input.ids.length>1000)return json({type:'invalidArguments'},400);return json({accountId:context.accountId,state:token(this.state!.sequence),emails:this.repository.readEmails({ids:input.ids,limit:1000})});
        }
        if(path==='/provider-event'&&request.method==='POST'){
          if(!context.actor.actions.includes('mail.provider-event'))return json({type:'forbidden'},403);const event:any=await request.json();const submission=Object.values(this.state!.objects.EmailSubmission).find(item=>item.providerId===event.providerId&&item.identitySnapshot.email.toLowerCase()===String(event.sender).toLowerCase()&&item.envelope.rcptTo.some((recipient:any)=>recipient.email.toLowerCase()===String(event.recipient).toLowerCase()));if(!submission)return json({type:'notFound'},404);const next=clone(submission);const recipient=String(event.recipient).toLowerCase();next.deliveryStatus[recipient]=mergeRecipientDelivery(next.deliveryStatus[recipient],event);this.store('EmailSubmission',next);this.save();return json({updated:true});
        }
        if(path==='/forwarding-result'&&request.method==='POST'){
          if(!context.actor.actions.includes('mail.ingest'))return json({type:'forbidden'},403);const input:any=await request.json();const job=this.state!.objects.ForwardJob?.[input.jobId];if(!job||job.status!=='attempted')return json({type:'notFound'},404);if(!['forwarded','unknown'].includes(input.status))throw new Error('Invalid forwarding outcome');this.store('ForwardJob',{...job,status:input.status,error:input.error??null});if(input.status==='forwarded'&&!job.keepCopy){const email=this.repository.readEmails({ids:[job.emailId],limit:1})[0];if(email){delete email.mailboxIds['folder-inbox'];email.mailboxIds['folder-archive']=true;this.store('Email',email);}}this.save();return json({status:input.status});
        }
        return json({type:'notFound'},404);
      } catch (error) {
        if(error instanceof IdentityTransferError)return json({error:error.code,message:error.message},error.status);
        return json({type:'invalidArguments',description:error instanceof Error ? error.message : 'Invalid request'},400);
      }
    });
  }
  private store(type: string, object: MailObject, destroyed=false,preserveSubmissions:ReadonlySet<string>=new Set()) {
    const state = this.state!;if(type==='Email'){for(const [folder,field]of [['folder-trash','trashAt'],['folder-junk','junkAt']]){if(object.mailboxIds?.[folder])object[field]??=new Date().toISOString();else delete object[field];}if(object.mailboxIds?.['folder-junk']||object.mailboxIds?.['folder-trash']){delete object.snooze;delete object.followUp;delete object.mailboxIds['folder-snoozed'];}}if(type==='Email'&&destroyed){this.pendingActions.push(()=>this.provenance.invalidate(object.id));const blobs=new Set<string>();const visit=(value:any)=>{if(!value||typeof value!=='object')return;if(typeof value.blobId==='string')blobs.add(value.blobId);for(const child of Object.values(value))if(child&&typeof child==='object')visit(child);};visit(object);for(const blobId of blobs)this.stageSql('INSERT OR IGNORE INTO mail_gc_jobs(id) VALUES(?)',blobId);this.stageSql('DELETE FROM mail_scan_jobs WHERE email_id=?',object.id);this.stageSql('DELETE FROM mail_pending_automations WHERE email_id=?',object.id);for(const submission of Object.values(state.objects.EmailSubmission))if(submission.emailId===object.id){if(preserveSubmissions.has(submission.id)&&['pending','scheduled'].includes(submission.status))continue;const next=clone(submission);if(['pending','scheduled'].includes(next.status)){next.status='canceled';next.undoStatus='canceled';}delete next.emailSnapshot;this.store('EmailSubmission',next);}}const created=!Object.hasOwn(state.objects[type],object.id)&&(type!=='Email'||!this.repository.readEmails({ids:[object.id],limit:1}).length);const threadCreated=type==='Email'&&created&&!this.repository.readEmails({threadIds:[object.threadId],limit:1}).length&&!Object.values(state.objects.Email).some(email=>email.threadId===object.threadId); state.sequence++;
    if (destroyed) delete state.objects[type][object.id]; else state.objects[type][object.id] = object;
    state.changes.push({ sequence:state.sequence,type,id:object.id,destroyed,created,...(type==='Email'?{threadId:object.threadId,threadCreated}:{}) });
    if (state.changes.length > 10000) state.changes.splice(0,state.changes.length-10000);
  }
  private async execute(request: any, context: MailContext) {
    if (!Array.isArray(request.methodCalls) || request.methodCalls.length > 100) throw new Error('methodCalls must be an array of at most 100 calls');
    if ((request.using||[]).some((value:string)=>!capabilities.has(value))) return { type:'unknownCapability' };
    const methodResponses:any[] = []; const createdIds:Record<string,string> = {...request.createdIds};
    for (const tuple of request.methodCalls) {
      if (!Array.isArray(tuple) || tuple.length!==3) throw new Error('Invalid method call');
      const [name,originalArgs,callId] = tuple; let args:any = clone(originalArgs);const before=clone(this.state!);
      try {
        for (const [key,reference] of Object.entries(args)) if (key.startsWith('#')) {
          const ref:any=reference; const response=methodResponses.find(value=>value[2]===ref.resultOf&&value[0]===ref.name);
          if (!response) throw new Error('Invalid result reference');
          let values:any[]=[response[1]];
          for(const part of ref.path.split('/').slice(1)) values=values.flatMap(value=>part==='*' ? (Array.isArray(value)?value:Object.values(value||{})) : [value?.[part]]);
          args[key.slice(1)] = ref.path.includes('/*') ? values : values[0]; delete args[key];
        }
        const resolve=(value:any):any=>typeof value==='string'&&value.startsWith('#') ? createdIds[value.slice(1)]||value : Array.isArray(value)?value.map(resolve):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k.startsWith('#')?createdIds[k.slice(1)]||k:k,resolve(v)])):value;
        args=resolve(args);
        if (args.accountId && args.accountId!==context.accountId) {methodResponses.push(['error',stateError('accountNotFound'),callId]);continue;}
        const mutates=/(\/set|\/import|\/apply|\/verify|\/requestVerification|\/copy|\/start|\/cancel|\/retry|\/renew|\/step|\/recover|\/prepare|\/route|\/setup|\/resolve)$/.test(name);
        if(mutates&&/^(Identity|Domain|EmailSubmission|Settings|Lifecycle|Migration)\//.test(name)){const observed=this.state!.sequence;const transfer=await this.activeIdentityTransfer();if(transfer){methodResponses.push(['error',stateError('identityTransferInProgress','An address move is in progress. Retry that move to finish it.'),callId]);continue;}if(observed!==this.state!.sequence){methodResponses.push(['error',stateError('stateMismatch','An address move finished. Refresh this inbox before making another change.'),callId]);continue;}}
        if(!mutates&&name!=='Core/echo'&&!context.actor.actions.includes('mail.read')&&!(['EmailSubmission','Identity'].includes(name.split('/')[0])&&context.actor.actions.includes('mail.send'))){methodResponses.push(['error',stateError('forbidden'),callId]);continue;}
        if(name==='EmailSubmission/recover'&&(!context.enoughFeatures||this.lifecycle.get().status!=='active')){methodResponses.push(['error',stateError(context.enoughFeatures?'forbidden':'unknownMethod'),callId]);continue;}
        if(name==='EmailSubmission/recover'&&!['mail.read','mail.draft'].every(action=>context.actor.actions.includes(action))){methodResponses.push(['error',stateError('forbidden'),callId]);continue;}
        const required=name==='Identity/resolve'?'mail.send':name==='EmailSubmission/recover'?'mail.draft':name==='Blob/copy'?'mail.draft':name.startsWith('Migration/')?'mail.draft':name.startsWith('Export/')?'mail.read':name.startsWith('EmailSubmission/')?'mail.send':name.startsWith('Email/')?'mail.draft':['Snooze','FollowUp','Mailbox','Rule'].includes(name.split('/')[0])?'mail.organize':'mail.manage';
        if (mutates&&!context.actor.actions.includes(required)&&!(required!=='mail.send'&&context.actor.actions.includes('mail.edit'))&&!(name==='Email/set'&&context.actor.actions.includes('mail.organize'))) {methodResponses.push(['error',stateError('forbidden'),callId]);continue;}
        const internalOperationId=args.operationId||crypto.randomUUID();const operationKey=mutates?`${context.actor.id}:${internalOperationId}`:null;const expectedRevision=this.state!.sequence;
        const fingerprint=JSON.stringify([name,args]); const existing=operationKey?this.state!.receipts[operationKey]:null;
        if(existing&&existing.fingerprint!==fingerprint){methodResponses.push(['error',stateError('invalidArguments','Operation ID already used for another request'),callId]);continue;}
        const result=existing ? clone(existing.response) : await this.method(name,args,{...context,commandOperationId:internalOperationId});
        if(mutates&&before.sequence!==expectedRevision)throw new Error('Internal command revision changed');
        // A directory outage can hide a successful claim. Retrying the same
        // resolver command must recheck it rather than replay a permanent error.
        if(operationKey&&!existing&&!(name==='Identity/resolve'&&result.type==='serverFail')){this.state!.receipts[operationKey]={fingerprint,response:clone(result)};const receiptKeys=Object.keys(this.state!.receipts);if(receiptKeys.length>10000)delete this.state!.receipts[receiptKeys[0]];}
        for(const [key,value] of Object.entries(result.created||{})) createdIds[key]=(value as any).id;
        const implicit=result.__implicitResponses||[];delete result.__implicitResponses;if(name!=='Lifecycle/get')this.save();
        methodResponses.push([result.type&&result.accountId===undefined?'error':name,result,callId]);for(const [implicitName,implicitResult]of implicit)methodResponses.push([implicitName,implicitResult,callId]);
      }catch(error){this.pendingSql=[];this.pendingActions=[];this.state=this.repository.load({includeEmails:false})||before;this.persistedRevision=this.state.sequence;methodResponses.push(['error',stateError(error instanceof Error&&error.message==='anchorNotFound'?'anchorNotFound':'invalidArguments',error instanceof Error?error.message:'Invalid arguments'),callId]);}
    }
    await this.scheduleAlarm();
    return {methodResponses,sessionState:token(this.state!.sequence),createdIds};
  }
  private validateRuleForward(rule:MailObject,context:MailContext){if(!rule.actions?.forwardTo?.length)return;if(!context.actor.actions.includes('mail.manage')||!context.actor.actions.includes('mail.send')||!context.authorityProof)throw new Error('Forwarding rules require management and sending authorization');this.assertAutomationAuthority(context);for(const address of rule.actions.forwardTo)if(!this.state!.objects.ForwardingVerification?.[address.toLowerCase()]?.verified)throw new Error('Rule destination is not verified');}
  private migrations(context:MailContext){return new SqliteMailMigration(this.ctx.storage,this.env,{
    createMailbox:async(box,parentId,operationId)=>{const objects=this.state!.objects;const prior=[...this.ctx.storage.sql.exec<{response:string}>('SELECT response FROM mail_migration_item_results WHERE id=?',operationId)][0];if(prior)return JSON.parse(prior.response).id;const existing=Object.values(objects.Mailbox).find(item=>box.role?item.role===box.role:item.name===box.name&&item.parentId===parentId);const id=existing?.id||crypto.randomUUID();if(!existing){const mailbox={id,name:box.name,parentId,role:null,sortOrder:0,isSubscribed:true};this.validate('Mailbox',mailbox);this.store('Mailbox',mailbox);}this.stageSql('INSERT INTO mail_migration_item_results(id,response) VALUES(?,?)',operationId,JSON.stringify({id}));this.save();return id;},
    importRaw:async(raw,metadata)=>{const accepted=[...this.ctx.storage.sql.exec<{response:string}>('SELECT response FROM mail_migration_item_results WHERE id=?',metadata.operationId)][0];if(accepted)return JSON.parse(accepted.response);const blobId=`migration-${metadata.operationId}`;await this.putBlob(blobId,raw,raw.length,'raw');this.provenance.recordSource(blobId,context.actor.id);const email=await this.importEmail({blobId,mailboxIds:metadata.mailboxIds,keywords:metadata.keywords,receivedAt:metadata.receivedAt},context);if(!this.findDuplicate(email.rawHash))this.pendingActions.push(()=>this.provenance.recordPrepared(email.id,context.actor.id,email.blobId));const duplicate=this.findDuplicate(email.rawHash);const result={id:duplicate?.id||email.id,isDuplicate:!!duplicate};if(!duplicate)this.store('Email',email);this.stageSql('INSERT INTO mail_migration_item_results(id,response) VALUES(?,?)',metadata.operationId,JSON.stringify(result));this.save();return result;}
  });}
  private blobIsClean(blobId:string){const row=[...this.ctx.storage.sql.exec<{status:string}>('SELECT status FROM mail_blob_security WHERE blob_id=?',blobId)][0];return !row||row.status==='clean';}
  private assertAutomationAuthority(context:MailContext){
    if(!context.actor.actions.includes('mail.manage')||!context.actor.actions.includes('mail.send')||!context.authorityProof?.expiresAt||context.authorityProof.expiresAt<=Date.now())throw new Error('Current automation management and sending authority is required');
    if(context.authorityProof.actions&&(!Array.isArray(context.authorityProof.actions)||context.authorityProof.actions.length>32||!['mail.manage','mail.send'].every(action=>context.authorityProof!.actions!.includes(action))))throw new Error('Exact issued automation actions are required');
  }
  private setAutomationAuthority(context:MailContext){this.assertAutomationAuthority(context);const proof=context.authorityProof;if(!proof||typeof proof.expiresAt!=='number'||proof.expiresAt<=Date.now())throw new Error('Current automation management and sending authority is required');
    this.store('PrivateConfig',{id:'automation',actorId:context.actor.id,authorityProof:clone(proof),lifecycleGeneration:this.lifecycle.get().revision,renewal:{status:proof.actions?'healthy':'manual',nextAttempt:proof.actions?Math.max(Date.now()+1000,proof.expiresAt-10*86400000):null,reason:proof.actions?null:'legacy_actions_require_fresh_authorization'}});
  }
  private automationEnabled(){return !!(this.settings().forwarding?.enabled||this.settings().vacation?.enabled||this.getRules().some(rule=>rule.enabled!==false&&rule.actions?.forwardTo?.length));}
  private automationHealth(){const failure=[...this.ctx.storage.sql.exec<{error:string;at:number}>('SELECT error,at FROM mail_forward_status ORDER BY at DESC LIMIT 1')][0];const config=this.state!.objects.PrivateConfig?.automation;const proof=config?.authorityProof;const expiresAt=Number.isFinite(proof?.expiresAt)?proof.expiresAt:null;const renewal=config?.renewal;const renewRequired=expiresAt===null||expiresAt<=Date.now()+7*86400000||!Array.isArray(proof?.actions)||['manual','denied'].includes(renewal?.status);return {status:!proof?'unavailable':renewal?.status==='denied'?'denied':renewal?.status==='retry'?'retrying':renewRequired?'renewRequired':'healthy',expiresAt,renewRequired,nextAttempt:renewal?.nextAttempt??null,lastError:renewal?.reason??(proof&&!proof.actions?'legacy_actions_require_fresh_authorization':null),...(failure?{lastForwardingFailure:{reason:failure.error,at:failure.at,recovery:'After the message clears quarantine, forward it manually. Native incoming forwarding cannot be replayed.'}}:{})};}
  private async processAutomationRenewal(now:number){
    const config=this.state!.objects.PrivateConfig?.automation;if(!config||!this.automationEnabled()||['denied','manual'].includes(config.renewal?.status))return;
    if((config.lifecycleGeneration??0)!==this.lifecycle.get().revision){this.store('PrivateConfig',{...config,renewal:{status:'denied',reason:'account_lifecycle_changed',nextAttempt:null}});this.save();return;}const proof=config.authorityProof;if(!proof?.expiresAt||proof.expiresAt<=now){this.store('PrivateConfig',{...config,renewal:{status:'denied',reason:'authority_expired',nextAttempt:null}});this.save();return;}
    const due=config.renewal?.nextAttempt??proof.expiresAt-10*86400000;if(due>now)return;
    let pending=config.renewal?.pending;
    if(!pending){let expiresAt=now+90*86400000-60000;if(proof.credentialId){if(!this.env.MAIL_CREDENTIALS){this.store('PrivateConfig',{...config,renewal:{status:'retry',reason:'credential_service_unavailable',nextAttempt:Math.min(proof.expiresAt,now+5*60000)}});this.save();return;}try{const response=await this.env.MAIL_CREDENTIALS.get(this.env.MAIL_CREDENTIALS.idFromName('mail-client-credentials-v1')).fetch(new Request('https://mail-credentials/lookup-id',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:proof.credentialId,version:proof.credentialVersion})}));if(response.status>=500)throw new Error('unavailable');const value:any=response.ok?await response.json():null;if(!value?.credential){this.store('PrivateConfig',{...config,renewal:{status:'denied',reason:'credential_revoked_or_changed',nextAttempt:null}});this.save();return;}expiresAt=Math.min(expiresAt,value.credential.expiresAt);if(expiresAt<=proof.expiresAt){this.store('PrivateConfig',{...config,renewal:{status:'manual',reason:'credential_expiry_requires_reconnect',nextAttempt:null}});this.save();return;}}catch{this.store('PrivateConfig',{...config,renewal:{status:'retry',reason:'credential_service_unavailable',nextAttempt:Math.min(proof.expiresAt,now+5*60000)}});this.save();return;}}
      pending={operationId:crypto.randomUUID(),expiresAt,oldLease:proof.lease};this.store('PrivateConfig',{...config,renewal:{status:'pending',pending,nextAttempt:now,attempts:config.renewal?.attempts||0}});this.save();
    }
    const lifecycleBefore=this.lifecycle.get();const configFingerprint=JSON.stringify({actorId:config.actorId,proof,pending});const result=await renewAutomationAuthority({accountId:this.state!.context.accountId,organizationId:this.state!.context.organizationId,workspaceId:this.state!.context.workspaceId,actorId:config.actorId,proof:proof as AutomationProof,lifecycleGeneration:lifecycleBefore.revision,status:lifecycleBefore.status,pending,now},this.env);
    const current=this.state!.objects.PrivateConfig.automation;const lifecycleAfter=this.lifecycle.get();if(!current||lifecycleAfter.status!=='active'||lifecycleAfter.revision!==lifecycleBefore.revision||JSON.stringify({actorId:current.actorId,proof:current.authorityProof,pending:current.renewal?.pending})!==configFingerprint)return;
    if(result.status==='allowed')this.store('PrivateConfig',{...current,authorityProof:result.proof,lifecycleGeneration:lifecycleBefore.revision,renewal:{status:'healthy',nextAttempt:result.proof.expiresAt-10*86400000}});
    else if(result.status==='retry'){const attempts=(current.renewal?.attempts||0)+1;this.store('PrivateConfig',{...current,renewal:{status:'retry',pending,attempts,reason:result.reason,nextAttempt:Math.min(proof.expiresAt,now+Math.min(24*3600000,5*60000*2**Math.min(attempts,8)))}});}
    else this.store('PrivateConfig',{...current,renewal:{status:result.status,reason:result.reason,nextAttempt:null}});
    this.save();
  }
  private getEmails() { return Object.values(this.state!.objects.Email); }
  private settings():any{const prefs=this.state!.objects.Settings?.singleton||{};const vacation=Object.values(this.state!.objects.VacationResponse)[0];return {...prefs,...(vacation?{vacation:{...prefs.vacation,enabled:vacation.isEnabled,subject:vacation.subject,textBody:vacation.textBody,fromDate:vacation.fromDate,toDate:vacation.toDate}}:{})};}
  private getRules() { return Object.values(this.state!.objects.Rule).sort((a,b)=>(a.sortOrder??0)-(b.sortOrder??0)||a.id.localeCompare(b.id)); }
  private mailbox(object: MailObject,context:MailContext) {
    const allows=(action:string)=>context.actor.actions.includes(action)||action!=='mail.send'&&context.actor.actions.includes('mail.edit');
    return {...object,...this.repository.mailboxCounts(object.id),myRights:{mayReadItems:allows('mail.read'),mayAddItems:allows('mail.draft'),mayRemoveItems:allows('mail.organize'),maySetSeen:allows('mail.organize'),maySetKeywords:allows('mail.organize'),mayCreateChild:allows('mail.organize'),mayRename:!object.id.startsWith('folder-')&&allows('mail.organize'),mayDelete:!object.id.startsWith('folder-')&&allows('mail.organize'),maySubmit:allows('mail.send')}};
  }
  private loadEmails(args:any,type:string,operation:string){
    const ids:string[]=[];
    if(type==='Email'&&operation==='set'){ids.push(...Object.keys(args.update||{}),...(args.destroy||[]));}
    else if(type==='Email'&&operation==='get'){if(args.ids===null||args.ids===undefined){for(const email of this.repository.readEmails({limit:1000}))this.state!.objects.Email[email.id]=email;return;}ids.push(...args.ids);}
    else if(['Snooze','FollowUp'].includes(type)||type==='Rule'&&['apply','preview'].includes(operation)){if(args.emailIds)ids.push(...args.emailIds);else{for(const email of this.repository.readEmails({limit:1000}))this.state!.objects.Email[email.id]=email;return;}}
    else if(type==='EmailSubmission'&&operation==='set'){for(const input of Object.values(args.create||{}) as any[])if(input.emailId)ids.push(input.emailId);}
    else if(type==='SearchSnippet')ids.push(...(args.emailIds||[]));
    if(ids.length>1000)throw new Error('Too many objects');
    for(const email of this.repository.readEmails({ids,limit:1000}))this.state!.objects.Email[email.id]=email;
  }
  private async method(name:string,args:any,context:MailContext):Promise<any> {
    const state=this.state!; const accountId=state.context.accountId; const [type,operation]=name.split('/'); const currentState=token(state.sequence);if(type!=='Lifecycle')this.lifecycle.assertActive();this.loadEmails(args,type,operation);
    let parseResponseBudget=32*1024*1024;const extended=await extendedMethod({name,args:{accountId,...args},state,context,readBlob:async()=>null,liveThreadIds:async ids=>this.repository.liveThreadIds(ids),blobExists:async blobId=>{if(!/^[\w.-]+$/.test(blobId)||!this.blobIsClean(blobId))return false;const object=await this.env.MAIL_BLOBS.get(this.key(blobId));await object?.body?.cancel();return !!object;},parseStoredBlob:async blobId=>{if(!/^[\w.-]+$/.test(blobId)||!this.blobIsClean(blobId))return null;const object=await this.env.MAIL_BLOBS.get(this.key(blobId));await object?.body?.cancel();if(!object)return null;const source=await this.mimeSource(blobId);const rawSecurity=[...this.ctx.storage.sql.exec<{status:string}>('SELECT status FROM mail_blob_security WHERE blob_id=?',blobId)][0];const canonical=[...this.ctx.storage.sql.exec<{json:string}>("SELECT json FROM mail_objects WHERE type='Email' AND json_extract(json,'$.blobId')=? LIMIT 1",blobId)][0];const accepted=canonical?JSON.parse(canonical.json):null;const status=rawSecurity?.status||(accepted&&!accepted.hasAttachment&&!accepted.quarantine?'clean':'pending');const {parsed}=await this.parseStoredMime(blobId,source,{sourceId:blobId,status});if(args.fetchAllBodyValues||args.fetchTextBodyValues||args.fetchHTMLBodyValues)parsed.bodyValues=await this.readBodyValues(parsed as any,args);const projectedSize=new TextEncoder().encode(JSON.stringify(parsed)).length;if(projectedSize>parseResponseBudget)throw new Error('Parsed body values exceed bounded response size');parseResponseBudget-=projectedSize;return {...parsed,size:source.size};}});if(extended!==undefined)return extended;
    if(name==='Core/echo')return args;
    if(name==='Identity/resolve'){
      if(!context.enoughFeatures)return stateError('unknownMethod');
      if(!context.actor.actions.includes('mail.send'))return stateError('forbidden');
      if(typeof args.operationId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.operationId)||typeof args.ifInState!=='string')return stateError('invalidArguments','A sending address requires an operation ID and explicit state');
      if(args.ifInState!==currentState)return stateError('stateMismatch');
      if(typeof args.email!=='string'||args.email.length>254||! /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(args.email.trim())||args.name!==undefined&&(typeof args.name!=='string'||args.name.length>256||/[\r\n\0]/.test(args.name)))return stateError('invalidArguments','Enter one complete email address on a supported domain');
      const email=args.email.trim().toLowerCase();
      const local=email.split('@')[0];if(local.length>64||local.startsWith('.')||local.endsWith('.')||local.includes('..'))return stateError('invalidArguments','Enter one complete email address on a supported domain');
      const domain=Object.values(state.objects.Domain).find(domain=>domain.sendingVerified===true&&domain.enabled!==false&&domain.name.toLowerCase()===email.split('@')[1]);
      if(!domain||!await this.authorizeZone(domain,context))return stateError('forbidden','This sending domain is not available in this inbox');
      const matches=Object.values(state.objects.Identity).filter(identity=>identity.email?.toLowerCase()===email);
      if(matches.some(identity=>identity.transferredTo||identity.enabled===false))return stateError('forbidden','This sending address is disabled or belongs to another inbox');
      const existing=matches.find(identity=>identity.verified===true);
      if(matches.length&&!existing)return stateError('forbidden','This sending address is not verified');
      if(!this.env.MAIL_DIRECTORY)return stateError('serverFail','Mail routing directory unavailable');
      const claimed=await this.env.MAIL_DIRECTORY.get(this.env.MAIL_DIRECTORY.idFromName('directory')).fetch(new Request('https://mail-directory/claim-sending-address',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account:{accountId:context.accountId,organizationId:context.organizationId,workspaceId:context.workspaceId,ownerActorId:context.actor.id},address:email,zoneId:domain.zoneId,enabled:true,catchAll:false})}));
      if(!claimed.ok){const failure=await claimed.json().catch(()=>({})) as {error?:string};return stateError(claimed.status===409?'forbidden':claimed.status===403?'forbidden':'serverFail',failure.error==='address_disabled'?'This sending address is disabled':failure.error==='identity_transfer_in_progress'?'This address is being moved to another inbox':claimed.status===409?'This sending address belongs to another inbox':'This sending address could not be confirmed');}
      const identity=existing||{id:crypto.randomUUID(),email,name:args.name?.trim()||'',verified:true,mayDelete:true};
      if(!existing)this.store('Identity',identity);
      return {accountId,oldState:currentState,newState:token(state.sequence),identity:this.publicObject('Identity',identity)};
    }
    if(name==='EmailSubmission/recover'){
      if(!context.enoughFeatures)return stateError('unknownMethod');
      if(!['mail.read','mail.draft'].every(action=>context.actor.actions.includes(action)))return stateError('forbidden');
      if(typeof args.operationId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.operationId)||typeof args.ifInState!=='string')return stateError('invalidArguments','Recovery requires an operation ID and explicit state');
      if(args.ifInState!==currentState)return stateError('stateMismatch');
      const submission=state.objects.EmailSubmission[args.submissionId];
      if(!submission||!['failed','uncertain'].includes(submission.status)||!submission.emailSnapshot)return stateError('notFound','No retained message is available for recovery');
      const snapshot=submission.emailSnapshot;
      if(typeof snapshot.blobId!=='string'||! /^[\w.-]+$/.test(snapshot.blobId)||snapshot.quarantine&&snapshot.quarantine.status!=='clean')return stateError('forbidden','Retained content is unavailable or quarantined');
      const sources=new Set<string>();const collect=(value:any)=>{if(!value||typeof value!=='object')return;if(typeof value.blobId==='string')sources.add(value.blobId);for(const child of Object.values(value))if(child&&typeof child==='object')collect(child);};collect(snapshot);
      if(sources.size>202)return stateError('invalidArguments','Retained message has too many content sources');
      for(const blobId of sources){if(! /^[\w.-]+$/.test(blobId)||!this.blobIsClean(blobId))return stateError('forbidden','Retained content is unavailable or quarantined');this.provenance.assertSource(blobId,context.actor.id,true);try{const source=await this.mimeSource(blobId);if(blobId===snapshot.blobId&&source.size!==snapshot.size)return stateError('notFound','Retained content is unavailable');}catch{return stateError('notFound','Retained content is unavailable');}}
      const draft=clone(snapshot);draft.id=crypto.randomUUID();draft.mailboxIds={'folder-drafts':true};draft.keywords={'$draft':true,'$seen':true};
      for(const property of ['snooze','followUp','trashAt','junkAt','quarantine','authorityProof','authorityBasis','knownContentBlob','actorId','identitySnapshot','emailSnapshot'])delete draft[property];
      this.validate('Email',draft);this.pendingActions.push(()=>this.provenance.recordPrepared(draft.id,context.actor.id,draft.blobId));this.store('Email',draft);
      return {accountId,submissionId:submission.id,originalStatus:submission.status,oldState:currentState,newState:token(state.sequence),emailId:draft.id,draft:{id:draft.id,blobId:draft.blobId,threadId:draft.threadId,size:draft.size}};
    }

    if(name.startsWith('Migration/')){if(!context.actor.actions.includes('mail.draft')||!context.actor.actions.includes('mail.organize'))return stateError('forbidden');const migration=this.migrations(context);if(operation==='get')return {accountId,list:args.ids?args.ids.map((id:string)=>migration.get(id,context.actor.id)):migration.list(context.actor.id)};if(operation==='start')return {accountId,job:await migration.start({...args,operationId:args.operationId||context.commandOperationId},context.actor.id)};if(operation==='step')return {accountId,job:await migration.step(args.jobId,context.actor.id)};if(operation==='cancel')return {accountId,job:migration.cancel(args.jobId,context.actor.id)};return stateError('unknownMethod');}
    if(['Domain/plan','Domain/apply','Domain/verify','Domain/prepare','Domain/route','Domain/setup'].includes(name)) {
      if(!context.actor.actions.includes('mail.manage')||!['owner','administrator'].includes(context.actor.workspaceRole||''))return stateError('forbidden');
      const domain=state.objects.Domain[args.domainId];if(!domain)return stateError('notFound');if(name==='Domain/verify'&&args.ifInState&&args.ifInState!==currentState)return stateError('stateMismatch');
      if(!await this.authorizeZone(domain,context))return stateError('forbidden','Domain zone has not been approved for this account');
      if (name === 'Domain/setup') {
        if (!args.ifInState || args.ifInState !== currentState) return stateError('stateMismatch');
        if (!this.env.MAIL_INGRESS_WORKER || domain.enabled === false) return stateError('invalidArguments', 'Enable this domain before setting up delivery.');
        type SetupStage = 'review' | 'dns' | 'verification' | 'receiving';
        type SetupStep = 'inspectRouting' | 'prepareSending' | 'planDns' | 'applyDns' | 'verifyDns' | 'verifySending' | 'registerAddresses' | 'connectRouting' | 'enableRoutingDns' | 'setCatchAll' | 'verifyFinalDns' | 'verifyRouting' | 'removeDns' | 'disableRecipientRule';
        let stage: SetupStage = 'review';
        let step: SetupStep = 'inspectRouting';
        let diagnostics: { stage: SetupStage; step: SetupStep; code: string; providerCodes?: number[] } | undefined;
        const invalidate = (sending: boolean) => {
          const current = state.objects.Domain[domain.id];
          this.store('Domain', { ...current, receivingConnected: false, ...(sending ? { sendingVerified: false, dnsState: 'unverified' } : {}) });
          if (sending) for (const identity of Object.values(state.objects.Identity)) if (identity.email.split('@')[1].toLowerCase() === domain.name.toLowerCase()) this.store('Identity', { ...identity, verified: false });
        };
        let recoveryId: string | undefined;
        const reviewed = args.reviewedProposal as DomainSetupProposal | undefined;
        if (reviewed && (reviewed.version !== 1 || reviewed.domain !== domain.name.toLowerCase() || reviewed.zoneId !== domain.zoneId || reviewed.worker !== this.env.MAIL_INGRESS_WORKER || reviewed.sendingSubdomainId !== domain.sendingSubdomainId)) return stateError('invalidArguments', 'Review belongs to another domain configuration.');
        const latestRecovery = () => Object.values(state.objects.PrivateConfig || {}).filter(item => item.domainId === domain.id && item.id.startsWith('domain-setup:')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || Number(b.createdSequence || 0) - Number(a.createdSequence || 0))[0];
        const recoveryEvidence = () => {
          const latest = latestRecovery();
          if (!latest) return {};
          const original = state.objects.PrivateConfig?.[latest.originalRecoveryId];
          const recovery = original?.domainId === domain.id && original.id.startsWith('domain-setup:') ? original : latest;
          // The rollback evidence stays bound to the first attempt in this
          // incomplete setup. Current progress belongs to the latest attempt.
          return {
            recovery: { id: recovery.id, status: recovery.status, createdAt: recovery.createdAt, completed: recovery.completed, proposal: recovery.proposal },
            recoveryProgress: { id: latest.id, status: latest.status, createdAt: latest.createdAt, completed: latest.completed, originalRecoveryId: recovery.id, ...(latest.previousRecoveryId ? { previousRecoveryId: latest.previousRecoveryId } : {}) },
          };
        };
        const answer = (status: 'ready' | 'blocked' | 'pending' | 'review', message: string, extra: Record<string, unknown> = {}) => ({ accountId, domainId: domain.id, status, stage: status === 'ready' ? 'complete' : stage, message, ...extra, ...recoveryEvidence(), ...(recoveryId ? { recoveryId } : {}), ...(diagnostics ? { diagnostics } : {}), newState: token(state.sequence), state: token(state.sequence) });
        try {
          // Existing recipient routes must be reviewed before any DNS writes.
          if (!args.reviewOnly && !reviewed) await inspectDomainRouting(this.env, domain.zoneId, this.env.MAIL_INGRESS_WORKER);
          step = 'prepareSending';
          const sendingSubdomainId = reviewed ? reviewed.sendingSubdomainId : await prepareSendingDomain(this.env, domain.name.toLowerCase(), domain.zoneId);
          const configured = { ...domain, sendingSubdomainId };
          this.store('Domain', configured);
          step = 'planDns';
          if (args.reviewOnly) {
            const proposal = await reviewDomainSetup(this.env, domain.name, domain.zoneId, sendingSubdomainId, this.env.MAIL_INGRESS_WORKER);
            return answer('review', 'Review the exact changes before replacing existing mail delivery.', { proposal });
          }
          if (reviewed) {
            await validateReviewedDomainSetup(this.env, reviewed);
            // Durable recovery evidence precedes any destructive provider request.
            // The command receipt prevents duplicate application after a lost response.
            recoveryId = `domain-setup:${context.commandOperationId}`;
            state.objects.PrivateConfig ??= {};
            const previous = latestRecovery();
            const continuing = previous && previous.status !== 'complete';
            const originalRecoveryId = continuing ? previous.originalRecoveryId || previous.id : recoveryId;
            this.store('PrivateConfig', { id: recoveryId, domainId: domain.id, actorId: context.actor.id, createdAt: new Date().toISOString(), createdSequence: state.sequence, originalRecoveryId, ...(continuing ? { previousRecoveryId: previous.id } : {}), status: 'pending', proposal: clone(reviewed), completed: [] });
            this.save();
            stage = 'dns';
            step = 'applyDns';
            const replacement = await applyReviewedDomainSetup(this.env, reviewed);
            this.store('PrivateConfig', { ...state.objects.PrivateConfig[recoveryId], status: replacement.status, completed: replacement.completed });
            this.save();
            if (replacement.status !== 'applied') { diagnostics = { stage, step, code: 'reviewedMutationOutcomeUnknown' }; invalidate(true); return answer('pending', 'Some reviewed changes could not be confirmed. The previous records and routes are saved for recovery. Review the current configuration before continuing.'); }
          }
          const plan = await fetchDomainDnsPlan(this.env, domain.name, domain.zoneId, sendingSubdomainId);
          if (plan.conflicts.length) { invalidate(true); return answer('blocked', 'Existing mail records need review. No DNS records were changed.', { plan }); }
          stage = 'dns';
          step = 'applyDns';
          const applied = await applyDomainDns(this.env, domain.zoneId, plan);
          if (applied.status !== 'applied') { diagnostics = { stage, step, code: 'dnsMutationOutcomeUnknown' }; console.warn('Mail domain setup failed', diagnostics); invalidate(true); return answer('pending', 'Some DNS updates could not be confirmed. Run setup again to check the records before continuing.', { applied: applied.applied }); }
          stage = 'verification';
          step = 'verifyDns';
          const verification = await verifyDomainDnsWithSpf(plan, await listDomainDns(this.env, domain.zoneId));
          step = 'verifySending';
          if (!await verifySendingDomain(this.env, domain.name, domain.zoneId, sendingSubdomainId)) { invalidate(true); return answer('pending', 'Cloudflare has not enabled sending for this domain. Retry setup to check its status.'); }
          const verified = { ...configured, dnsState: verification.ready ? 'verified' : 'error', sendingVerified: verification.ready, checks: verification.checks, warnings: verification.warnings };
          this.store('Domain', verified);
          for (const identity of Object.values(state.objects.Identity)) if (identity.email.split('@')[1].toLowerCase() === domain.name.toLowerCase()) this.store('Identity', { ...identity, verified: verification.ready });
          if (!verification.ready) { invalidate(true); return answer('pending', 'DNS records were added, but verification has not completed. Check the details and retry setup.', { checks: verification.checks, warnings: verification.warnings }); }
          stage = 'receiving';
          // Directory addresses must exist before the public route starts accepting mail.
          step = 'registerAddresses';
          await this.syncDirectory(verified, context);
          step = 'connectRouting';
          if (reviewed) {
            const completed = await connectReviewedDomainRouting(this.env, reviewed);
            if (recoveryId) {
              this.store('PrivateConfig', { ...state.objects.PrivateConfig[recoveryId], completed: [...new Set([...(state.objects.PrivateConfig[recoveryId].completed || []), ...completed])] });
              this.save();
            }
          }
          else await connectDomainRouting(this.env, domain.name, domain.zoneId, this.env.MAIL_INGRESS_WORKER);
          step = 'verifyFinalDns';
          const finalPlan = await fetchDomainDnsPlan(this.env, domain.name, domain.zoneId, sendingSubdomainId);
          const finalVerification = await verifyDomainDnsWithSpf(finalPlan, await listDomainDns(this.env, domain.zoneId));
          if (!finalVerification.ready) { invalidate(true); return answer('pending', 'DNS records changed while connecting receiving. Retry setup to check the final records.'); }
          step = 'verifyRouting';
          if (!await verifyDomainRouting(this.env, domain.zoneId, this.env.MAIL_INGRESS_WORKER)) { invalidate(false); return answer('pending', 'Cloudflare is still completing receiving setup. Retry setup to confirm the receiving route.'); }
          this.store('Domain', { ...verified, receivingConnected: true, checks: finalVerification.checks, warnings: finalVerification.warnings });
          if (recoveryId) this.store('PrivateConfig', { ...state.objects.PrivateConfig[recoveryId], status: 'complete' });
          return answer('ready', 'Sending and receiving are connected. DNS changes may take time to reach other mail servers.', { sendingVerified: true, receivingConnected: true, checks: finalVerification.checks, warnings: finalVerification.warnings });
        } catch (error) {
          const reason = error instanceof Error ? error.message : '';
          // Only our own fixed diagnostic codes leave this boundary. Exception
          // messages, request headers, provider bodies and credentials are never logged.
          const knownCodes = new Set(['domainReviewStale', 'domainReviewBlocked', 'domainReviewTooLarge', 'existingCatchAllRouteNeedsManualReview', 'existingRecipientRouteNeedsManualReview', 'dnsPlanStale', 'domainSetupNotConfigured', 'cloudflareApiFailure', 'invalidProviderResponse', 'invalidProviderDnsResponse', 'invalidDnsResponse', 'invalidIngressWorker', 'invalidDomain', 'invalidZoneId', 'invalidSendingSubdomainId', 'zoneDomainMismatch', 'dnsPaginationLimit', 'routingPaginationLimit', 'invalidMailDnsRequirement', 'providerRequirementsIncomplete', 'providerSpfRequirementsConflict', 'recordOutsideDomain', 'dnsPlanHasConflicts', 'dnsPlanInvalid', 'dnsRecordProtected', 'providerTimeout', 'providerUnavailable', 'missingDnsRecordId']);
          const code = knownCodes.has(reason) || /^cloudflareHttp[1-5][0-9]{2}$/.test(reason) ? reason : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'providerTimeout' : 'providerUnavailable';
          if (error instanceof DomainProviderError && error.providerStep) step = error.providerStep;
          diagnostics = { stage, step, code, ...(error instanceof DomainProviderError && error.providerCodes.length ? { providerCodes: error.providerCodes } : {}) };
          console.warn('Mail domain setup failed', diagnostics);
          if (recoveryId && state.objects.PrivateConfig?.[recoveryId]) {
            const recovery = state.objects.PrivateConfig[recoveryId];
            this.store('PrivateConfig', { ...recovery, status: 'unknown', completed: [...new Set([...(recovery.completed || []), ...(error instanceof DomainProviderError ? error.completed || [] : [])])] });
            this.save();
          }

          if (['existingCatchAllRouteNeedsManualReview', 'existingRecipientRouteNeedsManualReview'].includes(reason)) { invalidate(false); return answer('blocked', 'This domain has an active mail route owned by another application. Review it before connecting EnoughMail.'); }
          if (['domainReviewStale', 'domainReviewBlocked'].includes(reason)) return answer('blocked', 'The reviewed configuration changed or still contains a protected record. Review the latest changes before continuing.');
          if (reason === 'dnsPlanStale') { invalidate(true); return answer('pending', 'DNS records changed during setup. Run setup again to check the latest records.'); }
          if (reason === 'cloudflareHttp403' || reason === 'cloudflareHttp401') return answer('blocked', 'Cloudflare denied this setup request. Check the domain connection permissions for DNS, Email Sending, and Email Routing.');
          if (reason === 'domainSetupNotConfigured') return answer('blocked', 'Connect Cloudflare domain management before setting up delivery.');
          if (stage !== 'review') invalidate(stage !== 'receiving');
          return answer('pending', 'Domain setup could not complete. Your progress is saved; retry setup to check the current records before continuing.');
        }
      }
      if (['Domain/prepare','Domain/route'].includes(name)) {
        if (!args.ifInState || args.ifInState !== currentState) return stateError('stateMismatch');
        if (name === 'Domain/prepare') {
          const sendingSubdomainId = await prepareSendingDomain(this.env, domain.name.toLowerCase(), domain.zoneId);
          this.store('Domain', { ...domain, sendingSubdomainId, dnsState: 'unverified', sendingVerified: false });
          return { accountId, domainId: domain.id, sendingSubdomainId, newState: token(state.sequence) };
        }
        if (!this.env.MAIL_INGRESS_WORKER || !domain.sendingVerified || domain.enabled === false) return stateError('invalidArguments', 'Verify and enable the domain before connecting receiving.');
        const plan = await fetchDomainDnsPlan(this.env, domain.name, domain.zoneId, domain.sendingSubdomainId);
        const verification = await verifyDomainDnsWithSpf(plan, await listDomainDns(this.env, domain.zoneId));
        if (!verification.ready) return stateError('stateMismatch', 'DNS records changed. Review and verify again.');
        await connectDomainRouting(this.env, domain.name, domain.zoneId, this.env.MAIL_INGRESS_WORKER);
        await this.syncDirectory(domain, context);
        this.store('Domain', { ...domain, receivingConnected: true });
        return { accountId, domainId: domain.id, receivingConnected: true, newState: token(state.sequence) };
      }
      if(!domain.zoneId||!domain.sendingSubdomainId)return stateError('invalidArguments','Zone ID and provider sending subdomain ID required');
      const plan=await fetchDomainDnsPlan(this.env,domain.name,domain.zoneId,domain.sendingSubdomainId);
      if(name==='Domain/plan')return {accountId,domainId:domain.id,plan};
      if(name==='Domain/apply'){
        if(!args.ifInState||args.ifInState!==currentState)return stateError('stateMismatch');
        if(!args.plan||JSON.stringify(args.plan)!==JSON.stringify(plan))return stateError('stateMismatch','DNS plan changed; review again');
        const result=await applyDomainDns(this.env,domain.zoneId,plan);return {accountId,domainId:domain.id,...result};
      }
      const result=await verifyDomainDnsWithSpf(plan,await listDomainDns(this.env,domain.zoneId));
      this.store('Domain',{...domain,dnsState:result.ready?'verified':'error',sendingVerified:result.ready,checks:result.checks,warnings:result.warnings});
      for(const identity of Object.values(state.objects.Identity))if(!identity.transferredTo&&identity.email.split('@')[1].toLowerCase()===domain.name.toLowerCase())this.store('Identity',{...identity,verified:result.ready});
      if(result.ready)await this.syncDirectory(domain,context);
      return {accountId,domainId:domain.id,...result,state:token(state.sequence)};
    }
    if(name==='Quarantine/get'){
      const emails=this.repository.queryEmails({filter:{inMailbox:'folder-quarantine'},limit:1000});const list=this.repository.readEmails({ids:emails.ids,limit:1000}).map(email=>({id:email.id,subject:email.subject,status:email.quarantine?.status,reason:email.quarantine?.reason,scannerReceiptDigest:email.quarantine?.scannerReceiptDigest}));return {accountId,state:currentState,list,total:emails.total};
    }
    if(name==='Quarantine/retry'){
      if(!context.actor.actions.includes('mail.organize'))return stateError('forbidden');for(const id of args.emailIds||[]){const email=this.repository.readEmails({ids:[id],limit:1})[0];if(email?.quarantine)this.stageSql("UPDATE mail_scan_jobs SET next_attempt=?,status='pending' WHERE email_id=?",Date.now(),id);}return {accountId,state:currentState,status:'pending'};
    }
    if(name==='Quota/get')return {accountId,state:currentState,list:[this.quota.get()],notFound:[]};
    if(name==='Quota/set'){if(!context.actor.actions.includes('mail.manage'))return stateError('forbidden');const quota=this.quota.set(args.hardLimit,context.actor);state.objects.QuotaConfig??={};this.store('QuotaConfig',{id:'storage',hardLimit:quota.hardLimit});return {accountId,oldState:currentState,newState:token(state.sequence),quota};}
    if(name==='Retention/get')return {accountId,state:currentState,trashRetentionDays:state.objects.Retention?.singleton?.trashRetentionDays??30,junkRetentionDays:state.objects.Retention?.singleton?.junkRetentionDays??30};
    if(name==='Retention/set'){if(!context.actor.actions.includes('mail.manage'))return stateError('forbidden');for(const key of ['trashRetentionDays','junkRetentionDays'])if(args[key]!==undefined&&(!Number.isInteger(args[key])||args[key]<1||args[key]>3650))throw new Error('Invalid retention period');state.objects.Retention??={};this.store('Retention',{id:'singleton',trashRetentionDays:args.trashRetentionDays??30,junkRetentionDays:args.junkRetentionDays??30});return {accountId,newState:token(state.sequence),...state.objects.Retention.singleton};}
    if(name==='Lifecycle/get'){if(!context.actor.actions.includes('mail.manage'))return stateError('forbidden');return {accountId,...this.lifecycle.get()};}
    if(name==='Lifecycle/set'){const result=this.lifecycle.command({id:args.operationId||crypto.randomUUID(),expectedRevision:args.expectedRevision,action:args.action,actor:context.actor});if(args.action==='suspend'||args.action==='requestDeletion'){for(const domain of Object.values(state.objects.Domain))await this.withdrawDomain(domain,context);if(this.env.MAIL_CREDENTIALS){const operationId=await this.commandUuid(`${context.actor.id}:${args.operationId||context.commandOperationId}`);const revoked=await this.env.MAIL_CREDENTIALS.get(this.env.MAIL_CREDENTIALS.idFromName('mail-client-credentials-v1')).fetch(new Request('https://mail-credentials/revoke-account',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationId,context:{accountId,organizationId:context.organizationId,workspaceId:context.workspaceId,actorId:context.actor.id,actions:context.actor.actions}})}));if(!revoked.ok)throw new Error('Credential revocation unavailable');}for(const submission of Object.values(state.objects.EmailSubmission))if(['pending','scheduled'].includes(submission.status))this.store('EmailSubmission',{...submission,status:'canceled',undoStatus:'canceled',error:'accountSuspended'});if(state.objects.PrivateConfig?.automation)this.store('PrivateConfig',state.objects.PrivateConfig.automation,true);}if(args.action==='resume'||args.action==='cancelDeletion')for(const domain of Object.values(state.objects.Domain))if(domain.sendingVerified&&domain.enabled!==false)await this.syncDirectory(domain,context);state.objects.LifecycleConfig??={};this.store('LifecycleConfig',{id:'status',...result});return {accountId,...result};}
    if(name==='Export/start'){
      if(!['eml','mbox'].includes(args.format||'eml'))return stateError('invalidArguments');state.objects.Export??={};
      const exportId=crypto.randomUUID();const result=this.repository.createExport(exportId,context.actor.id,args.filter);this.store('Export',{id:exportId,actorId:context.actor.id,format:args.format||'eml',status:'ready',createdAt:new Date().toISOString(),total:result.total,snapshotState:currentState,mailboxes:clone(Object.values(state.objects.Mailbox))});return {accountId,exportId,state:currentState,status:'ready',total:result.total,mailboxes:clone(Object.values(state.objects.Mailbox))};
    }
    if(name==='Export/page'||name==='Export/cancel'){
      const job=state.objects.Export?.[args.exportId];if(!job||job.actorId!==context.actor.id)return stateError('notFound');
      if(name==='Export/cancel'){this.repository.cancelExport(job.id);this.store('Export',job,true);return {accountId,exportId:job.id,status:'canceled'};}
      return {accountId,exportId:job.id,state:job.snapshotState,status:job.status,mailboxes:job.mailboxes,...this.repository.exportPage(job.id,args.position,args.limit)};
    }
    if(name==='Forwarding/get')return {accountId,failures:[...this.ctx.storage.sql.exec<{emailId:string;status:string;reason:string;at:number}>('SELECT email_id AS emailId,status,error AS reason,at FROM mail_forward_status ORDER BY at DESC LIMIT 20')],list:Object.values(state.objects.ForwardingVerification||{}).map(item=>({address:item.address,status:item.status,verified:item.verified===true}))};
    if(name==='Forwarding/requestVerification'||name==='Forwarding/verify'){
      if(!context.actor.actions.includes('mail.manage'))return stateError('forbidden');
      state.objects.ForwardingVerification??={};const address=String(args.address||'').toLowerCase();const previous=state.objects.ForwardingVerification[address];
      if(name==='Forwarding/verify'){
        if(!previous||previous.actorId!==context.actor.id)return stateError('notFound');
        const result=await checkForwardingVerification(this.env,address,undefined,previous.providerId);const next={...previous,...result,verified:result.status==='verified'};this.store('ForwardingVerification',next);return {accountId,...result};
      }
      if(previous?.requestedAt&&Date.now()-Date.parse(previous.requestedAt)<60000)return stateError('tooManyRequests');
      this.store('ForwardingVerification',{id:address,address,actorId:context.actor.id,requestedAt:new Date().toISOString(),status:'pending',verified:false});this.save();
      const result=await requestForwardingVerification(this.env,{address});this.store('ForwardingVerification',{id:address,actorId:context.actor.id,requestedAt:new Date().toISOString(),...result,verified:result.status==='verified'});return {accountId,...result};
    }
    if(name==='Settings/get')return {accountId,state:currentState,automationHealth:this.automationHealth(),settings:{id:'singleton',undoSeconds:10,remoteImages:false,density:'comfortable',...this.settings()}};
    if(name==='Settings/renew'){if(!context.actor.actions.includes('mail.manage')||!context.actor.actions.includes('mail.send')||!context.authorityProof?.expiresAt)return stateError('forbidden','A fresh sending authorization is required');if(args.ifInState&&args.ifInState!==currentState)return stateError('stateMismatch');state.objects.PrivateConfig??={};this.setAutomationAuthority(context);return {accountId,oldState:currentState,newState:token(state.sequence),automationHealth:this.automationHealth()};}
    if(name==='Settings/set') {validateWritable('Settings',args.settings,'update',context.actor.actions);const {undoSeconds,remoteImages,density,signatures,favoriteMailboxIds,...workflow}=args.settings;validateSettings(workflow);if(signatures !== undefined){const library=validateSignatures(signatures);validateSignatureRemoval(library,Object.values(state.objects.Identity));args.settings={...args.settings,signatures:library};}if((workflow.forwarding?.enabled||workflow.vacation?.enabled)&&(!context.actor.actions.includes('mail.send')||!context.authorityProof))throw new Error('Automation requires current sending authority');if(favoriteMailboxIds&&(!Array.isArray(favoriteMailboxIds)||favoriteMailboxIds.some((id:string)=>!state.objects.Mailbox[id])))throw new Error('Invalid favorites');if(workflow.forwarding?.enabled&&!state.objects.ForwardingVerification?.[workflow.forwarding.address]?.verified)throw new Error('Forwarding destination is not verified');if(args.ifInState&&args.ifInState!==currentState)return stateError('stateMismatch');state.objects.Settings??={};const settings={...state.objects.Settings.singleton,...args.settings,id:'singleton'};if(workflow.vacation){const vacation={...state.objects.VacationResponse.singleton,id:'singleton',isEnabled:workflow.vacation.enabled,subject:workflow.vacation.subject,textBody:workflow.vacation.textBody,fromDate:workflow.vacation.fromDate??null,toDate:workflow.vacation.toDate??null};this.validate('VacationResponse',vacation);if(vacation.isEnabled)this.assertAutomationAuthority(context);this.store('VacationResponse',vacation);}this.store('Settings',settings);if(context.authorityProof&&context.actor.actions.includes('mail.manage')&&context.actor.actions.includes('mail.send')){state.objects.PrivateConfig??={};this.setAutomationAuthority(context);}return {accountId,oldState:currentState,newState:token(state.sequence),settings};}
    if(name==='FollowUp/set'){
      if(!args.ifInState||args.ifInState!==currentState)return stateError('stateMismatch');const updated:any={},notUpdated:any={};
      for(const id of args.emailIds||[]){const email=state.objects.Email[id];if(!email){notUpdated[id]=stateError('notFound');continue;}let next=clone(email);if(args.until===null)delete next.followUp;else next=applyFollowUp(email as any,{until:args.until,ifNoReply:args.ifNoReply??true,now:new Date().toISOString()}) as MailObject;this.store('Email',next);updated[id]=null;}
      return {accountId,oldState:currentState,newState:token(state.sequence),updated,notUpdated};
    }
    if(name==='Snooze/set') {
      if(args.ifInState&&args.ifInState!==currentState)return stateError('stateMismatch');const updated:any={};const notUpdated:any={};
      if(args.until!==null&&(!Number.isFinite(Date.parse(args.until))||Date.parse(args.until)<=Date.now()))throw new Error('Snooze time must be in the future');
      for(const id of args.emailIds||[]){const email=state.objects.Email[id];if(!email){notUpdated[id]=stateError('notFound');continue;}const next=clone(email);if(args.until){state.objects.Mailbox['folder-snoozed']??={id:'folder-snoozed',name:'Snoozed',role:null,parentId:null,sortOrder:5,isSubscribed:true};next.snooze={until:args.until,mailboxIds:clone(email.mailboxIds)};delete next.mailboxIds['folder-inbox'];next.mailboxIds['folder-snoozed']=true;}else{if(next.snooze)next.mailboxIds={...next.mailboxIds,...next.snooze.mailboxIds};delete next.mailboxIds['folder-snoozed'];delete next.snooze;}this.store('Email',next);updated[id]=null;}
      return {accountId,oldState:currentState,newState:token(state.sequence),updated,notUpdated};
    }
    if(name==='Rule/cancel'){this.repository.cancelRuleApplyJob(args.jobId,context.actor.id);return {accountId,jobId:args.jobId,status:'canceled'};}
    if(name==='Rule/apply'){
      if(args.ifInState&&args.ifInState!==currentState)return stateError('stateMismatch');
      const rules=args.rules?args.rules.map(validateRule):this.getRules().filter(rule=>!args.ruleIds||args.ruleIds.includes(rule.id));
      if(args.emailIds){const items=this.getEmails().filter(email=>args.emailIds.includes(email.id));for(const email of items)this.store('Email',applyRules(email as any,rules as any) as MailObject);return {accountId,state:token(state.sequence),total:items.length,processed:items.length,hasMore:false};}
      const jobId=args.jobId||context.commandOperationId!;if(!args.jobId)this.repository.createRuleApplyJob(jobId,context.actor.id,JSON.stringify(rules));
      const page=this.repository.ruleApplyPage(jobId,context.actor.id,100);const frozen=page.rules.map(validateRule);const emails=this.repository.readEmails({ids:page.ids,limit:100});for(const email of emails)this.store('Email',applyRules(email as any,frozen) as MailObject);
      this.pendingSql.push({query:'UPDATE mail_rule_apply_jobs SET cursor=?,status=? WHERE id=? AND actor_id=? AND cursor=?',bindings:[page.nextCursor,page.hasMore?'pending':'complete',jobId,context.actor.id,page.cursor]});
      return {accountId,state:token(state.sequence),jobId,total:page.total,processed:page.nextCursor,hasMore:page.hasMore};
    }
    if(name==='Rule/preview'){const rules=args.rules?args.rules.map(validateRule):this.getRules().filter(rule=>!args.ruleIds||args.ruleIds.includes(rule.id));const list=this.getEmails().filter(email=>!args.emailIds||args.emailIds.includes(email.id)).map(email=>({before:email,after:applyRules(email as any,rules as any)})).filter(item=>JSON.stringify(item.before)!==JSON.stringify(item.after));return {accountId,state:currentState,list:list.map(item=>({id:item.before.id,mailboxIds:item.after.mailboxIds,keywords:item.after.keywords})),total:list.length,bounded:true};}
    if(type==='Thread'&&operation==='get') {for(const email of this.repository.readEmails({threadIds:args.ids,limit:1000}))state.objects.Email[email.id]=email;const threads:Record<string,MailObject>={};for(const email of this.getEmails()){threads[email.threadId]??={id:email.threadId,emailIds:[]};threads[email.threadId].emailIds.push(email.id);}return this.getResponse(threads,args);}
    if(!writableTypes.has(type)||!state.objects[type])return stateError('unknownMethod');
    if(operation==='get'){const source=type==='Identity'?Object.fromEntries(Object.entries(state.objects.Identity).filter(([,item])=>!item.transferredTo)):type==='EmailSubmission'&&!context.actor.actions.includes('mail.read')?Object.fromEntries(Object.entries(state.objects[type]).filter(([,item])=>item.actorId===context.actor.id)):state.objects[type];const result=this.getResponse(source,type==='Email'?{...args,properties:undefined}:args);result.list=result.list.map((item:MailObject)=>{const projected=this.publicObject(type,item);if(type==='EmailSubmission'){const retained=state.objects.EmailSubmission[item.id];projected.recoverable=['mail.read','mail.draft'].every(action=>context.actor.actions.includes(action))&&['failed','uncertain'].includes(retained?.status)&&typeof retained?.emailSnapshot?.blobId==='string'&&(!retained.emailSnapshot.quarantine||retained.emailSnapshot.quarantine.status==='clean')&&this.blobIsClean(retained.emailSnapshot.blobId);}return projected;});if(type==='Rule')result.list.sort((a:MailObject,b:MailObject)=>(a.sortOrder??0)-(b.sortOrder??0)||a.id.localeCompare(b.id));if(type==='Mailbox')result.list=result.list.map((item:MailObject)=>this.mailbox(item,context));if(type==='Email'){
      let remaining=32*1024*1024;
      for(let index=0;index<result.list.length;index++){
        const item=result.list[index];let values:any=undefined;
        if(args.fetchAllBodyValues||args.fetchTextBodyValues||args.fetchHTMLBodyValues){
          values=await this.readBodyValues(item,args);
          const projected=projectEmail(item,args,values);const bytes=new TextEncoder().encode(JSON.stringify(projected)).length;if(bytes>remaining)return stateError('serverFail','Requested body values exceed the bounded response size; request fewer objects or maxBodyValueBytes');remaining-=bytes;result.list[index]=projected;continue;
        }
        result.list[index]=projectEmail(item,args,values);
      }
    }
return result;}
    if(type==='EmailSubmission'&&!context.actor.actions.includes('mail.read')&&['query','queryChanges','changes'].includes(operation))return stateError('forbidden');
    if(operation==='query'||operation==='queryChanges'){
      let list=Object.values(state.objects[type]).filter(value=>type!=='Identity'||!value.transferredTo);let filter=args.filter;if(args.filter?.text){const {text,...rest}=args.filter;const parsed=parseSearchQuery(text);filter=Object.keys(rest).length?{operator:'AND',conditions:[rest,parsed]}:parsed;}
      if(type==='Email'&&operation==='query'){
        validateFilter(filter||{});const page=this.repository.queryEmails({filter,sort:args.sort,position:args.position,limit:args.limit,anchor:args.anchor,anchorOffset:args.anchorOffset});const queryState=`${currentState}-${await this.hash(JSON.stringify([type,args.filter||{},args.sort||[]]))}`;
        const canCalculateChanges=page.total<=1000;
        if(canCalculateChanges){state.querySnapshots[queryState]=this.repository.queryEmails({filter,sort:args.sort,limit:1000}).ids;const keys=Object.keys(state.querySnapshots);if(keys.length>25)delete state.querySnapshots[keys[0]];}
        return {accountId,queryState,canCalculateChanges,position:page.position,ids:page.ids,total:page.total};
      }
      if(type==='Email'&&operation==='queryChanges'){const page=this.repository.queryEmails({filter,sort:args.sort,limit:1000});if(page.total>1000)return stateError('cannotCalculateChanges');for(const email of this.repository.readEmails({ids:page.ids,limit:1000}))state.objects.Email[email.id]=email;list=page.ids.map(id=>state.objects.Email[id]);}
      if(type==='Email'){validateFilter(filter||{});list=list.filter(item=>matchesFilter(item as any,filter));}else if(args.filter)list=list.filter(item=>Object.entries(args.filter).every(([key,value])=>item[key]===value));
      list=sortEmails(list as any,args.sort||[{property:type==='Email'?'receivedAt':'name',isAscending:type!=='Email'}],type==='Email'?this.getEmails() as any:undefined) as MailObject[];
      const all=list.map(item=>item.id);const queryState=`${currentState}-${await this.hash(JSON.stringify([type,args.filter||{},args.sort||[]]))}`;
      if(operation==='queryChanges'){const before=state.querySnapshots[args.sinceQueryState];if(!before)return stateError('cannotCalculateChanges');state.querySnapshots[queryState]=all;const removed=before.filter(id=>!all.includes(id));const added=all.flatMap((id,index)=>!before.includes(id)||before.indexOf(id)!==index?[{id,index}]:[]);for(const id of all)if(before.includes(id)&&before.indexOf(id)!==all.indexOf(id)&&!removed.includes(id))removed.push(id);return {accountId,oldQueryState:args.sinceQueryState,newQueryState:queryState,total:all.length,removed,added};}
      let position=args.position||0;if(position<0)position=Math.max(0,all.length+position);if(args.anchor){const anchor=all.indexOf(args.anchor);if(anchor<0)return stateError('anchorNotFound');position=Math.max(0,anchor+(args.anchorOffset||0));}
      state.querySnapshots[queryState]=all;const keys=Object.keys(state.querySnapshots);if(keys.length>100)delete state.querySnapshots[keys[0]];
      return {accountId,queryState,canCalculateChanges:true,position,ids:all.slice(position,position+Math.min(args.limit??100,1000)),total:all.length};
    }
    if(operation==='changes'){
      const since=parseToken(args.sinceState);if(since===null||since>state.sequence||(state.changes.length&&since<state.changes[0].sequence-1))return stateError('cannotCalculateChanges');
      const relevant=state.changes.filter(change=>change.type===type&&change.sequence>since);const limit=Math.max(1,Math.min(args.maxChanges||1000,1000));const page=relevant.slice(0,limit);const final=page.at(-1)?.sequence??state.sequence;const latest=new Map(page.map(item=>[item.id,item]));
      return {accountId,oldState:args.sinceState,newState:token(relevant.length>limit?final:state.sequence),hasMoreChanges:relevant.length>limit,created:[...latest.values()].filter(item=>!item.destroyed&&page.some(change=>change.id===item.id&&change.created)).map(item=>item.id),updated:[...latest.values()].filter(item=>!item.destroyed&&!page.some(change=>change.id===item.id&&change.created)).map(item=>item.id),destroyed:[...latest.values()].filter(item=>item.destroyed).map(item=>item.id)};
    }
    if(type==='Email'&&operation==='copy'){
      if(args.fromAccountId!==accountId)return this.copyForeign(args,context);if(!context.actor.actions.includes('mail.read'))return stateError('forbidden');if(args.ifFromInState&&args.ifFromInState!==currentState||args.ifInState&&args.ifInState!==currentState)return stateError('stateMismatch');
      if(!context.actor.actions.includes('mail.read')||!context.actor.actions.includes('mail.draft'))return stateError('forbidden');
      const created:any={},notCreated:any={},destroyed:string[]=[];
      for(const [key,input]of Object.entries(args.create||{}) as [string,any][]){try{const original=this.repository.readEmails({ids:[input.id],limit:1})[0];if(!original)throw new Error('Source email missing');if(original.quarantine&&original.quarantine.status!=='clean')throw new Error('Source email is quarantined');const {id,...patch}=input;validateWritable('Email',patch,'update',context.actor.actions);if(args.onSuccessDestroyOriginal&&!context.actor.actions.includes('mail.organize'))throw new Error('Destroy original denied');const email:MailObject={...patchObject(original,patch),id:crypto.randomUUID()};this.validate('Email',email);this.pendingActions.push(()=>this.provenance.recordPrepared(email.id,context.actor.id,email.blobId));this.store('Email',email);created[key]={id:email.id,blobId:email.blobId,threadId:email.threadId,size:email.size};if(args.onSuccessDestroyOriginal){if(!context.actor.actions.includes('mail.organize'))throw new Error('Destroy original denied');this.store('Email',original,true);destroyed.push(original.id);}}catch(error){notCreated[key]=stateError('invalidProperties',String(error));}}
      const result:any={fromAccountId:accountId,accountId,oldState:currentState,newState:token(state.sequence),created,notCreated};if(args.onSuccessDestroyOriginal)result.__implicitResponses=[['Email/set',{accountId,oldState:currentState,newState:token(state.sequence),destroyed}]];return result;
    }
    if(type==='Email'&&operation==='import'){
      if(args.ifInState&&args.ifInState!==currentState)return stateError('stateMismatch');const created:any={};const notCreated:any={};for(const [key,value] of Object.entries(args.emails||{})){try{const email=await this.importEmail(value as any,context);const duplicate=args.duplicatePolicy==='skipIdentical'?this.findDuplicate(email.rawHash):null;if(duplicate){created[key]={id:duplicate.id,blobId:duplicate.blobId,threadId:duplicate.threadId,size:duplicate.size,isDuplicate:true};continue;}this.pendingActions.push(()=>this.provenance.recordPrepared(email.id,context.actor.id,email.blobId));this.store('Email',email);created[key]={id:email.id,blobId:email.blobId,threadId:email.threadId,size:email.size};}catch(error){notCreated[key]=stateError('invalidEmail',String(error));}}return {accountId,oldState:currentState,newState:token(state.sequence),created,notCreated};
    }
    if(operation==='set'&&writableTypes.has(type))return this.setObjects(type,args,context);
    return stateError('unknownMethod');
  }
  private publicObject(type:string,object:MailObject):MailObject {const result=clone(object);if(type==='EmailSubmission')for(const key of ['authorityProof','emailSnapshot','identitySnapshot','actorId','attemptedAt','automation','authorityBasis','knownContentBlob'])delete result[key];return result;}
  private getResponse(objects:Record<string,MailObject>,args:any) {const ids=args.ids??Object.keys(objects);const list=ids.filter((id:string)=>objects[id]).map((id:string)=>clone(objects[id]));if(args.properties)for(let index=0;index<list.length;index++)list[index]=Object.fromEntries(['id',...args.properties].filter((key:string)=>key in list[index]).map((key:string)=>[key,list[index][key]]));return {accountId:this.state!.context.accountId,state:token(this.state!.sequence),list,notFound:ids.filter((id:string)=>!objects[id])};}
  private async commandUuid(value:string){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).slice(0,16);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes).map(value=>value.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
  private async hash(value:string){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(digest).slice(0,8)).map(value=>value.toString(16).padStart(2,'0')).join('');}
  private validate(type:string,object:MailObject) {
    if(type==='Mailbox'){if(object.color&&!/^#[a-f0-9]{6}$/i.test(object.color))throw new Error('Invalid label color');if(typeof object.name!=='string'||!object.name.trim())throw new Error('Mailbox name required');if(object.parentId&&!this.state!.objects.Mailbox[object.parentId])throw new Error('Parent mailbox missing');let parent=object.parentId;const visited=new Set([object.id]);while(parent){if(visited.has(parent))throw new Error('Mailbox cycle');visited.add(parent);parent=this.state!.objects.Mailbox[parent]?.parentId;}}
    if(type==='Email'){if(object.quarantine&&object.quarantine.status!=='clean'&&!object.mailboxIds?.['folder-quarantine'])throw new Error('Quarantined messages cannot leave quarantine before a clean scan');if(!object.mailboxIds||!Object.keys(object.mailboxIds).some(id=>object.mailboxIds[id]))throw new Error('At least one mailbox is required');for(const id of Object.keys(object.mailboxIds))if(object.mailboxIds[id]&&!this.state!.objects.Mailbox[id])throw new Error('Mailbox missing');if(!object.keywords||typeof object.keywords!=='object')throw new Error('Keywords map required');}
    if(type==='Rule')validateRule(object);
    if(type==='Identity')validateSignatureReference(object.signatureId,validateSignatures(this.settings().signatures||[]));
    if(type==='Identity'||type==='Contact'){if(typeof object.email!=='string'||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(object.email))throw new Error('Valid email required');}
    if(type==='Domain'){if(typeof object.name!=='string'||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(object.name))throw new Error('Valid domain required');}
  }
  private findDuplicate(hash:string):MailObject|null {
    const row=[...this.ctx.storage.sql.exec<{json:string}>("SELECT json FROM mail_objects WHERE type='Email' AND json_extract(json,'$.rawHash')=? LIMIT 1",hash)][0];return row?JSON.parse(row.json):null;
  }
  private async importEmail(input:any,context?:MailContext):Promise<MailObject>{
    if(typeof input.blobId!=='string'||! /^[\w.-]+$/.test(input.blobId))throw new Error('Invalid blob ID');if(context)this.provenance.assertSource(input.blobId,context.actor.id,context.actor.actions.includes('mail.read'));const source=await this.mimeSource(input.blobId);this.quota.reconcileBlob(input.blobId,source.size,'raw');const {parsed,rawHash}=await this.parseStoredMime(input.blobId,source);const attachments=parsed.attachments;
    const reference=(parsed.references||[]).at(-1)||parsed.inReplyTo?.at(-1);const existing=reference?this.repository.readEmails({messageReference:reference,limit:1})[0]:null;
    const object:MailObject={...parsed,attachments,rawHash,id:crypto.randomUUID(),blobId:input.blobId,threadId:existing?.threadId||crypto.randomUUID(),size:source.size,receivedAt:input.receivedAt||new Date().toISOString(),mailboxIds:input.mailboxIds||{'folder-inbox':true},keywords:input.keywords||{},hasAttachment:attachments.length>0};this.validate('Email',object);if(context&&!context.actor.actions.includes('mail.read'))for(const part of [...parsed.textBody,...parsed.htmlBody,...parsed.attachments])if(part.blobId)this.provenance.recordSource(part.blobId,context.actor.id);if(object.attachments.length)this.queueScan(object);return object;
  }
  private async setObjects(type:string,args:any,context:MailContext,preserveSubmissions:ReadonlySet<string>=new Set()){
    const state=this.state!;const actionCount=this.pendingActions.length,statementCount=this.pendingSql.length;const oldState=token(state.sequence);if(args.ifInState&&args.ifInState!==oldState)return stateError('stateMismatch');
    const replacement=type==='Email'&&Object.keys(args.create||{}).length===1&&(args.destroy||[]).length===1&&state.objects.Email[args.destroy[0]]?.keywords?.['$draft'];const replacementBefore=replacement?clone(state):null;
    const response:any={accountId:state.context.accountId,oldState,created:{},updated:{},destroyed:[],notCreated:{},notUpdated:{},notDestroyed:{}};
    for(const [key,input]of Object.entries(args.create||{})){try{validateWritable(type,input,'create',context.actor.actions);let object:MailObject={...(input as any),id:crypto.randomUUID()};
      if(type==='Email'){object.mailboxIds??={'folder-drafts':true};object.keywords??={'$draft':true};const {blobId,size,parsed}=await this.composeStored(object,context);object={...object,textBody:parsed.textBody,htmlBody:parsed.htmlBody,bodyValues:parsed.bodyValues,bodyStructure:parsed.bodyStructure,sender:parsed.sender,attachments:parsed.attachments,messageId:parsed.messageId};const reference=object.inReplyTo?.at(-1)||object.references?.at(-1);const parent=reference?this.repository.readEmails({messageReference:reference,limit:1})[0]:null;object={...object,blobId,threadId:parent?.threadId||crypto.randomUUID(),size,receivedAt:new Date().toISOString(),preview:Object.values(object.bodyValues||{}).map((value:any)=>value.value).join(' ').slice(0,200),hasAttachment:!!object.attachments?.length};}
      if(type==='Email'&&object.draftFrom!==undefined&&!object.keywords?.['$draft'])throw new Error('The pending sending address belongs to a draft');
      if(type==='Identity'){const domain=Object.values(state.objects.Domain).find(domain=>domain.sendingVerified&&domain.name.toLowerCase()===object.email?.split('@')[1]?.toLowerCase());object={...object,verified:!!domain,mayDelete:true};}if(type==='Domain')object={...object,dnsState:'unverified',sendingVerified:false};
      if(type==='EmailSubmission')object=await this.createSubmission(object,context);
      this.validate(type,object);if(type==='VacationResponse'&&object.isEnabled)this.assertAutomationAuthority(context);if(type==='Email')this.pendingActions.push(()=>this.provenance.recordPrepared(object.id,context.actor.id,object.blobId));if(type==='Rule')this.validateRuleForward(object,context);if(type==='Email'&&object.hasAttachment)this.queueScan(object);if(type==='Identity'){if(!await this.ownsTransferredAddress(object,false))throw new Error('This address belongs to another inbox.');if(Object.values(state.objects.Identity).some(identity=>identity.email.toLowerCase()===object.email.toLowerCase()))throw new Error('This address already has a sending identity.');const domain=Object.values(state.objects.Domain).find(domain=>domain.sendingVerified&&domain.name.toLowerCase()===object.email.split('@')[1].toLowerCase());if(domain)await this.registerIdentityAddress(domain,object,context);}this.store(type,object);if((type==='VacationResponse'||type==='Rule'&&object.actions?.forwardTo?.length)&&context.authorityProof&&context.actor.actions.includes('mail.manage')&&context.actor.actions.includes('mail.send')){state.objects.PrivateConfig??={};this.setAutomationAuthority(context);}response.created[key]=type==='Email'?{id:object.id,blobId:object.blobId,threadId:object.threadId,size:object.size}:this.publicObject(type,object);
    }catch(error){response.notCreated[key]=stateError('invalidProperties',error instanceof Error?error.message:String(error));}}
    if(replacement&&Object.keys(response.notCreated).length){response.notDestroyed[args.destroy[0]]=stateError('willDestroy','Draft replacement failed; original retained');response.newState=oldState;return response;}
    for(const [id,patch]of Object.entries(args.update||{})){try{validateWritable(type,patch,'update',context.actor.actions);const existing=state.objects[type][id];if(!existing)throw new Error('Object not found');
      if(type==='Identity'&&existing.transferredTo)throw new Error('This address was moved to another inbox.');
      if(type==='Identity'&&Object.keys(patch as any).some(key=>['verified','mayDelete'].includes(key)))throw new Error('Verification is server owned');
      if(type==='Domain'&&Object.keys(patch as any).some(key=>['dnsState','sendingVerified'].includes(key)))throw new Error('Domain verification is server owned');
      if(type==='EmailSubmission'&&!context.actor.actions.includes('mail.read')&&existing.actorId!==context.actor.id)throw new Error('Submission belongs to another actor');
      let next=patchObject(existing,patch as any);
      if(type==='Email'&&Object.hasOwn(patch as object,'draftFrom')&&(!existing.keywords?.['$draft']||!next.keywords?.['$draft']))throw new Error('The pending sending address belongs to a draft');
      if(type==='Domain'&&Object.hasOwn(patch as object,'catchAllAccountId')&&next.catchAllAccountId!==null&&next.catchAllAccountId!==context.accountId)throw new Error('Unmatched-address delivery must use this inbox.');
      if(type==='Domain'&&Object.keys(patch as object).length===1&&Object.hasOwn(patch as object,'catchAllAccountId')){
        this.validate(type,next);
        // A delivery toggle must not briefly withdraw every explicit address.
        // Commit the preference only after its one directory write is confirmed.
        if(next.catchAllAccountId===context.accountId&&next.sendingVerified){
          if(!this.env.MAIL_DIRECTORY)throw new Error('Mail routing directory unavailable');
          const account={accountId:context.accountId,organizationId:context.organizationId,workspaceId:context.workspaceId,ownerActorId:context.actor.id};
          const registered=await this.env.MAIL_DIRECTORY.get(this.env.MAIL_DIRECTORY.idFromName('directory')).fetch(new Request('https://mail-directory/register-address',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account,address:next.name,enabled:next.enabled!==false,catchAll:true})}));
          if(!registered.ok)throw new Error(registered.status===409?'Unmatched-address delivery already belongs to another inbox.':'Unmatched-address delivery could not be saved.');
        }else if(next.catchAllAccountId!==context.accountId&&existing.catchAllAccountId===context.accountId)await this.withdrawAddress(existing.name,context,true);
        this.store(type,next);response.updated[id]=null;continue;
      }
      if(type==='Identity'&&next.email!==existing.email)next.verified=false;
      if(type==='Domain'&&['name','zoneId','sendingSubdomainId'].some(key=>next[key]!==existing[key])){next.dnsState='unverified';next.sendingVerified=false;next.receivingConnected=false;}
      if(type==='Mailbox'&&existing.id.startsWith('folder-')&&(next.name!==existing.name||next.parentId!==existing.parentId))throw new Error('System mailbox cannot be renamed or moved');
      if(type==='EmailSubmission'){if(Object.keys(patch as any).some(key=>key!=='undoStatus')||(patch as any).undoStatus!=='canceled'||!['pending','scheduled'].includes(existing.status))throw new Error('Only pending submissions can be canceled');next={...existing,status:'canceled',undoStatus:'canceled'};}
      if(type==='Email'){if(existing.snooze&&(next.mailboxIds['folder-inbox']||next.mailboxIds['folder-trash'])){delete next.snooze;delete next.mailboxIds['folder-snoozed'];}if(Object.keys(patch as any).some(key=>['subject','from','draftFrom','to','cc','bcc','bodyValues','textBody','htmlBody','attachments'].some(field=>key===field||key.startsWith(field+'/')))){if(!context.enoughFeatures)throw new Error('Email content is immutable; create a replacement draft');if(!existing.keywords['$draft'])throw new Error('Message content is immutable except drafts');if(!context.actor.actions.includes('mail.read'))throw new Error('Reading authority is required to patch existing message content');const {blobId,size,parsed}=await this.composeStored(next,context);next={...next,blobId,size,textBody:parsed.textBody,htmlBody:parsed.htmlBody,bodyValues:parsed.bodyValues,bodyStructure:parsed.bodyStructure,sender:parsed.sender,attachments:parsed.attachments,messageId:parsed.messageId};}}
      this.validate(type,next);if(type==='VacationResponse'&&next.isEnabled)this.assertAutomationAuthority(context);if(type==='Email'&&next.blobId!==existing.blobId)this.pendingActions.push(()=>this.provenance.recordPrepared(next.id,context.actor.id,next.blobId));if(type==='Rule')this.validateRuleForward(next,context);if(type==='Identity'){if(!await this.ownsTransferredAddress(next,false))throw new Error('This address belongs to another inbox.');if(Object.values(state.objects.Identity).some(identity=>identity.id!==id&&identity.email.toLowerCase()===next.email.toLowerCase()))throw new Error('This address already has a sending identity.');const domain=Object.values(state.objects.Domain).find(domain=>domain.sendingVerified&&domain.name.toLowerCase()===next.email.split('@')[1].toLowerCase());next.verified=!!domain;if(domain)await this.registerIdentityAddress(domain,next,context);if(next.email.toLowerCase()!==existing.email.toLowerCase())await this.withdrawAddress(existing.email,context);}if(type==='Domain'){await this.withdrawDomain(existing,context);for(const identity of Object.values(state.objects.Identity))if(!identity.transferredTo&&identity.email.split('@')[1].toLowerCase()===existing.name.toLowerCase())this.store('Identity',{...identity,verified:next.sendingVerified===true});}if(type==='Email'&&next.blobId!==existing.blobId&&next.hasAttachment)this.queueScan(next);this.store(type,next);if((type==='VacationResponse'||type==='Rule'&&next.actions?.forwardTo?.length)&&context.authorityProof&&context.actor.actions.includes('mail.manage')&&context.actor.actions.includes('mail.send')){state.objects.PrivateConfig??={};this.setAutomationAuthority(context);}if(type==='Domain'&&next.sendingVerified)await this.syncDirectory(next,context);response.updated[id]=null;
    }catch(error){response.notUpdated[id]=stateError(state.objects[type][id]?'invalidProperties':'notFound',String(error));}}
    for(const id of args.destroy||[]){const existing=state.objects[type][id];if(!existing){response.notDestroyed[id]=stateError('notFound');continue;}if(type==='Mailbox'&&(existing.id.startsWith('folder-')||this.getEmails().some(email=>email.mailboxIds[id])||Object.values(state.objects.Mailbox).some(folder=>folder.parentId===id))){response.notDestroyed[id]=stateError('mailboxHasEmail','System, nonempty, or parent mailbox cannot be deleted');continue;}const required=type==='EmailSubmission'?'mail.send':['Identity','Domain','VacationResponse'].includes(type)?'mail.manage':type==='Email'?'mail.organize':'mail.organize';if(!context.actor.actions.includes(required)&&!context.actor.actions.includes('mail.edit')){response.notDestroyed[id]=stateError('forbidden');continue;}if(type==='EmailSubmission'&&!context.actor.actions.includes('mail.read')&&existing.actorId!==context.actor.id){response.notDestroyed[id]=stateError('forbidden');continue;}if(type==='EmailSubmission'&&!['pending','scheduled','canceled','failed'].includes(existing.status)){response.notDestroyed[id]=stateError('forbidden');continue;}if(type==='Identity'&&existing.transferredTo){response.notDestroyed[id]=stateError('forbidden','Moved identity history is retained.');continue;}if(type==='Identity')await this.withdrawAddress(existing.email,context);if(type==='Domain'){await this.withdrawDomain(existing,context);for(const identity of Object.values(state.objects.Identity))if(!identity.transferredTo&&identity.email.split('@')[1].toLowerCase()===existing.name.toLowerCase())this.store('Identity',{...identity,verified:false});}this.store(type,existing,true,preserveSubmissions);response.destroyed.push(id);}
    if(replacement&&Object.keys(response.notDestroyed).length&&replacementBefore){this.state=replacementBefore;this.pendingActions.length=actionCount;this.pendingSql.length=statementCount;response.created={};response.notCreated[Object.keys(args.create)[0]]=stateError('invalidProperties','Draft replacement could not remove original');response.newState=oldState;return response;}
    response.newState=token(state.sequence);
    if(type==='EmailSubmission'&&(args.onSuccessUpdateEmail||args.onSuccessDestroyEmail)){
      const update:any={},destroy:string[]=[],preserve=new Set<string>();for(const [reference,patch]of Object.entries(args.onSuccessUpdateEmail||{})){const submissionId=reference.startsWith('#')?response.created[reference.slice(1)]?.id:reference;const submission=state.objects.EmailSubmission[submissionId];if(submission&&(!reference.startsWith('#')?Object.hasOwn(response.updated,reference):response.created[reference.slice(1)]))update[submission.emailId]=patch;}
      for(const reference of args.onSuccessDestroyEmail||[]){const submissionId=reference.startsWith('#')?response.created[reference.slice(1)]?.id:reference;const submission=state.objects.EmailSubmission[submissionId];if(submission){destroy.push(submission.emailId);preserve.add(submission.id);}}
      this.loadEmails({update,destroy},'Email','set');const implicit=await this.setObjects('Email',{update,destroy,ifInState:token(state.sequence)},context,preserve);response.__implicitResponses=[['Email/set',implicit]];
    }
    return response;
  }
  private async copyForeign(args:any,context:MailContext){
    const source=context.transferSource;const accountId=this.state!.context.accountId;
    if(!source||source.accountId!==args.fromAccountId||source.actorId!==context.actor.id||source.organizationId!==context.organizationId||source.workspaceId!==context.workspaceId||!source.actions.includes('mail.read')||!context.actor.actions.includes('mail.draft'))return stateError('accountNotFound');
    if(!source.authorityProof||!mailAuthority(this.env))return stateError('forbidden');
    const proof=await mailAuthority(this.env)!.fetch(new Request(`https://mail-authority.internal/internal/native-resources/${encodeURIComponent(source.accountId)}/revalidate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...source.authorityProof,actions:['mail.read']})}));const auth:any=proof.ok?await proof.json():null;
    if(!auth?.authorization?.allowed||auth.resource?.id!==source.accountId||auth.context?.actorId!==context.actor.id||auth.context?.organizationId!==context.organizationId||auth.context?.workspaceId!==context.workspaceId)return stateError('forbidden');
    const operationId=args.operationId||context.commandOperationId!;const progressId=`${context.actor.id}:${operationId}`;this.state!.objects.CopyProgress??={};
    let progress=this.state!.objects.CopyProgress[progressId];const fingerprint=JSON.stringify(args);
    if(progress&&progress.fingerprint!==fingerprint)return stateError('invalidArguments','Copy command ID reused');
    if(!progress){if(args.ifFromInState&&args.ifFromInState!==source.state||args.ifInState&&args.ifInState!==token(this.state!.sequence))return stateError('stateMismatch');progress={id:progressId,fingerprint,created:{},notCreated:{},oldState:token(this.state!.sequence),actorId:context.actor.id};this.store('CopyProgress',progress);this.save();}
    const entries=Object.entries(args.create||{}) as [string,any][];if(entries.length>1000)return stateError('requestTooLarge');
    for(const [key,input]of entries){if(progress.created[key])continue;try{
      const original=source.emails.find(email=>email.id===input.id);if(!original)throw new Error('Source email missing');if(original.quarantine&&original.quarantine.status!=='clean')throw new Error('Source email is quarantined');const {id,...patch}=input;validateWritable('Email',patch,'create',context.actor.actions);if(Object.keys(patch).some(field=>!['mailboxIds','keywords'].includes(field)))throw new Error('Copy permits mailboxIds and keywords only');
      const sourceBlob=original.blobId;if(typeof sourceBlob!=='string'||! /^[\w.-]+$/.test(sourceBlob))throw new Error('Invalid source blob');
      const raw=await this.env.MAIL_BLOBS.get(`${source.accountId}/blobs/${sourceBlob}`);if(!raw)throw new Error('Source blob missing');
      await raw.body?.cancel();const sourceStream=await this.mimeSource(sourceBlob,source.accountId);const targetBlobId=`copy-${await this.hash(JSON.stringify([operationId,context.actor.id,key]))}`;await this.putStreamBlob(targetBlobId,await sourceStream.read(),sourceStream.size,'raw');this.provenance.recordSource(targetBlobId,context.actor.id);
      const email=await this.importEmail({blobId:targetBlobId,mailboxIds:patch.mailboxIds||original.mailboxIds,keywords:patch.keywords||original.keywords,receivedAt:original.receivedAt},context);this.pendingActions.push(()=>this.provenance.recordPrepared(email.id,context.actor.id,email.blobId));
      this.store('Email',email);progress.created[key]={id:email.id,blobId:email.blobId,threadId:email.threadId,size:email.size};delete progress.notCreated[key];this.store('CopyProgress',progress);this.save();
    }catch(error){progress.notCreated[key]=stateError('invalidProperties',String(error));this.store('CopyProgress',progress);this.save();}}
    const result={fromAccountId:source.accountId,accountId,oldState:progress.oldState,newState:token(this.state!.sequence),created:clone(progress.created),notCreated:clone(progress.notCreated)};this.store('CopyProgress',progress,true);return result;
  }
  private async withdrawAddress(address:string,context:MailContext,catchAll=false){
    if(!this.env.MAIL_DIRECTORY)return;
    const response=await this.env.MAIL_DIRECTORY.get(this.env.MAIL_DIRECTORY.idFromName('directory')).fetch(new Request('https://mail-directory/register-address',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account:{accountId:context.accountId,organizationId:context.organizationId,workspaceId:context.workspaceId,ownerActorId:context.actor.id},address,catchAll,enabled:false})}));
    // An unverified address was never registered. Conflicts belong to another account
    // and must not be withdrawn by this account's command.
    if(!response.ok&&![403,409].includes(response.status))throw new Error('Address withdrawal failed');
  }
  private async withdrawDomain(domain:MailObject,context:MailContext){
    const addresses=new Set<string>([domain.receivingAddress,...(domain.addresses||[]),...Object.values(this.state!.objects.Identity).filter(identity=>identity.email.split('@')[1].toLowerCase()===domain.name.toLowerCase()).map(identity=>identity.email)].filter(Boolean));
    for(const address of addresses)await this.withdrawAddress(address,context);if(domain.catchAllAccountId===context.accountId)await this.withdrawAddress(domain.name,context,true);
  }
  private async authorizeZone(domain:MailObject,context:MailContext){
    if(!this.env.MAIL_DIRECTORY)return false;
    const response=await this.env.MAIL_DIRECTORY.get(this.env.MAIL_DIRECTORY.idFromName('directory')).fetch(new Request('https://mail-directory/authorize-zone',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({domain:domain.name,zoneId:domain.zoneId,account:{accountId:context.accountId,organizationId:context.organizationId,workspaceId:context.workspaceId,ownerActorId:context.actor.id}})}));
    return response.ok&&(await response.json() as any).allowed===true;
  }
  private async registerIdentityAddress(domain:MailObject,identity:MailObject,context:MailContext){
    if(!this.env.MAIL_DIRECTORY)throw new Error('Mail routing directory unavailable');
    const stub=this.env.MAIL_DIRECTORY.get(this.env.MAIL_DIRECTORY.idFromName('directory'));
    const account={accountId:context.accountId,organizationId:context.organizationId,workspaceId:context.workspaceId,ownerActorId:context.actor.id};
    for(const [path,body]of [['/verify-domain',{account,domain:domain.name}],['/register-address',{account,address:identity.email,enabled:domain.enabled!==false&&identity.enabled!==false,catchAll:false}]] as const){
      const response=await stub.fetch(new Request(`https://mail-directory${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
      if(!response.ok)throw new Error(response.status===409?'This address belongs to another inbox.':'Sending address registration failed');
    }
  }
  private async syncDirectory(domain:MailObject,context:MailContext){
    if(!this.env.MAIL_DIRECTORY)throw new Error('Mail routing directory unavailable');
    const stub=this.env.MAIL_DIRECTORY.get(this.env.MAIL_DIRECTORY.idFromName('directory'));
    const account={accountId:context.accountId,organizationId:context.organizationId,workspaceId:context.workspaceId,ownerActorId:context.actor.id};
    const call=async(path:string,body:any)=>{const response=await stub.fetch(new Request(`https://mail-directory${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));if(!response.ok)throw new Error('Routing registration failed');};
    await call('/verify-domain',{domain:domain.name,account});
    for(const address of new Set<string>([domain.receivingAddress,...(domain.addresses||[])].filter(Boolean)))if(await this.ownsTransferredAddress({id:address,email:address},false))await call('/register-address',{account,address,enabled:domain.enabled!==false,catchAll:false});
    for(const identity of Object.values(this.state!.objects.Identity))if(!identity.transferredTo&&identity.email.split('@')[1].toLowerCase()===domain.name.toLowerCase())await call('/register-address',{account,address:identity.email,enabled:domain.enabled!==false&&identity.enabled!==false,catchAll:false});
    if(domain.catchAllAccountId===context.accountId)await call('/register-address',{account,address:domain.name,enabled:domain.enabled!==false,catchAll:true});
  }
  private async putBlob(blobId:string,bytes:Uint8Array|ReadableStream<Uint8Array>,size:number,kind:'raw'|'attachment'|'body'|'upload'){
    this.quota.reserveBlob(blobId,size,kind);try{await this.env.MAIL_BLOBS.put(this.key(blobId),bytes);this.quota.commitBlob(blobId);}catch(error){try{const existing=await this.env.MAIL_BLOBS.get(this.key(blobId));if(existing)this.quota.commitBlob(blobId);else this.quota.rollbackBlob(blobId);}catch{/* Keep uncertain reservations until reconciliation. */}throw error;}
  }
  private async mimeSource(blobId:string,accountId=this.state!.context.accountId):Promise<MimeStreamSource>{
    const key=`${accountId}/blobs/${blobId}`;const initial=await this.env.MAIL_BLOBS.get(key);if(!initial)throw new Error('Blob not found');
    const size=initial.size;if(size===undefined)throw new Error('Streaming blob metadata is required');await initial.body?.cancel();
    return {size,read:async range=>{const object=await this.env.MAIL_BLOBS.get(key,range?{range}:undefined);if(!object)throw new Error('Blob not found');if(object.body)return object.body;if((range?.length??size!)>1024*1024)throw new Error('Streaming blob body is required');return new Response(await object.arrayBuffer()).body!;}};
  }
  private async putStreamBlob(blobId:string,stream:ReadableStream<Uint8Array>,size:number,kind:'raw'|'attachment'|'body'|'upload'){
    const Constructor=(globalThis as any).FixedLengthStream;
    if(Constructor){const fixed=new Constructor(size);const abort=new AbortController();const piping=stream.pipeTo(fixed.writable,{signal:abort.signal});try{await Promise.all([this.putBlob(blobId,fixed.readable,size,kind),piping]);}catch(error){abort.abort(error);await fixed.readable.cancel(error).catch(()=>{});await piping.catch(()=>{});throw error;}}
    else {let count=0;const bounded=stream.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){count+=chunk.length;if(count>size)throw new Error('Blob length exceeded');controller.enqueue(chunk);},flush(){if(count!==size)throw new Error('Blob length mismatch');}}));await this.putBlob(blobId,bounded,size,kind);}
  }
  private async parseStoredMime(blobId:string,source:MimeStreamSource,taint?:{sourceId:string;status:string}){
    const rawHash=createHash('sha256');const hashed:MimeStreamSource={size:source.size,read:async range=>{const stream=await source.read(range);return range?stream:stream.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){rawHash.update(chunk);controller.enqueue(chunk);}}));}};
    const parsed=await parseMimeStream(hashed,blobId,{maxBodyValueBytes:8192,onLeaf:async(part,decoded)=>{
      const leafId=`leaf-${createHash('sha256').update(`${this.state!.context.accountId}:${blobId}:${part.partId}`).digest('hex')}`;const existing=await this.env.MAIL_BLOBS.get(this.key(leafId));if(existing){await existing.body?.cancel();await decoded.cancel();if(existing.size!==undefined&&existing.size!==part.size)throw new Error('Immutable MIME leaf size mismatch');if(taint)this.stageSql('INSERT INTO mail_blob_security(blob_id,email_id,status) VALUES(?,?,?) ON CONFLICT(blob_id) DO UPDATE SET status=excluded.status',leafId,`parse:${taint.sourceId}`,taint.status);return {blobId:leafId};}const hash=createHash('sha256');let decoder:TextDecoder|undefined;try{if(part.type.startsWith('text/'))decoder=new TextDecoder(part.charset||'utf-8');}catch{decoder=new TextDecoder();}let chunkIndex=0;
      const append=(value:string)=>{for(let offset=0;offset<value.length;){let end=Math.min(value.length,offset+48000);if(end<value.length&&value.charCodeAt(end-1)>=0xd800&&value.charCodeAt(end-1)<=0xdbff)end--;this.repository.appendBlobTextChunk(leafId,chunkIndex++,value.slice(offset,end));offset=end;}};
      const stream=decoded.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform:(chunk,controller)=>{hash.update(chunk);if(decoder)append(decoder.decode(chunk,{stream:true}));controller.enqueue(chunk);},flush:()=>{if(decoder){append(decoder.decode());this.repository.finalizeBlobText(leafId,hash.digest('hex'));}}}));
      try{await this.putStreamBlob(leafId,stream,part.size,part.type.startsWith('text/')&&!part.disposition?.includes('attachment')?'body':'attachment');}catch(error){this.repository.deleteBlobText(leafId);throw error;}
      if(taint)this.stageSql('INSERT INTO mail_blob_security(blob_id,email_id,status) VALUES(?,?,?) ON CONFLICT(blob_id) DO UPDATE SET status=excluded.status',leafId,`parse:${taint.sourceId}`,taint.status);return {blobId:leafId};
    }});return {parsed,rawHash:rawHash.digest('hex')};
  }
  private async readBodyValues(email:MailObject,args:any){
    const values:Record<string,any>={};const parts=[...(args.fetchAllBodyValues||args.fetchTextBodyValues?email.textBody||[]:[]),...(args.fetchAllBodyValues||args.fetchHTMLBodyValues?email.htmlBody||[]:[])];let total=0;
    for(const part of parts){const source=await this.mimeSource(part.blobId);const reader=(await source.read()).getReader();let decoder:TextDecoder;try{decoder=new TextDecoder(part.charset||'utf-8');}catch{decoder=new TextDecoder();}let value='',bytes=0,truncated=false;const limit=args.maxBodyValueBytes>0?args.maxBodyValueBytes:32*1024*1024;
      const append=(text:string)=>{const encoded=new TextEncoder().encode(text);let accepted=text;let length=encoded.length;if(bytes+length>limit){if(!args.maxBodyValueBytes)throw new Error('Requested body values exceed the bounded response size');let end=limit-bytes;while(end>0&&end<encoded.length&&(encoded[end]&0xc0)===0x80)end--;accepted=new TextDecoder().decode(encoded.subarray(0,end));length=end;truncated=true;}bytes+=length;value+=accepted;total+=length;if(total>32*1024*1024)throw new Error('Requested body values exceed the bounded response size');};
      try{while(true){const result=await reader.read();if(result.done){append(decoder.decode());break;}append(decoder.decode(result.value,{stream:true}));if(truncated){await reader.cancel();break;}}}finally{reader.releaseLock();}values[part.partId]={value:value.replace(/\r\n/g,'\n'),isEncodingProblem:email.bodyValues?.[part.partId]?.isEncodingProblem||false,isTruncated:truncated};
    }return values;
  }
  private async composeStored(object:MailObject,context:MailContext){
    const attachments=object.attachments||[];const validatePart=(part:any)=>{if(!part||typeof part!=='object')return;if(part.blobId)this.provenance.assertSource(part.blobId,context.actor.id,context.actor.actions.includes('mail.read'));for(const child of part.subParts||[])validatePart(child);};for(const part of [...(Array.isArray(object.textBody)?object.textBody:[]),...(Array.isArray(object.htmlBody)?object.htmlBody:[]),...(object.bodyStructure?[object.bodyStructure]:[])])validatePart(part);
    for(const part of attachments){this.provenance.assertSource(part.blobId,context.actor.id,context.actor.actions.includes('mail.read'));if(!part.blobId||!/^[\w.-]+$/.test(part.blobId)||!this.blobIsClean(part.blobId))throw new Error('Invalid attachment blob');}
    const email={...object,sentAt:object.sentAt||new Date().toISOString(),messageId:object.messageId||[`${crypto.randomUUID()}@enoughmail.local`]};
    const resolve=async(part:any)=>(await this.mimeSource(part.blobId)).read();
    const prepared=prepareMimeStream(email,resolve);let size=0;const counter=prepared.stream().getReader();try{while(true){const item=await counter.read();if(item.done)break;size+=item.value.length;if(size>64*1024*1024)throw new Error('Message exceeds MIME size limit');}}finally{counter.releaseLock();}
    const blobId=crypto.randomUUID();await this.putStreamBlob(blobId,prepared.stream(),size,'raw');this.provenance.recordSource(blobId,context.actor.id);const {parsed}=await this.parseStoredMime(blobId,await this.mimeSource(blobId));for(const part of [...parsed.textBody,...parsed.htmlBody,...parsed.attachments])if(part.blobId)this.provenance.recordSource(part.blobId,context.actor.id);return {blobId,size,parsed};
  }
  private async createSubmission(object:MailObject,context:MailContext){
    if(!context.actor.actions.includes('mail.send'))throw new Error('Send denied');
    const email=this.state!.objects.Email[object.emailId];const identity=this.state!.objects.Identity[object.identityId];if(identity&&!await this.ownsTransferredAddress(identity))throw new Error('This sending address belongs to another inbox.');if(email?.quarantine&&email.quarantine.status!=='clean')throw new Error('Attachments are quarantined');if(!email||!identity)throw new Error('Email and identity are required');if(!identity.verified||!Object.values(this.state!.objects.Domain).some(domain=>domain.name.toLowerCase()===identity.email.split('@')[1].toLowerCase()&&domain.sendingVerified))throw new Error('Sending identity is not verified');
    const actions=context.authorityProof?.actions||[];const prepared=email.keywords?.['$draft']===true&&this.provenance.prepared(email.id,context.actor.id,email.blobId);const authorityBasis=object.automation?'automation':prepared&&actions.includes('mail.send')?'prepared':context.actor.actions.includes('mail.read')&&actions.includes('mail.read')&&actions.includes('mail.send')?'read':null;if(!authorityBasis)throw new Error('Current reading authority or exact actor-prepared draft content is required');if(authorityBasis==='automation'&&(!actions.includes('mail.manage')||!actions.includes('mail.send')))throw new Error('Automation authorization is required');
    const domain=Object.values(this.state!.objects.Domain).find(domain=>domain.name.toLowerCase()===identity.email.split('@')[1].toLowerCase()&&domain.sendingVerified);if(!domain||domain.enabled===false||!await this.authorizeZone(domain,context))throw new Error('Sending domain authority is unavailable');
    if(!Array.isArray(email.from)||email.from.length!==1||email.from[0]?.email?.trim().toLowerCase()!==identity.email.toLowerCase())throw new Error('Exactly one From address must match the sending identity');if(email.sender?.length&&(email.sender.length!==1||email.sender[0]?.email?.trim().toLowerCase()!==identity.email.toLowerCase()))throw new Error('Sender must match the sending identity');if(email.draftFrom!==undefined&&email.draftFrom.trim().toLowerCase()!==identity.email.toLowerCase())throw new Error('Finish or confirm the sending address before sending');
    const scheduling=validateSubmissionEnvelope(object,email,identity,{allowEnoughScheduling:context.enoughFeatures,defaultUndoSeconds:context.enoughFeatures?10:0});
    if(context.authorityProof?.expiresAt&&Date.parse(scheduling.sendAt)>=context.authorityProof.expiresAt-60000)throw new Error('Scheduled delivery exceeds current authorization expiry');
    return {...object,...scheduling,authorityBasis,knownContentBlob:authorityBasis==='prepared'?email.blobId:null,emailSnapshot:clone(email),status:Date.parse(scheduling.sendAt)>Date.now()+60000?'scheduled':'pending',undoStatus:'pending',deliveryStatus:{},actorId:context.actor.id,authorityProof:context.authorityProof?clone(context.authorityProof):null,identitySnapshot:clone(identity)};
  }

  private async scheduleAlarm(){if(!this.state)return;const phase=this.lifecycle.get();if(phase.status!=='active'){if(phase.purgeAfter&&phase.status!=='deleted')await this.ctx.storage.setAlarm(Math.max(Date.now()+1000,phase.purgeAfter));else await this.ctx.storage.deleteAlarm();return;}const emailAlarm=this.repository.nextEmailAlarm();const retentionAlarm=this.repository.nextRetentionDeadline({trashRetentionDays:this.state.objects.Retention?.singleton?.trashRetentionDays,junkRetentionDays:this.state.objects.Retention?.singleton?.junkRetentionDays});const scanDeadline=[...this.ctx.storage.sql.exec<{deadline:number|null}>("SELECT min(next_attempt) AS deadline FROM mail_scan_jobs WHERE status='pending'")][0]?.deadline;const lifecycle=this.lifecycle.get();const gcPending=[...this.ctx.storage.sql.exec('SELECT id FROM mail_gc_jobs LIMIT 1')].length;const automationDeadline=[...this.ctx.storage.sql.exec<{deadline:number|null}>('SELECT min(next_attempt) AS deadline FROM mail_pending_automations')][0]?.deadline;const renewal=this.state.objects.PrivateConfig?.automation?.renewal;const renewalTime=this.automationEnabled()&&!['denied','manual'].includes(renewal?.status)?renewal?.nextAttempt:null;const transferDeadline=this.identityTransferLock()?.repairAt;const pushDeadline=this.pushWakeups.next();const times=[...(pushDeadline!==undefined?[pushDeadline]:[]),...(transferDeadline?[transferDeadline]:[]),...(automationDeadline?[automationDeadline]:[]),...(renewalTime?[renewalTime]:[]),...(gcPending?[Date.now()+1000]:[]),...(retentionAlarm?[retentionAlarm]:[]),...(lifecycle.purgeAfter?[lifecycle.purgeAfter]:[]),...(scanDeadline?[scanDeadline]:[]),...(emailAlarm?[emailAlarm]:[]),...Object.values(this.state.objects.EmailSubmission).filter(item=>['pending','scheduled'].includes(item.status)).map(item=>Date.parse(item.sendAt))].filter(Number.isFinite);if(times.length)await this.ctx.storage.setAlarm(Math.max(Date.now()+1,Math.min(...times)));else await this.ctx.storage.deleteAlarm();}
  private queueScan(email:MailObject,recipientAddress?:string){
    const desired=clone(email.mailboxIds);email.mailboxIds={'folder-quarantine':true};email.quarantine={status:'pending',reason:'scanRequired',blobId:email.blobId};
    this.stageSql("INSERT INTO mail_scan_jobs(id,email_id,blob_id,size,desired_mailboxes,next_attempt,status,attempts) VALUES(?,?,?,?,?,?,'pending',0) ON CONFLICT(id) DO UPDATE SET email_id=excluded.email_id,desired_mailboxes=excluded.desired_mailboxes,next_attempt=excluded.next_attempt,status='pending'",email.blobId,email.id,email.blobId,email.size,JSON.stringify(desired),Date.now());
    if(recipientAddress)this.stageSql('UPDATE mail_scan_jobs SET recipient_address=? WHERE id=?',recipientAddress,email.blobId);this.stageSql("INSERT INTO mail_blob_security(blob_id,email_id,status) VALUES(?,?,'pending') ON CONFLICT(blob_id) DO UPDATE SET status='pending',receipt=NULL",email.blobId,email.id);
    for(const attachment of email.attachments)this.stageSql("INSERT INTO mail_blob_security(blob_id,email_id,status) VALUES(?,?,'pending') ON CONFLICT(blob_id) DO UPDATE SET status='pending',receipt=NULL",attachment.blobId,email.id);
  }
  private async processScans(targetEmailId?:string,runDelayedAutomations=true){
    const jobs=[...this.ctx.storage.sql.exec<any>(`SELECT * FROM mail_scan_jobs WHERE status='pending' AND next_attempt<=? ${targetEmailId?'AND email_id=?':''} ORDER BY next_attempt LIMIT 2`,Date.now(),...(targetEmailId?[targetEmailId]:[]))];
    for(const job of jobs.slice(0,50)){const email=this.repository.readEmails({ids:[job.email_id],limit:1})[0];if(!email||email.blobId!==job.blob_id){this.stageSql('DELETE FROM mail_scan_jobs WHERE id=?',job.id);this.save();continue;}
      const receipt=await scanMail({accountId:this.state!.context.accountId,blobId:job.blob_id,size:job.size,...(email.rawHash?{expectedSha256:email.rawHash}:{})},this.env as any);const next=clone(email);next.quarantine={...next.quarantine,...receipt,scannerReceiptDigest:receipt.scannerReceiptDigest??null};
      if(receipt.status==='clean'){next.mailboxIds=JSON.parse(job.desired_mailboxes);next.quarantine.status='clean';if(job.recipient_address&&next.mailboxIds?.['folder-inbox']&&!next.mailboxIds?.['folder-junk']&&!next.mailboxIds?.['folder-trash']&&!next.keywords?.['$draft']&&!next.keywords?.['$junk'])this.pendingActions.push(()=>this.repository.recordEmailDelivery());this.stageSql("UPDATE mail_scan_jobs SET status='clean' WHERE id=?",job.id);if(job.recipient_address)this.stageSql('INSERT OR IGNORE INTO mail_pending_automations(id,email_id,blob_id,recipient_address,next_attempt) VALUES(?,?,?,?,?)',job.id,email.id,email.blobId,job.recipient_address,Date.now());this.stageSql("UPDATE mail_blob_security SET status='clean',receipt=? WHERE email_id=?",JSON.stringify(receipt),email.id);}
      else if(receipt.status==='infected'||receipt.status==='oversized'){this.stageSql('UPDATE mail_scan_jobs SET status=? WHERE id=?',receipt.status,job.id);this.stageSql('UPDATE mail_blob_security SET status=?,receipt=? WHERE email_id=?',receipt.status,JSON.stringify(receipt),email.id);}
      else this.stageSql('UPDATE mail_scan_jobs SET attempts=attempts+1,next_attempt=? WHERE id=?',Date.now()+5*60*1000,job.id);
      this.store('Email',next);this.save();
    }
    if(runDelayedAutomations)await this.processPendingAutomations();
  }
  private async processPendingAutomations(){
    const jobs=[...this.ctx.storage.sql.exec<any>('SELECT * FROM mail_pending_automations WHERE next_attempt<=? ORDER BY next_attempt LIMIT 10',Date.now())];
    for(const job of jobs){const email=this.repository.readEmails({ids:[job.email_id],limit:1})[0];const config=this.state!.objects.PrivateConfig?.automation;
      if(!email||email.blobId!==job.blob_id||email.quarantine?.status!=='clean'||!config||config.renewal?.status==='denied'||config.authorityProof?.expiresAt<=Date.now()||!this.automationEnabled()){this.stageSql('DELETE FROM mail_pending_automations WHERE id=?',job.id);this.save();continue;}
      const before=clone(this.state!);const statements=this.pendingSql.length,actions=this.pendingActions.length;
      try{const result=await this.queueAutomations(email,job.recipient_address,false);if(result!==null)this.stageSql('DELETE FROM mail_pending_automations WHERE id=?',job.id);else this.stageSql('UPDATE mail_pending_automations SET attempts=attempts+1,next_attempt=? WHERE id=?',Math.min(config.authorityProof.expiresAt,Date.now()+5*60000),job.id);this.save();}
      catch{this.state=before;this.pendingSql.length=statements;this.pendingActions.length=actions;this.stageSql('UPDATE mail_pending_automations SET attempts=attempts+1,next_attempt=? WHERE id=?',Math.min(config.authorityProof.expiresAt,Date.now()+5*60000),job.id);this.save();}
    }
  }
  private async processGarbage(){const ids=[...this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM mail_gc_jobs LIMIT 100')].map(row=>row.id);const referenced=new Set(this.repository.referencedBlobs(ids));for(const id of ids){if(!referenced.has(id)){await this.env.MAIL_BLOBS.delete(this.key(id));this.quota.forgetBlob(id);this.repository.deleteBlobText(id);this.provenance.forgetBlob(id);this.ctx.storage.sql.exec('DELETE FROM mail_blob_security WHERE blob_id=?',id);}this.ctx.storage.sql.exec('DELETE FROM mail_gc_jobs WHERE id=?',id);}}
  private async processLifecycle(now:number){
    const lifecycle=this.lifecycle.get();if(lifecycle.purgeAfter===null||lifecycle.purgeAfter>now)return;
    const result=await this.lifecycle.purgeBatch(this.quota,id=>this.env.MAIL_BLOBS.delete(this.key(id)).then(()=>undefined),now);
    if(!result.done)return;
    // An R2 prefix enumeration is required before finalizing legacy account deletion.
    const bucket=this.env.MAIL_BLOBS as any;if(!bucket.list)return;
    const objects=await bucket.list({prefix:`${this.state!.context.accountId}/blobs/`,limit:100});if(objects.objects.length){for(const item of objects.objects)await bucket.delete(item.key);return;}
    const purged=this.repository.purgeBatchRows(100);if(!purged.done)return;this.lifecycle.finishPurge(now);
    this.state!.objects=Object.fromEntries(Object.keys(this.state!.objects).map(type=>[type,{}]));this.state!.changes=[];this.state!.receipts={};this.state!.querySnapshots={};
  }
  private async queueAutomations(email:MailObject,recipientAddress:string,allowForwarding=true){
    if(await this.activeIdentityTransfer()){this.stageSql('INSERT OR IGNORE INTO mail_pending_automations(id,email_id,blob_id,recipient_address,next_attempt) VALUES(?,?,?,?,?)',email.id,email.id,email.blobId,recipientAddress,Date.now()+30_000);return null;}
    if(email.quarantine&&email.quarantine.status!=='clean')return null;const state=this.state!;const config=state.objects.PrivateConfig?.automation;if(!config?.authorityProof||config.renewal?.status==='denied'||(config.lifecycleGeneration??0)!==this.lifecycle.get().revision)return null;
    const settings=this.settings();const now=new Date().toISOString();const previous:Record<string,string>={};for(const sender of email.from||[]){const address=typeof sender==='string'?sender:sender.email;if(address){const at=this.repository.vacationCooldown(address);if(at)previous[address.toLowerCase()]=at;}}
    const jobs:any[]=buildAutoResponses(email as any,settings,{now,recipientAddress,lastVacationResponses:previous});for(const forward of email.ruleForwards||[])if(!jobs.some(job=>job.type==='forward'&&job.to.toLowerCase()===forward.address.toLowerCase()))jobs.push({type:'forward',id:await this.hash(JSON.stringify([email.id,forward.ruleId,forward.address])),to:forward.address,keepCopy:true});const directives:any[]=[];delete email.ruleForwards;
    const identity=Object.values(state.objects.Identity).find(item=>item.verified&&item.email.toLowerCase()===String(recipientAddress).toLowerCase())||Object.values(state.objects.Identity).find(item=>item.verified&&item.email.split('@')[1].toLowerCase()===String(recipientAddress).split('@')[1]?.toLowerCase());
    for(const job of jobs.slice(0,50)){
      if(job.type==='vacation'&&state.objects.EmailSubmission[job.id])continue;
      if(job.type==='forward'){if(!allowForwarding)continue;
        const verification=state.objects.ForwardingVerification?.[job.to.toLowerCase()];if(!verification?.verified||!identity)continue;const fresh=await checkForwardingVerification(this.env,verification.address,undefined,verification.providerId);if(fresh.status!=='verified')continue;
        const authorized=await this.authorizeDelayed({id:job.id,identityId:identity.id,identitySnapshot:identity,actorId:config.actorId,authorityProof:config.authorityProof,automation:true},true);if(!authorized)continue;
        state.objects.ForwardJob??={};this.store('ForwardJob',{id:job.id,emailId:email.id,address:job.to,keepCopy:job.keepCopy??settings.forwarding?.keepCopy!==false,status:'attempted',attemptedAt:now});directives.push({address:job.to,keepCopy:job.keepCopy??settings.forwarding?.keepCopy!==false,jobId:job.id});continue;
      }
      if(!identity)continue;if(!await this.authorizeDelayed({id:job.id,identityId:identity.id,identitySnapshot:identity,actorId:config.actorId,authorityProof:config.authorityProof,automation:true},true))return null;
      const message:MailObject={id:crypto.randomUUID(),from:[{email:identity.email,name:identity.name||null}],to:[{email:job.to,name:null}],cc:[],bcc:[],subject:job.subject,text:job.textBody||'',mailboxIds:{'folder-drafts':true},keywords:{'$draft':true},receivedAt:now,threadId:email.threadId,inReplyTo:email.messageId||[],references:[...(email.references||[]),...(email.messageId||[])],attachments:[]};
      const raw=buildMime(message);const header=new TextEncoder().encode('Auto-Submitted: auto-replied\r\n');const bytes=new Uint8Array(header.length+raw.length);bytes.set(header);bytes.set(raw,header.length);const blobId=crypto.randomUUID();await this.putBlob(blobId,bytes,bytes.length,'raw');const {parsed}=await this.parseStoredMime(blobId,await this.mimeSource(blobId));Object.assign(message,{blobId,size:bytes.length,messageId:parsed.messageId,textBody:parsed.textBody,htmlBody:parsed.htmlBody,bodyValues:parsed.bodyValues,preview:parsed.preview,hasAttachment:false});
      this.store('Email',message);const submission=await this.createSubmission({id:job.id,emailId:message.id,identityId:identity.id,undoSeconds:0,automation:true},{...state.context,actor:{id:config.actorId,actions:['mail.send']},enoughFeatures:true,authorityProof:config.authorityProof});this.store('EmailSubmission',submission);this.pendingActions.push(()=>this.repository.recordVacationCooldown(job.to.toLowerCase(),now));
    }
    return directives;
  }
  private latchAutomationDenied(reason:string){const config=this.state!.objects.PrivateConfig?.automation;if(config)this.store('PrivateConfig',{...config,renewal:{status:'denied',reason,nextAttempt:null}});}
  private async authorizeDelayed(submission:MailObject,automationPreflight=false):Promise<boolean> {
    const snapshot=submission.emailSnapshot,sender=submission.identitySnapshot?.email?.toLowerCase();
    if(!automationPreflight&&(!sender||!Array.isArray(snapshot?.from)||snapshot.from.length!==1||snapshot.from[0]?.email?.trim().toLowerCase()!==sender||snapshot.sender?.length&&(snapshot.sender.length!==1||snapshot.sender[0]?.email?.trim().toLowerCase()!==sender)||snapshot.draftFrom!==undefined&&snapshot.draftFrom.trim().toLowerCase()!==sender||submission.envelope?.mailFrom?.email?.toLowerCase()!==sender))return false;
    const proof=submission.authorityProof;const required=submission.automation?['mail.manage','mail.send']:submission.authorityBasis==='prepared'?['mail.send']:['mail.read','mail.send'];if(submission.authorityBasis==='prepared'&&(submission.knownContentBlob!==submission.emailSnapshot?.blobId||submission.actorId===undefined))return false;const identity=this.state!.objects.Identity[submission.identityId];if(identity&&!await this.ownsTransferredAddress(identity))return false;
    if(!identity?.verified||identity.email!==submission.identitySnapshot.email||!Object.values(this.state!.objects.Domain).some(domain=>domain.name.toLowerCase()===identity.email.split('@')[1].toLowerCase()&&domain.sendingVerified))return false;
    const domain=Object.values(this.state!.objects.Domain).find(domain=>domain.name.toLowerCase()===identity.email.split('@')[1].toLowerCase()&&domain.sendingVerified);if(!domain||domain.enabled===false||!await this.authorizeZone(domain,{...this.state!.context,actor:{id:submission.actorId,actions:['mail.send']}}))return false;
    if(!mailAuthority(this.env)||!proof?.lease||!proof.jobId)return false;
    try {
      const credentialAllowed=async()=>{if(proof.credentialId){if(!this.env.MAIL_CREDENTIALS)return false;const response=await this.env.MAIL_CREDENTIALS.get(this.env.MAIL_CREDENTIALS.idFromName('mail-client-credentials-v1')).fetch(new Request('https://mail-credentials/lookup-id',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:proof.credentialId,version:proof.credentialVersion})}));const credential:any=response.ok?(await response.json() as any).credential:null;if(!credential||credential.id!==proof.credentialId||credential.version!==proof.credentialVersion||credential.jobId!==proof.jobId||credential.revokedAt!==null||credential.expiresAt<=Date.now()||credential.accountId!==this.state!.context.accountId||credential.organizationId!==this.state!.context.organizationId||credential.workspaceId!==this.state!.context.workspaceId||credential.actorId!==submission.actorId||(credential.lifecycleGeneration??0)!==this.lifecycle.get().revision||!required.every(action=>credential.actions?.includes(action))){if(submission.automation&&response.status<500)this.latchAutomationDenied('credential_revoked_or_changed');return false;}}return true;};
      if(!await credentialAllowed())return false;
      const response=await mailAuthority(this.env)!.fetch(new Request(`https://mail-authority.internal/internal/native-resources/${encodeURIComponent(this.state!.context.accountId)}/revalidate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lease:proof.lease,jobId:proof.jobId,actions:required})}));
      if(!response.ok){if(submission.automation&&response.status===403)this.latchAutomationDenied('authorization_revoked');return false;}const value:any=await response.json();
      const allowed=value.authorization?.allowed===true&&required.every(action=>value.authorization.effectiveActions?.includes(action))&&value.resource?.id===this.state!.context.accountId&&value.context?.organizationId===this.state!.context.organizationId&&value.context?.workspaceId===this.state!.context.workspaceId&&value.context?.actorId===submission.actorId;if(!allowed&&submission.automation)this.latchAutomationDenied('authorization_revoked');if(!allowed)return false;return await credentialAllowed();
    }catch{return false;}
  }
  async alarm(){return this.serial(async()=>{this.flushPushWakeups();const transfer=this.identityTransferLock();if(transfer){this.writeIdentityTransferLock({...transfer,repairAt:Date.now()+30_000});await this.ctx.storage.setAlarm(Date.now()+30_000);}if(await this.activeIdentityTransfer()){await this.ctx.storage.setAlarm(Date.now()+30_000);return;}
    if(!this.state)return;const now=Date.now();if(this.lifecycle.get().status!=='active'){await this.processLifecycle(now);await this.scheduleAlarm();return;}await this.processAutomationRenewal(now);await this.processScans();for(const email of this.repository.readRetentionDue({trashRetentionDays:this.state.objects.Retention?.singleton?.trashRetentionDays,junkRetentionDays:this.state.objects.Retention?.singleton?.junkRetentionDays},now,100))this.store('Email',email,true);this.save();await this.processGarbage();this.state.objects.Email=Object.fromEntries(this.repository.readEmails({dueBefore:now,limit:1000}).map(email=>[email.id,email]));const dueThreads=[...new Set(this.getEmails().filter(email=>email.followUp?.ifNoReply).map(email=>email.threadId))];if(dueThreads.length)for(const email of this.repository.readEmails({threadIds:dueThreads,limit:1000}))this.state.objects.Email[email.id]=email;
    for(const next of reconcileFollowUps(this.getEmails() as any,new Date(now).toISOString())){const existing=this.state.objects.Email[next.id];if(JSON.stringify(next)!==JSON.stringify(existing))this.store('Email',next as MailObject);}
    for(const email of this.getEmails())if(email.snooze&&Date.parse(email.snooze.until)<=now){const next=clone(email);if(!next.mailboxIds['folder-trash'])next.mailboxIds={...next.mailboxIds,...next.snooze.mailboxIds};delete next.mailboxIds['folder-snoozed'];delete next.snooze;this.store('Email',next);}
    for(const submission of Object.values(this.state.objects.EmailSubmission)){
      if(!['pending','scheduled'].includes(submission.status)||Date.parse(submission.sendAt)>now)continue;
      const next=clone(submission);next.undoStatus='final';
      if(!await this.authorizeDelayed(submission)){next.status='failed';next.error=submission.authorityBasis?'authorizationRevokedOrUnavailable':'authorizationRequired';this.store('EmailSubmission',next);continue;}
      let result:Awaited<ReturnType<typeof sendRawMail>>;
      try{result=await sendRawMail(this.env as any,{from:submission.identitySnapshot.email,to:submission.envelope.rcptTo.map((value:any)=>value.email),blobId:submission.emailSnapshot.blobId,accountId:this.state.context.accountId},async()=>{
        // MIME preparation can await R2. Revalidate source authority and credential
        // after preparation, immediately before committing the internet attempt.
        if(!await this.authorizeDelayed(submission))throw new DispatchAuthorizationDenied('authorizationRevokedBeforeAttempt');
        this.store('EmailSubmission',{...next,status:'sending',attemptedAt:new Date().toISOString()});this.save();
      });}catch(error){
        if(error instanceof DispatchAuthorizationDenied){next.status='failed';next.error='authorizationRevokedBeforeAttempt';this.store('EmailSubmission',next);this.save();continue;}
        // A failed durable attempt commit never reached the provider. Restore the
        // committed state so an alarm retry cannot mistake RAM for an actual send.
        this.state=this.repository.load({includeEmails:false});this.persistedRevision=this.state?.sequence??null;this.pendingSql=[];this.pendingActions=[];throw error;
      }
      next.status=result.status==='accepted'?'sent':result.status==='unknown'?'uncertain':'failed';next.error=result.error??null;next.providerId=result.providerId??null;next.deliveryStatus=initialRecipientDelivery(submission.envelope.rcptTo.map((item:any)=>item.email),result);
      if(result.status==='accepted'){const email=this.repository.readEmails({ids:[submission.emailId],limit:1})[0];const unchanged=email&&email.blobId===submission.emailSnapshot.blobId;const sent=clone(unchanged?email:submission.emailSnapshot);if(!unchanged)sent.id=crypto.randomUUID();delete sent.keywords['$draft'];delete sent.draftFrom;sent.keywords['$seen']=true;delete sent.mailboxIds['folder-drafts'];sent.mailboxIds['folder-sent']=true;this.store('Email',sent);next.sentEmailId=sent.id;delete next.emailSnapshot;}
      this.store('EmailSubmission',next);this.save();if(next.providerId&&this.env.MAIL_DIRECTORY){const account={accountId:this.state.context.accountId,organizationId:this.state.context.organizationId,workspaceId:this.state.context.workspaceId,ownerActorId:submission.actorId};await this.env.MAIL_DIRECTORY.get(this.env.MAIL_DIRECTORY.idFromName('directory')).fetch(new Request('https://mail-directory/register-provider',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account,providerId:next.providerId,sender:submission.identitySnapshot.email})}));}
    }
    this.save();await this.scheduleAlarm();
  });}
}
