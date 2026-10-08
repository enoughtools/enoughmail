import React, { useEffect, useState } from 'react';
import { Button } from '@open-cloud/ui';
import { NativeSelect } from '@rebnz/enough-ui/native-select';
import { Spinner } from '@rebnz/enough-ui/spinner';
import type { MailClient, GetResult } from './jmap';

export type TransferIdentity = { id: string; email: string; signatureId?: string | null };
type Command = { operationId: string; sourceAccountId: string; destinationAccountId: string; identityId: string; expectedSourceState: string; expectedDestinationState: string };
export function pendingIdentityTransfers(client: MailClient, accountId: string): TransferIdentity[] {
  const prefix = ['enough-mail:identity-transfer', client.session.organizationId, client.session.workspaceId, client.session.actorId, accountId].map(encodeURIComponent).join(':') + ':';
  const values: TransferIdentity[] = [];
  try { for (let index = 0; index < sessionStorage.length; index++) { const key = sessionStorage.key(index); if (!key?.startsWith(prefix)) continue; const saved = JSON.parse(sessionStorage.getItem(key) || '{}'); const command = saved.command || saved; if (command.sourceAccountId === accountId && typeof command.identityId === 'string') values.push({ id: command.identityId, email: typeof saved.email === 'string' ? saved.email : 'Pending address move' }); } } catch { /* The move panel reports restricted storage. */ }
  return values;
}
export default function IdentityTransfer({ client, accountId, identity, onClose, onComplete }: { client: MailClient; accountId: string; identity: TransferIdentity; onClose: () => void; onComplete: () => void }) {
  const storageKey = ['enough-mail:identity-transfer', client.session.organizationId, client.session.workspaceId, client.session.actorId, accountId, identity.id].map(encodeURIComponent).join(':');
  const [destination, setDestination] = useState(''), [review, setReview] = useState<Command | null>(null), [pending, setPending] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const targets = Object.entries(client.session.accounts).filter(([id, account]) => { const actions = (account.accountCapabilities['urn:enough:params:jmap:mail'] as { actions?: string[] } | undefined)?.actions || []; return id !== accountId && !account.isReadOnly && actions.includes('mail.manage'); });
  useEffect(() => {
    try { const raw = sessionStorage.getItem(storageKey); if (!raw) return; const stored = JSON.parse(raw); const saved = (stored.command || stored) as Command; if (saved.sourceAccountId === accountId && saved.identityId === identity.id && typeof saved.operationId === 'string' && typeof saved.expectedSourceState === 'string' && typeof saved.expectedDestinationState === 'string' && typeof saved.destinationAccountId === 'string') { setPending(saved); setDestination(saved.destinationAccountId); } } catch { setError('The previous move could not be read. Reload before starting another move.'); }
  }, [storageKey, accountId, identity.id]);
  async function prepare() {
    setBusy(true); setError(''); setReview(null);
    try {
      const [source, target] = await Promise.all([client.call<GetResult<TransferIdentity>>('Identity/get', {}, accountId), client.call<GetResult<TransferIdentity>>('Identity/get', {}, destination)]);
      if (!source.list.some(value => value.id === identity.id && value.email === identity.email)) throw new Error('This address changed. Reload email addresses before moving it.');
      if (target.list.some(value => value.email.toLowerCase() === identity.email.toLowerCase())) throw new Error('The destination already contains this address. Reload both inboxes.');
      const sourceState = client.states.get(`${accountId}:Identity`), targetState = client.states.get(`${destination}:Identity`);
      if (!sourceState || !targetState) throw new Error('Current inbox revisions are unavailable. Reload and try again.');
      setReview({ operationId: crypto.randomUUID(), sourceAccountId: accountId, destinationAccountId: destination, identityId: identity.id, expectedSourceState: sourceState, expectedDestinationState: targetState });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The move could not be reviewed.'); }
    finally { setBusy(false); }
  }
  async function move(command: Command) {
    // Retain the exact operation and revisions before the first write, including across reloads.
    try { sessionStorage.setItem(storageKey, JSON.stringify({ command, email: identity.email })); } catch { setError('This browser cannot preserve move recovery. Enable session storage before moving the address.'); return; }
    setBusy(true); setError(''); setPending(command);
    try {
      const response = await fetch('/apps/mail/api/identities/transfer', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
      const data = await response.json() as { moved?: boolean; error?: { message?: string; code?: string } | string; code?: string; message?: string };
      if (!response.ok) {
        // A 5xx or transport failure may have committed. Never replace its command with a new one.
        if (['transfer_aborted', 'transfer_expired'].includes(typeof data.error === 'object' ? data.error?.code || data.code || '' : data.error || data.code || '')) { sessionStorage.removeItem(storageKey); setPending(null); setReview(null); }
        throw new Error(typeof data.error === 'object' ? data.error?.message || data.message || 'The move was refused. Review both inboxes before trying again.' : data.message || 'The move could not be confirmed. Retry the pending move.');
      }
      if (!data.moved) throw new Error('The move response was incomplete. Retry the pending move to confirm its outcome.');
      sessionStorage.removeItem(storageKey); setPending(null); try { await client.discover(); } catch { /* The confirmed move is authoritative; parent reloads inbox data. */ } onComplete();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The move could not be confirmed. Retry the pending move.'); }
    finally { setBusy(false); }
  }
  return <section className="mail-settings-subsection" aria-label="Move email address">
    <div><h4>Move {identity.email}</h4><p>Future incoming mail and permission to send from this address move to the destination inbox. Existing messages and drafts remain here.</p></div>
    <p>The destination must already have this domain verified. Both inboxes need current management permission. Finish active sends first. The current signature is preserved as an inline signature in the destination inbox.</p>
    {error && <p role="alert">{error}</p>}
    {pending ? <><p role="status">A move is awaiting confirmation. Retry the same operation before starting another move.</p><Button disabled={busy} onClick={() => void move(pending)}>{busy ? <><Spinner size="sm" /> Confirming…</> : 'Retry pending move'}</Button></> : <>
      {!targets.length ? <p>No other inboxes are available with management permission. Create an inbox or ask its manager for access.</p> : <label className="mail-settings-field">Destination inbox<NativeSelect value={destination} disabled={busy} onChange={event => { setDestination(event.target.value); setReview(null); }}><option value="">Choose an inbox</option>{targets.map(([id, account]) => <option key={id} value={id}>{account.name}</option>)}</NativeSelect></label>}
      {review ? <><p>Move <strong>{identity.email}</strong> from <strong>{client.session.accounts[accountId]?.name}</strong> to <strong>{client.session.accounts[review.destinationAccountId]?.name}</strong>? People with access to the destination will gain access to future mail for this address.</p><Button disabled={busy} onClick={() => void move(review)}>{busy ? 'Moving…' : 'Move email address'}</Button></> : <Button disabled={busy || !destination} onClick={() => void prepare()}>{busy ? 'Checking inboxes…' : 'Review move'}</Button>}
    </>}
    <Button variant="outline" disabled={busy} onClick={onClose}>{pending ? 'Close and keep pending move' : 'Cancel'}</Button>
  </section>;
}
