import { mailAuthority, type MailAuthorityEnvironment } from './authority';
import type { AssetFetcher } from '@open-cloud/worker';
import { MailAccessError, MailAuthorityClient, type MailWorkspaceAccount } from './core';

interface Namespace { idFromName(name: string): unknown; get(id: unknown): AssetFetcher; }
interface Storage { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; list<T>(options: {prefix:string}): Promise<Map<string,T>>; transaction<T>(callback:(storage:Storage)=>Promise<T>):Promise<T>; }
export interface CredentialsEnv extends MailAuthorityEnvironment { MAIL_CREDENTIALS: Namespace;  MAIL_ACCOUNTS: Namespace; MAIL_PUSH_REGISTRY?: Namespace; MAIL_PUSH_ORIGINS?: string; }
export interface Credential {
  id:string; name:string; accountId:string; organizationId:string; workspaceId:string; actorId:string;
  actions:string[]; expiresAt:number; createdAt:number; revokedAt:number|null; version:number;
  hash:string; lease:string; jobId:string; lifecycleGeneration?:number;
}
const ACTIONS=['mail.read','mail.organize','mail.draft','mail.send','mail.manage'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function boundedBytes(request:Request,limit:number):Promise<Uint8Array> {
  const reader=request.body?.getReader(); const chunks:Uint8Array[]=[];let size=0;
  try {if(reader)while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>limit){await reader.cancel();throw new MailAccessError('request_too_large','Request is too large.',413);}chunks.push(chunk.value);}}finally{reader?.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export async function credentialHash(token:string):Promise<string> {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
function metadata(record:Credential){const {hash,lease,jobId,...publicValue}=record;return publicValue;}
function sameActor(record:Credential,context:MailWorkspaceAccount){return record.organizationId===context.organizationId&&record.workspaceId===context.workspaceId&&record.actorId===context.actorId;}
/** Private service-bound store. Only hashes are retained; the bearer secret is shown once. */
export class MailCredentials {
  constructor(private readonly ctx:{storage:Storage},private readonly env?:CredentialsEnv){}
  async fetch(request:Request):Promise<Response>{
    if(new URL(request.url).pathname==='/internal/client-jmap'){
      if(!this.env)return Response.json({error:'client_unavailable'},{status:503});
      const {handleClientJmap}=await import('./public-client');
      return handleClientJmap(request,{...this.env,MAIL_CREDENTIALS:{idFromName:name=>name,get:()=>this}});
    }
    if(request.method!=='POST')return Response.json({error:'method_not_allowed'},{status:405});
    let body:any;try{body=JSON.parse(new TextDecoder().decode(await boundedBytes(request,32768)));}catch{return Response.json({error:'invalid_request'},{status:400});}
    const path=new URL(request.url).pathname;
    if(path==='/lookup-id'){
      if(typeof body.id!=='string'||!uuid.test(body.id)||!Number.isSafeInteger(body.version))return Response.json({credential:null});
      const record=await this.ctx.storage.get<Credential>('credential:'+body.id);
      return Response.json({credential:record&&record.revokedAt===null&&record.expiresAt>Date.now()&&record.version===body.version?record:null});
    }
    if(path==='/validate-job'){
      if(typeof body.id!=='string'||!uuid.test(body.id)||!Number.isSafeInteger(body.version))return Response.json({allowed:false});
      const record=await this.ctx.storage.get<Credential>('credential:'+body.id);
      const allowed=Boolean(record&&record.revokedAt===null&&record.expiresAt>Date.now()&&record.version===body.version&&record.accountId===body.accountId&&record.actorId===body.actorId&&record.organizationId===body.organizationId&&record.workspaceId===body.workspaceId&&record.actions.includes('mail.send'));
      return Response.json({allowed});
    }
    if(path==='/lookup'){
      if(typeof body.hash!=='string'||!/^[a-f0-9]{64}$/.test(body.hash))return Response.json({credential:null});
      const id=await this.ctx.storage.get<string>('hash:'+body.hash),record=id?await this.ctx.storage.get<Credential>('credential:'+id):undefined;
      return Response.json({credential:record&&!record.revokedAt&&record.expiresAt>Date.now()?record:null});
    }
    const context=body.context as MailWorkspaceAccount;
    if(!context||!['organizationId','workspaceId','actorId'].every(key=>typeof context[key as keyof MailWorkspaceAccount]==='string'&&context[key as keyof MailWorkspaceAccount]))return Response.json({error:'invalid_context'},{status:400});
    if(path==='/revoke-account'){
      if(typeof context.accountId!=='string'||!context.accountId||!Array.isArray(body.context.actions)||!body.context.actions.includes('mail.manage')||!uuid.test(body.operationId??''))return Response.json({error:'invalid_context'},{status:403});
      return this.ctx.storage.transaction(async storage=>{
        const receiptKey=`account-revocation:${context.organizationId}:${context.workspaceId}:${context.accountId}:${body.operationId}`;
        const canonical=JSON.stringify([context.actorId,context.accountId,context.organizationId,context.workspaceId]);
        const prior=await storage.get<{request:string;result:unknown}>(receiptKey);
        if(prior)return prior.request===canonical?Response.json(prior.result):Response.json({error:'operation_conflict'},{status:409});
        const records=await storage.list<Credential>({prefix:'credential:'});let revoked=0;
        for(const record of records.values())if(record.accountId===context.accountId&&record.organizationId===context.organizationId&&record.workspaceId===context.workspaceId&&record.revokedAt===null){
          record.revokedAt=Date.now();record.version++;await storage.put('credential:'+record.id,record);revoked++;
        }
        const result={revoked};await storage.put(receiptKey,{request:canonical,result});return Response.json(result);
      });
    }
    if(path==='/list'){const records=await this.ctx.storage.list<Credential>({prefix:'credential:'});return Response.json({credentials:[...records.values()].filter(record=>sameActor(record,context)).map(metadata)});}
    if(!uuid.test(body.operationId??''))return Response.json({error:'operation_id_required'},{status:400});
    return this.ctx.storage.transaction(async storage=>{
      const receiptKey=`receipt:${context.organizationId}:${context.workspaceId}:${context.actorId}:${body.operationId}`;
      const canonical=JSON.stringify(path==='/issue'?{context,operationId:body.operationId,accountId:body.credential?.accountId,name:body.credential?.name,actions:body.credential?.actions,requestedExpiresAt:body.requestedExpiresAt}:body);
      const receipt=await storage.get<{request:string;result:unknown}>(receiptKey);
      if(receipt)return receipt.request===canonical?Response.json(receipt.result):Response.json({error:'operation_conflict'},{status:409});
      if(path==='/issue'){
        const record=body.credential as Credential;
        if(!record||!sameActor(record,context)||!uuid.test(record.id)||record.version!==1||!record.hash||!record.lease||!record.jobId||record.revokedAt!==null||!Array.isArray(record.actions)||!record.actions.length||!record.actions.every(action=>ACTIONS.includes(action))||record.expiresAt<=Date.now()||record.expiresAt>Date.now()+90*86400000)return Response.json({error:'invalid_credential'},{status:400});
        await storage.put('credential:'+record.id,record);await storage.put('hash:'+record.hash,record.id);
        const result={credential:metadata(record)};await storage.put(receiptKey,{request:canonical,result});return Response.json(result, {status:201});
      }
      if(path==='/revoke'){
        const record=await storage.get<Credential>('credential:'+body.id);
        if(!record||!sameActor(record,context))return Response.json({error:'not_found'},{status:404});
        if(record.version!==body.expectedVersion)return Response.json({error:'revision_conflict'},{status:409});
        record.revokedAt=Date.now();record.version++;await storage.put('credential:'+record.id,record);
        const result={credential:metadata(record)};await storage.put(receiptKey,{request:canonical,result});return Response.json(result);
      }
      return Response.json({error:'not_found'},{status:404});
    });
  }
}
export function credentialsStore(env:CredentialsEnv){return env.MAIL_CREDENTIALS.get(env.MAIL_CREDENTIALS.idFromName('mail-client-credentials-v1'));}
async function storeCall(env:CredentialsEnv,path:string,body:unknown){return credentialsStore(env).fetch(new Request('https://mail-credentials.internal'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));}
async function currentCredentialAdmission(env:CredentialsEnv,context:{accountId:string;organizationId:string;workspaceId:string;actorId:string;actions:string[]}):Promise<number>{
  const response=await env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(context.accountId)).fetch(new Request('https://mail-account.internal/credential-admission',{method:'POST',headers:{'Content-Type':'application/json','X-Mail-Account-Context':JSON.stringify({accountId:context.accountId,organizationId:context.organizationId,workspaceId:context.workspaceId,actor:{id:context.actorId,actions:context.actions}})},body:'{}'}));
  const admission=await response.json() as {allowed?:boolean;status?:string;generation?:number};
  if(!response.ok||admission.allowed!==true||admission.status!=='active'||!Number.isSafeInteger(admission.generation)||admission.generation!<0)throw new MailAccessError('account_inactive','This account is not available for client access.',403);
  return admission.generation!;
}
export async function handleCredentialsApi(request:Request,env:CredentialsEnv,context:MailWorkspaceAccount):Promise<Response>{
  const path=new URL(request.url).pathname.replace(/^\/apps\/mail/,'');
  if(request.method==='GET'&&path==='/api/credentials')return storeCall(env,'/list',{context});
  const body=JSON.parse(new TextDecoder().decode(await boundedBytes(request,16384)));
  if(request.method==='DELETE'&&/^\/api\/credentials\/[^/]+$/.test(path))return storeCall(env,'/revoke',{context,id:decodeURIComponent(path.split('/')[3]),expectedVersion:body.expectedVersion,operationId:body.operationId});
  if(request.method!=='POST'||path!=='/api/credentials')throw new MailAccessError('method_not_allowed','Unsupported credential operation.',405);
  if(!uuid.test(body.operationId??'')||typeof body.name!=='string'||!body.name.trim()||body.name.length>100||typeof body.accountId!=='string'||!Array.isArray(body.actions)||!body.actions.length||!body.actions.every((action:unknown)=>typeof action==='string'&&ACTIONS.includes(action)))throw new MailAccessError('invalid_request','Choose an account, name, and permissions.',400);
  const expiresAt=body.expiresAt??Date.now()+30*86400000;
  if(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+90*86400000)throw new MailAccessError('invalid_expiry','Credentials expire within 90 days.',400);
  const core=new MailAuthorityClient(mailAuthority(env)),resource=await core.authorize(request,body.accountId,body.actions);
  if(resource.organizationId!==context.organizationId||resource.workspaceId!==context.workspaceId)throw new MailAccessError('forbidden','Account is unavailable.');
  const lifecycleGeneration=await currentCredentialAdmission(env,{...context,accountId:body.accountId,actions:body.actions});
  const jobId=crypto.randomUUID();const proof=await core.call<{lease:string}>(request,`/api/native-resources/${encodeURIComponent(body.accountId)}/lease`,'POST',{jobId,actions:body.actions,expiresAt});
  const random=crypto.getRandomValues(new Uint8Array(32));const token='emj_'+[...random].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const credential:Credential={...context,id:crypto.randomUUID(),name:body.name.trim(),accountId:body.accountId,actions:[...body.actions],expiresAt,createdAt:Date.now(),revokedAt:null,version:1,hash:await credentialHash(token),lease:proof.lease,jobId,lifecycleGeneration};
  const response=await storeCall(env,'/issue',{context,operationId:body.operationId,credential,requestedExpiresAt:body.expiresAt??null});
  if(!response.ok)return response;
  const result=await response.json() as {credential:{id:string;version:number;lifecycleGeneration?:number}};
  try{
    const current=await currentCredentialAdmission(env,{...context,accountId:body.accountId,actions:body.actions});
    if(current!==lifecycleGeneration||current!==(result.credential.lifecycleGeneration??0))throw new MailAccessError('account_lifecycle_changed','Account lifecycle changed. Issue a new client credential.',409);
  }catch(error){
    await storeCall(env,'/revoke',{context,id:result.credential.id,expectedVersion:result.credential.version,operationId:result.credential.id});
    throw error;
  }
  return Response.json({...result,...(result.credential.id===credential.id?{token}:{secretAlreadyIssued:true})},{status:response.status,headers:{'Cache-Control':'no-store'}});
}
export async function validateCredential(request:Request,env:CredentialsEnv):Promise<Credential>{
  const authorization=request.headers.get('Authorization')??'';
  if(!/^Bearer emj_[a-f0-9]{64}$/.test(authorization))throw new MailAccessError('invalid_token','A valid client credential is required.',401);
  const result=await storeCall(env,'/lookup',{hash:await credentialHash(authorization.slice(7))});
  const {credential}=await result.json() as {credential:Credential|null};if(!credential)throw new MailAccessError('invalid_token','The credential has expired or been revoked.',401);
  if(!mailAuthority(env))throw new MailAccessError('core_unavailable','Workspace services are unavailable.',503);
  const response=await mailAuthority(env)!.fetch(new Request(`https://mail-authority.internal/internal/native-resources/${encodeURIComponent(credential.accountId)}/revalidate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lease:credential.lease,jobId:credential.jobId,actions:credential.actions})}));
  if(!response.ok)throw new MailAccessError('credential_permission_denied','Account permission is no longer available.',403);
  const value=await response.json() as any;
  if(value.authorization?.allowed!==true||value.resource?.id!==credential.accountId||value.resource?.ownerAppId!=='mail'||value.resource?.resourceType!=='mail.account'||value.context?.organizationId!==credential.organizationId||value.context?.workspaceId!==credential.workspaceId||value.context?.actorId!==credential.actorId||!credential.actions.every(action=>value.authorization.effectiveActions?.includes(action)))throw new MailAccessError('credential_permission_denied','Account permission is no longer available.',403);
  const lifecycleGeneration=await currentCredentialAdmission(env,credential);
  if(lifecycleGeneration!==(credential.lifecycleGeneration??0))throw new MailAccessError('account_lifecycle_changed','The account lifecycle changed. Reconnect this client.',403);
  return credential;
}
