import RecipientInput from './RecipientInput';
import SenderInput from './SenderInput';
import { completeRecipients, validRecipient } from '../domain/recipients';
import './compose.css';
import { Input } from '@rebnz/enough-ui/input';
import { Textarea } from '@rebnz/enough-ui/textarea';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@rebnz/enough-ui/button';
import { Label } from '@rebnz/enough-ui/label';
import { ButtonGroup } from '@rebnz/enough-ui/button-group';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel } from '@rebnz/enough-ui/dropdown-menu';
import { Attachment, AttachmentContent, AttachmentTitle, AttachmentDescription, AttachmentActions, AttachmentAction } from '@rebnz/enough-ui/attachment';
import { Bold, Italic, Underline, List, ListOrdered, Paperclip, ImagePlus, Clock, FileText, PenLine, Link2, Trash2, Send, ChevronDown, Maximize2, Minimize2, Minus } from 'lucide-react';
import {useDialog} from './use-dialog';
import { discardComposeDraft, recoverNewDraftConflict, saveComposeDraft, chooseSendingIdentity, chooseSendingAddress, resolveComposeIdentity, draftReplacementArgs, createComposeOperation, isConfirmedDraftConflict, isConfirmedRejection, isConfirmedSubmissionRejection, type DraftBaseline, type PendingComposeOperation } from './compose-operations';
import { addresses, draftCacheKey, type BodyPart, type Email, type GetResult, type Identity, type Mailbox, type MailClient, type SetResult } from './jmap';
import { cleanComposeHtml as cleanEditorHtml, composeTextHtml as textHtml, composePlainText, quoteMessage, replySubject, forwardSubject, replaceComposeSignature } from './compose-content';
import { messageHtml, messagePlainText } from './message-body';

interface Props {
  client: MailClient; accountId: string; undoSeconds?:number; mailboxes: Mailbox[]; identities: Identity[];
  reply?: Email; mode?: 'reply' | 'replyAll' | 'forward'; draft?: Email; recoveryId?: string; onClose: () => void; onSaved: () => void;
  onSubmitted: (submissionId: string, draftId?: string) => void;
  docked?: boolean;
  suggestedContacts?: {name?:string;email:string}[];
  onSetupDomain?: () => void;
  onManageTemplates?: () => void;
  onManageSignatures?: () => void;
}
interface Fields { identityId: string; fromEmail: string; signatureId?: string; to: string; cc: string; bcc: string; subject: string; body: string; attachments: BodyPart[]; sendAt: string; rich?: boolean; html?: string; replyThread?: { inReplyTo: string[]; references: string[] }; }
interface Signature { id: string; name: string; text: string; html: string; }
interface Recovery { draftBaseline?: DraftBaseline; sourceBlobId?:string; sourceEmailId?:string; fields: Fields; emailId?: string; pendingDraft?: PendingComposeOperation; pendingSubmission?: PendingComposeOperation; pendingIdentity?: PendingComposeOperation; pendingDiscard?: PendingComposeOperation; conflicted?: boolean; conflictBackup?: Fields; }
interface Contact { name?: string; email?: string; emails?: (string | { value?: string; email?: string })[]; }
const formatAddresses = (items?: { name?: string; email: string }[]|null) => (items || []).map(item => item.email).join(', ');
const messageIds = (email: Email | undefined, property: 'messageId' | 'inReplyTo' | 'references', header: string): string[] => {
  const value = (email as (Email & Record<string, unknown>) | undefined)?.[property];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return [value];
  return (email?.headers?.find(item => item.name.toLowerCase() === header)?.value.match(/<([^>]+)>/g) || []).map(item => item.slice(1, -1));
};
const replyTargets = (email: Email) => email.replyTo?.length ? email.replyTo : email.from;
const replyThread = (email: Email) => ({ inReplyTo: messageIds(email, 'messageId', 'message-id'), references: [...messageIds(email, 'references', 'references'), ...messageIds(email, 'messageId', 'message-id')] });
const plainBody = (email?: Email) => {
  const text = email ? messagePlainText(email) : '';
  if (text) return text;
  const html = email ? messageHtml(email) : '';
  if (!html) return '';
  const template = document.createElement('template'); template.innerHTML = html;
  template.content.querySelectorAll('script,style,iframe,object,embed,svg,math').forEach(node => node.remove());
  template.content.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  template.content.querySelectorAll('p, div, li').forEach(node => node.append('\n'));
  return template.content.textContent || '';
};

