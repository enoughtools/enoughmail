import React, { useEffect, useState } from 'react';
import { Button } from '@open-cloud/ui';
import { NativeSelect } from '@rebnz/enough-ui/native-select';
import { approveDomainReview, loadDomains } from './DomainsSettings';
import { useMailConfirm } from './use-mail-confirm';
import DomainSetupReview from './DomainSetupReview';
import type { MailClient } from './jmap';

/** Enabling an existing domain in an inbox belongs alongside address assignment. */
export default function DomainForInbox({ client, accountId, configured, onChanged, onBusy }: { client: MailClient; accountId: string; configured: { id: string; name: string; catchAllAccountId?: string | null }[]; onChanged: () => void; onBusy: (busy: boolean) => void }) {
  const { confirm, dialog } = useMailConfirm();
  const [available, setAvailable] = useState<{ name: string; zoneId: string }[]>([]);
  const [selected, setSelected] = useState(''), [reviewId, setReviewId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void loadDomains(client).then(result => { if (active) setAvailable([...new Map(result.domains.filter(domain => domain.zoneId && !configured.some(existing => existing.name.toLowerCase() === domain.name.toLowerCase())).map(domain => [domain.name.toLowerCase(), { name: domain.name, zoneId: domain.zoneId! }])).values()]); });
    return () => { active = false; };
  }, [client, accountId, JSON.stringify(configured)]);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  async function enable() {
    const domain = available.find(value => value.name === selected); if (!domain || busy) return;
    setBusy(true); setError('');
    try {
      const result = await client.call<{ created?: Record<string, { id: string }> }>('Domain/set', { create: { addressDomain: { ...domain, enabled: true, catchAllAccountId: null } } }, accountId);
      const id = result.created?.addressDomain?.id;
      if (!id) throw new Error('Domain configuration could not be added. Reload before retrying.');
      setReviewId(id);
      await approveDomainReview({ ...domain, id, accountId });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Domain configuration could not be enabled.'); }
    finally { setBusy(false); }
  }
  if (!available.length && !configured.length && !reviewId && !error) return null;
  return <section className="mail-settings-subsection" aria-label="Use an existing domain">
    {dialog}
    {configured.length > 0 && <details className="mail-secondary-tools"><summary>Unmatched-address delivery</summary><p>Accept mail sent to unconfigured addresses at a domain in this inbox. Leave this off to reject unknown recipients.</p>{configured.map(domain => <div className="mail-inline-actions" key={domain.id}><span>{domain.name} · {domain.catchAllAccountId === accountId ? 'Enabled' : 'Off'}</span><Button variant="outline" size="sm" disabled={busy} onClick={async () => { const enabled = domain.catchAllAccountId === accountId; if (!await confirm(`${enabled ? 'Stop accepting' : 'Accept'} mail for unmatched addresses at ${domain.name} in ${client.session.accounts[accountId]?.name}?`)) return; setBusy(true); setError(''); try { await client.call('Domain/set', { update: { [domain.id]: { catchAllAccountId: enabled ? null : accountId } } }, accountId); onChanged(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Delivery could not be updated.'); } finally { setBusy(false); } }}>{domain.catchAllAccountId === accountId ? 'Disable' : 'Enable'}</Button></div>)}</details>}
    {error && <p role="alert">{error}</p>}
    {reviewId ? <DomainSetupReview client={client} accountId={accountId} domainId={reviewId} onBusy={setBusy} onCancel={() => { setReviewId(''); onChanged(); }} onComplete={result => { if (result.status === 'ready') { setReviewId(''); onChanged(); } }} /> : available.length > 0 ? <details className="mail-secondary-tools"><summary>Use a domain from another inbox</summary><p>Enable an existing domain for {client.session.accounts[accountId]?.name}. Review its setup, then add an address here or move one from another inbox. Existing address assignments stay in place.</p><label className="mail-settings-field">Domain<NativeSelect value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}><option value="">Choose a domain</option>{available.map(domain => <option key={domain.name} value={domain.name}>{domain.name}</option>)}</NativeSelect></label><Button variant="outline" disabled={busy || !selected} onClick={() => void enable()}>Review domain for this inbox</Button></details> : null}
  </section>;
}
