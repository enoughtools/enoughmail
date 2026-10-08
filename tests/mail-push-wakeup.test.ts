import {it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {MailPushWakeups} from '../apps/mail/src/server/push-wakeup';
it('durably retries failed account hints and preserves changes committed during delivery',async()=>{
 const db=new DatabaseSync(':memory:');const storage={sql:{exec<T>(query:string,...args:any[]):Iterable<T>{const s=db.prepare(query);return (s.columns().length?s.all(...args):[s.run(...args)]) as T[];}}};let calls=0,accept=false;let wake:MailPushWakeups;const registry={idFromName:(id:string)=>id,get:()=>({async fetch(){calls++;if(!accept)throw new Error('Unavailable');wake.mark(2);return Response.json({ok:true});}})};
 try{wake=new MailPushWakeups(storage,registry);wake.watch('registry',Date.now()+86400000);expect(wake.next()).toBeUndefined();wake.mark(1);await wake.flush();expect(calls).toBe(1);expect(wake.next()).toBeGreaterThan(Date.now());db.prepare('UPDATE mail_push_watchers SET next_attempt=0').run();accept=true;await wake.flush();expect(calls).toBe(2);expect(wake.next()).toBe(0);}finally{db.close();}
});
