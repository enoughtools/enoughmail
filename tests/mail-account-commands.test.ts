import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCAN_LIMITS } from '../apps/mail/src/server/scanner';
import { parseMime } from '../apps/mail/src/domain/mime';
import { MailAccount, type MailAccountEnvironment } from '../apps/mail/src/server/account';
import { MAIL_EVENT_TYPES } from '../apps/mail/src/domain/events';

const databases: DatabaseSync[]=[];
afterEach(()=>{vi.unstubAllGlobals();for(const db of databases.splice(0))db.close();});
function fixture(){
  const db=new DatabaseSync(':memory:');databases.push(db);let nesting=0;let fault=false;
  const blobs=new Map<string,Uint8Array>();
  const storage={sql:{exec<T>(sql:string,...bindings:unknown[]):Iterable<T>{if(fault&&sql.startsWith('INSERT INTO mail_objects'))throw new Error('Injected failure');const statement=db.prepare(sql);return (statement.columns().length?statement.all(...bindings as any[]):[statement.run(...bindings as any[])]) as T[];}},transactionSync<T>(task:()=>T):T{const save=`save_${++nesting}`;db.exec(`SAVEPOINT ${save}`);try{const result=task();db.exec(`RELEASE ${save}`);return result;}catch(error){db.exec(`ROLLBACK TO ${save}; RELEASE ${save}`);throw error;}},async setAlarm(_time:number){},async deleteAlarm(){}};
  const bucket:MailAccountEnvironment['MAIL_BLOBS'] & {list(input:{prefix:string;limit:number}):Promise<{objects:{key:string}[]}>}={async put(key:string,value:any){blobs.set(key,value instanceof ReadableStream?new Uint8Array(await new Response(value).arrayBuffer()):new Uint8Array(value));},async get(key:string,options?:{range?:{offset:number;length:number}}){const value=blobs.get(key);const part=value&&(options?.range?value.slice(options.range.offset,options.range.offset+options.range.length):value);return part?{size:value!.length,body:new Response(part.slice()).body!,async arrayBuffer(){return part.slice().buffer;}}:null;},async delete(key:string){blobs.delete(key);},async list(input:{prefix:string;limit:number}){return {objects:Array.from(blobs.keys()).filter(key=>key.startsWith(input.prefix)).slice(0,input.limit).map(key=>({key}))};}};
  const env:MailAccountEnvironment={MAIL_BLOBS:bucket};
  const context={authorityProof:{actions:['mail.read','mail.organize','mail.draft','mail.manage','mail.send'],lease:'fixture-proof',jobId:crypto.randomUUID(),expiresAt:Date.now()+90*86400000},accountId:'account',organizationId:'org',workspaceId:'workspace',actor:{id:'actor',actions:['mail.read','mail.organize','mail.draft','mail.manage','mail.send']}};
  let account=new MailAccount({storage},env);
  async function call(name:string,args:any={},actions=context.actor.actions,actorId=context.actor.id,enough=false){const response=await account.fetch(new Request('https://account/jmap',{method:'POST',body:JSON.stringify({...context,actor:{...context.actor,id:actorId,actions},authorityProof:{...context.authorityProof,actions},request:{using:['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail',...(enough?['urn:enough:params:jmap:mail']:[])],methodCalls:[[name,{accountId:'account',...args},'call']]}})}));return (await response.json() as any).methodResponses[0][1];}
  async function raw(id:string,text:string){blobs.set(`account/blobs/${id}`,new TextEncoder().encode(text));return id;}
  async function eventResponse(types:readonly string[],actions=context.actor.actions){return account.fetch(new Request('https://account/event-state',{method:'POST',headers:{'x-mail-account-context':JSON.stringify({...context,actor:{...context.actor,actions}})},body:JSON.stringify({types})}));}
  async function eventState(){return (await (await eventResponse(['EmailDelivery'])).json() as any).states.EmailDelivery;}
  return {db,blobs,env,context,call,raw,eventState,eventResponse,async wait(after:string,actions=context.actor.actions){return account.fetch(new Request('https://account/event-wait',{method:'POST',headers:{'x-mail-account-context':JSON.stringify({...context,actor:{...context.actor,actions}})},body:JSON.stringify({after})}));},async ingest(blobId:string,to:string){return account.fetch(new Request('https://account/ingest',{method:'POST',headers:{'x-mail-account-context':JSON.stringify({...context,actor:{...context.actor,actions:['mail.ingest']}})},body:JSON.stringify({blobId,to,from:'sender@source.test'})}));},crashAfterClean(){(account as any).processPendingAutomations=async()=>{throw new Error('Injected crash after clean commit');};},alarm:()=>account.alarm(),restart(){account=new MailAccount({storage},env);},fail(value:boolean){fault=value;}};
}

it('accepts every product event type while rejecting unknown types and actors without read authority',async()=>{
  const f=fixture();const response=await f.eventResponse(MAIL_EVENT_TYPES);expect(response.status).toBe(200);
  expect(Object.keys((await response.json() as any).states).sort()).toEqual([...MAIL_EVENT_TYPES].sort());
  expect((await f.eventResponse(['PrivateConfig'])).status).toBe(400);
  expect((await f.eventResponse(MAIL_EVENT_TYPES,['mail.send'])).status).toBe(403);
});