export default function Compose({ client, accountId, undoSeconds=10, mailboxes, identities, reply, mode = 'reply', draft, recoveryId: recoveryOverride, onClose, onSaved, onSubmitted, onSetupDomain, onManageTemplates, onManageSignatures, suggestedContacts=[], docked=false }: Props) {
  const [expanded,setExpanded]=useState(false),[minimized,setMinimized]=useState(false);
  const dialogRef=useRef<HTMLElement>(null);useDialog(dialogRef, false);
  const cacheKey = draftCacheKey(client.session, accountId);
  const recoveryId = recoveryOverride || draft?.id || (reply ? `reply:${reply.id}` : 'new');
  const serverInitialFields=useRef<Fields|null>(null);
  const recoveredLocally = useRef(false);
  const initial = (): Recovery => {
    const identity = chooseSendingIdentity(identities, draft, mode === 'forward' ? undefined : reply);
    const fields: Fields = {
      identityId: identity?.id || '', fromEmail: chooseSendingAddress(identities, draft, mode === 'forward' ? undefined : reply), to: draft?.draftRecipients?.to ?? formatAddresses(draft?.to || (reply ? replyTargets(reply) : undefined)),
      cc: draft?.draftRecipients?.cc ?? formatAddresses(draft?.cc), bcc: draft?.draftRecipients?.bcc ?? formatAddresses(draft?.bcc),
      subject: draft?.subject || (reply ? replySubject(reply.subject) : ''),
      body: draft ? plainBody(draft) : `${identity?.textSignature ? `\n\n${identity.textSignature}` : ''}${reply ? `\n\nOn ${new Date(reply.receivedAt).toLocaleString()}, ${formatAddresses(reply.from)} wrote:\n${plainBody(reply).split('\n').map(line => `> ${line}`).join('\n')}` : ''}`,
      attachments: draft?.attachments || [], sendAt: '', rich: draft ? !!draft.htmlBody?.length : true, html: cleanEditorHtml(draft?.htmlBody?.map(part => draft.bodyValues?.[part.partId || '']?.value || '').join('') || ''),
      replyThread: draft ? { inReplyTo: messageIds(draft, 'inReplyTo', 'in-reply-to'), references: messageIds(draft, 'references', 'references') } : reply ? replyThread(reply) : undefined,
    };
    if (!draft) {
      const signature = cleanEditorHtml(identity?.htmlSignature || textHtml(identity?.textSignature || ''),false,true);
      const quoted = reply ? quoteMessage(reply, mode === 'forward' ? 'forward' : 'reply', plainBody(reply)) : undefined;
      fields.html = cleanEditorHtml(`<p><br></p>${signature ? `<div data-mail-signature="true">${signature}</div>` : ''}${quoted?.html || ''}`);
      fields.body = `${identity?.textSignature || composePlainText(signature)}${quoted ? `\n\n${quoted.body}` : ''}`;
      fields.attachments = reply?.attachments?.filter(part => part.cid || part.disposition === 'inline') || [];
    }
    if (reply && !draft && mode === 'replyAll') {
      const own = new Set([...identities.map(item => item.email.toLowerCase()), fields.fromEmail.toLowerCase()]);
      const recipients = [...(replyTargets(reply) || []), ...(reply.to || []), ...(reply.cc || [])];
      fields.to = formatAddresses(recipients.filter((address, index) => !own.has(address.email.toLowerCase()) && recipients.findIndex(item => item.email.toLowerCase() === address.email.toLowerCase()) === index));
    }
    if (reply && !draft && mode === 'forward') {
      fields.to = ''; fields.cc = ''; fields.bcc = ''; fields.replyThread = undefined;
      fields.subject = forwardSubject(reply.subject);
      fields.attachments = reply.attachments || [];
      fields.body = `${identity?.textSignature || ''}\n\n---------- Forwarded message ----------\nFrom: ${formatAddresses(reply.from)}\nDate: ${new Date(reply.receivedAt).toLocaleString()}\nSubject: ${reply.subject}\nTo: ${formatAddresses(reply.to)}\n\n${plainBody(reply)}`;
    }
    serverInitialFields.current=fields;
    try {
      const entries = JSON.parse(localStorage.getItem(cacheKey) || '{}');
      const recovered = entries[recoveryId] as Recovery | undefined;
      const storedBackup = entries[`${recoveryId}:conflict-backup`]?.fields as Fields | undefined;
      const normalizeBackup = (value: Fields): Fields => ({ ...value, fromEmail: value.fromEmail ?? identities.find(item => item.id === value.identityId)?.email ?? '' });
      const backup = storedBackup && normalizeBackup(storedBackup);
      if (recovered?.conflictBackup) recovered.conflictBackup = normalizeBackup(recovered.conflictBackup);
      if (recovered?.fields && typeof recovered.fields.body === 'string' && Array.isArray(recovered.fields.attachments)){recovered.fields = { ...recovered.fields, fromEmail: recovered.fields.fromEmail ?? identities.find(item => item.id === recovered.fields.identityId)?.email ?? (draft ? fields.fromEmail : '') }; recoveredLocally.current = true;if(draft&&!recovered.pendingDraft&&!recovered.pendingSubmission&&!recovered.pendingDiscard&&(recovered.sourceEmailId!==draft.id || recovered.sourceBlobId!==draft.blobId))return {fields,emailId:draft.id,conflicted:true,conflictBackup:recovered.fields};return recoverNewDraftConflict({ ...recovered, conflictBackup: recovered.conflictBackup || backup }, draft?.id);}
      if (backup && typeof backup.body === 'string' && Array.isArray(backup.attachments)) return { fields, emailId: draft?.id, conflictBackup: backup };
    } catch { /* The server draft remains usable if local storage is unavailable. */ }
    return { fields, emailId: draft?.id };
  };
  const [recovery] = useState(initial);
  const activeRecoveryId = useRef(recoveryId);
  const lastStoredRecoveryId = useRef(recoveryId);
  const [fields, setFields] = useState(recovery.fields);
  const [status, setStatus] = useState(draft ? 'Draft loaded' : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [localAvailable, setLocalAvailable] = useState(true);
  const [templates, setTemplates] = useState<{ id: string; name: string; subject?: string; body?: string; text?: string; textBody?: string }[]>([]);
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [contacts, setContacts] = useState<{ name: string; email: string }[]>([]);
  const [sendingDomains, setSendingDomains] = useState<string[]>([]);
  const [resolvedIdentities, setResolvedIdentities] = useState<Identity[]>([]);
  const availableIdentities = [...resolvedIdentities, ...identities.filter(identity => !resolvedIdentities.some(item => item.id === identity.id))];
  const senderEdited = useRef(false);
  const richEditor = useRef<HTMLDivElement>(null);
  const inlinePreviews = useRef(new Map<string, string>());
  const latest = useRef(fields);
  const emailId = useRef(recovery.emailId);
  const draftBaseline = useRef<DraftBaseline | undefined>(recovery.draftBaseline || (draft ? { id: draft.id, blobId: draft.blobId, mailboxIds: draft.mailboxIds, keywords: draft.keywords } : undefined));
  const draftMetadata = useRef(draft ? { mailboxIds: draft.mailboxIds, keywords: draft.keywords } : undefined);
  const pendingDraft = useRef(recovery.pendingDraft);
  const conflicted = useRef(!!recovery.conflicted);
  const [draftConflict, setDraftConflict] = useState(!!recovery.conflicted);
  const [conflictBackup, setConflictBackup] = useState<Fields | undefined>(recovery.conflictBackup);
  const conflictBackupRef = useRef(recovery.conflictBackup);
  const pendingSubmission = useRef(recovery.pendingSubmission);
  const pendingIdentity = useRef(recovery.pendingIdentity);
  const [senderUncertain, setSenderUncertain] = useState(!!recovery.pendingIdentity);
  const pendingDiscard = useRef(recovery.pendingDiscard);
  const [discardUncertain, setDiscardUncertain] = useState(!!recovery.pendingDiscard);
  const [submissionUncertain, setSubmissionUncertain] = useState(!!recovery.pendingSubmission);
  const saved = useRef(draft&&!recovery.pendingDraft&&!recovery.pendingSubmission?JSON.stringify(serverInitialFields.current||recovery.fields):'');
  const saving = useRef<Promise<string> | null>(null);
  const mounted = useRef(true);
  const submitted = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  latest.current = fields;

  const storeRecovery = (clear = false) => {
    try {
      const entries = JSON.parse(localStorage.getItem(cacheKey) || '{}');
      if (lastStoredRecoveryId.current !== activeRecoveryId.current) delete entries[lastStoredRecoveryId.current];
      lastStoredRecoveryId.current = activeRecoveryId.current;
      if (conflictBackupRef.current) entries[`${activeRecoveryId.current}:conflict-backup`] = { fields: conflictBackupRef.current };
      if (clear) delete entries[activeRecoveryId.current];
      else entries[activeRecoveryId.current] = {draftBaseline:draftBaseline.current,sourceBlobId:draftBaseline.current?.blobId,sourceEmailId:emailId.current, fields: latest.current, emailId: emailId.current, pendingDraft: pendingDraft.current, pendingSubmission: pendingSubmission.current, pendingIdentity: pendingIdentity.current, pendingDiscard: pendingDiscard.current, conflicted: conflicted.current, conflictBackup: conflictBackupRef.current, updatedAt: new Date().toISOString() };
      localStorage.setItem(cacheKey, JSON.stringify(entries));
      if (mounted.current) setLocalAvailable(true);
    } catch { if (mounted.current) setLocalAvailable(false); }
  };
  const save = async (): Promise<string> => {
    if (saving.current) {
      await saving.current;
      if (saved.current === JSON.stringify(latest.current) && emailId.current) return emailId.current;
      return save();
    }
    const operation = async () => {
      if (conflicted.current) throw new Error('The server draft changed. Keep your edits as a new draft or reload the server draft.');
      if (pendingSubmission.current) throw new Error('Confirm the pending send before changing this draft.');
      if (pendingDiscard.current) throw new Error('Confirm the pending discard before changing this draft.');
      const snapshot = latest.current;
      const fingerprint = JSON.stringify(snapshot);
      if (saved.current === fingerprint && emailId.current) return emailId.current;
      const draftMailbox = mailboxes.find(box => box.role === 'drafts');
      if (!draftMailbox) throw new Error('This account needs a Drafts mailbox before you can save or send.');
      const identity = availableIdentities.find(item => item.email.toLowerCase() === snapshot.fromEmail.trim().toLowerCase());
      if (mounted.current) setStatus('Saving draft…');
      const content = {
        mailboxIds: draftMetadata.current?.mailboxIds || { [draftMailbox.id]: true },
        keywords: { ...(draftMetadata.current?.keywords || {}), $draft: true },
        from: validRecipient(snapshot.fromEmail.trim()) ? [{ ...(identity?.name ? { name: identity.name } : {}), email: snapshot.fromEmail.trim() }] : [],
        draftFrom: snapshot.fromEmail,
        to: completeRecipients(snapshot.to), cc: completeRecipients(snapshot.cc), bcc: completeRecipients(snapshot.bcc),
        draftRecipients: {to:snapshot.to,cc:snapshot.cc,bcc:snapshot.bcc},
        subject: snapshot.subject, bodyValues: { text: { value: snapshot.body }, ...(snapshot.rich ? { html: { value: cleanEditorHtml(snapshot.html || textHtml(snapshot.body), true) } } : {}) },
        textBody: [{ partId: 'text', type: 'text/plain' }], htmlBody: snapshot.rich ? [{ partId: 'html', type: 'text/html' }] : [], attachments: snapshot.attachments,
        inReplyTo: snapshot.replyThread?.inReplyTo || [], references: snapshot.replyThread?.references || [],
      };
      const replay = !!pendingDraft.current;
      let operation = pendingDraft.current || createComposeOperation(draftReplacementArgs(content, emailId.current), fingerprint, client.states.get(`${accountId}:Email`));
      pendingDraft.current = operation; storeRecovery();
      let result: SetResult;
      try { const savedDraft = await saveComposeDraft<SetResult>(client, accountId, operation, next => { pendingDraft.current = next; storeRecovery(); }, replay, draftBaseline.current); operation = savedDraft.operation; result = savedDraft.result; }
      catch (cause) {
        if (isConfirmedRejection(cause)) {
          pendingDraft.current = undefined;
          if (emailId.current && isConfirmedDraftConflict(cause)) {
            conflicted.current = true; setDraftConflict(true);
            setStatus('Server draft changed; autosave paused');
          }
          storeRecovery();
        }
        throw cause;
      }
      const replacementId = result.created?.compose?.id || (operation.args.update && emailId.current && result.updated && Object.hasOwn(result.updated, emailId.current) ? emailId.current : undefined);
      if (!replacementId) throw new Error('The mail server did not confirm the saved draft. Retry to recover the same operation.');
      const created = result.created?.compose;
      if (!created?.blobId) throw new Error('The server has not confirmed the complete draft receipt. Retry to recover the same saved draft.');
      const savedContent = (operation.args.create as { compose: { mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> } }).compose;
      draftBaseline.current = { id: replacementId, blobId: created.blobId, mailboxIds: savedContent.mailboxIds, keywords: savedContent.keywords };
      emailId.current = replacementId;
      activeRecoveryId.current = replacementId;
      saved.current = operation.fingerprint;
      pendingDraft.current = undefined;
      storeRecovery();
      if (mounted.current) { setStatus('Draft saved'); setError(''); }
      onSavedRef.current();
      if (saved.current !== JSON.stringify(latest.current)) return operationNext();
      return emailId.current;
    };
    const operationNext = async (): Promise<string> => { saving.current = null; return save(); };
    const pending = operation();
    saving.current = pending;
    try { return await pending; } finally { if (saving.current === pending) saving.current = null; }
  };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (submitted.current) return;
    storeRecovery();
    if (busy || uploading || pendingIdentity.current || pendingSubmission.current || pendingDiscard.current || conflicted.current) return;
    if (!emailId.current && !pendingDraft.current && JSON.stringify(fields) === JSON.stringify(serverInitialFields.current)) return;
    if(emailId.current&&!pendingDraft.current&&saved.current===JSON.stringify(fields))return;
    const timeout = window.setTimeout(() => { void save().catch(cause => { if (mounted.current) { setError(cause instanceof Error ? cause.message : 'Could not save draft.'); setStatus('Draft not saved to server'); } }); }, 1200);
    return () => window.clearTimeout(timeout);
  }, [fields, busy, uploading, draftConflict, discardUncertain]);
  useEffect(() => {
    let active = true;
    void client.call<GetResult<Contact>>('Contact/get', {}, accountId).then(result => {
      if (!active) return;
      setContacts(result.list.flatMap(contact => {
        const values = contact.emails || (contact.email ? [contact.email] : []);
        return values.flatMap(value => {
          const email = typeof value === 'string' ? value : value.value || value.email;
          return email ? [{ name: contact.name || '', email }] : [];
        });
      }));
    }).catch(() => { /* Contacts are optional; manual recipient entry always works. */ });
    void client.call<GetResult<{ id: string; name: string; subject?: string; body?: string; text?: string; textBody?: string }>>('Template/get', {}, accountId).then(result => { if (active) setTemplates(result.list); }).catch(() => { /* Composing without templates remains available. */ });
    void client.call<{ settings?: { signatures?: Signature[] } }>('Settings/get', {}, accountId).then(result => {
      if (!active) return;
      const library = result.settings?.signatures || [];
      setSignatures(library);
      const selected = availableIdentities.find(identity => identity.id === latest.current.identityId);
      const signature = library.find(item => item.id === selected?.signatureId);
      if (signature && !draft && !recoveredLocally.current && latest.current.html === serverInitialFields.current?.html) {
        const html = replaceComposeSignature(latest.current.html || textHtml(latest.current.body), signature.html || textHtml(signature.text));
        const next = { ...latest.current, signatureId: signature.id, html, body: composePlainText(html) };
        serverInitialFields.current = next;
        setFields(next);
      }
    }).catch(() => { /* Saved identities retain their legacy signature when the library is unavailable. */ });
    void client.call<GetResult<{ name: string; enabled?: boolean; sendingVerified?: boolean }>>('Domain/get', {}, accountId).then(result => {
      if (!active) return;
      const domains = result.list.filter(domain => domain.enabled !== false && domain.sendingVerified === true).map(domain => domain.name);
      setSendingDomains(domains);
      if (!draft && reply && mode !== 'forward' && !recoveredLocally.current && !senderEdited.current) {
        const fromEmail = chooseSendingAddress(identities, undefined, reply, domains);
        const identityId = identities.find(identity => identity.email.toLowerCase() === fromEmail.toLowerCase())?.id || '';
        const own = new Set([...identities.map(identity => identity.email.toLowerCase()), fromEmail.toLowerCase()]);
        const updateRecipients = mode === 'replyAll' && latest.current.to === serverInitialFields.current?.to;
        const candidates = [...(replyTargets(reply) || []), ...(reply.to || []), ...(reply.cc || [])];
        const to = updateRecipients ? formatAddresses(candidates.filter((address, index) => !own.has(address.email.toLowerCase()) && candidates.findIndex(item => item.email.toLowerCase() === address.email.toLowerCase()) === index)) : latest.current.to;
        const next = { ...latest.current, fromEmail, identityId, to };
        latest.current = next; setFields(next);
        // Only refresh automatic defaults, retaining the original content baseline
        // so edits made while domain suggestions load still trigger autosave.
        if (serverInitialFields.current) serverInitialFields.current = { ...serverInitialFields.current, fromEmail, identityId, ...(updateRecipients ? { to } : {}) };
      }
    }).catch(() => { /* Existing addresses and server validation remain available if domain suggestions cannot load. */ });
    void client.call<GetResult<Identity>>('Identity/get', {}, accountId).then(result => {
      if (active) setResolvedIdentities(previous => [...result.list, ...previous.filter(identity => !result.list.some(item => item.id === identity.id))]);
      // Suggestions may arrive after typing or recovery; the raw From stays put.
    }).catch(() => { /* Cached suggestions remain usable; Send always validates the current address. */ });
    return () => { active = false; };
  }, [client, accountId]);

  useEffect(() => {
    if (fields.rich && richEditor.current && document.activeElement !== richEditor.current) richEditor.current.innerHTML = cleanEditorHtml(fields.html || textHtml(fields.body));
  }, [fields.rich, fields.html]);
  useEffect(() => {
    const abort = new AbortController();
    const show = (cid: string, url: string) => {
      for (const image of richEditor.current?.querySelectorAll<HTMLImageElement>('img') || []) {
        if ((image.getAttribute('data-mail-inline-cid') || image.getAttribute('src')) === 'cid:' + cid) { image.setAttribute('data-mail-inline-cid', 'cid:' + cid); image.src = url; }
      }
    };
    for (const part of fields.attachments) {
      if (!part.cid || !/^image\/(png|jpeg|gif|webp)$/i.test(part.type)) continue;
      const cid = part.cid.replace(/^<|>$/g, '');
      const known = inlinePreviews.current.get(part.blobId);
      if (known) show(cid, known);
      else void client.readBlob(accountId, part, abort.signal).then(bytes => {
        if (abort.signal.aborted) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: part.type }));
        const previous = inlinePreviews.current.get(part.blobId); if (previous) URL.revokeObjectURL(previous);
        inlinePreviews.current.set(part.blobId, url); show(cid, url);
      }).catch(() => { /* The original CID and attachment remain intact if a preview is unavailable. */ });
    }
    return () => abort.abort();
  }, [fields.attachments, fields.html, fields.rich, client, accountId]);
  useEffect(() => () => { for (const url of inlinePreviews.current.values()) URL.revokeObjectURL(url); }, []);

  const change = <K extends keyof Fields>(key: K, value: Fields[K]) => setFields(previous => ({ ...previous, [key]: value, ...(key === 'body' && !previous.rich ? { html: textHtml(value as string) } : {}) }));
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Mail request failed.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const confirmSender = async (): Promise<Identity> => {
    let identity: Identity;
    try {
      identity = await resolveComposeIdentity<Identity>(client, accountId, latest.current.fromEmail, operation => {
        pendingIdentity.current = operation; storeRecovery();
      }, pendingIdentity.current);
    } catch (cause) {
      if (isConfirmedRejection(cause) || !pendingIdentity.current) { setSenderUncertain(false); throw cause; }
      setSenderUncertain(true);
      throw new Error(`The sending address could not be confirmed. Your message has not been sent. Retry to confirm the same address. ${cause instanceof Error ? cause.message : ''}`);
    }
    setSenderUncertain(false);
    setResolvedIdentities(previous => [...previous.filter(item => item.id !== identity.id), identity]);
    latest.current = { ...latest.current, fromEmail: identity.email, identityId: identity.id };
    setFields(latest.current); storeRecovery();
    if (mounted.current) setStatus('Sending address confirmed; message not sent yet');
    return identity;
  };
  const send = () => run(async () => {
    if (submitted.current) throw new Error('This message has already been submitted.');
    const firstAttempt = !pendingSubmission.current;
    if (!pendingSubmission.current) {
      if (!validRecipient(latest.current.fromEmail.trim())) throw new Error('Enter a complete sending email address.');
      const recipients = [...addresses(latest.current.to), ...addresses(latest.current.cc), ...addresses(latest.current.bcc)];
      if (!recipients.length || recipients.some(address => !validRecipient(address.email))) throw new Error('Enter valid recipient email addresses, separated by commas.');
      if (latest.current.sendAt && new Date(latest.current.sendAt).getTime() <= Date.now()) throw new Error('Choose a future date and time for scheduled sending.');
      const identity = await confirmSender();
      const id = await save();
      const args = { create: { compose: { emailId: id, identityId: identity.id, undoSeconds, ...(latest.current.sendAt ? { sendAt: new Date(latest.current.sendAt).toISOString() } : {}) } } };
      const sendingState = await client.call<GetResult<unknown>>('EmailSubmission/get', { ids: [] }, accountId);
      if (!sendingState.state) throw new Error('Refresh your mail session before sending this message.');
      pendingSubmission.current = createComposeOperation(args, JSON.stringify([id, latest.current]), sendingState.state);
      storeRecovery();
    }
    setSubmissionUncertain(true);
    let result: SetResult;
    try { result = await client.call<SetResult>('EmailSubmission/set', pendingSubmission.current.args, accountId); }
    catch (cause) {
      if (isConfirmedSubmissionRejection(cause, firstAttempt)) {
        pendingSubmission.current = undefined; setSubmissionUncertain(false); storeRecovery();
        throw new Error(`Message was not submitted: ${cause instanceof Error ? cause.message : 'Server rejected sending.'}`);
      }
      throw new Error(`Sending outcome is unconfirmed. ${cause instanceof Error ? cause.message : 'The request could not be confirmed.'} Retry send confirmation to recover the same submission; no new send will be created.`);
    }
    const submissionId = result.created?.compose?.id;
    if (!submissionId) throw new Error('Sending outcome is unconfirmed. Retry send confirmation to recover the same submission.');
    submitted.current = true;
    pendingSubmission.current = undefined;
    storeRecovery(true);
    onSubmitted(submissionId, emailId.current);
  });
  const keepAsNewDraft = (source = latest.current) => run(async () => {
    if (pendingDraft.current || pendingIdentity.current || pendingSubmission.current || pendingDiscard.current) throw new Error('Confirm the pending operation before creating a copy.');
    // Refresh only for a new create, never to rebase an update onto someone else's edits.
    await client.call<GetResult<Email>>('Email/get', { ids: [] }, accountId);
    emailId.current = undefined; draftBaseline.current = undefined; draftMetadata.current = undefined; saved.current = '';
    source = { ...source, fromEmail: source.fromEmail ?? availableIdentities.find(identity => identity.id === source.identityId)?.email ?? '' };
    latest.current = source; setFields(source);
    conflicted.current = false; setDraftConflict(false); setError(''); storeRecovery();
    await save();
  });
  const reloadServerDraft = () => run(async () => {
    if (!emailId.current) throw new Error('No saved server draft is available; keep your edits as a new draft.');
    if (pendingDraft.current || pendingIdentity.current || pendingSubmission.current || pendingDiscard.current) throw new Error('Confirm the pending operation before reloading.');
    conflictBackupRef.current = structuredClone(latest.current); setConflictBackup(conflictBackupRef.current); storeRecovery();
    const result = await client.call<GetResult<Email>>('Email/get', { ids: [emailId.current], fetchAllBodyValues: true }, accountId);
    const server = result.list[0];
    if (!server) throw new Error('The server draft was removed. Your local edits are preserved; keep them as a new draft.');
    if (!server.keywords?.$draft) throw new Error('This message is no longer an editable draft. Your local edits are preserved; keep them as a new draft.');
    const identity = chooseSendingIdentity(identities, server);
    const replacement: Fields = {
      identityId: identity?.id || '', fromEmail: chooseSendingAddress(identities, server), to: server.draftRecipients?.to ?? formatAddresses(server.to), cc: server.draftRecipients?.cc ?? formatAddresses(server.cc), bcc: server.draftRecipients?.bcc ?? formatAddresses(server.bcc),
      subject: server.subject, body: plainBody(server), attachments: server.attachments || [], sendAt: '', rich: !!server.htmlBody?.length,
      html: cleanEditorHtml(server.htmlBody?.map(part => server.bodyValues?.[part.partId || '']?.value || '').join('') || ''),
      replyThread: { inReplyTo: messageIds(server, 'inReplyTo', 'in-reply-to'), references: messageIds(server, 'references', 'references') },
    };
    draftBaseline.current = { id: server.id, blobId: server.blobId, mailboxIds: server.mailboxIds, keywords: server.keywords };
    draftMetadata.current = { mailboxIds: server.mailboxIds, keywords: server.keywords };
    latest.current = replacement; setFields(replacement); saved.current = JSON.stringify(replacement);
    conflicted.current = false; setDraftConflict(false); setStatus('Server draft loaded; previous local edits preserved'); setError(''); storeRecovery();
  });

  const attach = async (files: FileList | File[] | null, inline=false) => {
    if (!files?.length) return;
    setUploading(true); setError('');
    try {
      for (const file of Array.from(files)) {
        if(inline&&!/^image\/(png|jpeg|gif|webp)$/i.test(file.type))throw new Error('Choose a PNG, JPEG, GIF or WebP image.');
        const uploaded = await client.upload(file, accountId);const cid=inline?`${crypto.randomUUID()}@enoughmail`:undefined;const part=inline?{...uploaded,cid,disposition:'inline'}:uploaded;
        setFields(previous => ({ ...previous, attachments: [...previous.attachments, part],...(inline?{rich:true,html:`${previous.html||textHtml(previous.body)}<p><img src="cid:${cid}" alt="Embedded image"></p>`}:{}) }));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Attachment upload failed.'); }
    finally { setUploading(false); }
  };
  const switchSender = (fromEmail: string) => {
    senderEdited.current = true;
    const identity = availableIdentities.find(item => item.email.toLowerCase() === fromEmail.trim().toLowerCase());
    const signature = signatures.find(item => item.id === identity?.signatureId);
    setFields(current => {
      // Keep an explicitly chosen signature while typing a custom address.
      if (!identity) return { ...current, fromEmail, identityId: '' };
      const html = replaceComposeSignature(current.rich ? current.html || textHtml(current.body) : textHtml(current.body), signature?.html || identity.htmlSignature || textHtml(signature?.text || identity.textSignature || ''));
      return { ...current, fromEmail, identityId: identity.id, signatureId: signature?.id, body: composePlainText(html), html };
    });
  };

  useEffect(() => {
    const target = dialogRef.current?.querySelector<HTMLElement>(reply ? '[aria-label="Message"]' : '[aria-label="To"]');
    target?.focus();
    if (target instanceof HTMLTextAreaElement && reply) target.setSelectionRange(0, 0);
  }, []);

  const [showCopies, setShowCopies] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [showFormatting, setShowFormatting] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const linkSelection = useRef<Range | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [replyMode, setReplyMode] = useState<'reply' | 'replyAll' | 'forward' | 'attachment'>(mode);
  const fileInput = useRef<HTMLInputElement>(null), imageInput = useRef<HTMLInputElement>(null);
  const locked = busy || senderUncertain || submissionUncertain || discardUncertain;
  const selectedIdentity = availableIdentities.find(identity => identity.email.toLowerCase() === fields.fromEmail.trim().toLowerCase());
  const sendingNeedsSetup = selectedIdentity?.verified === false;
  const canSend = senderUncertain || submissionUncertain || Boolean(validRecipient(fields.fromEmail.trim()) && !sendingNeedsSetup && addresses(fields.to + ',' + fields.cc + ',' + fields.bcc).length);
  const closeSaved = () => void run(async () => { await save(); storeRecovery(true); onClose(); });
  const preserveAndClose = () => { storeRecovery(); onClose(); };
  const discard = () => void run(async () => {
    if (conflicted.current && !pendingDiscard.current) throw new Error('Resolve the draft conflict before discarding.');
    if (saving.current) await saving.current;
    if (pendingDraft.current) await save();
    try {
      if (emailId.current || pendingDiscard.current) await discardComposeDraft(client, accountId, draftBaseline.current, operation => {
        pendingDiscard.current = operation; setDiscardUncertain(true); storeRecovery();
      }, pendingDiscard.current);
    } catch (cause) {
      if (isConfirmedRejection(cause)) {
        pendingDiscard.current = undefined; setDiscardUncertain(false);
        if (isConfirmedDraftConflict(cause)) { conflicted.current = true; setDraftConflict(true); }
        storeRecovery();
      }
      throw cause;
    }
    pendingDiscard.current = undefined; setDiscardUncertain(false);
    submitted.current = true; storeRecovery(true); onSavedRef.current(); onClose();
  });
  const format = (command: string) => {
    const apply = () => {
      richEditor.current?.focus(); document.execCommand(command);
      if (richEditor.current) setFields(previous => ({ ...previous, html: cleanEditorHtml(richEditor.current!.innerHTML), body: richEditor.current!.innerText }));
    };
    if (!fields.rich) { setFields(previous => ({ ...previous, rich: true, html: textHtml(previous.body) })); window.requestAnimationFrame(apply); }
    else apply();
  };
  const insertLink = () => {
    if (!/^(https?:\/\/|mailto:)[^\s<>]+$/i.test(linkUrl)) { setError('Enter a complete https:// or mailto: link.'); return; }
    richEditor.current?.focus();
    const selection = window.getSelection(); if (linkSelection.current && selection) { selection.removeAllRanges(); selection.addRange(linkSelection.current); }
    if (selection?.isCollapsed) document.execCommand('insertHTML', false, '<a href="' + textHtml(linkUrl) + '">' + textHtml(linkUrl) + '</a>');
    else document.execCommand('createLink', false, linkUrl);
    if (richEditor.current) setFields(previous => ({ ...previous, html: cleanEditorHtml(richEditor.current!.innerHTML), body: richEditor.current!.innerText }));
    setShowLink(false); setLinkUrl(''); setError('');
  };
  const applySignature = (signature?: Signature) => setFields(previous => {
    const html = replaceComposeSignature(previous.html || textHtml(previous.body), signature ? signature.html || textHtml(signature.text) : '');
    return { ...previous, signatureId: signature?.id || '', html, body: composePlainText(html) };
  });
  const switchReplyMode = (next: 'reply' | 'replyAll' | 'forward' | 'attachment') => {
    if (!reply) return;
    setReplyMode(next);
    setFields(previous => {
      const template = document.createElement('template'); template.innerHTML = previous.html || textHtml(previous.body);
      template.content.querySelectorAll('[data-mail-quote]').forEach(element => element.remove());
      const own = new Set([...availableIdentities.map(identity => identity.email.toLowerCase()), previous.fromEmail.trim().toLowerCase()]);
      const candidates = next === 'replyAll' ? [...(replyTargets(reply) || []), ...(reply.to || []), ...(reply.cc || [])] : replyTargets(reply) || [];
      const to = next === 'forward' || next === 'attachment' ? '' : formatAddresses(candidates.filter((address, index) => (next !== 'replyAll' || !own.has(address.email.toLowerCase())) && candidates.findIndex(item => item.email.toLowerCase() === address.email.toLowerCase()) === index));
      const quote = next === 'attachment' ? '' : quoteMessage(reply, next === 'forward' ? 'forward' : 'reply', plainBody(reply)).html;
      const html = cleanEditorHtml(template.innerHTML + quote);
      const attachments = next === 'attachment' ? [{ blobId: reply.blobId, name: (reply.subject || 'Forwarded message') + '.eml', type: 'message/rfc822', size: (reply as Email & { size?: number }).size || 0 }] : next === 'forward' ? reply.attachments || [] : reply.attachments?.filter(part => part.cid || part.disposition === 'inline') || [];
      return { ...previous, to, cc: '', bcc: '', subject: next === 'forward' || next === 'attachment' ? forwardSubject(reply.subject) : replySubject(reply.subject), replyThread: next === 'forward' || next === 'attachment' ? undefined : replyThread(reply), html, body: composePlainText(html), attachments };
    });
  };
  const insertTemplate = (template: typeof templates[number]) => setFields(previous => {
    const body = template.textBody || template.body || template.text || '';
    const html = (previous.html || textHtml(previous.body)) + '<p>' + textHtml(body) + '</p>';
    return { ...previous, subject: template.subject || previous.subject, body: previous.body + (previous.body ? '\n\n' : '') + body, html };
  });
  return <section ref={dialogRef} role="region" tabIndex={-1} className={`mail-compose ${docked?'mail-compose-docked':''} ${expanded?'mail-compose-expanded':''} ${minimized?'mail-compose-minimized':''}`} aria-label="Compose message" onFocus={event=>{if(event.target===event.currentTarget)setMinimized(false);}} onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!locked && !uploading && !draftConflict) void run(async () => { await save(); }); }
  }}>
    <div className="mail-compose-workspace">
      <header className="mail-compose-heading">
        <h2>{draft ? 'Edit draft' : reply ? replyMode === 'forward' || replyMode === 'attachment' ? 'Forward message' : replyMode === 'replyAll' ? 'Reply to all' : 'Reply' : 'New message'}</h2>
        <div className="mail-compose-heading-actions">{docked&&<><Button variant="ghost" size="icon-sm" type="button" aria-label={minimized?'Restore composer':'Minimize composer'} onClick={()=>setMinimized(value=>!value)}><Minus /></Button><Button variant="ghost" size="icon-sm" type="button" aria-label={expanded?'Restore docked composer':'Expand composer'} onClick={()=>{setMinimized(false);setExpanded(value=>!value);}}>{expanded?<Minimize2 />:<Maximize2 />}</Button></>}
          <Button variant="ghost" size="sm" type="button" disabled={locked || uploading || draftConflict} onClick={() => setDiscardConfirm(true)}><Trash2 size={16} />Discard</Button>
          <Button variant="outline" size="sm" type="button" disabled={locked || uploading || draftConflict} onClick={closeSaved}>Save & close</Button>
        </div>
      </header>
      <div className="mail-compose-scroll">
      {draftConflict && <section className="mail-compose-notice mail-compose-conflict" role="alert"><h3>This draft needs your attention</h3><p>Another version was saved. Your edits are safe here; autosave is paused.</p><div className="mail-compose-notice-actions"><Button type="button" disabled={busy || uploading} onClick={() => void keepAsNewDraft()}>Keep my version as a new draft</Button>{emailId.current && <Button variant="outline" type="button" disabled={busy || uploading} onClick={() => void reloadServerDraft()}>Use saved version</Button>}<Button variant="ghost" type="button" disabled={busy || uploading || !localAvailable} onClick={preserveAndClose}>Keep on this device & close</Button></div>{emailId.current && <small>Using the saved version keeps a recovery copy of your current edits.</small>}</section>}
      {senderUncertain && !submissionUncertain && <section className="mail-compose-notice" role="alert"><h3>Confirm this sending address</h3><p>Your message has not been sent. Retry to confirm the same address before sending.</p>{error && <p>{error}</p>}<Button variant="outline" size="sm" type="button" disabled={busy || uploading} onClick={() => void run(async () => { await confirmSender(); })}>Check sending address</Button><Button variant="outline" size="sm" type="button" disabled={busy || uploading || !localAvailable} onClick={preserveAndClose}>Keep on this device & close</Button></section>}
      {submissionUncertain && <section className="mail-compose-notice" role="alert"><h3>Confirm whether this message was sent</h3><p>The server hasn’t confirmed the result. Confirming retries the same request and won’t send a second copy.</p>{error && <p>{error}</p>}<Button variant="outline" size="sm" type="button" disabled={busy || uploading || !localAvailable} onClick={preserveAndClose}>Keep on this device & close</Button></section>}
      {discardUncertain && <section className="mail-compose-notice" role="alert"><h3>Confirm whether this draft was discarded</h3><p>Your local copy is preserved until the server confirms the result. Checking again retries the same request.</p>{error && <p>{error}</p>}<div className="mail-compose-notice-actions"><Button size="sm" disabled={busy} onClick={discard}>Confirm discard</Button><Button variant="outline" size="sm" disabled={busy || !localAvailable} onClick={preserveAndClose}>Keep on this device & close</Button></div></section>}
      {error && !draftConflict && !senderUncertain && !submissionUncertain && !discardUncertain && <section className="mail-compose-notice mail-compose-error" role="alert"><h3>Couldn’t complete this action</h3><p>{error}</p>{localAvailable && <Button variant="ghost" size="sm" type="button" disabled={busy || uploading} onClick={preserveAndClose}>Keep on this device & close</Button>}</section>}
      {!identities.length && !sendingDomains.length && <section className="mail-compose-notice"><h3>Add a sending address</h3><p>Open Settings → Email addresses to connect the address you’ll send from. You can write and save a draft now.</p></section>}
      {sendingNeedsSetup && <section className="mail-compose-notice"><h3>This address isn’t ready to send yet</h3><p>Finish domain setup for {selectedIdentity?.email.split('@')[1]} to verify sending. Your draft is preserved.</p>{onSetupDomain && <Button variant="outline" size="sm" disabled={locked || uploading} onClick={() => { storeRecovery(); setMinimized(true); onSetupDomain(); }}>Finish domain setup</Button>}</section>}
      {discardConfirm && !discardUncertain && <div className="mail-compose-discard" role="alert"><div><strong>Discard this draft?</strong><p>The saved draft and this device’s recovery copy will be removed.</p></div><Button variant="outline" size="sm" disabled={busy} onClick={() => setDiscardConfirm(false)}>Keep writing</Button><Button variant="destructive" size="sm" disabled={busy} onClick={discard}>Discard draft</Button></div>}
      <div className="mail-compose-paper">
        <div className="mail-compose-envelope">
          <div className="mail-envelope-row"><Label htmlFor="mail-compose-from">From</Label><SenderInput id="mail-compose-from" value={fields.fromEmail} disabled={locked} identities={availableIdentities} domains={sendingDomains} onChange={switchSender} /></div>
          
          <div className="mail-envelope-row"><Label htmlFor="mail-compose-to">To</Label><div className="mail-envelope-recipient"><RecipientInput id="mail-compose-to" label="To" value={fields.to} disabled={locked} contacts={[...contacts,...suggestedContacts,...identities]} onChange={value=>change('to',value)} /><Button variant="ghost" size="sm" type="button" disabled={locked} aria-expanded={showCopies || Boolean(fields.cc || fields.bcc)} onClick={() => setShowCopies(value => !value)}>Cc / Bcc</Button></div></div>
          {(showCopies || fields.cc || fields.bcc) && (['cc', 'bcc'] as const).map(key => <div className="mail-envelope-row" key={key}><Label htmlFor={'mail-compose-' + key}>{key === 'cc' ? 'Cc' : 'Bcc'}</Label><RecipientInput id={'mail-compose-'+key} label={key==='cc'?'Cc':'Bcc'} value={fields[key]} disabled={locked} contacts={[...contacts,...suggestedContacts,...identities]} onChange={value=>change(key,value)} /></div>)}
          <div className="mail-envelope-row"><Label htmlFor="mail-compose-subject">Subject</Label><Input id="mail-compose-subject" aria-label="Subject" value={fields.subject} disabled={locked} placeholder="Add a subject" onChange={event => change('subject', event.target.value)} /></div>
        </div>
        <div className="mail-compose-tools">
          {reply && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm" disabled={locked}>{replyMode === 'attachment' ? 'Forward as attachment' : replyMode === 'forward' ? 'Forward' : replyMode === 'replyAll' ? 'Reply all' : 'Reply'}<ChevronDown size={14} /></Button></DropdownMenuTrigger><DropdownMenuContent align="start">{([['reply', 'Reply'], ['replyAll', 'Reply all'], ['forward', 'Forward'], ['attachment', 'Forward as attachment']] as const).map(([value, label]) => <DropdownMenuItem key={value} onSelect={() => switchReplyMode(value)}>{label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>}
          <Button variant="ghost" size="icon-sm" aria-label="Attach files" title="Attach files" type="button" disabled={locked || uploading} onClick={() => fileInput.current?.click()}><Paperclip size={16} /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Insert image" title="Insert image" type="button" disabled={locked || uploading} onClick={() => imageInput.current?.click()}><ImagePlus size={16} /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Send later" title="Send later" type="button" aria-expanded={showSchedule} disabled={locked} onClick={() => setShowSchedule(value => !value)}><Clock size={16} /></Button>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" disabled={locked} aria-label="Templates" title="Templates"><FileText size={16} /></Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuLabel>Insert a template</DropdownMenuLabel>{templates.length ? templates.map(template => <DropdownMenuItem key={template.id} onSelect={() => insertTemplate(template)}>{template.name}</DropdownMenuItem>) : <DropdownMenuItem disabled>No templates yet</DropdownMenuItem>}{onManageTemplates && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { storeRecovery(); setMinimized(true); onManageTemplates(); }}>Manage templates</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" disabled={locked} aria-label="Signature" title="Signature"><PenLine size={16} /></Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuLabel>Choose a signature</DropdownMenuLabel><DropdownMenuItem onSelect={() => applySignature()}>No signature</DropdownMenuItem>{signatures.map(signature => <DropdownMenuItem key={signature.id} onSelect={() => applySignature(signature)}>{signature.name}</DropdownMenuItem>)}{!signatures.length && <DropdownMenuItem disabled>No saved signatures yet</DropdownMenuItem>}{onManageSignatures && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { storeRecovery(); setMinimized(true); onManageSignatures(); }}>Manage signatures</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu>
          <Button variant="ghost" size="icon-sm" type="button" aria-label="Formatting options" title="Formatting options" aria-expanded={showFormatting} disabled={locked} onMouseDown={event => event.preventDefault()} onClick={() => setShowFormatting(value => !value)}><Bold size={16} /></Button>
        </div>
        {showSchedule && <div className="mail-compose-schedule"><div><Label htmlFor="mail-compose-send-at">Send later</Label><Input id="mail-compose-send-at" type="datetime-local" value={fields.sendAt} disabled={locked} onChange={event => change('sendAt', event.target.value)} /></div><p>Uses your device’s time zone.</p><Button variant="ghost" size="sm" disabled={locked} onClick={() => { change('sendAt', ''); setShowSchedule(false); }}>{fields.sendAt ? 'Clear schedule' : 'Cancel'}</Button></div>}
        <div hidden={!showFormatting} className="mail-compose-format" role="toolbar" aria-label="Message formatting">
          <ButtonGroup aria-label="Text formatting">
            {([{ command: 'bold', label: 'Bold', Icon: Bold }, { command: 'italic', label: 'Italic', Icon: Italic }, { command: 'underline', label: 'Underline', Icon: Underline }, { command: 'insertUnorderedList', label: 'Bullet list', Icon: List }, { command: 'insertOrderedList', label: 'Numbered list', Icon: ListOrdered }]).map(({ command, label, Icon }) => <Button variant="ghost" size="icon-sm" key={command} type="button" aria-label={label} title={label} disabled={locked} onMouseDown={event => event.preventDefault()} onClick={() => format(command)}><Icon size={16} /></Button>)}
            <Button variant="ghost" size="icon-sm" type="button" aria-label="Insert link" title="Insert link" disabled={locked || !fields.rich} onMouseDown={event => { event.preventDefault(); const selection = window.getSelection(); linkSelection.current = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null; }} onClick={() => setShowLink(value => !value)}><Link2 size={16} /></Button>
          </ButtonGroup>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" disabled={locked}>{fields.rich ? 'Rich text' : 'Plain text'}<ChevronDown size={14} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => setFields(previous => ({ ...previous, rich: true, html: previous.html || textHtml(previous.body) }))}>Rich text</DropdownMenuItem><DropdownMenuItem onSelect={() => setFields(previous => ({ ...previous, rich: false, body: composePlainText(previous.html || textHtml(previous.body)) }))}>Plain text</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        </div>
        {showLink && <form className="mail-compose-link" onSubmit={event => { event.preventDefault(); insertLink(); }}><Label htmlFor="mail-compose-link-url">Link</Label><Input id="mail-compose-link-url" aria-label="Link address" autoFocus placeholder="https://example.com" value={linkUrl} onChange={event => setLinkUrl(event.target.value)} /><Button size="sm" type="submit">Insert link</Button><Button variant="ghost" size="sm" type="button" onClick={() => setShowLink(false)}>Cancel</Button></form>}
        <div className="mail-editor-surface" onClick={event => { if (event.target === event.currentTarget && !locked) { const editor = event.currentTarget.querySelector<HTMLElement>('[role="textbox"], textarea'); editor?.focus(); } }}>
          {fields.rich ? <div ref={richEditor} className="mail-compose-rich" role="textbox" aria-label="Message" aria-multiline="true" data-placeholder="Write your message…" contentEditable={!locked} suppressContentEditableWarning onInput={event => { const element = event.currentTarget; setFields(previous => ({ ...previous, body: element.innerText, html: cleanEditorHtml(element.innerHTML) })); }} onPaste={event => { event.preventDefault(); const files=Array.from(event.clipboardData.files).filter(file=>/^image\/(png|jpeg|gif|webp)$/i.test(file.type));if(files.length){void attach(files,true);return;} const html = event.clipboardData.getData('text/html'); document.execCommand(html ? 'insertHTML' : 'insertText', false, html ? cleanEditorHtml(html,false,true) : event.clipboardData.getData('text/plain')); if (richEditor.current) setFields(previous => ({ ...previous, body: richEditor.current!.innerText, html: cleanEditorHtml(richEditor.current!.innerHTML) })); }} /> : <Textarea aria-label="Message" className="mail-compose-text" placeholder="Write your message…" value={fields.body} disabled={locked} onChange={event => change('body', event.target.value)} />}
        </div>
        {fields.attachments.length > 0 && <ul className="mail-compose-attachments" aria-label="Attachments">{fields.attachments.map((part, index) => <li key={part.blobId + ':' + index}><Attachment size="sm"><AttachmentContent><AttachmentTitle>{part.name || 'Attachment'}</AttachmentTitle><AttachmentDescription>{Math.ceil(part.size / 1024)} KB{part.disposition === 'inline' ? ' · Inline image' : ''}</AttachmentDescription></AttachmentContent><AttachmentActions><AttachmentAction variant="ghost" size="icon-sm" type="button" disabled={locked || uploading} aria-label={'Remove ' + (part.name || 'attachment')} onClick={() => change('attachments', fields.attachments.filter((_, item) => item !== index))}>×</AttachmentAction></AttachmentActions></Attachment></li>)}</ul>}

        <input ref={fileInput} className="mail-compose-file-input" type="file" multiple disabled={locked || uploading} onChange={event => { void attach(event.target.files); event.target.value = ''; }} /><input ref={imageInput} className="mail-compose-file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={locked || uploading} onChange={event => { void attach(event.target.files, true); event.target.value = ''; }} />
      </div>
      {conflictBackup && !draftConflict && <div className="mail-compose-backup"><p>Your previous local edits are preserved.</p><Button variant="outline" size="sm" type="button" disabled={locked || uploading} onClick={() => void keepAsNewDraft(conflictBackup)}>Restore as a new draft</Button></div>}
      </div>
        <footer className="mail-compose-footer">
          <span className="mail-compose-feedback" role="status">{uploading ? 'Uploading attachment…' : !localAvailable ? 'Device recovery unavailable' : fields.sendAt ? 'Scheduled for ' + new Date(fields.sendAt).toLocaleString() : ''}</span>
          <Button type="button" disabled={busy || uploading || draftConflict || discardUncertain || !canSend} onClick={() => void send()}><Send size={16} />{uploading ? 'Uploading…' : busy ? 'Working…' : senderUncertain ? 'Confirm sending address' : submissionUncertain ? 'Confirm send' : fields.sendAt ? 'Schedule send' : 'Send'}</Button>
          <span className="sr-only" aria-live="polite">{status}</span>
        </footer>
    </div>
  </section>;
}
