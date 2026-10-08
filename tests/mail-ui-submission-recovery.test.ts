import {describe,expect,it} from 'vitest';
import {pendingRecovery,recoveryKey,recoveredDraft,definitiveRecoveryRejection,type SubmissionRecoveryRequest,type SubmissionRecoveryResult} from '../apps/mail/src/ui/submission-recovery';
import type {MailSession} from '../apps/mail/src/ui/jmap';
const request:SubmissionRecoveryRequest={submissionId:'attempt',ifInState:'s7',operationId:'01234567-89ab-cdef-0123-456789abcdef'};
const result:SubmissionRecoveryResult={accountId:'a',submissionId:'attempt',oldState:'s7',newState:'s8',emailId:'new-draft',draft:{id:'new-draft',blobId:'retained',threadId:'thread',size:100},originalStatus:'uncertain'};
describe('Retained submission recovery',()=>{
 it('retains exact receipts when final authorization loss may follow a committed recovery',()=>{expect(definitiveRecoveryRejection({confirmed:true,authorizationLost:true})).toBe(false);expect(definitiveRecoveryRejection({confirmed:true})).toBe(false);expect(definitiveRecoveryRejection({confirmed:true,errorType:'stateMismatch'})).toBe(true);});
 it('preserves the exact scoped revision and operation for ambiguous retries without content or authority',()=>{expect(pendingRecovery({...request,emailSnapshot:{body:'private'},authorityProof:'secret'})).toEqual(request);expect(pendingRecovery({submissionId:'attempt',operationId:request.operationId})).toBeNull();});
 it('isolates browser receipt state by verified actor, workspace and account',()=>{const session={organizationId:'org',workspaceId:'workspace',actorId:'alice'} as MailSession;expect(recoveryKey(session,'a')).not.toBe(recoveryKey({...session,actorId:'bob'},'a'));expect(recoveryKey(session,'a')).not.toBe(recoveryKey(session,'b'));});
 it('opens only the newly confirmed draft, never the original submission Email',()=>{expect(recoveredDraft(result,'a',request)).toBe('new-draft');});
 it.each([{accountId:'other'},{submissionId:'different'},{oldState:'changed'},{draft:{...result.draft,id:'original-email'}},{originalStatus:'sent'}])('refuses mismatched recovery results and retains the exact pending request',change=>{expect(()=>recoveredDraft({...result,...change} as SubmissionRecoveryResult,'a',request)).toThrow('did not confirm');expect(pendingRecovery(request)).toEqual(request);});
});