it('keeps live thread changes after restart and deletion of one message',async()=>{
  const f=fixture();await f.raw('first','From: sender@example.com\r\nTo: reader@example.net\r\nMessage-ID: <first@example.com>\r\nSubject: First\r\n\r\nHello');
  const first=(await f.call('Email/import',{emails:{first:{blobId:'first'}}})).created.first;
  await f.raw('second','From: sender@example.com\r\nTo: reader@example.net\r\nMessage-ID: <second@example.com>\r\nIn-Reply-To: <first@example.com>\r\nSubject: Reply\r\n\r\nHello again');
  const second=(await f.call('Email/import',{emails:{second:{blobId:'second'}}})).created.second;
  expect(second.threadId).toBe(first.threadId);
  const baseline=await f.call('Thread/get',{ids:[first.threadId]});f.restart();
  expect((await f.call('Email/set',{destroy:[second.id]})).destroyed).toContain(second.id);
  const changes=await f.call('Thread/changes',{sinceState:baseline.state});
  expect(changes.updated).toContain(first.threadId);expect(changes.destroyed).not.toContain(first.threadId);
});

it('parses without phantom messages or scan jobs and blocks unscanned derived attachment blobs',async()=>{
  const f=fixture();await f.raw('parse','From: sender@example.com\r\nTo: reader@example.net\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nHello\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=file.bin\r\n\r\nBytes\r\n--x--');
  const baseline=await f.call('Email/get',{ids:[]});
  const parsed=await f.call('Email/parse',{blobIds:['parse'],properties:['attachments']});
  expect(parsed.parsed.parse.attachments).toHaveLength(1);
  expect((await f.call('Email/get',{ids:[]})).state).toBe(baseline.state);
  expect(f.db.prepare('SELECT count(*) n FROM mail_scan_jobs').get()?.n).toBe(0);
  expect(f.db.prepare("SELECT count(*) n FROM mail_objects WHERE type='Email'").get()?.n).toBe(0);
  const id=parsed.parsed.parse.attachments[0].blobId;
  expect(f.db.prepare('SELECT status FROM mail_blob_security WHERE blob_id=?').get(id)?.status).toBe('pending');
});

it('rolls back scanner authority when the matching canonical email commit fails',async()=>{
  const f=fixture();await f.call('Email/get',{ids:[]});await f.raw('scan','From: sender@example.com\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=x.bin\r\n\r\nPayload');f.fail(true);
  expect((await f.call('Email/import',{emails:{message:{blobId:'scan'}}})).type).toBe('invalidArguments');f.fail(false);
  expect(f.db.prepare('SELECT count(*) n FROM mail_scan_jobs').get()?.n).toBe(0);
  expect(f.db.prepare('SELECT count(*) n FROM mail_blob_security').get()?.n).toBe(0);
  expect(f.db.prepare("SELECT count(*) n FROM mail_objects WHERE type='Email'").get()?.n).toBe(0);
});


it('purges expired Trash content and physical raw and body blobs',async()=>{
  const f=fixture();await f.raw('expired','From: sender@example.com\r\nSubject: Old\r\n\r\nBody');
  const old=(await f.call('Email/import',{emails:{old:{blobId:'expired'}}})).created.old;
  await f.call('Email/set',{update:{[old.id]:{mailboxIds:{'folder-trash':true}}}});
  const at=Date.now()-31*86400000;
  f.db.prepare("UPDATE mail_objects SET json=json_set(json,'$.trashAt',?) WHERE type='Email' AND id=?").run(new Date(at).toISOString(),old.id);
  f.db.prepare('UPDATE mail_email_index SET trash_at=? WHERE id=?').run(at,old.id);
  f.restart();await f.alarm();
  expect((await f.call('Email/get',{ids:[old.id]})).notFound).toContain(old.id);
  expect(f.blobs.has('account/blobs/expired')).toBe(false);expect(f.blobs.size).toBe(0);
  expect(f.db.prepare('SELECT count(*) n FROM mail_gc_jobs').get()?.n).toBe(0);
});


it('changes durable EmailDelivery only for accepted new emails across restarts',async()=>{
  const f=fixture();const initial=await f.eventState();await f.raw('delivery','From: sender@example.com\r\nSubject: New\r\n\r\nBody');
  const message=await (await f.ingest('delivery','reader@example.net')).json() as any;const delivered=await f.eventState();expect(delivered).not.toBe(initial);
  await f.ingest('delivery','reader@example.net');expect(await f.eventState()).toBe(delivered);
  await f.call('Email/set',{update:{[message.id]:{'keywords/$seen':true}}});expect(await f.eventState()).toBe(delivered);f.restart();expect(await f.eventState()).toBe(delivered);
  await f.call('Email/set',{destroy:[message.id]});expect(await f.eventState()).toBe(delivered);
});

