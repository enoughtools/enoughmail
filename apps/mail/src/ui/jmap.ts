import { parseRecipients } from '../domain/recipients';
export interface MailSession {
    username: string;
    actorId:string;
    organizationId:string;
    workspaceId:string;
    apiUrl: string;
    uploadUrl: string;
    downloadUrl: string;
    eventSourceUrl?: string;
    capabilities: Record<string, unknown>;
    accounts: Record<string, {
        name: string;
        isReadOnly: boolean;
        accountCapabilities: Record<string, unknown>;
    }>;
    primaryAccounts: Record<string, string>;
}
export interface Mailbox {
    id: string;
    name: string;
    role: string | null;
    parentId?: string | null;
    color?: string;
    totalEmails: number;
    unreadEmails: number;
}
export interface Address {
    name?: string;
    email: string;
}
export interface BodyPart {
    partId?: string;
    blobId: string;
    name?: string;
    type: string;
    size: number;
    cid?: string | null;
    isInline?: boolean;
    disposition?: string | null;
}
export interface Email {
    id: string;
    threadId: string;
    blobId: string;
    mailboxIds: Record<string, boolean>;
    keywords: Record<string, boolean>;
    from: Address[]|null;
    to: Address[]|null;
    cc?: Address[]|null;
    bcc?: Address[]|null;
    replyTo?: Address[]|null;
    subject: string;
    receivedAt: string;
    preview: string;
    hasAttachment: boolean;
    textBody?: BodyPart[];
    htmlBody?: BodyPart[];
    bodyValues?: Record<string, {
        value: string;
        isTruncated?: boolean;
    }>;
    attachments?: BodyPart[];
    headers?: {
        name: string;
        value: string;
    }[];
    draftRecipients?: {to?:string;cc?:string;bcc?:string};
    /** Raw, possibly incomplete From value retained only on editable drafts. */
    draftFrom?: string;
    /** Recipient recorded by the trusted receiving transport, never a MIME header. */
    deliveryRecipient?: string;
    snoozedUntil?: string | null;
}
export interface Identity {
    verified?: boolean;
    id: string;
    name: string;
    email: string;
    textSignature?: string;
    htmlSignature?: string;
    signatureId?: string | null;
}
export interface IdentityResolveResult {
    accountId: string;
    oldState: string;
    newState: string;
    identity: Identity;
}
export interface GetResult<T> {
    accountId: string;
    state: string;
    list: T[];
    notFound?: string[];
}
export interface SetResult {
    oldState: string;
    newState: string;
    created?: Record<string, {
        id: string;
        blobId?: string;
    }>;
    updated?: Record<string, unknown>;
    destroyed?: string[];
    notCreated?: Record<string, {
        type: string;
        description?: string;
    }>;
    notUpdated?: Record<string, {
        type: string;
        description?: string;
    }>;
    notDestroyed?: Record<string, {
        type: string;
        description?: string;
    }>;
}
export const MAIL_CAP = 'urn:ietf:params:jmap:mail';
export const SUBMISSION_CAP = 'urn:ietf:params:jmap:submission';
export function safeEndpoint(value: string): string { const url = new URL(value, window.location.origin); if (url.origin !== window.location.origin)
    throw new Error('Mail server returned an untrusted endpoint.'); return url.pathname + url.search; }
