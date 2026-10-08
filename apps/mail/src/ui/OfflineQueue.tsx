import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@open-cloud/ui';
import './utilities.css';
import { MailClient, type Email, type GetResult, type Mailbox, type MailSession, type SetResult } from './jmap';
import { cacheScope, discardQueuedMutation, readQueuedMutations, type QueuedMutation } from './offline';
import { useDialog } from './use-dialog';

type Patch = Record<string, Record<string, true | null>>;
type Review = { commandId: string; state: string; emails: Email[]; mailboxes: Mailbox[]; update: Patch };
function desiredPatch(command: QueuedMutation): Patch | null {
  const update = command.args.update;
  if (!update || typeof update !== 'object' || Array.isArray(update) || !Object.keys(update).length || 'create' in command.args || 'destroy' in command.args) return null;
  const result: Patch = {};
  for (const [id, value] of Object.entries(update)) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return null;
    const patch: Record<string, true | null> = {};
    for (const [path, target] of Object.entries(value)) {
      if (!/^(keywords|mailboxIds)\/[^/]+$/.test(path) || (target !== true && target !== null)) return null;
      patch[path] = target;
    }
    result[id] = patch;
  }
  return result;
}
function message(error: unknown) { return error instanceof Error ? error.message : 'The queued change could not be processed.'; }
function decodePath(path: string) { return path.replace(/~1/g, '/').replace(/~0/g, '~'); }
const keywordNames: Record<string, string> = { '$seen': 'Read', '$flagged': 'Starred', '$answered': 'Answered', '$draft': 'Draft', '$important': 'Important', '$forwarded': 'Forwarded', '$junk': 'Spam', '$notjunk': 'Not spam' };

