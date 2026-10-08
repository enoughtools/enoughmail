import React, { useEffect, useState } from 'react';
import { Button } from '@open-cloud/ui';
import { Input } from '@rebnz/enough-ui/input';
import { useMailConfirm } from './use-mail-confirm';
import { Spinner } from '@rebnz/enough-ui/spinner';
import DomainDiscovery from './DomainDiscovery';
import DomainSetupReview from './DomainSetupReview';
import type { GetResult, MailClient } from './jmap';

type Domain = { id: string; name: string; zoneId?: string; sendingVerified?: boolean; receivingConnected?: boolean };
type ScopedDomain = Domain & { accountId: string };
const capability = 'urn:enough:params:jmap:mail';
export function domainManagers(client: MailClient) {
  return Object.keys(client.session.accounts).filter(id => {
    const account = client.session.accounts[id];
    const actions = (account.accountCapabilities[capability] as { actions?: string[] } | undefined)?.actions || [];
    return !account.isReadOnly && (actions.includes('mail.manage') || actions.includes('mail.edit'));
  }).sort();
}

/** Aggregate visibility without merging account-owned records or their authority. */
export async function loadDomains(client: MailClient) {
  const results = await Promise.allSettled(Object.keys(client.session.accounts).map(async accountId => {
    const result = await client.call<GetResult<Domain>>('Domain/get', {}, accountId);
    return result.list.map(domain => ({ ...domain, accountId }));
  }));
  return {
    domains: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
    failures: results.flatMap((result, index) => result.status === 'rejected' ? [Object.keys(client.session.accounts)[index]] : []),
  };
}
export async function approveDomainReview(domain: ScopedDomain) {
  const params = new URLSearchParams({ domain: domain.name.toLowerCase(), zoneId: (domain.zoneId || '').toLowerCase(), accountId: domain.accountId });
  const read = await fetch(`/apps/mail/api/domains/approval?${params}`, { method: 'GET', credentials: 'same-origin' });
  const approval = await read.json() as { revision: number; message?: string };
  if (!read.ok) throw new Error(approval.message || 'Domain access could not be checked.');
  const response = await fetch('/apps/mail/api/domains/approve', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: domain.accountId, domain: domain.name.toLowerCase(), zoneId: (domain.zoneId || '').toLowerCase(), operationId: crypto.randomUUID(), expectedRevision: approval.revision }) });
  if (!response.ok) throw new Error('Domain access could not be approved. Reload and try again.');
}

