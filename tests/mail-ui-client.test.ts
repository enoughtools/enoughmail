import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {MailClient,safeEndpoint,type MailSession} from '../apps/mail/src/ui/jmap';
const session:MailSession={username:'actor',actorId:'actor',organizationId:'org',workspaceId:'space',apiUrl:'/apps/mail/jmap/api',uploadUrl:'/apps/mail/jmap/upload/{accountId}',downloadUrl:'/apps/mail/jmap/download/{accountId}/{blobId}/{name}',capabilities:{'urn:ietf:params:jmap:core':{}},primaryAccounts:{},accounts:{a:{name:'Inbox',isReadOnly:false,accountCapabilities:{}}}};
describe('Mail JMAP browser client',()=>{
 beforeEach(()=>{vi.stubGlobal('window',{location:{origin:'https://enough.example'}});});
 afterEach(()=>vi.unstubAllGlobals());
 it('does not roll confirmed edit state back when an older speculative read finishes later',async()=>{
  let complete!: (response:Response)=>void;
  vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{const name=JSON.parse(options.body).methodCalls[0][0];if(name==='Email/get')return new Promise<Response>(resolve=>{complete=resolve;});return Response.json({methodResponses:[['Email/set',{oldState:'7',newState:'8',updated:{e:null}},'ui']]});}));
  const client=new MailClient();client.session=session;client.states.set('a:Email','7');
  const reading=client.readBatch([['Email/get',{ids:['e']},'emails']],'a');
  await client.call('Email/set',{update:{e:{'keywords/$seen':true}}},'a');
  complete(Response.json({methodResponses:[['Email/get',{accountId:'a',state:'7',list:[]},'emails']]}));
  await reading;expect(client.states.get('a:Email')).toBe('8');
 });
 it('rejects cross-origin server endpoints including protocol-relative URLs',()=>{expect(()=>safeEndpoint('https://attacker.example/jmap')).toThrow('untrusted');expect(()=>safeEndpoint('//attacker.example/jmap')).toThrow('untrusted');expect(safeEndpoint('/apps/mail/jmap/api')).toBe('/apps/mail/jmap/api');});
 it('sends state preconditions and persistent operation IDs inside method arguments',async()=>{const requests:any[]=[];vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify({methodResponses:[['Email/set',{oldState:'7',newState:'8',updated:{e:null}},'ui']]}),{status:200});}));const client=new MailClient();client.session=session;client.states.set('a:Email','7');await client.call('Email/set',{operationId:'same-command',update:{e:{keywords:{$seen:true}}}},'a');expect(requests[0].methodCalls[0][1]).toMatchObject({accountId:'a',operationId:'same-command',ifInState:'7'});expect(client.states.get('a:Email')).toBe('8');});
 it('fences automatic domain setup as an idempotent mutation',async()=>{let request:any;vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{request=JSON.parse(options.body);return Response.json({methodResponses:[['Domain/setup',{status:'pending',newState:'domain-8'},'ui']]});}));const client=new MailClient();client.session=session;client.states.set('a:Domain','domain-7');await client.call('Domain/setup',{domainId:'domain'},'a');expect(request.requestId).toEqual(expect.any(String));expect(request.methodCalls[0][1]).toMatchObject({accountId:'a',domainId:'domain',ifInState:'domain-7',operationId:expect.any(String)});expect(client.states.get('a:Domain')).toBe('domain-8');});
 it('retains the exact sending-address command and advances its Identity state',async()=>{let request:any;vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{request=JSON.parse(options.body);return Response.json({methodResponses:[['Identity/resolve',{accountId:'a',oldState:'identity-7',newState:'identity-8',identity:{id:'alias',email:'alias@example.test'}},'ui']]});}));const client=new MailClient();client.session=session;client.states.set('a:Identity','identity-7');await client.call('Identity/resolve',{email:'alias@example.test',operationId:'stable-command',ifInState:'original-revision'},'a');expect(request.requestId).toEqual(expect.any(String));expect(request.methodCalls[0][1]).toMatchObject({accountId:'a',email:'alias@example.test',operationId:'stable-command',ifInState:'original-revision'});expect(client.states.get('a:Identity')).toBe('identity-8');});
 it('retains explicit undo state instead of rebasing onto current state',async()=>{let args:any;vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{args=JSON.parse(options.body).methodCalls[0][1];return new Response(JSON.stringify({methodResponses:[['error',{type:'stateMismatch'},'ui']]}));}));const client=new MailClient();client.session=session;client.states.set('a:Email','newer');await expect(client.call('Email/set',{ifInState:'original-change-state',update:{e:{keywords:{}}}},'a')).rejects.toThrow('stateMismatch');expect(args.ifInState).toBe('original-change-state');expect(client.states.get('a:Email')).toBe('newer');});
 it('rejects partial mutation failure rather than displaying success',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({methodResponses:[['EmailSubmission/set',{notCreated:{send:{type:'forbidden',description:'Identity not verified'}}},'ui']]}))));const client=new MailClient();client.session=session;await expect(client.call('EmailSubmission/set',{create:{send:{emailId:'e',identityId:'i'}}},'a')).rejects.toThrow('Identity not verified');});
 it('uses confirmed state from a partially failed mutation when retrying another domain',async()=>{
  const requests:any[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{
   requests.push(JSON.parse(options.body));
   return Response.json({methodResponses:[['Domain/set',requests.length===1
    ?{oldState:'7',newState:'8',updated:{first:null},notUpdated:{second:{type:'invalidProperties',description:'Delivery could not be saved'}}}
    :{oldState:'8',newState:'9',updated:{second:null}},'ui']]});
  }));
  const client=new MailClient();client.session=session;client.states.set('a:Domain','7');
  await expect(client.call('Domain/set',{update:{first:{catchAllAccountId:'a'},second:{catchAllAccountId:'a'}}},'a')).rejects.toThrow('Delivery could not be saved');
  expect(client.states.get('a:Domain')).toBe('8');
  await client.call('Domain/set',{update:{second:{catchAllAccountId:'a'}}},'a');
  expect(requests[1].methodCalls[0][1].ifInState).toBe('8');
  expect(requests[1].methodCalls[0][1].operationId).not.toBe(requests[0].methodCalls[0][1].operationId);
  expect(client.states.get('a:Domain')).toBe('9');
 });
 it('reports expired authorization without caching new session data',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:403})));const client=new MailClient();await expect(client.discover()).rejects.toThrow('Sign in');expect(client.session).toBeUndefined();});
});

