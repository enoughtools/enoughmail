import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@open-cloud/ui';
import { Spinner } from '@rebnz/enough-ui/spinner';
import './utilities.css';
import {useDialog} from './use-dialog';
import { MailClient, type Email, type GetResult } from './jmap';
import {pendingRecovery,recoveryKey,recoveredDraft,definitiveRecoveryRejection,type SubmissionRecoveryRequest,type SubmissionRecoveryResult} from './submission-recovery';

interface Submission {
  id: string;
  emailId: string;
  status?: string;
  undoStatus?: string;
  recoverable?: boolean;
  sendAt?: string;
  error?: string | null;
  deliveryStatus?: Record<string, {
    status: 'queued' | 'delivered' | 'deferred' | 'bounced' | 'failed' | 'rejected' | 'complained' | 'suppressed' | 'unknown';
    terminal: boolean;
    updatedAt: string;
    reason?: string;
    smtpStatusCode?: string | number;
    smtpEnhancedStatusCode?: string;
  }>;
}

const statusLabels: Record<string, string> = {
  pending: 'Waiting to send', scheduled: 'Scheduled', canceled: 'Canceled',
  failed: 'Failed', uncertain: 'Delivery unconfirmed', sending: 'Sending', sent: 'Submitted to mail provider',
};
const recipientStatusLabels: Record<string, string> = {
  queued: 'Queued by mail provider; delivery not confirmed', delivered: 'Accepted by recipient mail server',
  deferred: 'Delivery delayed', bounced: 'Bounced', failed: 'Delivery failed', rejected: 'Rejected',
  complained: 'Recipient reported spam', suppressed: 'Sending suppressed', unknown: 'Delivery not confirmed',
};
function submissionStatus(value: Submission) {
  return value.status || (value.undoStatus === 'canceled' ? 'canceled' : value.undoStatus === 'pending' ? 'pending' : 'unknown');
}
function displayTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