it('does not restore content while repeated lifecycle reads interleave bounded purge batches',async()=>{
  const f=fixture();const create=Object.fromEntries(Array.from({length:55},(_,index)=>['draft'+index,{from:[{email:'sender@example.com'}],to:[{email:'reader@example.net'}],subject:'Draft '+index,textBody:[{partId:'text',type:'text/plain'}],bodyValues:{text:{value:'Body'}},mailboxIds:{'folder-drafts':true},keywords:{'$draft':true}}]));
  const drafts=await f.call('Email/set',{create});expect(Object.keys(drafts.created)).toHaveLength(55);const lifecycle=await f.call('Lifecycle/get');
  await f.call('Lifecycle/set',{action:'requestDeletion',expectedRevision:lifecycle.revision,operationId:crypto.randomUUID()});f.db.prepare('UPDATE mail_lifecycle SET purge_after=? WHERE id=1').run(Date.now()-1);
  let previous=55;let intermediate=false;
  for(let batch=0;batch<20;batch++){await f.alarm();const count=Number(f.db.prepare("SELECT count(*) n FROM mail_objects WHERE type='Email'").get()?.n);expect(count).toBeLessThanOrEqual(previous);previous=count;for(let read=0;read<3;read++){const result=await f.call('Lifecycle/get');if(result.status==='purging')intermediate=true;expect(Number(f.db.prepare("SELECT count(*) n FROM mail_objects WHERE type='Email'").get()?.n)).toBe(count);}if((await f.call('Lifecycle/get')).status==='deleted')break;}
  expect(intermediate).toBe(true);expect((await f.call('Lifecycle/get')).status).toBe('deleted');expect(f.blobs.size).toBe(0);f.restart();expect((await f.call('Lifecycle/get')).status).toBe('deleted');expect(f.db.prepare("SELECT count(*) n FROM mail_objects WHERE type='Email'").get()?.n).toBe(0);
});


it('rejects automation renewal without both management and sending actions',async()=>{
  const f=fixture();expect((await f.call('Settings/renew',{},['mail.send'])).type).toBe('forbidden');expect((await f.call('Settings/renew',{},['mail.manage'])).type).toBe('forbidden');
});

it('imports a standard source through the actual account migration callbacks',async()=>{
  const f=fixture();f.env.MAIL_MIGRATION_KEY='local-migration-fixture-key-at-least-32-characters';f.env.MAIL_MIGRATION_ALLOWED_ORIGINS='https://mail-source.enough.tools';
  vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{const request=new Request(input,init);const url=new URL(request.url);expect(request.headers.get('authorization')).toBe('Bearer local-migration-fixture');
    if(url.pathname==='/session')return Response.json({capabilities:{'urn:ietf:params:jmap:mail':{}},primaryAccounts:{'urn:ietf:params:jmap:mail':'source'},accounts:{source:{accountCapabilities:{'urn:ietf:params:jmap:mail':{}}}},apiUrl:url.origin+'/api',downloadUrl:url.origin+'/download/{accountId}/{blobId}/{name}'});
    if(url.pathname.startsWith('/download/'))return new Response('From: sender@example.com\r\nSubject: Migrated\r\n\r\nBody');
    const [name,args,id]=(await request.json() as any).methodCalls[0];const value=name==='Mailbox/get'?{list:[{id:'inbox',name:'Inbox',role:'inbox',parentId:null},{id:'label',name:'Imported',role:null,parentId:null}]}:name==='Email/query'?{ids:['source-message'],position:args.position,total:1,queryState:'stable'}:{list:[{id:'source-message',blobId:'raw',mailboxIds:{inbox:true,label:true},keywords:{'$seen':true},receivedAt:'2026-01-05T12:00:00Z'}]};return Response.json({methodResponses:[[name,value,id]]});
  });
  const started=await f.call('Migration/start',{sessionUrl:'https://mail-source.enough.tools/session',credential:'local-migration-fixture'});const completed=await f.call('Migration/step',{jobId:started.job.id});expect(completed.job.state,JSON.stringify(completed)).toBe('completed');expect(completed.job.imported).toBe(1);
});


