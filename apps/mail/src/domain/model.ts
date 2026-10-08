export const MAIL_CAPABILITY = 'urn:enough:params:jmap:mail';
export interface MailActor { id: string; actions: string[]; workspaceRole?:string }
export interface MailContext { organizationId: string; workspaceId: string; accountId: string; actor: MailActor; enoughFeatures?:boolean; commandOperationId?:string; transferSource?:{accountId:string;organizationId:string;workspaceId:string;actorId:string;actions:string[];state:string;emails:MailObject[];authorityProof?:{lease:string;jobId:string}}; authorityProof?: { lease: string; jobId: string; credentialId?:string;credentialVersion?:number;expiresAt?:number; actions?:string[] } }
export type MailObject = Record<string, any> & { id: string };
export interface MailChange { sequence: number; type: string; id: string; destroyed: boolean; created?: boolean; threadId?: string; threadCreated?: boolean }
export interface MailState {
  version: 1; context: MailContext; sequence: number; objects: Record<string, Record<string, MailObject>>;
  changes: MailChange[]; receipts: Record<string, { fingerprint: string; response: unknown }>;
  querySnapshots: Record<string, string[]>;
}
export const objectTypes = ['Mailbox', 'Email', 'Identity', 'EmailSubmission', 'Rule', 'Contact', 'Domain', 'Template', 'VacationResponse'] as const;
export function initialMailState(context: MailContext): MailState {
  const objects: MailState['objects'] = Object.fromEntries(objectTypes.map(type => [type, {}]));
  for (const [role, name] of [['inbox','Inbox'],['drafts','Drafts'],['sent','Sent'],['trash','Trash'],['junk','Spam'],['archive','Archive']]) {
    const id = `folder-${role}`;
    objects.Mailbox[id] = { id, name, role, parentId: null, sortOrder: 0, isSubscribed: true };
  }
  objects.Mailbox['folder-quarantine']={id:'folder-quarantine',name:'Quarantine',role:null,parentId:null,sortOrder:6,isSubscribed:true};
  objects.VacationResponse.singleton={id:'singleton',isEnabled:false,fromDate:null,toDate:null,subject:null,textBody:null,htmlBody:null};
  objects.Mailbox['folder-snoozed']={id:'folder-snoozed',name:'Snoozed',role:null,parentId:null,sortOrder:5,isSubscribed:true};
  return { version: 1, context, sequence: 0, objects, changes: [], receipts: {}, querySnapshots: {} };
}
export function token(sequence: number) { return `m${sequence.toString(36)}`; }
export function parseToken(value: unknown): number | null {
  return typeof value === 'string' && /^m[0-9a-z]+$/.test(value) ? parseInt(value.slice(1), 36) : null;
}
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
export function stateError(type: string, description?: string): Record<string, unknown> { return { type, ...(description ? { description } : {}) }; }
export function patchObject(object: MailObject, patch: Record<string, unknown>): MailObject {
  const next = clone(object);
  for (const [path, value] of Object.entries(patch)) {
    if (path === 'id' || path === 'blobId' || path === 'threadId' || path === 'size' || path === 'receivedAt') throw new Error(`Read-only property: ${path}`);
    const segments = path.split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (segments.some(segment => !segment || ['__proto__', 'prototype', 'constructor'].includes(segment))) throw new Error('Unsafe patch path');
    let target: any = next;
    for (const segment of segments.slice(0, -1)) { if (!Object.hasOwn(target, segment) || !target[segment] || typeof target[segment] !== 'object') target[segment] = {}; target = target[segment]; }
    const key = segments.at(-1)!;
    if (segments.length > 1 && value === null) delete target[key]; else target[key] = value;
  }
  return next;
}
