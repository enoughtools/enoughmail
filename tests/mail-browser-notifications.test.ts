import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
it('verifies JMAP push and only notifies once for a new authorized inbox delivery cursor',async()=>{
 const handlers:Record<string,((event:any)=>void)[]>={},shown:any[]=[],posted:any[]=[];let config:any;
 const indexedDB={open(){const request:any={result:{createObjectStore(){},close(){},transaction(){const tx:any={objectStore:()=>({get(){const req:any={};queueMicrotask(()=>{req.result=config;req.onsuccess?.();tx.oncomplete?.();});return req;},put(value:any){const req:any={};queueMicrotask(()=>{config=structuredClone(value);req.onsuccess?.();tx.oncomplete?.();});return req;}})};return tx;}}};queueMicrotask(()=>request.onsuccess());return request;}};
 const fetch=vi.fn(async(_url:any,options:any)=>{const body=JSON.parse(options.body);posted.push(body);return Response.json({methodResponses:[['PushSubscription/set',{updated:{subscription:null}},'verify']]});});
 runInNewContext(readFileSync(new URL('../apps/mail/public/mail-sw.js',import.meta.url),'utf8'),{self:{location:{origin:'https://mail.test'},registration:{showNotification:async(title:any,options:any)=>{shown.push({title,...options});}},clients:{matchAll:async()=>[]},addEventListener(type:string,handler:any){(handlers[type]??=[]).push(handler);}},indexedDB,queueMicrotask,crypto,URL,fetch,Response,caches:{}});
 async function emit(type:string,event:any){const pending:Promise<any>[]=[];for(const handler of handlers[type]||[])handler({...event,waitUntil:(promise:Promise<any>)=>pending.push(promise)});await Promise.all(pending);}
 await emit('message',{data:{type:'MAIL_NOTIFICATIONS_CONFIG',config:{enabled:true,apiUrl:'https://mail.test/apps/mail/jmap/api',states:{a:'d1'}}},ports:[]});
 await emit('push',{data:{json:()=>({'@type':'PushVerification',pushSubscriptionId:'subscription',verificationCode:'code'})}});expect(posted[0].methodCalls[0][0]).toBe('PushSubscription/set');expect(posted[0].methodCalls[0][1].update.subscription.verificationCode).toBe('code');expect(shown).toHaveLength(1);
 const state=(changed:any)=>emit('push',{data:{json:()=>({'@type':'StateChange',changed})}});
 await state({a:{Email:'draft-2',EmailDelivery:'d1'},unknown:{EmailDelivery:'d2'}});expect(shown).toHaveLength(1);
 await state({a:{EmailDelivery:'d2'}});await state({a:{EmailDelivery:'d2'}});expect(shown).toHaveLength(2);expect(shown[1].title).toBe('New mail in Enough Mail');expect(shown[1].body).not.toContain('sender');const status:any[]=[];await emit('message',{data:{type:'MAIL_NOTIFICATIONS_STATUS'},ports:[{postMessage:(value:any)=>status.push(value)}]});expect(status[0].lastNotificationAt).toBeGreaterThan(0);
 await emit('message',{data:{type:'MAIL_NOTIFICATIONS_CONFIG',config:{enabled:false}},ports:[]});await state({a:{EmailDelivery:'d3'}});expect(shown).toHaveLength(2);
});