it('opens offline fallback only for a tagged discovery transport TypeError',async()=>{
 vi.stubGlobal('window',{location:{origin:'https://enough.example'}});
 vi.stubGlobal('fetch',vi.fn(async()=>{throw new TypeError('Failed to fetch');}));
 const {canUseOfflineCopy}=await import('../apps/mail/src/ui/jmap');
 let transport:unknown;try{await new MailClient().discover();}catch(error){transport=error;}
 expect(canUseOfflineCopy(transport)).toBe(true);
 expect(canUseOfflineCopy(new TypeError('Malformed server response'))).toBe(false);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:403})));
 let denied:unknown;try{await new MailClient().discover();}catch(error){denied=error;}
 expect(canUseOfflineCopy(denied)).toBe(false);
 vi.unstubAllGlobals();
});

describe('Authenticated embedded-image downloads',()=>{
 afterEach(()=>vi.unstubAllGlobals());
 const image={blobId:'private-image',type:'image/png',size:10,name:'logo.png'};
 const ready=()=>{vi.stubGlobal('window',{location:{origin:'https://enough.example'}});const client=new MailClient();client.session=session;return client;};
 it('does not bypass revoked authorization for stored image content',async()=>{const client=ready();const lost=vi.fn();client.onAuthorizationLost=lost;vi.stubGlobal('fetch',vi.fn(async()=>new Response('Forbidden',{status:403})));await expect(client.readBlob('a',image)).rejects.toThrow('unavailable (403)');expect(lost).toHaveBeenCalledOnce();});
 it('enforces actual streamed bytes even when attachment metadata understates the size',async()=>{const client=ready();const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(5*1024*1024+1));controller.close();}});vi.stubGlobal('fetch',vi.fn(async()=>new Response(body)));await expect(client.readBlob('a',image)).rejects.toThrow('display limit');});
 it('reads only the authenticated account-scoped attachment endpoint',async()=>{const client=ready();const fetcher=vi.fn(async()=>new Response(Uint8Array.from([137,80,78,71])));vi.stubGlobal('fetch',fetcher);expect(new Uint8Array(await client.readBlob('a',image))).toEqual(Uint8Array.from([137,80,78,71]));expect(fetcher.mock.calls[0]).toEqual(['/apps/mail/jmap/download/a/private-image/logo.png',expect.objectContaining({credentials:'same-origin',cache:'no-store'})]);});
});

