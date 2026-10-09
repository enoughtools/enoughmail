import type { MailOAuthEnv } from './mcp-oauth';
import type { NativeResource } from '@open-cloud/contracts';
import { mailAuthority, type MailAuthorityEnvironment } from './authority';
import type { AssetFetcher } from '@open-cloud/worker';
import { MailAccessError, MailAuthorityClient, type MailWorkspaceAccount } from './core';

interface Namespace { idFromName(name: string): unknown; get(id: unknown): AssetFetcher; }
interface Storage { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; delete?(key:string):Promise<unknown>; list<T>(options: {prefix:string}): Promise<Map<string,T>>; transaction<T>(callback:(storage:Storage)=>Promise<T>):Promise<T>; }
export interface CredentialsEnv extends MailAuthorityEnvironment, MailOAuthEnv { MAIL_CREDENTIALS: Namespace;  MAIL_ACCOUNTS: Namespace; MAIL_PUSH_REGISTRY?: Namespace; MAIL_PUSH_ORIGINS?: string; }
export interface Credential {
  /** Absent on historical, account-specific JMAP credentials. */
  scope?: 'workspace';
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
    if(new URL(request.url).pathname==='/internal/client-mcp'){
      if(!this.env)return Response.json({error:'client_unavailable'},{status:503});
      const {handleClientMcp}=await import('./client-mcp');
      return handleClientMcp(request,{...this.env,MAIL_CREDENTIALS:{idFromName:name=>name,get:()=>this}});
    }
    if(new URL(request.url).pathname==='/internal/client-jmap'){
      if(!this.env)return Response.json({error:'client_unavailable'},{status:503});
      const {handleClientJmap}=await import('./public-client');
      return handleClientJmap(request,{...this.env,MAIL_CREDENTIALS:{idFromName:name=>name,get:()=>this}});
    }
    if(request.method!=='POST')return Response.json({error:'method_not_allowed'},{status:405});
    let body:any;try{body=JSON.parse(new TextDecoder().decode(await boundedBytes(request,32768)));}catch{return Response.json({error:'invalid_request'},{status:400});}
    const path=new URL(request.url).pathname;
    if(path==='/oauth-create-code'){
      const record=await this.ctx.storage.get<Credential>('credential:'+body.credentialId);
      if(!record||record.revokedAt!==null||record.expiresAt<=Date.now()||record.version!==body.credentialVersion||!body.context||!sameActor(record,body.context)||!Array.isArray(body.actions)||JSON.stringify(record.actions)!==JSON.stringify(body.actions)||typeof body.challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.challenge)||body.resource!==this.env?.MAIL_MCP_PUBLIC_ORIGIN+'/mcp'||body.clientId!==(this.env?.MAIL_MCP_CLIENT_ID??'enoughmail-chatgpt')||!(this.env?.MAIL_MCP_REDIRECT_URIS??'').split(',').map(value=>value.trim()).includes(body.redirectUri))return Response.json({error:'invalid_grant'},{status:400});
      return this.ctx.storage.transaction(async storage=>{
        const pending=await storage.list<{expiresAt:number;consumed?:boolean}>({prefix:'oauth-code:'});let active=0;
        for(const [key,value]of pending)if(value.expiresAt<=Date.now()||value.consumed)await storage.delete?.(key);else active++;
        if(active>=1000)return Response.json({error:'temporarily_unavailable'},{status:503});
        const code=[...crypto.getRandomValues(new Uint8Array(32))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
        await storage.put('oauth-code:'+await credentialHash(code),{credentialId:record.id,credentialVersion:record.version,clientId:body.clientId,redirectUri:body.redirectUri,resource:body.resource,challenge:body.challenge,expiresAt:Date.now()+300000});
        return Response.json({code},{headers:{'Cache-Control':'no-store'}});
      });
    }
    if(path==='/oauth-exchange'){
      if(typeof body.code!=='string'||!/^[a-f0-9]{64}$/.test(body.code)||typeof body.verifier!=='string'||!/^[A-Za-z0-9._~-]{43,128}$/.test(body.verifier))return Response.json({error:'invalid_grant'},{status:400});
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body.verifier)));
      const challenge=btoa(String.fromCharCode(...digest)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
      return this.ctx.storage.transaction(async storage=>{
        const key='oauth-code:'+await credentialHash(body.code);
        const code=await storage.get<{credentialId:string;credentialVersion:number;clientId:string;redirectUri:string;resource:string;challenge:string;expiresAt:number;consumed?:boolean}>(key);
        if(!code||code.consumed||code.expiresAt<=Date.now()||code.clientId!==body.clientId||code.redirectUri!==body.redirectUri||code.resource!==body.resource||code.challenge!==challenge)return Response.json({error:'invalid_grant'},{status:400});
        const credential=await storage.get<Credential>('credential:'+code.credentialId);
        if(!credential||credential.version!==code.credentialVersion||credential.revokedAt!==null||credential.expiresAt<=Date.now())return Response.json({error:'invalid_grant'},{status:400});
        const token='emj_'+[...crypto.getRandomValues(new Uint8Array(32))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
        await storage.put(key,{...code,consumed:true});
        const oldTokens=await storage.list<{expiresAt:number}>({prefix:'oauth-token:'});for(const [oldKey,value]of oldTokens)if(value.expiresAt<=Date.now())await storage.delete?.(oldKey);
        if(oldTokens.size>=10000)return Response.json({error:'temporarily_unavailable'},{status:503});
        await storage.put('oauth-token:'+await credentialHash(token),{credentialId:credential.id,credentialVersion:credential.version,resource:code.resource,expiresAt:credential.expiresAt});
        return Response.json({access_token:token,token_type:'Bearer',expires_in:Math.floor((credential.expiresAt-Date.now())/1000),scope:credential.actions.join(' ')},{headers:{'Cache-Control':'no-store','Pragma':'no-cache'}});
      });
    }
    if(path==='/lookup-id'){
      if(typeof body.id!=='string'||!uuid.test(body.id)||!Number.isSafeInteger(body.version))return Response.json({credential:null});
      const record=await this.ctx.storage.get<Credential>('credential:'+body.id);
      if(!record||record.revokedAt!==null||record.expiresAt<=Date.now()||record.version!==body.version)return Response.json({credential:null});
      if(record.scope==='workspace'){
        if(!this.env||typeof body.accountId!=='string')return Response.json({credential:null});
        const generation=await this.ctx.storage.get<number>(`mcp-account-admission:${record.id}:${record.version}:${body.accountId}`);
        if(generation===undefined)return Response.json({credential:null});
        try{return Response.json({credential:await resolveWorkspaceCredential(this.env,{...record,lifecycleGeneration:generation},body.accountId,false)});}catch(error){console.info('EnoughMail event verification',{stage:'workspace_credential_resolution',code:error instanceof MailAccessError?error.code:'service_unavailable',status:error instanceof MailAccessError?error.status:503});return Response.json({credential:null},{status:error instanceof MailAccessError&&error.status<500?200:503});}
      }
      return Response.json({credential:record});
    }
    if(path==='/validate-job'){
      if(typeof body.id!=='string'||!uuid.test(body.id)||!Number.isSafeInteger(body.version))return Response.json({allowed:false});
      let record=await this.ctx.storage.get<Credential>('credential:'+body.id);
      if(record?.scope==='workspace'&&record.revokedAt===null&&record.version===body.version&&this.env){
        const generation=await this.ctx.storage.get<number>(`mcp-account-admission:${record.id}:${record.version}:${body.accountId}`);
        if(generation===undefined)return Response.json({allowed:false});
        try{record=await resolveWorkspaceCredential(this.env,{...record,lifecycleGeneration:generation},body.accountId,false);}catch(error){return Response.json({allowed:false},{status:error instanceof MailAccessError&&error.status<500?200:503});}
      }
      const allowed=Boolean(record&&record.revokedAt===null&&record.expiresAt>Date.now()&&record.version===body.version&&record.accountId===body.accountId&&record.actorId===body.actorId&&record.organizationId===body.organizationId&&record.workspaceId===body.workspaceId&&record.actions.includes('mail.send'));
      return Response.json({allowed});
    }
    if(path==='/remember-account-admission'){
      const record=await this.ctx.storage.get<Credential>('credential:'+body.id);
      if(!record||record.scope!=='workspace'||record.revokedAt!==null||record.expiresAt<=Date.now()||record.version!==body.version||!uuid.test(body.accountId)||!Number.isSafeInteger(body.generation)||body.generation<0)return Response.json({error:'invalid_grant'},{status:403});
      // A cache of the account-owned lifecycle check made before dispatch.
      // Account callbacks must not synchronously call back into the account's
      // serial queue: alarms/events enforce their current generation locally.
      await this.ctx.storage.put(`mcp-account-admission:${record.id}:${record.version}:${body.accountId}`,body.generation);
      return Response.json({saved:true});
    }
    if(path==='/lookup'){
      if(typeof body.hash!=='string'||!/^[a-f0-9]{64}$/.test(body.hash))return Response.json({credential:null});
      const alias=await this.ctx.storage.get<{credentialId:string;credentialVersion:number;resource:string;expiresAt:number}>('oauth-token:'+body.hash);
      const id=alias?(alias.resource===body.audience&&alias.expiresAt>Date.now()?alias.credentialId:undefined):await this.ctx.storage.get<string>('hash:'+body.hash);
      const record=id?await this.ctx.storage.get<Credential>('credential:'+id):undefined;
      if(alias&&record?.version!==alias.credentialVersion)return Response.json({credential:null});
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
      const canonical=JSON.stringify(path==='/issue'?{context,operationId:body.operationId,accountId:body.credential?.accountId,scope:body.credential?.scope,name:body.credential?.name,actions:body.credential?.actions,requestedExpiresAt:body.requestedExpiresAt}:body);
      const receipt=await storage.get<{request:string;result:unknown}>(receiptKey);
      if(receipt)return receipt.request===canonical?Response.json(receipt.result):Response.json({error:'operation_conflict'},{status:409});
      if(path==='/issue'){
        const record=body.credential as Credential;
        if(!record||(record.scope!==undefined&&record.scope!=='workspace')||!sameActor(record,context)||!uuid.test(record.id)||record.version!==1||!record.hash||!record.lease||!record.jobId||record.revokedAt!==null||!Array.isArray(record.actions)||!record.actions.length||!record.actions.every(action=>ACTIONS.includes(action))||record.expiresAt<=Date.now()||record.expiresAt>Date.now()+90*86400000)return Response.json({error:'invalid_credential'},{status:400});
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
  if(response.status>=500)throw new MailAccessError('account_unavailable','Account services are unavailable.',503);
  const admission=await response.json() as {allowed?:boolean;status?:string;generation?:number};
  if(!response.ok||admission.allowed!==true||admission.status!=='active'||!Number.isSafeInteger(admission.generation)||admission.generation!<0)throw new MailAccessError('account_inactive','This account is not available for client access.',403);
  return admission.generation!;
}
interface WorkspaceGrantResponse { context: { organizationId:string;workspaceId:string;actorId:string }; actions?:string[]; expiresAt?:number; resources?:NativeResource[]; resource?:NativeResource; lease?:string; jobId?:string; }
async function workspaceGrantCall(env:CredentialsEnv,credential:Credential,operation:string,extra:Record<string,unknown>={}):Promise<WorkspaceGrantResponse>{
  const authority=mailAuthority(env);if(!authority)throw new MailAccessError('authority_unavailable','Mail authority is unavailable.',503);
  const response=await authority.fetch(new Request('https://mail-authority.internal/internal/mail-client-grants/'+operation,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lease:credential.lease,jobId:credential.jobId,...extra})}));
  if(!response.ok)throw new MailAccessError('credential_permission_denied','Mail connection permission is unavailable.',[401,403,404].includes(response.status)?403:503);
  const value=await response.json() as WorkspaceGrantResponse;
  if(value.context?.organizationId!==credential.organizationId||value.context?.workspaceId!==credential.workspaceId||value.context?.actorId!==credential.actorId)throw new MailAccessError('credential_permission_denied','Mail connection identity does not match.',403);
  return value;
}
async function validateWorkspaceGrant(env:CredentialsEnv,credential:Credential){
  const value=await workspaceGrantCall(env,credential,'revalidate');
  if(value.expiresAt!==credential.expiresAt||!credential.actions.every(action=>value.actions?.includes(action)))throw new MailAccessError('credential_permission_denied','Mail connection permissions changed.',403);
}
async function resolveWorkspaceCredential(env:CredentialsEnv,credential:Credential,accountId:string,checkAdmission=true):Promise<Credential>{
  await validateWorkspaceGrant(env,credential);
  const value=await workspaceGrantCall(env,credential,'account',{accountId});
  const resource=value.resource;
  if(!resource||resource.id!==accountId||resource.ownerAppId!=='mail'||resource.resourceType!=='mail.account'||resource.organizationId!==credential.organizationId||resource.workspaceId!==credential.workspaceId||!Array.isArray(resource.effectiveActions)||!resource.effectiveActions.length||resource.effectiveActions.some(action=>!credential.actions.includes(action))||typeof value.lease!=='string'||!value.lease||value.jobId!==credential.jobId||value.expiresAt!==credential.expiresAt)throw new MailAccessError('credential_permission_denied','Account permission is unavailable.',403);
  const current={...credential,accountId,actions:resource.effectiveActions,lease:value.lease};
  if(!checkAdmission)return current;
  const lifecycleGeneration=await currentCredentialAdmission(env,current);
  const saved=await storeCall(env,'/remember-account-admission',{id:credential.id,version:credential.version,accountId,generation:lifecycleGeneration});
  if(!saved.ok)throw new MailAccessError('credential_permission_denied','Mail connection changed.',403);
  return {...current,lifecycleGeneration};
}
/** MCP-only connection grant. Native/JMAP account credentials remain unchanged. */
export async function issueWorkspaceMcpCredential(request:Request,env:CredentialsEnv,context:MailWorkspaceAccount,actions:string[],operationId:string):Promise<Response>{
  if(!uuid.test(operationId)||!actions.length||actions.some(action=>!ACTIONS.includes(action)))throw new MailAccessError('invalid_request','Invalid Mail connection.',400);
  const expiresAt=Date.now()+30*86400000,jobId=crypto.randomUUID();
  const grant=await new MailAuthorityClient(mailAuthority(env)).call<{lease:string;context:WorkspaceGrantResponse['context']}>(request,'/api/mail-client-grants','POST',{operationId:crypto.randomUUID(),jobId,actions,expiresAt});
  if(grant.context?.organizationId!==context.organizationId||grant.context?.workspaceId!==context.workspaceId||grant.context?.actorId!==context.actorId||!grant.lease)throw new MailAccessError('credential_permission_denied','Mail connection identity does not match.',403);
  // No bearer secret is exposed by the consent flow. OAuth exchanges a separate,
  // audience-bound token; the root grant can never be used through public JMAP.
  const credential:Credential={...context,scope:'workspace',id:crypto.randomUUID(),name:'ChatGPT MCP — all accounts',actions:[...actions],expiresAt,createdAt:Date.now(),revokedAt:null,version:1,hash:await credentialHash(crypto.randomUUID()+crypto.randomUUID()),lease:grant.lease,jobId};
  const response=await storeCall(env,'/issue',{context,operationId,credential,requestedExpiresAt:null});
  if(response.ok)await validateWorkspaceGrant(env,credential);
  return response;
}
export async function listMcpAccounts(request:Request,env:CredentialsEnv):Promise<{id:string;name:string;actions:string[]}[]>{
  const credential=await validateCredential(request,env,env.MAIL_MCP_PUBLIC_ORIGIN?env.MAIL_MCP_PUBLIC_ORIGIN+'/mcp':undefined);
  if(credential.scope!=='workspace')return [{id:credential.accountId,name:credential.name,actions:credential.actions}];
  const value=await workspaceGrantCall(env,credential,'accounts');
  if(!Array.isArray(value.resources))throw new MailAccessError('authority_unavailable','Invalid account discovery.',503);
  const accounts=[];
  for(const resource of value.resources){
    if(resource.ownerAppId!=='mail'||resource.resourceType!=='mail.account'||resource.organizationId!==credential.organizationId||resource.workspaceId!==credential.workspaceId)continue;
    try{const current=await resolveWorkspaceCredential(env,credential,resource.id);accounts.push({id:resource.id,name:resource.name,actions:current.actions});}
    catch(error){if(!(error instanceof MailAccessError)||error.status>=500)throw error;}
  }
  return accounts;
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
export async function validateCredential(request:Request,env:CredentialsEnv,audience?:string,accountId?:string):Promise<Credential>{
  const authorization=request.headers.get('Authorization')??'';
  if(!/^Bearer emj_[a-f0-9]{64}$/.test(authorization))throw new MailAccessError('invalid_token','A valid client credential is required.',401);
  const result=await storeCall(env,'/lookup',{hash:await credentialHash(authorization.slice(7)),...(audience?{audience}:{})});
  const {credential}=await result.json() as {credential:Credential|null};if(!credential)throw new MailAccessError('invalid_token','The credential has expired or been revoked.',401);
  if(credential.scope==='workspace'){
    if(!env.MAIL_MCP_PUBLIC_ORIGIN||audience!==env.MAIL_MCP_PUBLIC_ORIGIN+'/mcp')throw new MailAccessError('invalid_token','This connection is restricted to MCP.',401);
    await validateWorkspaceGrant(env,credential);
    return accountId===undefined?credential:resolveWorkspaceCredential(env,credential,accountId);
  }
  if(accountId!==undefined&&accountId!==credential.accountId)throw new MailAccessError('credential_permission_denied','Account permission is unavailable.',403);
  if(!mailAuthority(env))throw new MailAccessError('core_unavailable','Workspace services are unavailable.',503);
  const response=await mailAuthority(env)!.fetch(new Request(`https://mail-authority.internal/internal/native-resources/${encodeURIComponent(credential.accountId)}/revalidate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lease:credential.lease,jobId:credential.jobId,actions:credential.actions})}));
  if(!response.ok)throw new MailAccessError('credential_permission_denied','Account permission is no longer available.',403);
  const value=await response.json() as any;
  if(value.authorization?.allowed!==true||value.resource?.id!==credential.accountId||value.resource?.ownerAppId!=='mail'||value.resource?.resourceType!=='mail.account'||value.context?.organizationId!==credential.organizationId||value.context?.workspaceId!==credential.workspaceId||value.context?.actorId!==credential.actorId||!credential.actions.every(action=>value.authorization.effectiveActions?.includes(action)))throw new MailAccessError('credential_permission_denied','Account permission is no longer available.',403);
  const lifecycleGeneration=await currentCredentialAdmission(env,credential);
  if(lifecycleGeneration!==(credential.lifecycleGeneration??0))throw new MailAccessError('account_lifecycle_changed','The account lifecycle changed. Reconnect this client.',403);
  return credential;
}
