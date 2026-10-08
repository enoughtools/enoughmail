import {useMailConfirm} from './use-mail-confirm';
import { NativeSelect } from '@rebnz/enough-ui/native-select';
import { Spinner } from '@rebnz/enough-ui/spinner';
import { Input } from '@rebnz/enough-ui/input';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@open-cloud/ui';
import { type MailClient } from './jmap';

interface Quota { id: string; used: number; reserved: number; blobCount: number; hardLimit: number | null }
interface Retention { accountId: string; state: string; trashRetentionDays: number; junkRetentionDays: number }
interface Lifecycle { accountId: string; status: 'active' | 'suspended' | 'deletionRequested' | 'purging' | 'deleted'; revision: number; purgeAfter: number | null }
interface Pending { method: string; args: Record<string, unknown>; notice: string }
function bytes(value: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let amount = value; let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[unit]}`;
}
function message(error: unknown) { return error instanceof Error ? error.message : 'Mail settings could not be loaded.'; }

export default function StorageSettings({ client, accountId, onChanged, mode = 'storage' }: { mode?: 'storage' | 'administration'; client: MailClient; accountId: string; onChanged: () => void }) {
 const {confirm,dialog:confirmationDialog}=useMailConfirm();
  const capability = client.session.accounts[accountId]?.accountCapabilities['urn:enough:params:jmap:mail'] as { actions?: string[] } | undefined;
  const manager = capability?.actions?.includes('mail.manage') === true;
  const [quota, setQuota] = useState<Quota | null>(null);
  const [retention, setRetention] = useState<Retention | null>(null);
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null);
  const [limit, setLimit] = useState('');
  const [limitUnit, setLimitUnit] = useState(1073741824);
  const [trashDays, setTrashDays] = useState('30');
  const [junkDays, setJunkDays] = useState('30');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const generation = useRef(0);
  const running = useRef(false);

  async function reload(version = generation.current) {
    if (mode === 'administration') { const value = manager ? await client.call<Lifecycle>('Lifecycle/get', {}, accountId) : null; if (version === generation.current) { if (value && value.accountId !== accountId) throw new Error('Inbox status belongs to another account.'); setLifecycle(value); } return; }
    const [q, r] = await Promise.all([
      client.call<{ accountId: string; list: Quota[] }>('Quota/get', {}, accountId),
      client.call<Retention>('Retention/get', {}, accountId),
    ]);
    if (version !== generation.current) return;
    if (q.accountId !== accountId || r.accountId !== accountId) throw new Error('Mail settings returned a different account. Reload your session.');
    const storage = q.list.find(value => value.id === 'storage');
    if (!storage) throw new Error('Mail storage information is unavailable.');
    setQuota(storage); setRetention(r); setLifecycle(null);
    setLimit(storage.hardLimit === null ? '' : String(storage.hardLimit));
    setTrashDays(String(r.trashRetentionDays)); setJunkDays(String(r.junkRetentionDays));
  }
  useEffect(() => {
    const version = ++generation.current;
    setQuota(null); setRetention(null); setLifecycle(null); setPending(null); setError(''); setNotice(''); setLoading(true); setBusy(false); running.current = false;
    void reload(version).catch(e => { if (version === generation.current) setError(message(e)); }).finally(() => { if (version === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [client, accountId, manager, mode]);

  async function refresh() {
    if (running.current) return;
    const version = generation.current; running.current = true; setBusy(true); setError('');
    try { await reload(version); }
    catch (e) { if (version === generation.current) setError(message(e)); }
    finally { if (version === generation.current) { running.current = false; setBusy(false); } }
  }
  async function mutate(operation: Pending) {
    if (!manager || running.current) return;
    const version = generation.current; running.current = true; setPending(operation); setBusy(true); setError(''); setNotice('');
    try {
      await client.call(operation.method, operation.args, accountId);
      if (version !== generation.current) return;
      setPending(null); setNotice(operation.notice); onChanged();
      await reload(version);
    } catch (e) {
      if (version !== generation.current) return;
      if ((e as { confirmed?: boolean })?.confirmed) setPending(null);
      setError(message(e));
    } finally { if (version === generation.current) { running.current = false; setBusy(false); } }
  }
  function operation(method: string, args: Record<string, unknown>, success: string) {
    // Freeze both the command and its revision until the server confirms the outcome.
    return { method, args: { ...args, operationId: crypto.randomUUID(), ...(client.states.get(`${accountId}:${method.split('/')[0]}`) ? { ifInState: client.states.get(`${accountId}:${method.split('/')[0]}`) } : {}) }, notice: success };
  }
  async function saveQuota(event: React.FormEvent) {
    event.preventDefault(); if (!quota || pending) return;
    const hardLimit = limit.trim() === '' ? null : Number(limit);
    if (hardLimit !== null && (!Number.isSafeInteger(hardLimit) || hardLimit < 1)) { setError('Enter a positive whole number of bytes, or leave the limit blank.'); return; }
    if (hardLimit !== null && (quota.hardLimit === null || hardLimit < quota.hardLimit) && !await confirm('Lower this storage limit? New uploads may be blocked when used and reserved storage reach the limit. Existing messages will not be deleted by this setting.')) return;
    void mutate(operation('Quota/set', { hardLimit }, 'Storage limit saved.'));
  }
  async function saveRetention(event: React.FormEvent) {
    event.preventDefault(); if (!retention || pending) return;
    const trashRetentionDays = Number(trashDays); const junkRetentionDays = Number(junkDays);
    if (![trashRetentionDays, junkRetentionDays].every(value => Number.isInteger(value) && value >= 1 && value <= 3650)) { setError('Choose whole retention periods from 1 to 3,650 days.'); return; }
    if ((trashRetentionDays < retention.trashRetentionDays || junkRetentionDays < retention.junkRetentionDays) && !await confirm('Shorten retention? Export messages you need first. When automatic expiration is enabled, older Trash or Junk messages may be permanently deleted sooner.')) return;
    void mutate(operation('Retention/set', { trashRetentionDays, junkRetentionDays }, 'Retention configuration saved.'));
  }
  async function changeLifecycle(action: 'suspend' | 'resume' | 'requestDeletion' | 'cancelDeletion') {
    if (!lifecycle || pending) return;
    const prompts = { suspend: 'Suspend this mail account? Mail operations will be disabled and pending or scheduled sends will be canceled.', resume: 'Resume this mail account?', requestDeletion: 'Request account deletion? Export your mail first. Mail operations and pending sends will stop. This requests deletion rather than erasing the account immediately; cancel before the displayed purge deadline.', cancelDeletion: 'Cancel the deletion request and reactivate this account? Previously canceled sends will not restart.' };
    if (!await confirm(prompts[action])) return;
    void mutate(operation('Lifecycle/set', { action, expectedRevision: lifecycle.revision }, 'Account status updated.'));
  }
  const locked = busy || loading || Boolean(pending);
  return <div className="mail-storage-settings">{confirmationDialog}
    
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {pending && <p role="status">This change has not been confirmed. Retry sends the same command safely. <Button variant="outline" disabled={busy || !manager} onClick={() => void mutate(pending)}>Retry pending change</Button></p>}
    <Button variant="outline" disabled={busy || loading} onClick={() => void refresh()}>Refresh settings</Button>
    {loading ? <p role="status"><Spinner size="sm" /> Loading storage settings…</p> : <>
      {mode === 'storage' && <><h4>Storage usage</h4>
      {quota && <>{quota.hardLimit !== null && <div className="mail-storage-meter"><progress max={quota.hardLimit} value={Math.min(quota.hardLimit,quota.used + quota.reserved)} aria-label="Storage used and reserved" /><span>{Math.round((quota.used + quota.reserved) / quota.hardLimit * 100)}% used or reserved</span></div>}<dl><dt>Used</dt><dd>{bytes(quota.used)}</dd><dt>Reserved for uploads</dt><dd>{bytes(quota.reserved)}</dd><dt>Stored blobs</dt><dd>{quota.blobCount.toLocaleString()}</dd><dt>Account limit</dt><dd>{quota.hardLimit === null ? 'No configured account limit' : bytes(quota.hardLimit)}</dd></dl></>}
      {manager && quota && <form className="mail-settings-form" onSubmit={saveQuota}><label className="mail-settings-field">Storage limit<Input type="number" min="0.001" step="any" disabled={locked} value={limit === '' ? '' : Number(limit) / limitUnit} onChange={event => setLimit(event.target.value === '' ? '' : String(Math.round(Number(event.target.value) * limitUnit)))} /></label><label className="mail-settings-field">Unit<NativeSelect value={limitUnit} disabled={locked} onChange={event => setLimitUnit(Number(event.target.value))}><option value="1073741824">GiB</option><option value="1048576">MiB</option><option value="1">Bytes</option></NativeSelect></label><p>Leave blank for no configured account limit. Cloudflare resource limits still apply. Used and reserved storage both count toward this limit.</p><Button type="submit" disabled={locked}>Save storage limit</Button></form>}
      <h4>Automatically clear discarded mail</h4>
      <p>Choose how long messages remain in Trash and Spam. These settings take effect when automatic expiration runs.</p>
      {retention && (manager ? <form className="mail-settings-form" onSubmit={saveRetention}><label className="mail-settings-field">Trash retention in days<Input type="number" min="1" max="3650" step="1" required disabled={locked} value={trashDays} onChange={event => setTrashDays(event.target.value)} /></label><label className="mail-settings-field">Spam retention in days<Input type="number" min="1" max="3650" step="1" required disabled={locked} value={junkDays} onChange={event => setJunkDays(event.target.value)} /></label><Button type="submit" disabled={locked}>Save retention</Button></form> : <p>Trash: {retention.trashRetentionDays} days. Junk: {retention.junkRetentionDays} days.</p>)}
      {!manager && <p>You can view storage and retention. Account management permission is required to change them.</p>}
      </>}{mode === 'administration' && !manager && <p>You need inbox management permission to change its service status.</p>}
      {mode === 'administration' && manager && lifecycle && <section aria-label="Mail account lifecycle"><h4>Account status</h4><p>{({ active: 'Active', suspended: 'Suspended', deletionRequested: 'Deletion requested', purging: 'Deletion in progress', deleted: 'Deleted' })[lifecycle.status]}</p>{lifecycle.purgeAfter !== null && <p>Deletion eligible after <time dateTime={new Date(lifecycle.purgeAfter).toISOString()}>{new Date(lifecycle.purgeAfter).toLocaleString()}</time>. Export your mail before requesting deletion; cancel the request before this deadline to retain the account.</p>}{lifecycle.status === 'active' && <Button variant="outline" disabled={locked} onClick={() => changeLifecycle('suspend')}>Suspend account</Button>}{lifecycle.status === 'suspended' && <Button variant="outline" disabled={locked} onClick={() => changeLifecycle('resume')}>Resume account</Button>}{['active', 'suspended'].includes(lifecycle.status) && <Button variant="outline" disabled={locked} onClick={() => changeLifecycle('requestDeletion')}>Request account deletion</Button>}{lifecycle.status === 'deletionRequested' && <Button variant="outline" disabled={locked || (lifecycle.purgeAfter !== null && lifecycle.purgeAfter <= Date.now())} onClick={() => changeLifecycle('cancelDeletion')}>Cancel deletion request</Button>}</section>}
    </>}
  </div>;
}
