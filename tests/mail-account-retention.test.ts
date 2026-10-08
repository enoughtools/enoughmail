import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MailAccountLifecycle, MailQuotaManager, planRetention } from '../apps/mail/src/server/retention';
import type { MailSqlStorage } from '../apps/mail/src/server/store';
const databases: DatabaseSync[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function fixture(){
  const db=new DatabaseSync(':memory:');databases.push(db);let nesting=0;
  const storage:MailSqlStorage={sql:{exec<T>(sql:string,...bindings:unknown[]):Iterable<T>{const statement=db.prepare(sql);return (statement.columns().length?statement.all(...bindings as any[]):[statement.run(...bindings as any[])]) as T[];}},transactionSync<T>(run:()=>T):T{const name=`tx${++nesting}`;db.exec(`SAVEPOINT ${name}`);try{const result=run();db.exec(`RELEASE ${name}`);return result;}catch(error){db.exec(`ROLLBACK TO ${name}`);db.exec(`RELEASE ${name}`);throw error;}}};
  return {db,storage,quota:new MailQuotaManager(storage),lifecycle:new MailAccountLifecycle(storage)};
}
const actor={id:'owner',actions:['mail.manage']};const day=86400000;
describe('Mail retention and durable account quota',()=>{
  it('expires only current trash/spam membership using exact 30 day deadlines',()=>{
    const start='2026-01-01T00:00:00Z';const now=Date.parse(start)+30*day;
    const plan=planRetention([{id:'trash',mailboxIds:{'folder-trash':true},trashAt:start},{id:'spam',mailboxIds:{'folder-junk':true},junkAt:start},{id:'restored',mailboxIds:{'folder-inbox':true},trashAt:start},{id:'missing',mailboxIds:{'folder-trash':true}},{id:'later',mailboxIds:{'folder-trash':true},trashAt:new Date(now).toISOString()}],{},now);
    expect(plan).toEqual({expiredIds:['trash','spam'],nextDeadline:now+30*day});
    expect(()=>planRetention([],{trashRetentionDays:0},now)).toThrow('Invalid retention days');
  });
  it('counts physical blobs once across restart and reserves capacity before upload',()=>{
    const f=fixture();f.quota.set(100,actor);expect(f.quota.reserveBlob('raw',60,'raw')).toBe(true);expect(f.quota.reserveBlob('raw',60,'raw')).toBe(false);
    expect(f.quota.get()).toMatchObject({used:0,reserved:60,blobCount:1,hardLimit:100});
    expect(()=>f.quota.reserveBlob('attachment',41,'attachment')).toThrow('overQuota');
    f.quota.commitBlob('raw');const restarted=new MailQuotaManager(f.storage);expect(restarted.get()).toMatchObject({used:60,reserved:0,blobCount:1});
    restarted.rollbackBlob('raw');expect(restarted.get().used).toBe(60);
    restarted.reserveBlob('attachment',40,'attachment');restarted.rollbackBlob('attachment');expect(restarted.get()).toMatchObject({used:60,reserved:0});
    expect(()=>restarted.reserveBlob('raw',50,'raw')).toThrow('identity reused');
    restarted.forgetBlob('raw');expect(restarted.get().used).toBe(0);
    restarted.reconcileBlob('legacy',200,'raw');restarted.reconcileBlob('legacy',200,'raw');expect(restarted.get()).toMatchObject({used:200,blobCount:1});expect(()=>restarted.reserveBlob('new',1,'raw')).toThrow('overQuota');
  });
  it('validates managed quota and never assumes a paid storage allowance is an enforced limit',()=>{
    const f=fixture();expect(f.quota.get().hardLimit).toBe(null);
    expect(()=>f.quota.set(100,{id:'reader',actions:['mail.read']})).toThrow('forbidden');
    expect(()=>f.quota.set(-1,actor)).toThrow('Invalid storage limit');
    f.quota.reserveBlob('large',1000,'upload');f.quota.commitBlob('large');f.quota.set(500,actor);
    expect(()=>f.quota.reserveBlob('more',1,'body')).toThrow('overQuota');expect(f.quota.get().used).toBe(1000);
  });
  it('suspends and resumes without deleting data and fences lifecycle commands by revision and receipt',()=>{
    const f=fixture();f.quota.reserveBlob('raw',10,'raw');f.quota.commitBlob('raw');
    const request={id:'suspend',expectedRevision:0,action:'suspend' as const,actor,now:10};
    expect(f.lifecycle.command(request)).toEqual({status:'suspended',revision:1,purgeAfter:null});expect(()=>f.lifecycle.assertActive()).toThrow('disabled');
    expect(f.lifecycle.command({...request,now:20})).toEqual({status:'suspended',revision:1,purgeAfter:null});
    expect(()=>f.lifecycle.command({...request,action:'resume'})).toThrow('ID reused');
    expect(()=>f.lifecycle.command({id:'stale',expectedRevision:0,action:'resume',actor})).toThrow('revisionConflict');
    f.lifecycle.command({id:'resume',expectedRevision:1,action:'resume',actor});f.lifecycle.assertActive();expect(f.quota.get().used).toBe(10);
    expect(f.db.prepare('SELECT count(*) n FROM mail_lifecycle_history').get()?.n).toBe(2);
  });
  it('allows cancel during grace and bounds purge with safe retry after an R2 failure',async()=>{
    const f=fixture();const initial=f.lifecycle.command({id:'delete',expectedRevision:0,action:'requestDeletion',actor,now:0});expect(initial.purgeAfter).toBe(30*day);
    await expect(f.lifecycle.purgeBatch(f.quota,async()=>{},day)).rejects.toThrow('not due');
    f.lifecycle.command({id:'cancel',expectedRevision:1,action:'cancelDeletion',actor,now:day});f.lifecycle.assertActive();
    f.lifecycle.command({id:'delete2',expectedRevision:2,action:'requestDeletion',actor,now:day});
    for(let i=0;i<102;i++){const id=`blob${String(i).padStart(3,'0')}`;f.quota.reserveBlob(id,1,'raw');f.quota.commitBlob(id);}
    const deleted:string[]=[];await expect(f.lifecycle.purgeBatch(f.quota,async(id)=>{if(id==='blob002')throw new Error('R2 unavailable');deleted.push(id);},31*day)).rejects.toThrow('R2 unavailable');
    expect(f.quota.get().blobCount).toBe(100);expect(f.lifecycle.get().status).toBe('purging');
    const result=await new MailAccountLifecycle(f.storage).purgeBatch(f.quota,async(id)=>{deleted.push(id);},31*day);expect(result).toEqual({done:true,deleted:100});expect(new Set(deleted).size).toBe(102);
    expect(()=>f.lifecycle.command({id:'latecancel',expectedRevision:4,action:'cancelDeletion',actor})).toThrow('Invalid lifecycle transition');
    f.lifecycle.finishPurge(31*day);expect(f.lifecycle.get().status).toBe('deleted');expect(f.db.prepare('SELECT count(*) n FROM mail_lifecycle_history').get()?.n).toBe(5);
  });
});