export default function OfflineQueue({ client, session, onClose, onChanged }: {
  client: MailClient; session: MailSession; onClose: () => void; onChanged: () => void;
}) {
  const scope = cacheScope(session);
  const dialogRef = useRef<HTMLElement>(null);
  useDialog(dialogRef, false);
  const [commands, setCommands] = useState<readonly QueuedMutation[]>(() => readQueuedMutations(scope));
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const operation = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setCommands(readQueuedMutations(scope)); setReview(null); setError(''); setNotice('');
    return () => { generation.current++; };
  }, [scope]);
  function authorization(error: unknown) {
    const detail = error as { authorizationLost?: boolean; errorType?: string };
    if (detail?.authorizationLost || detail?.errorType === 'forbidden') client.onAuthorizationLost?.();
  }
  function refresh() { setCommands(readQueuedMutations(scope)); onChanged(); }
  async function reviewLatest(command: QueuedMutation) {
    if (operation.current) return;
    const update = desiredPatch(command);
    if (!update) { setError('This older change replaces complete fields or changes unsupported fields. Discard it, then make the change again from your current mailbox.'); setReview(null); return; }
    if (!session.accounts[command.accountId] || session.accounts[command.accountId].isReadOnly) { setError('This account is no longer writable. You can discard the local change.'); setReview(null); return; }
    const current = generation.current;
    operation.current = true; setBusy(command.id); setReview(null); setError(''); setNotice('');
    try {
      const [emails, mailboxes] = await Promise.all([
        client.call<GetResult<Email>>('Email/get', { ids: Object.keys(update), properties: ['id', 'subject', 'keywords', 'mailboxIds'] }, command.accountId),
        client.call<GetResult<Mailbox>>('Mailbox/get', { properties: ['id', 'name'] }, command.accountId),
      ]);
      if (generation.current !== current) return;
      if (!emails.state || emails.notFound?.length || Object.keys(update).some(id => !emails.list.some(email => email.id === id))) throw new Error('Some messages are no longer available. Discard this change and redo it for the remaining messages.');
      setReview({ commandId: command.id, state: emails.state, emails: emails.list, mailboxes: mailboxes.list, update });
    } catch (e) { authorization(e); if (generation.current === current) setError(message(e)); }
    finally { operation.current = false; if (generation.current === current) setBusy(null); }
  }
  async function reapply(command: QueuedMutation) {
    if (operation.current || review?.commandId !== command.id) return;
    const current = generation.current;
    operation.current = true; setBusy(command.id); setError(''); setNotice('');
    const reviewed = review;
    setReview(null);
    try {
      if (cacheScope(client.session) !== scope) throw new Error('Your mail session changed. Reopen queued changes in your current session.');
      const saved = readQueuedMutations(scope).find(value => value.id === command.id);
      if (!saved || JSON.stringify(saved.args) !== JSON.stringify(command.args)) throw new Error('This queued change has changed or already synchronized. Refresh the list.');
      if (!client.session.accounts[command.accountId] || client.session.accounts[command.accountId].isReadOnly) throw new Error('This account is no longer writable.');
      const result = await client.call<SetResult>('Email/set', { update: reviewed.update, ifInState: reviewed.state, operationId: crypto.randomUUID() }, command.accountId);
      if (Object.keys(reviewed.update).some(id => !Object.prototype.hasOwnProperty.call(result.updated || {}, id)) || Object.keys(result.notUpdated || {}).length) throw new Error('The server did not confirm every message change. Review the latest messages before trying again.');
      discardQueuedMutation(scope, command.id);
      if (generation.current !== current) return;
      refresh(); setNotice('Reviewed changes saved. Other message fields were preserved.');
    } catch (e) {
      authorization(e);
      if (generation.current === current) { refresh(); setError(`${message(e)} The queued change was retained. Review the latest messages before another attempt.`); }
    } finally { operation.current = false; if (generation.current === current) setBusy(null); }
  }
  function discard(command: QueuedMutation) {
    if (operation.current) return;
    setError(''); setNotice('');
    try { discardQueuedMutation(scope, command.id); setReview(null); refresh(); setNotice('Local queued change discarded. Server messages were not changed.'); }
    catch (e) { setError(message(e)); }
  }
  return <section ref={dialogRef} role="region" tabIndex={-1} aria-label="Queued mail changes" className="mail-settings mail-utility">
    <header className="mail-settings-header mail-utility-header"><div><p className="mail-utility-eyebrow">On this device</p><h2>Queued changes</h2><p>Review changes that could not synchronize before applying them to your current mail.</p></div><Button variant="outline" disabled={Boolean(busy)} onClick={onClose}>Back to mail</Button></header>
    {error && <div className="mail-utility-notice mail-utility-notice-error" role="alert"><strong>Changes need another review</strong><p>{error}</p></div>}{notice && <div className="mail-utility-notice" role="status">{notice}</div>}
    <div className="mail-utility-toolbar"><p className="mail-utility-meta">{commands.length} {commands.length === 1 ? 'change' : 'changes'} waiting for review</p><Button variant="outline" disabled={Boolean(busy)} onClick={() => { setReview(null); refresh(); }}>Refresh queue</Button></div>
    {!commands.length ? <div className="mail-utility-empty"><h3>All caught up</h3><p>There are no changes waiting on this device. Changes made offline appear here if they need your review.</p><Button onClick={onClose}>Return to inbox</Button></div> : <ul className="mail-utility-list">{commands.map(command => {
      const patch = desiredPatch(command);
      const active = review?.commandId === command.id ? review : null;
      const count = patch ? Object.keys(patch).length : 0;
      const writable = Boolean(session.accounts[command.accountId] && !session.accounts[command.accountId].isReadOnly);
      const changes = patch ? [...new Set(Object.values(patch).flatMap(fields => Object.entries(fields).map(([path, target]) => {
        const [kind, encoded] = path.split('/'); const key = decodePath(encoded);
        if (kind === 'mailboxIds') return 'Update folders or labels';
        if (key === '$seen') return target ? 'Mark as read' : 'Mark as unread';
        if (key === '$flagged') return target ? 'Add star' : 'Remove star';
        return `${target ? 'Add' : 'Remove'} ${keywordNames[key]?.toLowerCase() || 'message flag'}`;
      })))] : [];
      return <li className="mail-utility-item" key={command.id}>
        <div className="mail-utility-item-heading"><h3>{session.accounts[command.accountId]?.name || 'Unavailable inbox'}</h3><span className="mail-utility-status" data-tone={patch && writable ? 'neutral' : 'warning'}>{patch && writable ? 'Needs review' : 'Cannot apply'}</span></div>
        <p>{count ? `${count} ${count === 1 ? 'message' : 'messages'} · ${changes.join(' · ')}` : 'An older change is waiting on this device.'}</p>
        {!patch && <p className="mail-utility-inline-error">This older change cannot safely be reapplied. Discard it, then make the change again from your current mailbox.</p>}
        {!writable && <p className="mail-utility-inline-error">This inbox is no longer writable. You can discard the change stored on this device.</p>}
        {active && <div className="mail-utility-review"><h4>Review current messages</h4><p>Compare the latest message details with the changes you want to apply.</p>{active.emails.map(email => <div className="mail-utility-review-message" key={email.id}>
          <h5>{email.subject || '(No subject)'}</h5>
          <dl><div><dt>Current status</dt><dd>{[email.keywords?.$seen ? 'Read' : 'Unread', ...Object.keys(email.keywords || {}).filter(key => key !== '$seen' && email.keywords[key]).map(key => keywordNames[key] || 'Other flag')].join(', ')}</dd></div>
          <div><dt>Current folders</dt><dd>{Object.keys(email.mailboxIds || {}).filter(id => email.mailboxIds[id]).map(id => active.mailboxes.find(mailbox => mailbox.id === id)?.name || 'Unavailable folder').join(', ') || 'None'}</dd></div></dl>
          <p className="mail-utility-review-label">Your changes</p><ul className="mail-utility-change-list">{Object.entries(active.update[email.id]).map(([path, target]) => {
            const [kind, encoded] = path.split('/'); const key = decodePath(encoded);
            const label = kind === 'keywords' ? (keywordNames[key] || 'message flag') : (active.mailboxes.find(mailbox => mailbox.id === key)?.name || 'Unavailable folder');
            return <li key={path}>{kind === 'keywords' && key === '$seen' ? (target ? 'Mark as read' : 'Mark as unread') : kind === 'keywords' && key === '$flagged' ? (target ? 'Add star' : 'Remove star') : `${target ? 'Add' : 'Remove'} ${kind === 'keywords' ? 'flag' : 'folder'}: ${label}`}</li>;
          })}</ul>
        </div>)}<p className="mail-utility-meta">Only these flags and folders will change. The message content stays the same.</p><div className="mail-utility-actions"><Button disabled={Boolean(busy)} onClick={() => void reapply(command)}>Apply reviewed changes</Button><Button variant="outline" disabled={Boolean(busy)} onClick={() => setReview(null)}>Cancel review</Button></div></div>}
        <div className="mail-utility-actions">
          {!active && <Button disabled={Boolean(busy) || !patch || !writable} onClick={() => void reviewLatest(command)}>{busy === command.id ? 'Working…' : 'Review latest messages'}</Button>}
          <Button variant="outline" disabled={Boolean(busy)} onClick={() => discard(command)}>Discard local change</Button>
        </div>
      </li>;
    })}</ul>}
    {commands.length > 0 && <p className="mail-utility-footnote">Discarding a local change leaves your server messages unchanged.</p>}
  </section>;
}