it('keeps the queued immutable snapshot through onSuccessDestroyEmail and records a distinct Sent copy',async()=>{
  const f=fixture();f.env.CF_ACCOUNT_ID='fixture-account';f.env.CF_API_TOKEN='local-fixture-token';
  f.env.MAIL_DIRECTORY={idFromName:()=>0,get:()=>({async fetch(){return Response.json({allowed:true});}})};
  f.env.CORE={async fetch(){return Response.json({authorization:{allowed:true,effectiveActions:['mail.send','mail.manage']},resource:{id:'account'},context:{organizationId:'org',workspaceId:'workspace',actorId:'actor'}});}};
  await f.call('Email/get',{ids:[]});
  f.db.prepare('INSERT INTO mail_objects(type,id,json) VALUES(?,?,?)').run('Domain','domain',JSON.stringify({id:'domain',name:'example.com',zoneId:'zone',sendingVerified:true}));
  f.db.prepare('INSERT INTO mail_objects(type,id,json) VALUES(?,?,?)').run('Identity','identity',JSON.stringify({id:'identity',email:'sender@example.com',verified:true,name:'Sender'}));f.restart();
  const original=(await f.call('Email/set',{create:{draft:{from:[{email:'sender@example.com'}],to:[{email:'reader@example.net'}],subject:'Original snapshot',textBody:[{partId:'text',type:'text/plain'}],bodyValues:{text:{value:'Original immutable body'}},mailboxIds:{'folder-drafts':true},keywords:{'$draft':true}}}})).created.draft;
  const bytes=f.blobs.get('account/blobs/'+original.blobId)!.slice();
  const queued=await f.call('EmailSubmission/set',{create:{submission:{emailId:original.id,identityId:'identity',envelope:{mailFrom:{email:'sender@example.com',parameters:{HOLDFOR:'2'}},rcptTo:[{email:'reader@example.net'}]}}},onSuccessDestroyEmail:['#submission']});
  expect(queued.notCreated).toEqual({});const submissionId=queued.created.submission.id;const stored=JSON.parse(String(f.db.prepare("SELECT json FROM mail_objects WHERE type='EmailSubmission' AND id=?").get(submissionId)?.json));
  expect(stored.status).toBe('pending');expect(stored.emailSnapshot.blobId).toBe(original.blobId);expect((await f.call('Email/get',{ids:[original.id]})).notFound).toContain(original.id);expect(f.blobs.get('account/blobs/'+original.blobId)).toEqual(bytes);
  const replacement=(await f.call('Email/set',{create:{replacement:{from:[{email:'sender@example.com'}],to:[{email:'reader@example.net'}],subject:'Edited replacement',textBody:[{partId:'text',type:'text/plain'}],bodyValues:{text:{value:'Edited draft body'}},mailboxIds:{'folder-drafts':true},keywords:{'$draft':true}}}})).created.replacement;
  stored.sendAt=new Date(Date.now()-1).toISOString();f.db.prepare("UPDATE mail_objects SET json=? WHERE type='EmailSubmission' AND id=?").run(JSON.stringify(stored),submissionId);f.restart();let attempts=0;
  vi.stubGlobal('fetch',async(_input:RequestInfo|URL,init?:RequestInit)=>{attempts++;const parsed=parseMime(new TextEncoder().encode(JSON.parse(String(init?.body)).mime_message),'sent');expect(Object.values(parsed.bodyValues).map(value=>value.value).join('')).toBe('Original immutable body');return Response.json({success:true,result:{message_id:'provider-one',queued:['reader@example.net']}});});
  await f.alarm();expect(attempts).toBe(1);expect((await f.call('EmailSubmission/get',{ids:[submissionId]})).list[0].status).toBe('sent');
  expect((await f.call('Email/get',{ids:[replacement.id]})).list[0].keywords['$draft']).toBe(true);const sent=await f.call('Email/query',{filter:{inMailbox:'folder-sent'}});expect(sent.ids).toHaveLength(1);expect(sent.ids[0]).not.toBe(original.id);expect(sent.ids[0]).not.toBe(replacement.id);expect((await f.call('Email/get',{ids:sent.ids})).list[0].blobId).toBe(original.blobId);
});

