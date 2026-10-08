import { boundedUploadStream, UploadTooLarge } from './bounded-stream';
import { MailAccessError } from './core';
import { executeAuthorizedJmap, type JmapRequest, type JmapResponse } from './jmap-router';
import { handlePushJmap, type PushAuthorityProof } from './push';
import { boundedBytes, validateCredential, type CredentialsEnv, type Credential } from './credentials';
const CORE='urn:ietf:params:jmap:core',MAIL='urn:ietf:params:jmap:mail',SEND='urn:ietf:params:jmap:submission';
const MAX_REQUEST=1048576,MAX_UPLOAD=67108864;
const supportsMailData=(actions:readonly string[])=>actions.some(action=>['mail.read','mail.draft','mail.edit'].includes(action));
const allowedPath=(path:string)=>path==='/.well-known/jmap'||['/jmap/session','/jmap/api','/jmap/events'].includes(path)||/^\/jmap\/upload\/[^/]+$/.test(path)||/^\/jmap\/download\/[^/]+\/[^/]+\/[^/]+$/.test(path);
function fail(code:string,message:string,status=400):never{throw new MailAccessError(code,message,status);}
function headers(credential:Credential){return new Headers({'X-Mail-Account-Context':JSON.stringify({accountId:credential.accountId,organizationId:credential.organizationId,workspaceId:credential.workspaceId,actor:{id:credential.actorId,actions:credential.actions}}),'Content-Type':'application/json'});}
function envelope(credential:Credential,body:unknown){return {accountId:credential.accountId,organizationId:credential.organizationId,workspaceId:credential.workspaceId,actor:{id:credential.actorId,actions:credential.actions},authorityProof:{lease:credential.lease,jobId:credential.jobId,expiresAt:credential.expiresAt,actions:[...credential.actions],credentialId:credential.id,credentialVersion:credential.version},request:body};}
function accountStub(env:CredentialsEnv,credential:Credential){return env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(credential.accountId));}
/** Public companion exposes only token-authenticated JMAP, never workspace routes. */
export async function handlePublicClient(request:Request,env:{MAIL_CREDENTIALS?:CredentialsEnv['MAIL_CREDENTIALS']}):Promise<Response>{
  const url=new URL(request.url),path=url.pathname;
  if(!allowedPath(path))return Response.json({error:'not_found'},{status:404});
  if(!/^Bearer emj_[a-f0-9]{64}$/.test(request.headers.get('Authorization')??''))return Response.json({error:'invalid_token'},{status:401});
  if(!env.MAIL_CREDENTIALS)return Response.json({error:'client_gateway_unavailable'},{status:503});
  try{
    const isUpload=path.startsWith('/jmap/upload/');
    const bytes=isUpload?undefined:await boundedBytes(request,MAX_REQUEST);
    const body=isUpload?boundedUploadStream(request,MAX_UPLOAD):bytes!.buffer as ArrayBuffer;
    const target=new URL('https://mail.internal/internal/client-jmap');target.searchParams.set('path',path+url.search);
    const forwardHeaders=new Headers({'Authorization':request.headers.get('Authorization')??'','X-Mail-Client-Origin':url.origin});
    if(request.headers.has('Content-Type'))forwardHeaders.set('Content-Type',request.headers.get('Content-Type')!);
    if(isUpload&&request.headers.has('Content-Length'))forwardHeaders.set('Content-Length',request.headers.get('Content-Length')!);
    const gateway=env.MAIL_CREDENTIALS.get(env.MAIL_CREDENTIALS.idFromName('mail-client-credentials-v1'));
    const response=await gateway.fetch(new Request(target,{method:request.method,headers:forwardHeaders,body:['GET','HEAD'].includes(request.method)?undefined:body,duplex:'half'} as RequestInit));
    const responseHeaders=new Headers(response.headers);responseHeaders.set('Cache-Control','no-store');responseHeaders.set('X-Content-Type-Options','nosniff');
    return new Response(response.body,{status:response.status,headers:responseHeaders});
  }catch(error){return (error instanceof MailAccessError||error instanceof UploadTooLarge)?Response.json({error:error.code},{status:error.status}):Response.json({error:'client_gateway_unavailable'},{status:503});}
}
/** Called only on the private Mail service binding, before browser authentication. */
export async function handleClientJmap(request:Request,env:CredentialsEnv):Promise<Response>{
  try{
    const input=new URL(request.url).searchParams.get('path')??'';
    if(!input.startsWith('/')||input.startsWith('//'))fail('not_found','Unknown client route.',404);
    const url=new URL('https://client.internal'+input),path=url.pathname;
    if(!allowedPath(path))fail('not_found','Unknown client route.',404);
    const credential=await validateCredential(request,env);
    const method=request.method;
    const requireAction=(action:string)=>{if(!credential.actions.includes(action))fail('forbidden','Credential lacks the required permission.',403);};
    if(path==='/.well-known/jmap'||path==='/jmap/session'){
      if(!['GET','HEAD'].includes(method))fail('method_not_allowed','Use GET.',405);
      const origin=request.headers.get('X-Mail-Client-Origin');if(!origin||new URL(origin).origin!==origin)fail('invalid_origin','Invalid client origin.');
      const base=origin+'/jmap',caps:Record<string,unknown>={...(supportsMailData(credential.actions)?{[MAIL]:{maxMailboxesPerEmail:null,maxMailboxDepth:20,maxSizeMailboxName:255,maxSizeAttachmentsPerEmail:MAX_UPLOAD,emailQuerySortOptions:['receivedAt','subject','from','to','size'],mayCreateTopLevelMailbox:credential.actions.includes('mail.organize')}}:{}),'urn:enough:params:jmap:mail':{actions:credential.actions}};
      const maxDelayedSend=Math.max(0,Math.min(89*86400,Math.floor((credential.expiresAt-credential.createdAt)/1000)-60));
      if(credential.actions.includes('mail.send'))caps[SEND]={maxDelayedSend,submissionExtensions:maxDelayedSend?{FUTURERELEASE:[String(maxDelayedSend),new Date(credential.expiresAt-60000).toISOString().replace(/\.\d{3}Z$/,'Z')]}:{}};
      const session={capabilities:{[CORE]:{maxSizeUpload:MAX_UPLOAD,maxConcurrentUpload:4,maxSizeRequest:MAX_REQUEST,maxConcurrentRequests:4,maxCallsInRequest:32,maxObjectsInGet:500,maxObjectsInSet:500,collationAlgorithms:['i;unicode-casemap']},...(supportsMailData(credential.actions)?{[MAIL]:{}}:{}),...(credential.actions.includes('mail.send')?{[SEND]:{}}:{}),'urn:enough:params:jmap:mail':{}},accounts:{[credential.accountId]:{name:credential.name,isPersonal:true,isReadOnly:!credential.actions.some(action=>['mail.organize','mail.draft','mail.manage','mail.send'].includes(action)),accountCapabilities:caps}},primaryAccounts:{...(supportsMailData(credential.actions)?{[MAIL]:credential.accountId}:{}),...(credential.actions.includes('mail.send')?{[SEND]:credential.accountId}:{})},username:credential.actorId,actorId:credential.actorId,organizationId:credential.organizationId,workspaceId:credential.workspaceId,apiUrl:base+'/api',uploadUrl:base+'/upload/{accountId}',downloadUrl:base+'/download/{accountId}/{blobId}/{name}?type={type}',eventSourceUrl:base+'/events?types={types}&closeafter={closeafter}&ping={ping}',state:String(credential.version)};
      return method==='HEAD'?new Response(null,{headers:{'Content-Type':'application/json'}}):Response.json(session,{headers:{'Cache-Control':'no-store'}});
    }
    const segments=path.split('/').map(decodeURIComponent);
    if(path==='/jmap/api'){
      if(method!=='POST')fail('method_not_allowed','Use POST.',405);
      if(!(request.headers.get('Content-Type')??'').toLowerCase().startsWith('application/json'))fail('invalid_content_type','Send JSON.',415);
      const body=JSON.parse(new TextDecoder().decode(await boundedBytes(request,MAX_REQUEST)));
      if(!Array.isArray(body.methodCalls)||body.methodCalls.some((call:any)=>!Array.isArray(call)||call[1]?.accountId&&call[1].accountId!==credential.accountId))fail('account_not_found','Credential is restricted to its account.',403);
      if(!Array.isArray(body.using)||body.using.some((capability:unknown)=>![CORE,MAIL,SEND,'urn:enough:params:jmap:mail'].includes(String(capability))))fail('unknown_capability','Unsupported capability.');
      const value=await executeAuthorizedJmap({
        request:body as JmapRequest,
        workspace:credential,
        authorizeAccount:async id=>{
          const current=await validateCredential(request,env);
          if(id!==current.accountId) return null;
          return {accountId:current.accountId,organizationId:current.organizationId,workspaceId:current.workspaceId,actor:{id:current.actorId,actions:current.actions}};
        },
        callGlobal:async(name,args,callId)=>{
          requireAction('mail.read');await validateCredential(request,env);
          const proof:PushAuthorityProof={kind:'credential',actorId:credential.actorId,organizationId:credential.organizationId,workspaceId:credential.workspaceId,credentialId:credential.id,credentialVersion:credential.version,accountId:credential.accountId,lease:credential.lease,jobId:credential.jobId,actions:credential.actions};
          const {operationId,...parameters}=args;
          const result=await handlePushJmap({scope:`credential:${credential.id}:${credential.version}`,proof,operationId},name,parameters,env);
          await validateCredential(request,env);
          return {methodResponses:[[typeof result.type==='string'?'error':name,result,callId]],sessionState:String(credential.version)};
        },
        callAccount:async(_context,single)=>{
          const response=await accountStub(env,credential).fetch(new Request('https://mail-account.internal/jmap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope(credential,single))}));
          if(!response.ok)fail('client_operation_failed','Mail operation unavailable.',response.status);
          const result=await response.json() as JmapResponse;await validateCredential(request,env);return result;
        },
        sessionState:()=>String(credential.version),
      });
      await validateCredential(request,env);return Response.json(value);
    }
    if(path.startsWith('/jmap/upload/')){
      if(method!=='POST')fail('method_not_allowed','Use POST.',405);requireAction('mail.draft');
      if(segments[3]!==credential.accountId)fail('account_not_found','Credential is restricted to its account.',403);
      const body=boundedUploadStream(request,MAX_UPLOAD),forwardHeaders=headers(credential);if(request.headers.has('Content-Length'))forwardHeaders.set('Content-Length',request.headers.get('Content-Length')!);forwardHeaders.set('Content-Type',request.headers.get('Content-Type')??'application/octet-stream');
      return accountStub(env,credential).fetch(new Request('https://mail-account.internal/upload',{method:'POST',headers:forwardHeaders,body,duplex:'half'} as RequestInit));
    }
    if(path.startsWith('/jmap/download/')){
      if(!['GET','HEAD'].includes(method))fail('method_not_allowed','Use GET.',405);requireAction('mail.read');
      if(segments[3]!==credential.accountId)fail('account_not_found','Credential is restricted to its account.',403);
      const response=await accountStub(env,credential).fetch(new Request('https://mail-account.internal/blob/'+encodeURIComponent(segments[4]),{headers:headers(credential)}));
      const outputHeaders=new Headers(response.headers);outputHeaders.set('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(segments[5])}`);
      return new Response(method==='HEAD'?null:response.body,{status:response.status,headers:outputHeaders});
    }
    if(path==='/jmap/events'){
      if(method!=='GET')fail('method_not_allowed','Use GET.',405);requireAction('mail.read');
      const closeAfter=url.searchParams.get('closeafter');if(closeAfter&&!['state','no'].includes(closeAfter))fail('invalid_closeafter','Invalid event close behavior.');const requested=url.searchParams.get('types'),types=requested&&requested!=='*'?requested.split(','):['Email','EmailDelivery','Thread','Mailbox','EmailSubmission','Identity','Rule','Contact','Domain','Template','VacationResponse'];
      if(types.some(type=>!['Email','EmailDelivery','Thread','Mailbox','EmailSubmission','Identity','Rule','Contact','Domain','Template','VacationResponse'].includes(type)))fail('invalid_event_types','Unknown event type.');
      let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined;const previous=new Map<string,string>();const requestedPing=Number(url.searchParams.get('ping')??30);if(!Number.isFinite(requestedPing)||requestedPing<0)fail('invalid_ping','Invalid event ping interval.');const pingInterval=requestedPing===0?0:Math.min(3600,Math.max(30,requestedPing));let lastPing=0;
      const stream=new ReadableStream<Uint8Array>({start(controller){const tick=async()=>{try{
        const current=await validateCredential(request,env);
        const response=await accountStub(env,current).fetch(new Request('https://mail-account.internal/event-state',{method:'POST',headers:headers(current),body:JSON.stringify({types})}));
        if(!response.ok)throw new Error('Unavailable');const data=await response.json() as {states:Record<string,string>};const changed:Record<string,string>={};for(const [type,state]of Object.entries(data.states??{}))if(types.includes(type)&&typeof state==='string'&&previous.get(type)!==state){changed[type]=state;previous.set(type,state);}
        await validateCredential(request,env);if(cancelled)return;if(Object.keys(changed).length)controller.enqueue(new TextEncoder().encode(`event: state\ndata: ${JSON.stringify({'@type':'StateChange',changed:{[current.accountId]:changed}})}\n\n`));if(pingInterval&&Date.now()-lastPing>=pingInterval*1000){controller.enqueue(new TextEncoder().encode(`event: ping\ndata: ${JSON.stringify({interval:pingInterval})}\n\n`));lastPing=Date.now();}
        if(url.searchParams.get('closeafter')==='state'&&Object.keys(changed).length){cancelled=true;controller.close();return;}timer=setTimeout(tick,15000);
      }catch{if(!cancelled){cancelled=true;controller.close();}}};void tick();},cancel(){cancelled=true;if(timer)clearTimeout(timer);}});
      return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store'}});
    }
    fail('not_found','Unknown client route.',404);
  }catch(error){return (error instanceof MailAccessError||error instanceof UploadTooLarge)?Response.json({error:error.code,message:error.message},{status:error.status}):error instanceof SyntaxError?Response.json({error:'invalid_json'},{status:400}):Response.json({error:'client_unavailable'},{status:503});}
}