/** Only a fetch transport failure can open a previously verified offline copy. */
export function canUseOfflineCopy(error:unknown):boolean{return error instanceof TypeError&&(error as {transportFailure?:boolean}).transportFailure===true;}
async function mailFetch(path:RequestInfo|URL,options:RequestInit):Promise<Response>{try{return await fetch(path,options);}catch(error){if(error instanceof DOMException && error.name==='TimeoutError')throw new Error('Mail took too long to respond. Try again.');if(error instanceof TypeError)Object.assign(error,{transportFailure:true});throw error;}}
export class MailClient {
    session!: MailSession;
    onAuthorizationLost?:()=>void;
    states = new Map<string, string>();
    async discover(){
      const response=await mailFetch('/apps/mail/jmap/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000)});
      if(!response.ok){if(response.status===401||response.status===403)this.onAuthorizationLost?.();throw Object.assign(new Error(response.status===401||response.status===403?'Sign in to access your mail.':`Mail session unavailable (${response.status}).`),{confirmed:true,authorizationLost:response.status===401||response.status===403});}
      const candidate=await response.json() as MailSession;
      if(!candidate||typeof candidate!=='object')throw Object.assign(new Error('Mail discovery response is invalid.'),{confirmed:true});
      for(const field of ['actorId','organizationId','workspaceId','apiUrl','uploadUrl','downloadUrl'] as const)if(typeof candidate[field]!=='string'||!candidate[field])throw Object.assign(new Error('Mail session is missing its verified identity or endpoint scope.'),{confirmed:true});
      safeEndpoint(candidate.apiUrl);this.session=candidate;return candidate;
    }
    /** One authorized read envelope, including standard JMAP result references. Never retries mutations. */
    async readBatch(calls: [string, Record<string, unknown>, string][], accountId: string): Promise<Record<string, Record<string, any>>> {
        if (calls.some(([name]) => !/\/(get|query|changes|queryChanges)$/.test(name))) throw new Error('Only reads can be grouped.');
        const readSession=this.session;
        const observedStates=new Map(calls.map(([name])=>{const key=`${accountId}:${name.split('/')[0]}`;return [key,this.states.get(key)];}));
        const response = await mailFetch(safeEndpoint(this.session.apiUrl), {
            method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(20000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ using: Object.keys(this.session.capabilities), methodCalls: calls.map(([name, args, id]) => [name, { ...args, accountId }, id]) }),
        });
        if (!response.ok) {
            const authorizationLost = response.status === 401 || response.status === 403;
            if (authorizationLost) this.onAuthorizationLost?.();
            throw Object.assign(new Error(authorizationLost ? 'Your mail session expired. Sign in again.' : `Mail request failed (${response.status}).`), { authorizationLost, confirmed: authorizationLost });
        }
        const data = await response.json() as { methodResponses: [string, Record<string, any>, string][] };
        const results: Record<string, Record<string, any>> = {};
        for (const [name, , id] of calls) {
            const tuple = data.methodResponses?.find(value => value[2] === id);
            if (!tuple) throw new Error('Mail server returned an incomplete response.');
            if (tuple[0] === 'error') throw Object.assign(new Error(String(tuple[1].description || tuple[1].type || 'Mail request failed.')), { confirmed: true, errorType: tuple[1].type });
            if (tuple[0] !== name) throw new Error('Mail server returned an unexpected response.');
            results[id] = tuple[1];
            const key=`${accountId}:${name.split('/')[0]}`;
            // A speculative read may finish after a confirmed edit or a new session.
            // Do not replace that newer mutation precondition with its old snapshot.
            if (typeof tuple[1].state === 'string' && this.session===readSession && this.states.get(key)===observedStates.get(key)) this.states.set(key, tuple[1].state);
        }
        return results;
    }
    async call<T>(name: string, args: Record<string, unknown>, accountId?: string): Promise<T> {
        const using = Object.keys(this.session.capabilities);
        const mutation = /\/(set|apply|verify|plan|prepare|route|setup|resolve)$/.test(name);
        const entity = name.split('/')[0];
        const state = this.states.get(`${accountId}:${entity}`);
        const payload = { ...args, ...(mutation && !('operationId' in args) ? { operationId: crypto.randomUUID() } : {}), ...(accountId ? { accountId } : {}), ...(mutation && state && !('ifInState' in args) ? { ifInState: state } : {}) };
        const response = await mailFetch(safeEndpoint(this.session.apiUrl), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ using, methodCalls: [[name, payload, 'ui']], ...(mutation ? { requestId: crypto.randomUUID() } : {}) }) });
        if (!response.ok){if(response.status===401||response.status===403)this.onAuthorizationLost?.();
            throw Object.assign(new Error(response.status === 401 || response.status === 403 ? 'Your mail session expired. Sign in again.' : `Mail request failed (${response.status}).`),{authorizationLost:response.status===401||response.status===403,confirmed:response.status===401||response.status===403});}
        const data = await response.json() as {
            methodResponses: [
                string,
                Record<string, unknown>,
                string
            ][];
        };
        const tuple = data.methodResponses?.find(v => v[2] === 'ui');
        if (!tuple)
            throw new Error('Mail server returned an incomplete response.');
        if (tuple[0] === 'error')
            throw Object.assign(new Error(String(tuple[1].description || tuple[1].type || 'Mail request failed.')),{confirmed:tuple[1].type!=='serverFail',errorType:tuple[1].type,submissionNotDispatched:tuple[1].submissionNotDispatched===true});
        const result = tuple[1];
        // A Set response can advance state even when one requested object fails.
        // Retain that confirmed state so the next explicit command can retry.
        const next = result.newState || result.state;
        if (typeof next === 'string')
            this.states.set(`${accountId}:${entity}`, next);
        for (const key of ['notCreated', 'notUpdated', 'notDestroyed']) {
            const failures = Object.values((result[key] || {}) as Record<string, {
                description?: string;
                type: string;
            }>);
            if (failures.length)
                throw Object.assign(new Error(failures.map(v => v.description || v.type).join('; ')),{confirmed:true});
        }
        return result as T;
    }
    async upload(file: File, accountId: string): Promise<BodyPart> { const path = this.session.uploadUrl.replace('{accountId}', encodeURIComponent(accountId)); const response = await mailFetch(safeEndpoint(path), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }); if (!response.ok)
        throw new Error(`Attachment upload failed (${response.status}).`); const data = await response.json(); return { blobId: data.blobId, name: file.name, type: data.type || file.type, size: data.size || file.size }; }
    download(accountId: string, blobId: string, name: string, type: string) { return safeEndpoint(this.session.downloadUrl.replace('{accountId}', encodeURIComponent(accountId)).replace('{blobId}', encodeURIComponent(blobId)).replace('{name}', encodeURIComponent(name)).replace('{type}', encodeURIComponent(type))); }
    async readBlob(accountId:string,part:BodyPart,signal?:AbortSignal):Promise<ArrayBuffer>{
      const response=await mailFetch(this.download(accountId,part.blobId,part.name||'inline-image',part.type),{credentials:'same-origin',cache:'no-store',signal});
      if(!response.ok){if(response.status===401||response.status===403)this.onAuthorizationLost?.();throw new Error(`Embedded image unavailable (${response.status}).`);}
      const limit=5*1024*1024;if(Number(response.headers.get('content-length')||0)>limit)throw new Error('Embedded image exceeds the display limit.');
      const reader=response.body?.getReader();if(!reader)throw new Error('Embedded image response is empty.');const chunks:Uint8Array[]=[];let size=0;
      try{while(true){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>limit){await reader.cancel();throw new Error('Embedded image exceeds the display limit.');}chunks.push(result.value);}}finally{reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes.buffer;
    }
}
export const addresses = parseRecipients;
export function draftCacheKey(session: MailSession, accountId: string) { return `enough-mail:drafts:${encodeURIComponent(JSON.stringify([session.organizationId,session.workspaceId,session.actorId,accountId]))}`; }
