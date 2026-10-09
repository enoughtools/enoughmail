import { describe, expect, it, vi } from 'vitest';
import { MailCredentials, credentialHash, handleCredentialsApi, type CredentialsEnv } from '../../../apps/mail/src/server/credentials';
import { handleClientJmap, handlePublicClient } from '../../../apps/mail/src/server/public-client';
class MemoryStorage {
  values=new Map<string,unknown>();
  async get<T>(key:string){return this.values.get(key) as T|undefined;}
  async put(key:string,value:unknown){this.values.set(key,structuredClone(value));}
  async list<T>({prefix}:{prefix:string}){return new Map([...this.values].filter(([key])=>key.startsWith(prefix))) as Map<string,T>;}
  async transaction<T>(callback:(store:MemoryStorage)=>Promise<T>){return callback(this);}
}
const context={accountId:'account',organizationId:'organization',workspaceId:'workspace',actorId:'actor'};
function setup(){
  const storage=new MemoryStorage(),store=new MailCredentials({storage});let coreAllowed=true;let dispatched=0;let lifecycleGeneration=0;
  const resource={id:'account',ownerAppId:'mail',resourceType:'mail.account',organizationId:'organization',workspaceId:'workspace',effectiveActions:['mail.read','mail.draft','mail.send']};
  const env:CredentialsEnv={MAIL_CREDENTIALS:{idFromName:name=>name,get:()=>store},MAIL_ACCOUNTS:{idFromName:name=>name,get:()=>({async fetch(request:Request){if(new URL(request.url).pathname==='/credential-admission')return Response.json({allowed:true,status:'active',generation:lifecycleGeneration});if(new URL(request.url).pathname==='/push-watch')return Response.json({watched:true});dispatched++;return Response.json({methodResponses:[]});}})},CORE:{async fetch(request:Request){
    const path=new URL(request.url).pathname;
    if(path.endsWith('/authorize'))return Response.json({allowed:true,effectiveActions:['mail.read','mail.draft','mail.send']});
    if(path.endsWith('/lease'))return Response.json({lease:'signed-native-lease'});
    if(path.startsWith('/api/'))return Response.json({resource});
    if(!coreAllowed)return Response.json({error:'forbidden'},{status:403});
    return Response.json({resource,context:{organizationId:'organization',workspaceId:'workspace',actorId:'actor'},authorization:{allowed:true,effectiveActions:['mail.read','mail.draft','mail.send']}});
  }}};
  const issue=async()=>{const result=await handleCredentialsApi(new Request('https://mail.test/api/credentials',{method:'POST',body:JSON.stringify({operationId:crypto.randomUUID(),accountId:'account',name:'Thunderbird',actions:['mail.read']})}),env,context);expect(result.status).toBe(201);return result.json() as Promise<any>;};
  const client=(token:string,path='/jmap/session',body?:unknown)=>handleClientJmap(new Request('https://mail.internal/internal/client-jmap?path='+encodeURIComponent(path),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'X-Mail-Client-Origin':'https://client.test','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),env);
  return {env,storage,issue,client,setAllowed(value:boolean){coreAllowed=value;},setGeneration(value:number){lifecycleGeneration=value;},dispatched:()=>dispatched};
}
describe('scoped third-party JMAP credentials',()=>{
  it('keeps the exact originally issued action order in native submission proofs',async()=>{
    const s=setup(),actions=['mail.send','mail.read','mail.send'];
    const issued=await (await handleCredentialsApi(new Request('https://mail.test/api/credentials',{method:'POST',body:JSON.stringify({operationId:crypto.randomUUID(),accountId:'account',name:'Exact scope',actions})}),s.env,context)).json() as any;
    let forwarded:any;s.env.MAIL_ACCOUNTS={idFromName:name=>name,get:()=>({async fetch(request:Request){if(new URL(request.url).pathname==='/credential-admission')return Response.json({allowed:true,status:'active',generation:0});forwarded=await request.json();return Response.json({methodResponses:[]});}})};
    await s.client(issued.token,'/jmap/api',{using:['urn:ietf:params:jmap:core','urn:ietf:params:jmap:submission'],methodCalls:[['EmailSubmission/set',{accountId:'account'},'send']]});
    expect(forwarded.authorityProof.actions).toEqual(actions);expect((await s.storage.get<any>('credential:'+issued.credential.id)).actions).toEqual(actions);
  });
  it('advertises mail mutation capability for native draft+send credentials while retaining no-read scope',async()=>{
    const s=setup();const issued=await (await handleCredentialsApi(new Request('https://mail.test/api/credentials',{method:'POST',body:JSON.stringify({operationId:crypto.randomUUID(),accountId:'account',name:'Composer',actions:['mail.draft','mail.send']})}),s.env,context)).json() as any;
    const session=await (await s.client(issued.token)).json() as any;expect(session.capabilities['urn:ietf:params:jmap:mail']).toBeDefined();expect(session.accounts.account.accountCapabilities['urn:enough:params:jmap:mail'].actions).toEqual(['mail.draft','mail.send']);
  });

  it('advertises submission only for send-only native clients',async()=>{
    const s=setup();const issued=await (await handleCredentialsApi(new Request('https://mail.test/api/credentials',{method:'POST',body:JSON.stringify({operationId:crypto.randomUUID(),accountId:'account',name:'Sender only',actions:['mail.send']})}),s.env,context)).json() as any;
    const session=await (await s.client(issued.token)).json() as any;
    expect(session.primaryAccounts).toEqual({'urn:ietf:params:jmap:submission':'account'});expect(session.capabilities['urn:ietf:params:jmap:mail']).toBeUndefined();expect(session.accounts.account.accountCapabilities['urn:ietf:params:jmap:mail']).toBeUndefined();
  });

  it('streams EmailDelivery from the private state endpoint without inventing a JMAP method',async()=>{
    const s=setup(),issued=await s.issue();let context:any;
    s.env.MAIL_ACCOUNTS={idFromName:name=>name,get:()=>({async fetch(request:Request){if(new URL(request.url).pathname==='/credential-admission')return Response.json({allowed:true,status:'active',generation:0});expect(new URL(request.url).pathname).toBe('/event-state');context=JSON.parse(request.headers.get('X-Mail-Account-Context')!);return Response.json({states:{EmailDelivery:'d1',Email:'m1'}});}})};
    const response=await s.client(issued.token,'/jmap/events?types=EmailDelivery&closeafter=state&ping=0'),text=await response.text();
    expect(context).toMatchObject({accountId:'account',actor:{id:'actor',actions:['mail.read']}});
    expect(text).toContain('"EmailDelivery":"d1"');expect(text).not.toContain('"Email":"m1"');expect(text).not.toContain('event: ping');
  });
  it('closes a native state stream if permission is revoked while fetching its states',async()=>{
    const s=setup(),issued=await s.issue();
    s.env.MAIL_ACCOUNTS={idFromName:name=>name,get:()=>({async fetch(request:Request){if(new URL(request.url).pathname==='/credential-admission')return Response.json({allowed:true,status:'active',generation:0});s.setAllowed(false);return Response.json({states:{EmailDelivery:'d1'}});}})};
    const response=await s.client(issued.token,'/jmap/events?types=EmailDelivery&closeafter=state&ping=0');expect(await response.text()).toBe('');
  });

  it('routes accountless native push with credential proof and prior result references',async()=>{
    const s=setup(),issued=await s.issue(),calls:any[]=[];
    s.env.MAIL_PUSH_REGISTRY={idFromName:name=>name,get:()=>({async fetch(request:Request){calls.push(await request.json());return Response.json({list:[{id:'subscription'}],notFound:[]});}})};
    const result=await (await s.client(issued.token,'/jmap/api',{using:['urn:ietf:params:jmap:core'],methodCalls:[['Core/echo',{value:'native'},'echo'],['PushSubscription/get',{ids:null},'push'],['PushSubscription/get',{'#ids':{resultOf:'push',name:'PushSubscription/get',path:'/list/*/id'}},'next']]})).json() as any;
    expect(result.methodResponses.map((tuple:any)=>tuple[0])).toEqual(['Core/echo','PushSubscription/get','PushSubscription/get']);
    expect(calls[0].authorityContext).toMatchObject({kind:'credential',credentialId:issued.credential.id,credentialVersion:1,actorId:'actor',accountId:'account'});
    expect(calls[1].args.ids).toEqual(['subscription']);expect(s.dispatched()).toBe(0);expect(result.sessionState).toBe('1');
  });

  it('denies legacy tokens after a lifecycle transition even when current Core grants still allow access',async()=>{
    const s=setup(),issued=await s.issue();s.setGeneration(2);
    expect((await s.client(issued.token)).status).toBe(403);
  });
  it('revokes a credential if suspension and restoration race its issuance',async()=>{
    const s=setup(),namespace=s.env.MAIL_CREDENTIALS,store=namespace.get(namespace.idFromName('mail-client-credentials-v1'));
    s.env.MAIL_CREDENTIALS={idFromName:name=>name,get:()=>({async fetch(request:Request){const result=await store.fetch(request);if(new URL(request.url).pathname==='/issue')s.setGeneration(2);return result;}})};
    await expect(handleCredentialsApi(new Request('https://mail.test/api/credentials',{method:'POST',body:JSON.stringify({operationId:crypto.randomUUID(),accountId:'account',name:'Racing client',actions:['mail.read']})}),s.env,context)).rejects.toMatchObject({code:'account_lifecycle_changed'});
    const records=await s.storage.list<any>({prefix:'credential:'});expect(records.size).toBe(1);expect([...records.values()][0].revokedAt).not.toBeNull();
  });

  it('revokes all account delegates without changing another account and replays the lifecycle command',async()=>{
    const s=setup(),issued=await s.issue(),record=await s.storage.get<any>('credential:'+issued.credential.id);
    const delegate={...record,id:crypto.randomUUID(),actorId:'delegate',hash:'b'.repeat(64)};
    const outside={...record,id:crypto.randomUUID(),accountId:'outside',hash:'c'.repeat(64)};
    await s.storage.put('credential:'+delegate.id,delegate);await s.storage.put('credential:'+outside.id,outside);
    const body={operationId:crypto.randomUUID(),context:{...context,actions:['mail.manage']}};
    const call=(value:any)=>s.env.MAIL_CREDENTIALS.get(s.env.MAIL_CREDENTIALS.idFromName('mail-client-credentials-v1')).fetch(new Request('https://credentials.internal/revoke-account',{method:'POST',body:JSON.stringify(value)}));
    expect((await call({...body,context:{...context,actions:['mail.read']}})).status).toBe(403);
    expect(await (await call(body)).json()).toEqual({revoked:2});expect(await (await call(body)).json()).toEqual({revoked:2});
    expect((await s.storage.get<any>('credential:'+delegate.id)).version).toBe(2);
    expect((await s.storage.get<any>('credential:'+outside.id)).revokedAt).toBeNull();
    expect((await s.client(issued.token)).status).toBe(401);
  });

  it('advertises future release within the issuing credential lifetime',async()=>{
    const s=setup();
    const issued=await (await handleCredentialsApi(new Request('https://mail.test/api/credentials',{method:'POST',body:JSON.stringify({operationId:crypto.randomUUID(),accountId:'account',name:'Sender',actions:['mail.read','mail.send'],expiresAt:Date.now()+3600000})}),s.env,context)).json() as any;
    const session=await (await s.client(issued.token)).json() as any;
    const caps=session.accounts.account.accountCapabilities['urn:ietf:params:jmap:submission'];
    expect(caps.maxDelayedSend).toBeGreaterThan(0);expect(caps.maxDelayedSend).toBeLessThanOrEqual(3540);
    expect(caps.submissionExtensions.FUTURERELEASE[0]).toBe(String(caps.maxDelayedSend));
    expect(Date.parse(caps.submissionExtensions.FUTURERELEASE[1])).toBeLessThan(issued.credential.expiresAt);
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+5000);
    try{expect(await (await s.client(issued.token)).json()).toEqual(session);}finally{clock.mockRestore();}
    const record=await s.storage.get<any>('credential:'+issued.credential.id);record.expiresAt=Date.now()+30000;await s.storage.put('credential:'+record.id,record);
    const short=await (await s.client(issued.token)).json() as any;
    expect(short.accounts.account.accountCapabilities['urn:ietf:params:jmap:submission']).toEqual({maxDelayedSend:0,submissionExtensions:{}});
  });

  it('stores a hash, reveals the secret once, and exposes only the scoped account',async()=>{
    const s=setup(),issued=await s.issue();expect(issued.token).toMatch(/^emj_[a-f0-9]{64}$/);
    const stored=JSON.stringify([...s.storage.values]);expect(stored).not.toContain(issued.token);expect(stored).toContain(await credentialHash(issued.token));
    const listed=await handleCredentialsApi(new Request('https://mail.test/api/credentials'),s.env,context);const metadata=await listed.json() as any;expect(metadata.credentials[0].hash).toBeUndefined();expect(metadata.credentials[0].lease).toBeUndefined();
    const session=await s.client(issued.token);expect(session.status).toBe(200);const body=await session.json() as any;expect(Object.keys(body.accounts)).toEqual(['account']);expect(body.apiUrl).toBe('https://client.test/jmap/api');expect(body.accounts.account.isReadOnly).toBe(true);
    const foreign=await s.client(issued.token,'/jmap/api',{methodCalls:[['Email/get',{accountId:'other'},'a']]});expect(foreign.status).toBe(403);expect(s.dispatched()).toBe(0);
  });
  it('replays issuance without creating a second secret or retaining plaintext, and expires credentials',async()=>{
    const s=setup(),operationId=crypto.randomUUID();
    const issue=()=>handleCredentialsApi(new Request('https://mail.test/api/credentials',{method:'POST',body:JSON.stringify({operationId,accountId:'account',name:'Client',actions:['mail.read']})}),s.env,context);
    const first=await (await issue()).json() as any,second=await (await issue()).json() as any;
    expect(second.credential.id).toBe(first.credential.id);expect(second.token).toBeUndefined();expect(second.secretAlreadyIssued).toBe(true);
    const key='credential:'+first.credential.id,record=await s.storage.get<any>(key);record.expiresAt=Date.now()-1;await s.storage.put(key,record);expect((await s.client(first.token)).status).toBe(401);
  });
  it('serves client requests through the remote credential Durable Object and denies write with read-only tokens',async()=>{
    const s=setup(),issued=await s.issue(),remote=new MailCredentials({storage:s.storage},s.env);
    const request=new Request('https://mail.internal/internal/client-jmap?path=%2Fjmap%2Fsession',{headers:{Authorization:'Bearer '+issued.token,'X-Mail-Client-Origin':'https://client.test'}});
    expect((await remote.fetch(request)).status).toBe(200);
    const upload=new Request('https://mail.internal/internal/client-jmap?path='+encodeURIComponent('/jmap/upload/account'),{method:'POST',headers:{Authorization:'Bearer '+issued.token},body:'file'});
    expect((await remote.fetch(upload)).status).toBe(403);expect(s.dispatched()).toBe(0);
  });
  it('enforces current Core permission and immediate credential revocation',async()=>{
    const s=setup(),issued=await s.issue();s.setAllowed(false);expect((await s.client(issued.token)).status).toBe(403);s.setAllowed(true);
    const revoke=await handleCredentialsApi(new Request('https://mail.test/api/credentials/'+issued.credential.id,{method:'DELETE',body:JSON.stringify({expectedVersion:1,operationId:crypto.randomUUID()})}),s.env,context);expect(revoke.status).toBe(200);expect((await s.client(issued.token)).status).toBe(401);
  });
  it('denies an already queued send after credential revocation even while its Core lease remains valid',async()=>{
    const s=setup();
    const issued=await (await handleCredentialsApi(new Request('https://mail.test/api/credentials',{method:'POST',body:JSON.stringify({operationId:crypto.randomUUID(),accountId:'account',name:'Sender',actions:['mail.read','mail.send']})}),s.env,context)).json() as any;
    const proof={id:issued.credential.id,version:issued.credential.version,...context};
    const validate=()=>s.env.MAIL_CREDENTIALS.get(s.env.MAIL_CREDENTIALS.idFromName('mail-client-credentials-v1')).fetch(new Request('https://credentials.internal/validate-job',{method:'POST',body:JSON.stringify(proof)}));
    expect(await (await validate()).json()).toEqual({allowed:true});
    await handleCredentialsApi(new Request('https://mail.test/api/credentials/'+issued.credential.id,{method:'DELETE',body:JSON.stringify({expectedVersion:1,operationId:crypto.randomUUID()})}),s.env,context);
    const currentCore=await s.env.CORE!.fetch(new Request('https://core.internal/internal/native-resources/account/revalidate',{method:'POST',body:JSON.stringify({lease:'signed-native-lease',jobId:crypto.randomUUID(),actions:['mail.send']})}));
    expect(currentCore.status).toBe(200);expect(await (await validate()).json()).toEqual({allowed:false});
  });
  it('revalidates read-only push credentials by identifier and revision without granting send',async()=>{
    const s=setup(),issued=await s.issue();
    const lookup=async(version:number)=>{
      const response=await s.env.MAIL_CREDENTIALS.get(s.env.MAIL_CREDENTIALS.idFromName('mail-client-credentials-v1')).fetch(new Request('https://credentials.internal/lookup-id',{method:'POST',body:JSON.stringify({id:issued.credential.id,version})}));
      return response.json() as Promise<any>;
    };
    const valid=await lookup(1);expect(valid.credential.id).toBe(issued.credential.id);expect(valid.credential.actions).toEqual(['mail.read']);expect((await lookup(2)).credential).toBeNull();
    await handleCredentialsApi(new Request('https://mail.test/api/credentials/'+issued.credential.id,{method:'DELETE',body:JSON.stringify({expectedVersion:1,operationId:crypto.randomUUID()})}),s.env,context);
    expect((await lookup(1)).credential).toBeNull();expect((await lookup(2)).credential).toBeNull();
  });
  it('fences stale revocations and hides another actor credential list',async()=>{
    const s=setup(),issued=await s.issue();const wrong=await handleCredentialsApi(new Request('https://mail.test/api/credentials/'+issued.credential.id,{method:'DELETE',body:JSON.stringify({expectedVersion:7,operationId:crypto.randomUUID()})}),s.env,context);expect(wrong.status).toBe(409);
    const foreign=await handleCredentialsApi(new Request('https://mail.test/api/credentials'),s.env,{...context,actorId:'other'});expect(await foreign.json()).toEqual({credentials:[]});
    expect((await s.client('emj_'+'0'.repeat(64))).status).toBe(401);
  });
  it('never exposes workspace routes and strips browser identity from public forwarding',async()=>{
    let forwarded:Request|undefined;const gateway={async fetch(request:Request){forwarded=request;return Response.json({ok:true});}};
    expect((await handlePublicClient(new Request('https://public.test/api/accounts'),{MAIL_CREDENTIALS:{idFromName:name=>name,get:()=>gateway}})).status).toBe(404);expect(forwarded).toBeUndefined();
    await handlePublicClient(new Request('https://public.test/.well-known/jmap',{headers:{Authorization:'Bearer emj_'+'a'.repeat(64),Cookie:'secret','Cf-Access-Jwt-Assertion':'forged','X-Mail-Actor-Id':'forged'}}),{MAIL_CREDENTIALS:{idFromName:name=>name,get:()=>gateway}});
    expect(forwarded!.headers.get('Cookie')).toBeNull();expect(forwarded!.headers.get('Cf-Access-Jwt-Assertion')).toBeNull();expect(forwarded!.headers.get('X-Mail-Actor-Id')).toBeNull();expect(forwarded!.headers.get('Authorization')).toBe('Bearer emj_'+'a'.repeat(64));
  });
});