export default function DomainsSettings({ client, onAddresses, onBusy }: { client: MailClient; onAddresses: () => void; onBusy: (busy: boolean) => void }) {
  const { confirm, dialog } = useMailConfirm();
  const [editing, setEditing] = useState<ScopedDomain | null>(null);
  const [manual, setManual] = useState({ name: '', zoneId: '' });
  const [domains, setDomains] = useState<ScopedDomain[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [review, setReview] = useState<ScopedDomain | null>(null);
  const [outcome, setOutcome] = useState<{ status: string; message: string } | null>(null);
  const managers = domainManagers(client);
  useEffect(() => {
    let active = true; setLoading(true);
    void loadDomains(client).then(result => { if (active) { setDomains(result.domains); setFailures(result.failures); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, revision]);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  async function start(domain: ScopedDomain) {
    setBusy(true); setError(''); setOutcome(null);
    try {
      // Approval remains scoped to the owning account; reviewing never replaces delivery.
      await approveDomainReview(domain);
      setReview(domain);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Domain setup could not be opened.'); }
    finally { setBusy(false); }
  }
  async function connect(domain: { name: string; zoneId: string }) {
    // New configuration has a stable permission boundary, independent of the inbox being viewed.
    const accountId = managers[0];
    if (!accountId || loading || failures.length) return;
    setBusy(true); setError('');
    try {
      const result = await client.call<{ created?: Record<string, { id: string }> }>('Domain/set', { create: { discovered: { name: domain.name, zoneId: domain.zoneId, enabled: true, catchAllAccountId: null } } }, accountId);
      const id = result.created?.discovered?.id;
      if (!id) throw new Error('The domain could not be added. Reload before trying again.');
      setRevision(value => value + 1);
      await start({ ...domain, id, accountId });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Domain setup could not start.'); }
    finally { setBusy(false); }
  }
  const groups = new Map<string, ScopedDomain[]>();
  for (const domain of domains) { const key = domain.name.toLowerCase(); groups.set(key, [...(groups.get(key) || []), domain]); }
  return <div className="mail-shared-domains">{dialog}
    {editing && <form onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); void client.call('Domain/set', { update: { [editing.id]: { name: editing.name, zoneId: editing.zoneId } } }, editing.accountId).then(() => { setEditing(null); setRevision(value => value + 1); }).catch(reason => setError(reason instanceof Error ? reason.message : 'Configuration could not be saved.')).finally(() => setBusy(false)); }}><h4>Edit domain configuration</h4><label className="mail-settings-field">Domain name<Input required value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label><label className="mail-settings-field">Cloudflare zone ID<Input required value={editing.zoneId || ''} onChange={event => setEditing({ ...editing, zoneId: event.target.value })} /></label><div className="mail-settings-form-footer"><Button disabled={busy}>Save changes</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button></div></form>}
    <div className="mail-domain-assignment-note"><p>Domains are shared setup for your mail installation. Manage email addresses and their inbox assignments in Email addresses.</p><Button variant="outline" size="sm" disabled={busy} onClick={onAddresses}>Manage email addresses</Button></div>
    {error && <p role="alert">{error}</p>}
    {failures.length > 0 && <div role="alert"><p>Couldn’t load domain configurations for {failures.map(id => client.session.accounts[id]?.name || id).join(', ')}. New setup is paused until all accessible configurations can be checked.</p><Button variant="outline" onClick={() => setRevision(value => value + 1)}>Retry loading domains</Button></div>}
    {outcome && <div className="mail-domain-setup-progress" data-state={outcome.status} role="status"><p>{outcome.message}</p><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Refresh status</Button></div>}
    {review && <DomainSetupReview key={`${review.accountId}:${review.id}`} client={client} accountId={review.accountId} domainId={review.id} onBusy={setBusy} onCancel={() => { setReview(null); setOutcome(null); }} onComplete={result => { setOutcome(result); setRevision(value => value + 1); if (result.status === 'ready') setReview(null); }} />}
    {loading ? <p role="status"><Spinner size="sm" /> Loading domains across your inboxes…</p> : <><h4 className="mail-settings-collection-heading">Configured domains <span>{groups.size}</span></h4><ul className="mail-settings-list">{[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, configurations]) => <li key={name}><div><strong>{name}</strong><span className="mail-setting-secondary">{configurations.every(domain => domain.sendingVerified && domain.receivingConnected) ? 'Ready to send and receive' : 'Setup needs attention'}</span>{configurations.length > 1 && <span className="mail-setting-secondary">{configurations.length} inbox configurations</span>}</div><div>{configurations.filter(domain => managers.includes(domain.accountId)).map(domain => <React.Fragment key={`${domain.accountId}:${domain.id}`}><Button variant="outline" size="sm" disabled={busy || !domain.zoneId} onClick={() => void start(domain)}>{configurations.length > 1 ? `Review ${client.session.accounts[domain.accountId]?.name}` : 'Review setup'}</Button><details className="mail-setting-domain-steps"><summary>Configuration</summary><div><Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(domain)}>Edit configuration</Button><Button variant="ghost" size="sm" disabled={busy} onClick={async () => { if (!await confirm(`Remove ${domain.name} from ${client.session.accounts[domain.accountId]?.name}? Addresses using this configuration will no longer be verified for sending.`, 'Remove domain configuration?', 'Remove')) return; setBusy(true); setError(''); try { await client.call('Domain/set', { destroy: [domain.id] }, domain.accountId); setRevision(value => value + 1); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Configuration could not be removed.'); } finally { setBusy(false); } }}>Remove configuration</Button></div></details></React.Fragment>)}</div></li>)}</ul>{!groups.size && <p>No configured domains yet. Choose a domain below to review its setup.</p>}</>}
    {managers[0] && !loading && !failures.length && <details className="mail-secondary-tools"><summary>Add a domain manually</summary><form onSubmit={event => { event.preventDefault(); void connect(manual); }}><label className="mail-settings-field">Domain name<Input required value={manual.name} onChange={event => setManual({ ...manual, name: event.target.value })} /></label><label className="mail-settings-field">Cloudflare zone ID<Input required value={manual.zoneId} onChange={event => setManual({ ...manual, zoneId: event.target.value })} /></label><Button disabled={busy}>Review setup</Button></form></details>}
    {managers[0] && !loading && !failures.length && <DomainDiscovery key={revision} accountId={managers[0]} connected={domains.map(domain => domain.zoneId || '')} busy={busy} onChoose={domain => void connect(domain)} />}
  </div>;
}