describe('Grouped mailbox reads',()=>{
 afterEach(()=>vi.unstubAllGlobals());
 const ready=()=>{vi.stubGlobal('window',{location:{origin:'https://enough.example'}});const client=new MailClient();client.session=session;return client;};
 it('uses one bounded authenticated envelope and preserves result references and account scope',async()=>{
  const client=ready();const fetcher=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>Response.json({methodResponses:[['Email/query',{ids:['e'],total:1},'query'],['Email/get',{state:'8',list:[{id:'e',preview:'Hello'}]},'emails'],['Mailbox/get',{state:'3',list:[]},'boxes']]}));vi.stubGlobal('fetch',fetcher);
  const result=await client.readBatch([['Email/query',{limit:50},'query'],['Email/get',{'#ids':{resultOf:'query',name:'Email/query',path:'/ids'},properties:['id','preview']},'emails'],['Mailbox/get',{},'boxes']],'a');
  expect(fetcher).toHaveBeenCalledOnce();const options=fetcher.mock.calls[0][1] as RequestInit;expect(options.credentials).toBe('same-origin');expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(options.body as string).methodCalls[1]).toEqual(['Email/get',{'#ids':{resultOf:'query',name:'Email/query',path:'/ids'},properties:['id','preview'],accountId:'a'},'emails']);expect(result.emails.list).toEqual([{id:'e',preview:'Hello'}]);expect(client.states.get('a:Email')).toBe('8');expect(client.states.get('a:Mailbox')).toBe('3');
 });
 it('never sends grouped mutations or reports partial read errors as success',async()=>{
  const client=ready();const fetcher=vi.fn(async()=>Response.json({methodResponses:[['error',{type:'forbidden'},'emails']]}));vi.stubGlobal('fetch',fetcher);
  await expect(client.readBatch([['Email/set',{destroy:['e']},'delete']],'a')).rejects.toThrow('Only reads');expect(fetcher).not.toHaveBeenCalled();await expect(client.readBatch([['Email/get',{ids:['e']},'emails']],'a')).rejects.toThrow('forbidden');
 });
 it('clears access on revoked grouped reads and reports timeouts with a retry message',async()=>{
  const client=ready();client.onAuthorizationLost=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:403})));await expect(client.readBatch([['Email/get',{},'emails']],'a')).rejects.toMatchObject({authorizationLost:true});expect(client.onAuthorizationLost).toHaveBeenCalledOnce();vi.stubGlobal('fetch',vi.fn(async()=>{throw new DOMException('Timed out','TimeoutError');}));await expect(client.readBatch([['Email/get',{},'emails']],'a')).rejects.toThrow('Mail took too long');
 });
});

it('retains uncertain mutation receipts when a server method fails internally',async()=>{
 vi.stubGlobal('window',{location:{origin:'https://enough.example'}});vi.stubGlobal('fetch',vi.fn(async()=>Response.json({methodResponses:[['error',{type:'serverFail',description:'Unable to execute account method'},'ui']]})));const client=new MailClient();client.session=session;await expect(client.call('EmailSubmission/set',{operationId:'stable',create:{message:{emailId:'draft',identityId:'identity'}}},'a')).rejects.toMatchObject({confirmed:false,errorType:'serverFail'});vi.unstubAllGlobals();
});

it('preserves non-dispatch evidence without treating an uncertain replay as rejected',async()=>{
 vi.stubGlobal('window',{location:{origin:'https://enough.example'}});
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({methodResponses:[['error',{type:'serverFail',submissionNotDispatched:true,description:'Authorization unavailable'},'ui']]})));
 const client=new MailClient();client.session=session;
 try{await expect(client.call('EmailSubmission/set',{operationId:'stable',create:{message:{emailId:'draft',identityId:'identity'}}},'a')).rejects.toMatchObject({confirmed:false,submissionNotDispatched:true,errorType:'serverFail'});}finally{vi.unstubAllGlobals();}
});
