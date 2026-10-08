import { Spinner } from '@rebnz/enough-ui/spinner';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@open-cloud/ui';
import { type MailClient } from './jmap';

interface Health { status: 'healthy' | 'renewRequired' | 'unavailable'; expiresAt: number | null; renewRequired: boolean }
interface HealthResponse { accountId: string; state?: string; oldState?: string; newState?: string; automationHealth: Health }
interface PendingRenewal { operationId: string; ifInState?: string }
const RENEW_WINDOW = 7 * 86400000;
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Automation authorization is unavailable.'; }
function checkedHealth(result: HealthResponse, accountId: string): Health {
  const health = result.automationHealth;
  if (result.accountId !== accountId || !health || !['healthy', 'renewRequired', 'unavailable'].includes(health.status) || typeof health.renewRequired !== 'boolean' || (health.expiresAt !== null && (!Number.isFinite(health.expiresAt) || health.expiresAt < 0 || health.expiresAt > 8640000000000000))) throw new Error('The mail server returned incomplete automation health. Refresh your session.');
  return health;
}

export default function AutomationHealth({ client, accountId }: { client: MailClient; accountId: string }) {
  const capability = client.session.accounts[accountId]?.accountCapabilities['urn:enough:params:jmap:mail'] as { actions?: string[] } | undefined;
  const canRenew = capability?.actions?.includes('mail.manage') === true && capability.actions.includes('mail.send');
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<PendingRenewal | null>(null);
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const running = useRef(false);
  async function load(version = generation.current) {
    const response = await client.call<HealthResponse>('Settings/get', {}, accountId);
    if (version === generation.current) { setHealth(checkedHealth(response, accountId)); setNow(Date.now()); }
  }
  useEffect(() => {
    const version = ++generation.current;
    setHealth(null); setPending(null); setLoading(true); setBusy(false); setError(''); setNotice(''); running.current = false;
    void load(version).catch(e => { if (version === generation.current) setError(errorMessage(e)); }).finally(() => { if (version === generation.current) setLoading(false); });
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => { window.clearInterval(timer); generation.current++; };
  }, [client, accountId, canRenew]);
  async function refresh() {
    if (running.current) return;
    const version = generation.current; running.current = true; setBusy(true); setError('');
    try { await load(version); }
    catch (e) { if (version === generation.current) setError(errorMessage(e)); }
    finally { if (version === generation.current) { running.current = false; setBusy(false); } }
  }
  async function renew(command: PendingRenewal) {
    if (!canRenew || running.current) return;
    const version = generation.current; running.current = true; setPending(command); setBusy(true); setError(''); setNotice('');
    try {
      const response = await client.call<HealthResponse>('Settings/renew', { ...command }, accountId);
      if (version !== generation.current) return;
      setHealth(checkedHealth(response, accountId)); setNow(Date.now()); setPending(null);
      setNotice('Automation authorization renewed. Review its current expiry below.');
    } catch (e) {
      if (version !== generation.current) return;
      if ((e as { confirmed?: boolean })?.confirmed) setPending(null);
      setError(errorMessage(e));
    } finally { if (version === generation.current) { running.current = false; setBusy(false); } }
  }
  function beginRenewal() {
    if (pending || !canRenew) return;
    const state = client.states.get(`${accountId}:Settings`);
    void renew({ operationId: crypto.randomUUID(), ...(state ? { ifInState: state } : {}) });
  }
  const stopped = health && (health.status === 'unavailable' || health.expiresAt === null || health.expiresAt <= now);
  const needsRenewal = health && (health.renewRequired || health.status === 'renewRequired' || (health.expiresAt !== null && health.expiresAt <= now + RENEW_WINDOW));
  return <section className="mail-automation-health" aria-label="Automation authorization">
    <h4>Automatic sending</h4>
    <p>Keep forwarding, vacation replies and reminders authorized to send while you are away.</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p role="status"><Spinner size="sm" /> Loading automation health…</p> : health && <>
      <p className="mail-automation-status" role="status" data-state={stopped ? 'expired' : needsRenewal ? 'renew' : 'healthy'}>{stopped ? 'Automation sending authorization is unavailable or expired. Renew it to allow unattended sending again.' : needsRenewal ? 'Automation authorization needs renewal. Sending remains authorized until the expiry shown below.' : 'Automation sending authorization is current.'}</p>
      {health.expiresAt !== null ? <p>Expires <time dateTime={new Date(health.expiresAt).toISOString()}>{new Date(health.expiresAt).toLocaleString()}</time>. Renewal is requested within seven days of expiry.</p> : <p>No authorization expiry is available.</p>}
      <details className="mail-secondary-tools"><summary>How automatic sending works</summary><p>Authorization expires and must be renewed explicitly. Individual rules must also be enabled and permitted; this status does not confirm that a rule has run.</p></details>
    </>}
    {pending && <p role="status">The renewal outcome has not been confirmed. Retry uses the same request. <Button variant="outline" disabled={busy || !canRenew} onClick={() => void renew(pending)}>Retry renewal</Button></p>}
    {canRenew ? <Button variant="outline" disabled={busy || loading || Boolean(pending) || !health} onClick={beginRenewal}>{busy ? 'Working…' : health?.status === 'unavailable' ? 'Connect automation authorization' : 'Renew automation authorization'}</Button> : <p>Account management and sending permissions are both required to renew automation authorization.</p>}{' '}
    <Button variant="outline" disabled={busy || loading} onClick={() => void refresh()}>Refresh health</Button>
  </section>;
}
