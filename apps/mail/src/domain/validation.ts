import { validateDraftRecipients } from './recipients';
/** Mutation input schemas are product-owned; server facts never come from a client patch. */
const forbiddenSegments = new Set(['__proto__', 'prototype', 'constructor']);
const roots: Record<string, Set<string>> = Object.fromEntries(Object.entries({
  Mailbox: ['color', 'name', 'parentId', 'sortOrder', 'isSubscribed', 'role'],
  Email: ['draftFrom', 'draftRecipients', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'sentAt', 'textBody', 'htmlBody', 'bodyValues', 'attachments', 'inReplyTo', 'references', 'text', 'html'],
  Identity: ['name', 'email', 'replyTo', 'bcc', 'textSignature', 'htmlSignature', 'signatureId'],
  EmailSubmission: ['envelope','emailId', 'identityId', 'undoSeconds', 'sendAt', 'undoStatus'],
  Rule: ['name', 'enabled', 'condition', 'actions', 'stop', 'sortOrder'],
  Contact: ['name', 'email', 'company', 'notes', 'favorite'],
  Domain: ['name', 'zoneId', 'sendingSubdomainId', 'receivingAddress', 'enabled', 'catchAllAccountId', 'addresses'],
  Template: ['name', 'subject', 'text', 'html', 'bodyValues', 'textBody', 'htmlBody'],
  VacationResponse: ['isEnabled', 'fromDate', 'toDate', 'subject', 'textBody', 'htmlBody'],
  Settings: ['favoriteMailboxIds','undoSeconds', 'remoteImages', 'density', 'pageSize', 'confirmDelete', 'showPreview', 'blockedSenders', 'mutedThreads', 'categories', 'savedSearches', 'forwarding', 'vacation', 'followUp', 'signatures'],
}).map(([type, fields]) => [type, new Set(fields)]));
const emailOrganization = new Set(['mailboxIds', 'keywords']);
function segments(path: string): string[] {
  return path.split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}
function safeValue(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error('Mutation value exceeds nesting limit');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (segments(key).some(part => forbiddenSegments.has(part))) throw new Error('Unsafe mutation property');
    safeValue(child, depth + 1);
  }
}
export function validateWritable(type: string, input: unknown, mode: 'create' | 'update', actions: string[]): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Mutation must be an object');
  const allowed = roots[type];
  if (!allowed) throw new Error('Unsupported mutation type');
  safeValue(input);
  for (const [path, value] of Object.entries(input)) {
    const parts = segments(path), root = parts[0];
    if (!root || parts.some(part => !part || forbiddenSegments.has(part)) || !allowed.has(root)) throw new Error(`Read-only or unsupported property: ${path}`);
    if (mode === 'create' && parts.length !== 1) throw new Error('Create properties must not be patch paths');
    if (type === 'Mailbox' && root === 'color' && (parts.length !== 1 || (value !== null && (typeof value !== 'string' || !/^#[a-f0-9]{6}$/i.test(value))))) throw new Error('Use a six-digit hex label color');
    if (type === 'Mailbox' && root === 'role' && (mode !== 'create' || value !== null)) throw new Error('Mailbox roles are server owned');
    if(type==='Email'&&root==='draftRecipients'){if(parts.length!==1)throw new Error('Replace draft recipients as a whole');validateDraftRecipients(value);}
    if(type==='Email'&&root==='draftFrom'&&(parts.length!==1||typeof value!=='string'||value.length>10000||/[\r\n\0]/.test(value)))throw new Error('Invalid draft sending address');
    if (type === 'Email' && root === 'attachments' && parts.length > 1) throw new Error('Replace attachment references as a whole');
    if (type === 'EmailSubmission' && mode === 'create' && root === 'undoStatus') throw new Error('Submission status is server owned');
    if (type === 'EmailSubmission' && mode === 'update' && (path !== 'undoStatus' || value !== 'canceled')) throw new Error('Only pending submissions can be canceled');
    let action = type === 'EmailSubmission' ? 'mail.send'
      : ['Domain', 'Identity', 'VacationResponse', 'Settings'].includes(type) ? 'mail.manage'
      : ['Mailbox', 'Rule'].includes(type) ? 'mail.organize' : 'mail.draft';
    if (type === 'Email' && mode === 'update' && emailOrganization.has(root)) action = 'mail.organize';
    if (!actions.includes(action) && !(action !== 'mail.send' && actions.includes('mail.edit'))) throw new Error(`Permission required: ${action}`);
    // IDs are opaque account-local references, never storage keys or arbitrary paths.
    if (type === 'Email' && root === 'attachments' && Array.isArray(value)) {
      for (const attachment of value) {
        if (!attachment || typeof attachment !== 'object' || typeof attachment.blobId !== 'string' || !/^[\w.-]{1,128}$/.test(attachment.blobId) || 'bytes' in attachment) throw new Error('Invalid attachment reference');
      }
    }
  }
  // Empty creates must still require the corresponding authority.
  if (mode === 'create' && !Object.keys(input).length) throw new Error('Create requires properties');
}