it('streams full body leaves and preserves distant full-text matches after flags and restart',async()=>{
  const f=fixture();const body='earlyneedle '+ 'x '.repeat(1100000)+' boundaryphrase terminalneedle 🌏';
  await f.raw('large-text',`From: sender@example.com\r\nSubject: Large\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
  const original=f.env.MAIL_BLOBS.get.bind(f.env.MAIL_BLOBS);f.env.MAIL_BLOBS.get=async(...args)=>{const result=await original(...args);if(result)result.arrayBuffer=async()=>{throw new Error('Whole-blob buffering forbidden');};return result;};
  const imported=await f.call('Email/import',{emails:{message:{blobId:'large-text'}}});expect(imported.notCreated).toEqual({});const id=imported.created.message.id;
  expect((await f.call('Email/query',{filter:{text:'earlyneedle terminalneedle'}})).ids).toContain(id);
  const parsed=await f.call('Email/parse',{blobIds:['large-text'],properties:['textBody','bodyValues'],fetchAllBodyValues:true});expect(parsed.notParsable).toEqual([]);expect(Object.values(parsed.parsed['large-text'].bodyValues)[0]).toMatchObject({value:body,isTruncated:false});
  const full=await f.call('Email/get',{ids:[id],properties:['bodyValues','textBody'],fetchAllBodyValues:true});const part=full.list[0].textBody[0];expect(full.list[0].bodyValues[part.partId].value).toBe(body);expect(full.list[0].bodyValues[part.partId].isTruncated).toBe(false);
  const clipped=await f.call('Email/get',{ids:[id],properties:['bodyValues'],fetchAllBodyValues:true,maxBodyValueBytes:13});expect(Object.values(clipped.list[0].bodyValues)[0]).toMatchObject({isTruncated:true});
  await f.call('Email/set',{update:{[id]:{'keywords/$flagged':true}}});f.restart();expect((await f.call('Email/query',{filter:{text:'earlyneedle terminalneedle'}})).ids).toContain(id);
});

it('composes a Gmail-sized attachment without reading whole R2 blobs',async()=>{
  const f=fixture();await f.call('Email/get',{ids:[]});const binary=new Uint8Array(25*1024*1024);for(let i=0;i<binary.length;i++)binary[i]=i%251;f.blobs.set('account/blobs/large-file',binary);
  const original=f.env.MAIL_BLOBS.get.bind(f.env.MAIL_BLOBS);f.env.MAIL_BLOBS.get=async(...args)=>{const result=await original(...args);if(result)result.arrayBuffer=async()=>{throw new Error('Whole-blob buffering forbidden');};return result;};
  const created=await f.call('Email/set',{create:{draft:{subject:'Attachment',mailboxIds:{'folder-drafts':true},keywords:{'$draft':true},attachments:[{blobId:'large-file',type:'application/octet-stream',name:'large.bin',size:binary.length}]}}});expect(created.notCreated).toEqual({});
  const metadata=await f.call('Email/get',{ids:[created.created.draft.id],properties:['attachments','quarantine']});const part=metadata.list[0].attachments[0];expect(part.size).toBe(binary.length);expect(Buffer.from(f.blobs.get(`account/blobs/${part.blobId}`)!).equals(Buffer.from(binary))).toBe(true);expect(metadata.list[0].quarantine.status).toBe('pending');
},30000);


it('rejects transitive foreign content sources before preparing a no-read draft',async()=>{
  const f=fixture();const source=(await f.call('Email/set',{create:{draft:{subject:'Private',textBody:[{partId:'text',type:'text/plain'}],bodyValues:{text:{value:'Private body'}},mailboxIds:{'folder-drafts':true},keywords:{'$draft':true}}}})).created.draft;const leaf=(await f.call('Email/get',{ids:[source.id],properties:['textBody']})).list[0].textBody[0].blobId;
  const actions=['mail.draft','mail.send'];const imported=await f.call('Email/import',{emails:{stolen:{blobId:source.blobId}}},actions,'other');expect(imported.notCreated.stolen.type).toBe('invalidEmail');
  const attached=await f.call('Email/set',{create:{stolen:{subject:'Stolen',attachments:[{blobId:leaf,type:'text/plain',name:'body.txt'}]}}},actions,'other');expect(attached.notCreated.stolen.type).toBe('invalidProperties');expect(attached.created).toEqual({});
  const patched=await f.call('Email/set',{update:{[source.id]:{subject:'Partial replacement'}}},actions,'other',true);expect(patched.notUpdated[source.id].type).toBe('invalidProperties');expect((await f.call('Email/get',{ids:[source.id]})).list[0].subject).toBe('Private');
});

it('recovers a vacation outbox exactly once after a crash following clean scan publication',async()=>{
  const f=fixture();f.env.CF_ACCOUNT_ID='fixture-account';f.env.CF_API_TOKEN='local-fixture-token';f.env.MAIL_DIRECTORY={idFromName:()=>0,get:()=>({async fetch(){return Response.json({allowed:true});}})};f.env.CORE={async fetch(request){const body=await request.json() as any;return Response.json({authorization:{allowed:true,effectiveActions:body.actions},resource:{id:'account',ownerAppId:'mail',resourceType:'mail.account'},context:{organizationId:'org',workspaceId:'workspace',actorId:'actor'},jobId:body.jobId});}};
  await f.call('Email/get',{ids:[]});f.db.prepare('INSERT INTO mail_objects(type,id,json) VALUES(?,?,?)').run('Domain','domain',JSON.stringify({id:'domain',name:'example.com',zoneId:'zone',sendingVerified:true}));f.db.prepare('INSERT INTO mail_objects(type,id,json) VALUES(?,?,?)').run('Identity','identity',JSON.stringify({id:'identity',email:'reader@example.com',verified:true}));f.restart();await f.call('VacationResponse/set',{update:{singleton:{isEnabled:true,subject:'Away',textBody:'Thank you'}}});
  await f.raw('incoming-scan','From: sender@source.test\r\nTo: reader@example.com\r\nSubject: Hello\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nHi\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=x.bin\r\n\r\nContent\r\n--x--');const deliveryBeforeScan=await f.eventState();await f.ingest('incoming-scan','reader@example.com');expect(await f.eventState()).toBe(deliveryBeforeScan);
  f.env.MAIL_SCANNER={async fetch(_input:any,init:any){await new Response(init.body).arrayBuffer();return Response.json({status:'clean',complete:true,sha256:init.headers['X-Mail-SHA256'],size:Number(init.headers['Content-Length']),engine:'fixture-clam',signatureVersion:'fixture-1',threats:[],limits:SCAN_LIMITS});}} as any;f.db.prepare('UPDATE mail_scan_jobs SET next_attempt=?').run(Date.now()-1);f.crashAfterClean();await expect(f.alarm()).rejects.toThrow('Injected crash');const deliveredAfterScan=await f.eventState();expect(deliveredAfterScan).not.toBe(deliveryBeforeScan);
  expect(f.db.prepare('SELECT status FROM mail_scan_jobs').get()?.status).toBe('clean');expect(f.db.prepare('SELECT count(*) n FROM mail_pending_automations').get()?.n).toBe(1);expect(f.db.prepare("SELECT count(*) n FROM mail_objects WHERE type='EmailSubmission'").get()?.n).toBe(0);
  f.restart();let attempts=0;vi.stubGlobal('fetch',async()=>{attempts++;return Response.json({success:true,result:{message_id:'reply-one',queued:['sender@source.test']}});});await f.alarm();await f.alarm();expect(f.db.prepare('SELECT count(*) n FROM mail_pending_automations').get()?.n).toBe(0);expect(f.db.prepare("SELECT count(*) n FROM mail_objects WHERE type='EmailSubmission'").get()?.n).toBe(1);expect(attempts).toBe(1);expect(await f.eventState()).toBe(deliveredAfterScan);
});

it('keeps prepared sender permissions separate from shared-content reading authority',async()=>{
  const f=fixture();f.env.CF_ACCOUNT_ID='fixture-account';f.env.CF_API_TOKEN='local-fixture-token';f.env.MAIL_DIRECTORY={idFromName:()=>0,get:()=>({async fetch(){return Response.json({allowed:true});}})};await f.call('Email/get',{ids:[]});f.db.prepare('INSERT INTO mail_objects(type,id,json) VALUES(?,?,?)').run('Domain','domain',JSON.stringify({id:'domain',name:'example.com',zoneId:'zone',sendingVerified:true}));f.db.prepare('INSERT INTO mail_objects(type,id,json) VALUES(?,?,?)').run('Identity','identity',JSON.stringify({id:'identity',email:'sender@example.com',verified:true}));f.restart();
  const draft={from:[{email:'sender@example.com'}],to:[{email:'reader@example.net'}],subject:'Private',textBody:[{partId:'text',type:'text/plain'}],bodyValues:{text:{value:'Secret original'}},mailboxIds:{'folder-drafts':true},keywords:{'$draft':true}};
  const owner=(await f.call('Email/set',{create:{owner:draft}})).created.owner;const senderActions=['mail.draft','mail.send'];const denied=await f.call('EmailSubmission/set',{create:{send:{emailId:owner.id,identityId:'identity'}}},senderActions,'other');expect(denied.notCreated.send.type).toBe('invalidProperties');
  const own=(await f.call('Email/set',{create:{own:{...draft,subject:'Sender own',bodyValues:{text:{value:'Sender prepared body'}}}}},senderActions,'other')).created.own;const accepted=await f.call('EmailSubmission/set',{create:{send:{emailId:own.id,identityId:'identity'}}},senderActions,'other');expect(accepted.notCreated).toEqual({});let stored=JSON.parse(String(f.db.prepare("SELECT json FROM mail_objects WHERE type='EmailSubmission' AND id=?").get(accepted.created.send.id)?.json));expect(stored.authorityBasis).toBe('prepared');
  await f.call('Email/set',{update:{[own.id]:{bodyValues:{text:{value:'Owner replaced private body'}}}}},f.context.actor.actions,'actor',true);const changed=await f.call('EmailSubmission/set',{create:{send:{emailId:own.id,identityId:'identity'}}},senderActions,'other');expect(changed.notCreated.send.type).toBe('invalidProperties');
  const shared=await f.call('EmailSubmission/set',{create:{send:{emailId:owner.id,identityId:'identity'}}},['mail.read','mail.send'],'other');expect(shared.notCreated).toEqual({});stored=JSON.parse(String(f.db.prepare("SELECT json FROM mail_objects WHERE type='EmailSubmission' AND id=?").get(shared.created.send.id)?.json));expect(stored.authorityBasis).toBe('read');stored.sendAt=new Date(Date.now()-1).toISOString();f.db.prepare("UPDATE mail_objects SET json=? WHERE type='EmailSubmission' AND id=?").run(JSON.stringify(stored),stored.id);f.restart();
  const requested:string[][]=[];f.env.CORE={async fetch(request){const body=await request.json() as any;requested.push(body.actions);return Response.json({authorization:{allowed:!body.actions.includes('mail.read'),effectiveActions:['mail.send']},resource:{id:'account'},context:{organizationId:'org',workspaceId:'workspace',actorId:'other'}});}};let attempts=0;vi.stubGlobal('fetch',async(_input:RequestInfo|URL,init?:RequestInit)=>{attempts++;const parsed=parseMime(new TextEncoder().encode(JSON.parse(String(init?.body)).mime_message),'sent');expect(Object.values(parsed.bodyValues).map(value=>value.value).join('')).toBe('Sender prepared body');return Response.json({success:true,result:{message_id:'sent',queued:['reader@example.net']}});});await f.alarm();expect(requested).toContainEqual(['mail.read','mail.send']);expect(attempts).toBe(1);expect((await f.call('EmailSubmission/get',{ids:[shared.created.send.id]})).list[0].status).toBe('failed');
});

it('renews active browser automation with a durable exact request and latches a later denial',async()=>{
  const f=fixture();await f.call('Settings/set',{settings:{vacation:{enabled:true,subject:'Away',textBody:'Thanks',responseIntervalDays:7}}});expect((await f.call('Settings/get')).settings.vacation).toMatchObject({enabled:true,subject:'Away',textBody:'Thanks',responseIntervalDays:7});expect((await f.call('VacationResponse/get')).list[0]).toMatchObject({isEnabled:true,subject:'Away',textBody:'Thanks'});const row=f.db.prepare("SELECT json FROM mail_objects WHERE type='PrivateConfig' AND id='automation'").get()!;const config=JSON.parse(String(row.json));config.authorityProof.actions=['mail.manage','mail.send'];config.authorityProof.expiresAt=Date.now()+9*86400000;config.renewal.nextAttempt=Date.now()-1;f.db.prepare("UPDATE mail_objects SET json=? WHERE type='PrivateConfig' AND id='automation'").run(JSON.stringify(config));f.restart();const requests:any[]=[];
  f.env.CORE={async fetch(request){const body=await request.json() as any;requests.push({path:new URL(request.url).pathname,...body});if(new URL(request.url).pathname.endsWith('/renew')){expect(f.db.prepare("SELECT json_extract(json,'$.renewal.pending.operationId') op FROM mail_objects WHERE type='PrivateConfig' AND id='automation'").get()?.op).toBe(body.operationId);return Response.json({lease:'opaque-renewed',expiresAt:body.expiresAt});}return Response.json({authorization:{allowed:true,effectiveActions:body.actions},resource:{id:'account',resourceType:'mail.account',ownerAppId:'mail'},context:{actorId:'actor',organizationId:'org',workspaceId:'workspace'},jobId:body.jobId});}};
  await f.alarm();const renewed=JSON.parse(String(f.db.prepare("SELECT json FROM mail_objects WHERE type='PrivateConfig' AND id='automation'").get()?.json));expect(renewed.authorityProof.lease).toBe('opaque-renewed');expect(requests.find(value=>value.path.endsWith('/renew')).actions).toEqual(['mail.manage','mail.send']);expect((await f.call('Settings/get')).automationHealth.status).toBe('healthy');
  renewed.renewal.nextAttempt=Date.now()-1;f.db.prepare("UPDATE mail_objects SET json=? WHERE type='PrivateConfig' AND id='automation'").run(JSON.stringify(renewed));f.restart();let deniedCalls=0;f.env.CORE={async fetch(){deniedCalls++;return Response.json({error:'forbidden'},{status:403});}};await f.alarm();const first=deniedCalls;expect((await f.call('Settings/get')).automationHealth.status).toBe('denied');await f.alarm();expect(deniedCalls).toBe(first);
});


async function retainedSubmissionFixture(status:'failed'|'uncertain'){
  const f=fixture();const created=await f.call('Email/set',{create:{draft:{subject:'Retained recovery',textBody:[{partId:'text',type:'text/plain'}],bodyValues:{text:{value:'Original retained body'}},mailboxIds:{'folder-drafts':true},keywords:{'$draft':true}}}});const emailId=created.created.draft.id;
  const snapshot=JSON.parse(String(f.db.prepare("SELECT json FROM mail_objects WHERE type='Email' AND id=?").get(emailId)?.json));await f.call('Email/set',{destroy:[emailId]});
  const submission={id:'retained-job',emailId,identityId:'old-identity',status,actorId:'original-sender',emailSnapshot:snapshot,identitySnapshot:{email:'original@example.com'},authorityProof:{lease:'old-private-lease'},envelope:{mailFrom:{email:'original@example.com'},rcptTo:[{email:'original-recipient@example.net'}]},providerId:status==='uncertain'?'unknown-provider':null,error:'authorizationRequired'};
  const original=JSON.stringify(submission);f.db.prepare('INSERT INTO mail_objects(type,id,json) VALUES(?,?,?)').run('EmailSubmission',submission.id,original);f.restart();return {f,snapshot,original,submissionId:submission.id};
}
for(const status of ['failed','uncertain'] as const)it(`recovers ${status} retained content as a new draft without changing delivery`,async()=>{
  const {f,snapshot,original,submissionId}=await retainedSubmissionFixture(status);const actions=['mail.read','mail.draft'];const state=(await f.call('EmailSubmission/get',{ids:[submissionId],properties:['id','status']},actions)).state;
  expect((await f.call('EmailSubmission/get',{ids:[submissionId],properties:['id','status']},actions)).list[0].recoverable).toBe(true);
  const args={submissionId,ifInState:state,operationId:crypto.randomUUID()};const result=await f.call('EmailSubmission/recover',args,actions,'actor',true);expect(result.originalStatus).toBe(status);expect(result.emailId).not.toBe(snapshot.id);expect(result.draft.blobId).toBe(snapshot.blobId);
  expect(await f.call('EmailSubmission/recover',args,actions,'actor',true)).toEqual(result);f.restart();expect(await f.call('EmailSubmission/recover',args,actions,'actor',true)).toEqual(result);
  const draft=(await f.call('Email/get',{ids:[result.emailId],fetchTextBodyValues:true},actions)).list[0];expect(draft.subject).toBe('Retained recovery');expect(draft.mailboxIds).toEqual({'folder-drafts':true});expect(draft.keywords).toEqual({'$draft':true,'$seen':true});expect(Object.values(draft.bodyValues).map((value:any)=>value.value).join('')).toBe('Original retained body');
  expect(String(f.db.prepare("SELECT json FROM mail_objects WHERE type='EmailSubmission' AND id=?").get(submissionId)?.json)).toBe(original);expect(f.db.prepare("SELECT count(*) n FROM mail_objects WHERE type='Email'").get()?.n).toBe(1);expect(f.db.prepare('SELECT actor_id,blob_id FROM mail_prepared_email WHERE email_id=?').get(result.emailId)).toMatchObject({actor_id:'actor',blob_id:snapshot.blobId});
  let attempts=0;vi.stubGlobal('fetch',async()=>{attempts++;throw new Error('Recovery must never send');});await f.alarm();expect(attempts).toBe(0);expect(String(f.db.prepare("SELECT json FROM mail_objects WHERE type='EmailSubmission' AND id=?").get(submissionId)?.json)).toBe(original);
});
it('requires current read and draft rights, exact state, safe sources and durable recovery receipts',async()=>{
  const {f,snapshot,submissionId}=await retainedSubmissionFixture('uncertain');const state=(await f.call('EmailSubmission/get',{ids:[submissionId]})).state;const args={submissionId,ifInState:state,operationId:crypto.randomUUID()};
  for(const actions of [['mail.send'],['mail.read'],['mail.draft']])expect((await f.call('EmailSubmission/recover',args,actions,'actor',true)).type).toBe('forbidden');
  expect((await f.call('EmailSubmission/recover',{...args,ifInState:'m0',operationId:crypto.randomUUID()},['mail.read','mail.draft'],'actor',true)).type).toBe('stateMismatch');
  f.db.prepare("INSERT INTO mail_blob_security(blob_id,email_id,status) VALUES(?,?,'infected')").run(snapshot.blobId,snapshot.id);expect((await f.call('EmailSubmission/recover',{...args,operationId:crypto.randomUUID()},['mail.read','mail.draft'],'actor',true)).type).toBe('forbidden');f.db.prepare('DELETE FROM mail_blob_security WHERE blob_id=?').run(snapshot.blobId);
  const raw=f.blobs.get(`account/blobs/${snapshot.blobId}`)!;f.blobs.delete(`account/blobs/${snapshot.blobId}`);expect((await f.call('EmailSubmission/recover',{...args,operationId:crypto.randomUUID()},['mail.read','mail.draft'],'actor',true)).type).toBe('notFound');f.blobs.set(`account/blobs/${snapshot.blobId}`,raw);
  f.fail(true);expect((await f.call('EmailSubmission/recover',args,['mail.read','mail.draft'],'actor',true)).type).toBe('invalidArguments');f.fail(false);expect(f.db.prepare("SELECT count(*) n FROM mail_objects WHERE type='Email'").get()?.n).toBe(0);
  const recovered=await f.call('EmailSubmission/recover',args,['mail.read','mail.draft'],'actor',true);expect(recovered.emailId).toBeTruthy();expect((await f.call('EmailSubmission/recover',args,['mail.send'],'actor',true)).type).toBe('forbidden');expect((await f.call('EmailSubmission/recover',{...args,submissionId:'different'},['mail.read','mail.draft'],'actor',true)).type).toBe('invalidArguments');expect((await f.call('EmailSubmission/recover',args,['mail.read','mail.draft'],'actor',false)).type).toBe('unknownMethod');const phase=await f.call('Lifecycle/get');await f.call('Lifecycle/set',{action:'suspend',expectedRevision:phase.revision,operationId:crypto.randomUUID()});expect((await f.call('EmailSubmission/recover',args,['mail.read','mail.draft'],'actor',true)).type).toBe('forbidden');
});


it('registers event wakeups without blocking the account command queue',async()=>{
 const f=fixture(); const initial=await(await f.eventResponse(['Identity'])).json() as any;
 const pending=f.wait(initial.cursor);
 await f.call('Identity/set',{create:{one:{name:'Sender',email:'sender@example.test'}}});
 expect(await(await pending).json()).toEqual({changed:true});
 expect((await f.wait(initial.cursor,['mail.send'])).status).toBe(403);
 expect(await(await f.wait(initial.cursor)).json()).toEqual({changed:true});
});

it('does not announce draft creation, draft replacement, or historical imports as incoming mail',async()=>{
 const f=fixture(),initial=await f.eventState();
 const draft={from:[{email:'sender@example.com'}],to:[{email:'reader@example.net'}],subject:'Draft',textBody:[{partId:'text',type:'text/plain'}],bodyValues:{text:{value:'Body'}},mailboxIds:{'folder-drafts':true},keywords:{'$draft':true}};
 const first=await f.call('Email/set',{create:{draft}});expect(first.created.draft.id).toBeTruthy();expect(await f.eventState()).toBe(initial);
 const replacement=await f.call('Email/set',{create:{replacement:{...draft,subject:'Edited draft'}},destroy:[first.created.draft.id]});expect(replacement.created.replacement.id).toBeTruthy();expect(await f.eventState()).toBe(initial);
 await f.raw('historic','From: sender@example.com\r\nSubject: Historic\r\n\r\nBody');
 const imported=await f.call('Email/import',{emails:{historic:{blobId:'historic',mailboxIds:{'folder-inbox':true}}}});expect(imported.created.historic.id).toBeTruthy();expect(await f.eventState()).toBe(initial);
});

it('does not announce incoming mail routed out of the inbox by a rule',async()=>{
 const f=fixture(),initial=await f.eventState();
 const rules=await f.call('Rule/set',{create:{archive:{name:'Archive notices',enabled:true,condition:{subject:'Notice'},actions:{removeMailboxIds:['folder-inbox'],addMailboxIds:['folder-archive']}}}},undefined,undefined,true);
 expect(rules.created.archive.id).toBeTruthy();
 await f.raw('notice','From: sender@example.com\r\nSubject: Notice\r\n\r\nBody');
 const response=await f.ingest('notice','reader@example.net');expect(response.status).toBe(200);expect(await f.eventState()).toBe(initial);
});