export default function Outbox({ client, accountId, onClose, onEdit }: {
  client: MailClient; accountId: string; onClose: () => void; onEdit: (emailId: string) => void;
}) {
  const dialogRef=useRef<HTMLElement>(null);useDialog(dialogRef, false);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [emails, setEmails] = useState<Record<string, Email>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<'all' | 'scheduled' | 'attention'>('all');
  const [recoveryRequest,setRecoveryRequest]=useState<SubmissionRecoveryRequest|null>(null);
  const recoveryStorageKey=recoveryKey(client.session,accountId);
  const capability=client.session.accounts[accountId]?.accountCapabilities['urn:enough:params:jmap:mail'] as {actions?:string[]}|undefined;
  const canRecover=capability?.actions?.includes('mail.read')===true&&capability.actions.includes('mail.draft');
  const generation = useRef(0);
  const mutation = useRef(false);
  const reload = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const current = ++generation.current;
    let inFlight = false;
    setSubmissions([]); setEmails({}); setFilter('all'); setLoading(true); setError(''); setNotice(''); setBusy(null);
    try{setRecoveryRequest(pendingRecovery(JSON.parse(sessionStorage.getItem(recoveryStorageKey)||'null')));}catch{setRecoveryRequest(null);}
    async function load() {
      if (inFlight || mutation.current) return;
      inFlight = true;
      try {
        const response = await client.call<GetResult<Submission>>('EmailSubmission/get', {}, accountId);
        const ids = [...new Set(response.list.map(value => value.emailId))];
        const messages = ids.length ? await client.call<GetResult<Email>>('Email/get', { ids, properties: ['id', 'subject', 'to'] }, accountId) : null;
        if (generation.current !== current) return;
        setSubmissions(response.list.slice().sort((a, b) => (b.sendAt || '').localeCompare(a.sendAt || '')));
        setEmails(Object.fromEntries((messages?.list || []).map(value => [value.id, value])));
        setError('');
      } catch (e) {
        if (generation.current === current) setError(e instanceof Error ? e.message : 'Could not load outgoing mail.');
      } finally {
        inFlight = false;
        if (generation.current === current) setLoading(false);
      }
    }
    reload.current = load;
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => { generation.current++; window.clearInterval(timer); };
  }, [client, accountId,recoveryStorageKey]);

  async function cancel(value: Submission, edit: boolean) {
    if (mutation.current) return;
    const current = generation.current;
    mutation.current = true; setBusy(value.id); setError(''); setNotice('');
    try {
      await client.call('EmailSubmission/set', { update: { [value.id]: { undoStatus: 'canceled' } } }, accountId);
      if (generation.current !== current) return;
      setNotice('Sending canceled. The message is still available to edit.');
      if (edit) onEdit(value.emailId);
    } catch (e) {
      if (generation.current === current) setError(e instanceof Error ? e.message : 'Could not cancel sending.');
    } finally {
      mutation.current = false;
      if (generation.current === current) { setBusy(null); await reload.current(); }
    }
  }

  async function recover(value?:Submission) {
    if(mutation.current||!canRecover)return;
    if(!recoveryRequest&&(!value?.recoverable||!['failed','uncertain'].includes(submissionStatus(value)))){setError('Retained content is unavailable for recovery. Refresh outgoing mail.');return;}
    const state=client.states.get(`${accountId}:EmailSubmission`);if(!recoveryRequest&&!state){setError('Refresh outgoing mail before recovering a draft.');return;}
    const current=generation.current;const request=recoveryRequest||{submissionId:value!.id,ifInState:state!,operationId:crypto.randomUUID()};
    mutation.current=true;setBusy(request.submissionId);setError('');setNotice('');
    try{
      // Persist only the scoped request, never retained message content or sending authority.
      sessionStorage.setItem(recoveryStorageKey,JSON.stringify(request));setRecoveryRequest(request);
      const response=await client.call<SubmissionRecoveryResult>('EmailSubmission/recover',{...request},accountId);
      const emailId=recoveredDraft(response,accountId,request);
      if(generation.current!==current)return;
      sessionStorage.removeItem(recoveryStorageKey);setRecoveryRequest(null);
      setNotice(response.originalStatus==='uncertain'?'Content recovered to a new draft. Delivery may already have occurred. Recovery does not resend the message.':'Content recovered to a new draft. Recovery does not send the message.');
      onEdit(emailId); // Existing editor hydrates the complete new Email before opening.
    }catch(problem){
      if(generation.current!==current)return;
      if(definitiveRecoveryRejection(problem)){try{sessionStorage.removeItem(recoveryStorageKey);}catch{/* The stored command remains safe to replay. */}setRecoveryRequest(null);}
      setError(problem instanceof Error?problem.message:'Draft recovery is unconfirmed. Retry the same recovery request.');
    }finally{mutation.current=false;if(generation.current===current)setBusy(null);}
  }

  const needsAttention = (value: Submission) => ['failed', 'uncertain'].includes(submissionStatus(value)) || Object.values(value.deliveryStatus || {}).some(detail => ['bounced', 'failed', 'rejected', 'complained', 'suppressed'].includes(detail.status));
  const scheduled = (value: Submission) => ['pending', 'scheduled'].includes(submissionStatus(value));
  const visible = submissions.filter(value => filter === 'all' || (filter === 'scheduled' ? scheduled(value) : needsAttention(value)));
  return <section ref={dialogRef} role="region" tabIndex={-1} className="mail-settings mail-utility" aria-label="Outgoing mail">
    <header className="mail-settings-header mail-utility-header"><div><p className="mail-utility-eyebrow">Delivery</p><h2>Outgoing mail</h2><p>Track scheduled messages and delivery to your recipients.</p></div><Button variant="outline" onClick={onClose}>Back to mail</Button></header>
    {error && <div className="mail-utility-notice mail-utility-notice-error" role="alert"><strong>Could not complete this request</strong><p>{error}</p><Button variant="outline" disabled={Boolean(busy)} onClick={() => void reload.current()}>Try again</Button></div>}
    {notice && <div className="mail-utility-notice" role="status">{notice}</div>}
    {recoveryRequest && <div className="mail-utility-notice mail-utility-notice-warning" role="status"><strong>Confirm your recovered draft</strong><p>The last recovery request is still unconfirmed. Checking it again safely returns the same draft without sending mail.</p><Button variant="outline" disabled={Boolean(busy) || !canRecover} onClick={() => void recover()}>{busy ? 'Checking recovery…' : 'Confirm recovered draft'}</Button></div>}
    <div className="mail-utility-toolbar"><div className="mail-utility-filters" aria-label="Filter outgoing mail">{([['all', 'All', submissions.length], ['scheduled', 'Scheduled', submissions.filter(scheduled).length], ['attention', 'Needs attention', submissions.filter(needsAttention).length]] as const).map(([id, label, count]) => <Button key={id} type="button" size="sm" variant={filter === id ? 'secondary' : 'ghost'} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}<span>{count}</span></Button>)}</div><Button variant="outline" disabled={Boolean(busy) || loading} onClick={() => void reload.current()}>Refresh</Button></div>
    {loading ? <div className="mail-utility-empty" role="status"><Spinner size="sm" /><p>Loading outgoing mail…</p></div> : !visible.length ? <div className="mail-utility-empty"><h3>{error ? 'Outgoing mail is unavailable' : filter === 'attention' ? 'Nothing needs attention' : filter === 'scheduled' ? 'No messages scheduled' : 'Your outbox is clear'}</h3><p>{error ? 'Try refreshing to load your recent sending activity.' : filter === 'scheduled' ? 'Messages you schedule will appear here until they send.' : filter === 'attention' ? 'Failed or unconfirmed deliveries will appear here for review.' : 'Scheduled messages and delivery updates will appear here after you send mail.'}</p></div> :
      <ul className="mail-utility-list">{visible.map(value => {
        const status = submissionStatus(value);
        const email = emails[value.emailId];
        const recipients = Object.entries(value.deliveryStatus || {});
        const cancelable = scheduled(value);
        const recipientFailures = recipients.filter(([, detail]) => ['bounced', 'failed', 'rejected', 'complained', 'suppressed'].includes(detail.status)).length;
        const recipientDelays = recipients.filter(([, detail]) => detail.status === 'deferred').length;
        return <li className="mail-utility-item" key={value.id}>
          <div className="mail-utility-item-heading"><h3>{email?.subject || '(No subject)'}</h3><span className="mail-utility-status" data-tone={needsAttention(value) ? 'warning' : status === 'sent' ? 'success' : 'neutral'}>{statusLabels[status] || 'Delivery status unavailable'}</span></div>
          {email?.to?.length ? <p className="mail-utility-recipients">To {email.to.map(address => address.name ? `${address.name} <${address.email}>` : address.email).join(', ')}</p> : null}
          {value.sendAt && <p className="mail-utility-meta">{status === 'scheduled' ? 'Scheduled for' : 'Sending time'} <time dateTime={value.sendAt}>{displayTime(value.sendAt)}</time></p>}
          {value.error && <p className="mail-utility-inline-error">{value.error}</p>}
          {status === 'uncertain' && <div className="mail-utility-notice mail-utility-notice-warning"><strong>Check delivery before sending again</strong><p>This message may already have arrived. Recovering its content creates a draft and does not send another copy.</p></div>}
          {status === 'sent' && <p className="mail-utility-meta">Submitted to your mail provider. Recipient delivery is shown below when available.</p>}
          {recipients.length > 0 && <details className="mail-utility-details"><summary>Recipient delivery <span>{recipients.filter(([, detail]) => detail.status === 'delivered').length} of {recipients.length} accepted{recipientFailures > 0 ? ` · ${recipientFailures} need attention` : ''}{recipientDelays > 0 ? ` · ${recipientDelays} delayed` : ''}</span></summary><ul className="mail-utility-deliveries">{recipients.map(([recipient, detail]) => <li key={recipient}><div><strong>{recipient}</strong><p>{recipientStatusLabels[detail.status] || 'Delivery not confirmed'}</p>{detail.reason && <p>{detail.reason}</p>}</div><div className="mail-utility-meta">{detail.updatedAt && <time dateTime={detail.updatedAt}>{displayTime(detail.updatedAt)}</time>}{(detail.smtpStatusCode || detail.smtpEnhancedStatusCode) && <p>SMTP {detail.smtpStatusCode} {detail.smtpEnhancedStatusCode}</p>}</div></li>)}</ul></details>}
          <div className="mail-utility-actions">
            {cancelable && <><Button disabled={Boolean(busy) || !email} onClick={() => void cancel(value, true)}>{busy === value.id ? 'Canceling…' : 'Cancel and edit'}</Button><Button variant="outline" disabled={Boolean(busy)} onClick={() => void cancel(value, false)}>Cancel sending</Button></>}
            {['failed', 'uncertain'].includes(status) && value.recoverable && <Button disabled={Boolean(busy) || Boolean(recoveryRequest) || !canRecover} onClick={() => void recover(value)}>{busy === value.id ? 'Recovering…' : 'Recover to draft'}</Button>}
            {(status === 'canceled' || status === 'failed') && email && <Button variant="outline" disabled={Boolean(busy)} onClick={() => onEdit(value.emailId)}>Edit message</Button>}
          </div>
        </li>;
      })}</ul>}
    <p className="mail-utility-footnote">Delivery updates refresh automatically every 15 seconds while this page is open.</p>
  </section>;
}
