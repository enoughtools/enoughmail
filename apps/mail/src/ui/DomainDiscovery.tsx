import { NativeSelect } from '@rebnz/enough-ui/native-select';
import React, { useEffect, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, CardDescription, Badge } from '@open-cloud/ui';
import { Input } from '@rebnz/enough-ui/input';
import { Spinner } from '@rebnz/enough-ui/spinner';

type Domain = { zoneId: string; name: string; status: string };
type Inspection = { domain: Domain; mailExchangers: string[]; existingMail: boolean; delivery: 'enoughmail' | 'cloudflare' | 'other' | 'mixed' | 'none'; routingCheck: 'verified' | 'unavailable' | 'not-needed' };
type Check = { inspection?: Inspection; error?: string };
const deliveryLabels = { enoughmail: 'EnoughMail', cloudflare: 'Cloudflare Email Routing', other: 'Other mail provider', mixed: 'Mixed mail providers', none: 'No mail records' };
export default function DomainDiscovery({ accountId, connected, onChoose, busy = false }: { accountId: string; connected: string[]; busy?: boolean; onChoose: (domain: Domain) => void }) {
  const [domains, setDomains] = useState<Domain[]>([]), [page, setPage] = useState(1), [pages, setPages] = useState(1);
  const [deliveryFilter, setDeliveryFilter] = useState('all');
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [checks, setChecks] = useState<Record<string, Check>>({}), [selectedId, setSelectedId] = useState(''), [retry, setRetry] = useState(0);
  const selected = checks[selectedId]?.inspection;
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function request<T>(params: string): Promise<T> {
      const response = await fetch(`/apps/mail/api/domains/discovery?accountId=${encodeURIComponent(accountId)}&${params}`, { credentials: 'same-origin', signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || data.message || data.description || 'Domain discovery is unavailable.');
      return data;
    }
    setLoading(true); setError(''); setDomains([]); setChecks({}); setSelectedId(''); setQuery('');
    void (async () => {
      try {
        const data = await request<{ domains: Domain[]; pages: number }>(`page=${page}`);
        if (!active) return;
        setDomains(data.domains); setPages(data.pages);
        // Bound simultaneous requests, and show each result as soon as it is ready.
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, data.domains.length) }, async () => {
          while (active && next < data.domains.length) {
            const domain = data.domains[next++];
            let check: Check;
            try { check = { inspection: await request<Inspection>(`zoneId=${encodeURIComponent(domain.zoneId)}`) }; }
            catch (e) { check = { error: e instanceof Error ? e.message : 'Could not read mail records.' }; }
            if (active) setChecks(previous => ({ ...previous, [domain.zoneId]: check }));
          }
        }));
      } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Domain discovery is unavailable.'); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, [accountId, page, retry]);
  const filtered = domains.filter(domain => domain.name.toLowerCase().includes(query.toLowerCase()) && (deliveryFilter === 'all' || checks[domain.zoneId]?.inspection?.delivery === deliveryFilter || (deliveryFilter === 'unchecked' && checks[domain.zoneId]?.error)));
  function providerName(inspection: Inspection): string {
    if (inspection.delivery !== 'other') return deliveryLabels[inspection.delivery];
    const hosts = inspection.mailExchangers.join(' ').toLowerCase();
    if (hosts.includes('protection.outlook.com')) return 'Microsoft Outlook';
    if (hosts.includes('google.com') || hosts.includes('googlemail.com')) return 'Google Workspace';
    if (hosts.includes('protonmail.ch') || hosts.includes('protonmail.com')) return 'Proton Mail';
    if (hosts.includes('messagingengine.com')) return 'Fastmail';
    if (hosts.includes('zoho.')) return 'Zoho Mail';
    return deliveryLabels.other;
  }
  const checked = Object.keys(checks).length;
  const failures = Object.values(checks).filter(check => check.error).length;
  const totals = Object.values(checks).reduce((counts, check) => { if (check.inspection) counts[check.inspection.delivery]++; return counts; }, { enoughmail: 0, cloudflare: 0, other: 0, mixed: 0, none: 0 });
  return <Card className="mail-domain-discovery"><CardHeader><CardTitle>Discover your domains</CardTitle><CardDescription>All domains in your Cloudflare account, with their current mail provider. Review a domain to connect it to EnoughMail.</CardDescription></CardHeader><CardContent>
    {error && <div role="alert"><p>{error}</p><Button variant="outline" size="sm" onClick={() => setRetry(v => v + 1)}>Try again</Button></div>}
    <div className="mail-domain-summary"><p role="status">{loading ? <><Spinner size="sm" /> {domains.length ? `Checking mail records · ${checked} of ${domains.length}` : 'Finding your domains…'}</> : domains.length ? `${domains.length} domains checked${pages > 1 ? ` on page ${page}` : ''}` : ''}</p>{domains.length > 0 && <Button variant="outline" size="sm" disabled={loading} onClick={() => setRetry(v => v + 1)}>Refresh records</Button>}</div>
    {domains.length > 0 && <div className="mail-domain-overview" aria-label="Mail delivery summary"><span><strong>{totals.enoughmail}</strong> EnoughMail</span><span><strong>{totals.other}</strong> other providers</span><span><strong>{totals.cloudflare}</strong> Cloudflare routing</span><span><strong>{totals.none}</strong> without MX records</span>{totals.mixed > 0 && <span><strong>{totals.mixed}</strong> mixed providers</span>}</div>}
    {failures > 0 && <p role="alert">{failures} {failures === 1 ? 'domain could' : 'domains could'} not be checked. Refresh records to try again.</p>}
    {domains.length > 0 && <><div className="mail-domain-filters"><label className="mail-settings-field"><span>Search domains</span><Input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a domain…" /></label><label className="mail-settings-field"><span>Mail provider</span><NativeSelect value={deliveryFilter} onChange={event => setDeliveryFilter(event.target.value)}><option value="all">All domains ({domains.length})</option>{Object.entries(deliveryLabels).map(([value,label]) => <option key={value} value={value}>{label} ({totals[value as keyof typeof totals]})</option>)}{failures > 0 && <option value="unchecked">Could not check ({failures})</option>}</NativeSelect></label></div><ul className="mail-domain-candidates">{filtered.map(domain => {
      const check = checks[domain.zoneId], inspection = check?.inspection;
      return <li key={domain.zoneId}><div className="mail-domain-details"><div className="mail-domain-name"><strong>{domain.name}</strong>{connected.includes(domain.zoneId) && <Badge variant="outline">Added to EnoughMail</Badge>}{domain.status !== 'active' && <Badge variant="outline">DNS not active</Badge>}</div><div className="mail-domain-status"><Badge variant="outline">{inspection ? providerName(inspection) : check?.error ? 'Couldn’t check records' : 'Checking records…'}</Badge>{inspection?.routingCheck === 'unavailable' && <p className="mail-help">Cloudflare routing destination could not be verified.</p>}{check?.error && <p className="mail-help">{check.error}</p>}</div></div><Button variant="outline" size="sm" disabled={!inspection || busy} onClick={() => setSelectedId(selectedId === domain.zoneId ? '' : domain.zoneId)}>{selectedId === domain.zoneId ? 'Close review' : 'Review domain'}</Button>{selectedId === domain.zoneId && selected && <div className="mail-domain-review"><h4>Connect {selected.domain.name}</h4><p>{selected.delivery === 'enoughmail' ? 'Incoming mail routes to this EnoughMail installation.' : selected.existingMail ? 'Mail delivery already exists. Review the records above before changing providers.' : 'No mail delivery records were found. You can start setup here.'}</p>{selected.mailExchangers.length > 0 && <details className="mail-secondary-tools"><summary>Current mail delivery records ({selected.mailExchangers.length})</summary><ul className="mail-domain-mx-records">{selected.mailExchangers.map((host,index) => <li key={index}>{host}</li>)}</ul></details>}{!connected.includes(domain.zoneId) && <Button disabled={domain.status !== 'active' || busy} onClick={() => onChoose(selected.domain)}>Set up {selected.domain.name}</Button>}<p className="mail-help">{connected.includes(domain.zoneId) ? 'This domain has already been added to EnoughMail. Manage setup in the configured domains list above.' : 'Setup connects sending and receiving automatically when there are no conflicting records. Existing mail delivery is preserved and shown for review if it needs your attention.'}</p></div>}</li>;
    })}</ul>{filtered.length === 0 && <p>No matching domains.</p>}{pages > 1 && <div className="mail-inline-actions"><Button variant="outline" disabled={page <= 1 || loading} onClick={() => setPage(v => v - 1)}>Previous</Button><span>Page {page} of {pages}</span><Button variant="outline" disabled={page >= pages || loading} onClick={() => setPage(v => v + 1)}>Next</Button></div>}</>}
    {!loading && !error && domains.length === 0 && <p>No domains found in this Cloudflare account. Add a domain in Cloudflare, then try again.</p>}
  </CardContent></Card>;
}
