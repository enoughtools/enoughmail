import type {MailSession} from './jmap';
export interface SubmissionRecoveryRequest { submissionId:string; ifInState:string; operationId:string }
export interface SubmissionRecoveryResult {accountId:string;submissionId:string;oldState:string;newState:string;emailId:string;draft:{id:string;blobId:string;threadId:string;size:number};originalStatus:'failed'|'uncertain'}
export function recoveryKey(session:MailSession,accountId:string):string{return `enough-mail:submission-recovery:${encodeURIComponent(JSON.stringify([session.organizationId,session.workspaceId,session.actorId,accountId]))}`;}
export function pendingRecovery(value:unknown):SubmissionRecoveryRequest|null{
 if(!value||typeof value!=='object')return null;const item=value as Record<string,unknown>;
 if(typeof item.submissionId!=='string'||!item.submissionId||item.submissionId.length>256||typeof item.ifInState!=='string'||!item.ifInState||item.ifInState.length>256||typeof item.operationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.operationId))return null;
 return {submissionId:item.submissionId,ifInState:item.ifInState,operationId:item.operationId};
}
export function recoveredDraft(result:SubmissionRecoveryResult,accountId:string,request:SubmissionRecoveryRequest):string{
 if(result.accountId!==accountId||result.submissionId!==request.submissionId||result.oldState!==request.ifInState||typeof result.newState!=='string'||!result.newState||typeof result.emailId!=='string'||!result.emailId||result.draft?.id!==result.emailId||!['failed','uncertain'].includes(result.originalStatus))throw new Error('The server did not confirm the recovered draft. Retry the same recovery request.');
 return result.emailId;
}

/** Final authorization loss may happen after commit; only a method rejection proves failure. */
export function definitiveRecoveryRejection(error:unknown):boolean{if(!error||typeof error!=='object')return false;const value=error as {confirmed?:boolean;authorizationLost?:boolean;errorType?:unknown};return value.confirmed===true&&value.authorizationLost!==true&&typeof value.errorType==='string';}
