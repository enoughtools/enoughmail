import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@open-cloud/ui';
import { Alert, AlertDescription, AlertTitle } from '@rebnz/enough-ui/alert';
import { Spinner } from '@rebnz/enough-ui/spinner';
import MailCheckbox from './MailCheckbox';
import type { MailClient } from './jmap';
import type { DomainSetupProposal, DnsRecord, DomainRoutingRule } from '../server/domains';
import './domain-setup-review.css';

type Recovery = { id: string; status: string; createdAt: string; completed: string[]; proposal: DomainSetupProposal };
type RecoveryProgress = Omit<Recovery, 'proposal'> & { originalRecoveryId: string; previousRecoveryId?: string };
type SetupDiagnostics = { stage: string; step: string; code: string; providerCodes?: number[] };
type SetupResult = { status: 'review' | 'ready' | 'blocked' | 'pending'; message: string; newState: string; proposal?: DomainSetupProposal; recovery?: Recovery; recoveryProgress?: RecoveryProgress; recoveryId?: string; diagnostics?: SetupDiagnostics; checks?: { type: string; name: string; status: 'ready' | 'missing' | 'conflict' }[]; warnings?: string[]; plan?: { conflicts: string[]; warnings: string[] } };
type Props = { client: MailClient; accountId: string; domainId: string; onComplete?: (result: SetupResult) => void; onCancel?: () => void; onBusy?: (busy: boolean) => void };

function download(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function RecordList({ records }: { records: DnsRecord[] }) {
  return <ul className="mail-setup-records">{records.map((record, index) => <li key={`${record.id || record.name}-${index}`}><span>{record.type} · {record.name}{record.priority !== undefined ? ` · priority ${record.priority}` : ''}</span><code>{record.content}</code></li>)}</ul>;
}

function RouteSummary({ rule, title }: { rule: DomainRoutingRule; title: string }) {
  return <div className="mail-setup-route"><h4>{title}</h4><p>{rule.enabled ? 'Enabled' : 'Disabled'}{rule.name ? ` · ${rule.name}` : ''}</p><dl><div><dt>Applies to</dt><dd>{rule.matchers.map(matcher => matcher.type === 'all' ? 'All incoming addresses' : matcher.value || 'Recipient rule').join(', ')}</dd></div><div><dt>Delivery</dt><dd>{rule.actions.map(action => action.type === 'forward' ? `Forward to ${action.value?.join(', ') || 'a destination'}` : action.type === 'worker' ? `Worker: ${action.value?.join(', ') || 'configured Worker'}` : action.type === 'drop' ? 'Drop incoming mail' : action.type).join('; ')}</dd></div></dl></div>;
}

const setupStages: Record<string, string> = { review: 'Review current setup', dns: 'Update DNS records', verification: 'Verify sending', receiving: 'Connect receiving', complete: 'Complete' };
const setupSteps: Record<string, string> = { inspectRouting: 'Check delivery routes', prepareSending: 'Prepare sending domain', planDns: 'Review DNS changes', applyDns: 'Apply DNS changes', removeDns: 'Remove reviewed DNS records', disableRecipientRule: 'Switch reviewed recipient routes', verifyDns: 'Verify DNS records', verifySending: 'Verify sending domain', registerAddresses: 'Register email addresses', connectRouting: 'Connect delivery routes', enableRoutingDns: 'Enable routing DNS', setCatchAll: 'Connect the receiving route', verifyFinalDns: 'Verify final DNS records', verifyRouting: 'Verify receiving route' };
function SetupStatus({ value }: { value: SetupResult }) {
  const diagnostics = value.diagnostics;
  const code = diagnostics && /^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(diagnostics.code) ? diagnostics.code : null;
  const providerCodes = diagnostics?.providerCodes?.filter(value => Number.isSafeInteger(value) && value >= 0).slice(0, 8) || [];
  const checks = value.checks?.filter(check => check.status !== 'ready') || [];
  const warnings = [...new Set([...(value.warnings || []), ...(value.plan?.warnings || [])])];
  return <Alert className={`mail-setup-callout ${value.status === 'ready' ? '' : 'mail-setup-warning'}`} role={value.status === 'blocked' ? 'alert' : 'status'}>
    <AlertTitle>{value.status === 'ready' ? 'Domain connected' : value.status === 'blocked' ? 'Setup is blocked' : 'Setup is not finished'}</AlertTitle>
    <AlertDescription>
      <p>{value.message}</p>
      {value.recoveryId && !value.recovery && <p>The original DNS records and routes were saved before changes. Refresh the review to download that backup for manual recovery.</p>}
      {!!value.plan?.conflicts.length && <ul>{value.plan.conflicts.map((conflict, index) => <li key={index}>{conflict}</li>)}</ul>}
      {checks.length > 0 && <ul aria-label="DNS records awaiting verification">{checks.map((check, index) => <li key={index}>{check.type} · {check.name}: {check.status === 'missing' ? 'not found yet' : 'conflicting value'}</li>)}</ul>}
      {warnings.length > 0 && <details><summary>DNS verification notes</summary><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      {diagnostics && <details><summary>Setup details</summary><dl className="mail-setup-diagnostics">
        {setupStages[diagnostics.stage] && <div><dt>Stage</dt><dd>{setupStages[diagnostics.stage]}</dd></div>}
        {setupSteps[diagnostics.step] && <div><dt>Operation</dt><dd>{setupSteps[diagnostics.step]}</dd></div>}
        {code && <div><dt>Result code</dt><dd><code>{code}</code></dd></div>}
        {providerCodes.length > 0 && <div><dt>Cloudflare codes</dt><dd>{providerCodes.join(', ')}</dd></div>}
      </dl></details>}
    </AlertDescription>
  </Alert>;
}

export default function DomainSetupReview({ client, accountId, domainId, onComplete, onCancel, onBusy }: Props) {
  const [review, setReview] = useState<SetupResult | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [recoveryProgress, setRecoveryProgress] = useState<RecoveryProgress | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true), [applying, setApplying] = useState(false);
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const applyPending = useRef(false);
  useEffect(() => { setRecovery(null); setRecoveryProgress(null); setApplying(false); applyPending.current = false; }, [client, accountId, domainId]);
  useEffect(() => {
    let active = true;
    generation.current++;
    setReview(null); setResult(null); setAcknowledged(false); setLoading(true); setError('');
    void (async () => {
      await client.call('Domain/get', {}, accountId);
      if (!active) return;
      return client.call<SetupResult>('Domain/setup', { domainId, reviewOnly: true }, accountId);
    })().then(data => {
      if (!active || !data) return;
      setReview(data); if (data.recovery) setRecovery(data.recovery);
      if (data.recoveryProgress) setRecoveryProgress(data.recoveryProgress);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'The domain could not be reviewed.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; generation.current++; };
  }, [client, accountId, domainId, refresh]);
  useEffect(() => { onBusy?.(applying); return () => onBusy?.(false); }, [applying, onBusy]);
  const proposal = review?.proposal;
  const replacing = Boolean(proposal && (proposal.removeRecords.length || proposal.disableRules.length || proposal.previousCatchAll.enabled));
  async function apply() {
    if (!proposal || !acknowledged || proposal.blockers.length || applyPending.current || !review?.newState) return;
    applyPending.current = true;
    setApplying(true); setError('');
    // One explicit command per reviewed plan. A lost response requires a new
    // provider review rather than blindly repeating destructive setup.
    const args = { domainId, reviewedProposal: proposal, ifInState: review.newState, operationId: crypto.randomUUID() };
    const applyingGeneration = generation.current;
    try {
      const data = await client.call<SetupResult>('Domain/setup', args, accountId);
      if (applyingGeneration !== generation.current) return;
      setResult(data); setReview(null); setAcknowledged(false);
      if (data.recovery) setRecovery(data.recovery);
      if (data.recoveryProgress) setRecoveryProgress(data.recoveryProgress);
      onComplete?.(data);
    } catch (reason) {
      if (applyingGeneration !== generation.current) return;
      setReview(null); setAcknowledged(false);
      setError(`${reason instanceof Error ? reason.message : 'The setup response could not be confirmed.'} Changes may already have applied. Review the current records before continuing. Any saved setup backup remains available after refreshing the review.`);
    } finally { if (applyingGeneration === generation.current) { applyPending.current = false; setApplying(false); } }
  }
  return <section className="mail-domain-setup-review" aria-label="Review domain setup" aria-busy={loading || applying}>
    <header><div><h3>{proposal ? `Connect ${proposal.domain}` : 'Review domain setup'}</h3><p>Check the delivery changes before connecting this domain to EnoughMail.</p></div>{onCancel && <Button variant="outline" size="sm" disabled={applying} onClick={onCancel}>Close review</Button>}</header>
    {loading && <p role="status"><Spinner size="sm" /> Checking current DNS and delivery routes…</p>}
    {error && <div className="mail-setup-callout mail-setup-warning" role="alert"><p>{error}</p></div>}
    {recovery && <div className="mail-setup-backup"><div><strong>Original setup backup</strong><p>Saved {new Date(recovery.createdAt).toLocaleString()} before adoption. Includes the original records and routes for manual recovery.</p></div><Button variant="outline" size="sm" disabled={applying} onClick={() => download(recovery, `${recovery.proposal.domain}-previous-mail-setup.json`)}>Download backup</Button></div>}
    {recoveryProgress && <div className="mail-setup-backup" aria-label="Latest setup attempt"><div><strong>Latest setup attempt</strong><p>{recoveryProgress.status === 'complete' ? 'Complete' : recoveryProgress.status === 'applied' ? 'Changes applied; verification may still be pending' : recoveryProgress.status === 'unknown' ? 'Outcome not confirmed' : 'Not finished'} · {recoveryProgress.completed.length} confirmed {recoveryProgress.completed.length === 1 ? 'operation' : 'operations'}. Started {new Date(recoveryProgress.createdAt).toLocaleString()}.</p></div></div>}
    {proposal && <>
      <div className={`mail-setup-callout ${replacing ? 'mail-setup-warning' : ''}`}><strong>{replacing ? 'Existing mail delivery will be replaced' : 'Connect mail delivery'}</strong><p>{replacing ? 'Existing mail delivery will be replaced and may be interrupted while changes propagate. The DNS records shown below will be updated first. Forwarding routes stay active until DNS and sending verification pass, then receiving switches to EnoughMail. Existing messages stay with their current provider.' : 'EnoughMail will add the required sending records and connect incoming mail. Assign email addresses to inboxes in Email addresses to accept mail.'}</p></div>
      <dl className="mail-setup-summary"><div><dt>DNS records to add</dt><dd>{proposal.plan.changes.filter(change => change.kind === 'create').length}</dd></div><div><dt>DNS records to update</dt><dd>{proposal.plan.changes.filter(change => change.kind === 'update').length}</dd></div><div><dt>DNS records to remove</dt><dd>{proposal.removeRecords.length}</dd></div><div><dt>Existing routes to disable</dt><dd>{proposal.disableRules.length}</dd></div></dl>
      <p className="mail-setup-route-summary">Incoming mail will route to EnoughMail. Unconfigured addresses will be rejected unless catch-all delivery is enabled.</p>
      {proposal.blockers.length > 0 && <div className="mail-setup-callout mail-setup-warning" role="alert"><strong>Resolve these issues before connecting</strong><ul>{proposal.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul></div>}
      <details><summary>Review exact DNS changes</summary>
        {proposal.removeRecords.length > 0 && <><h4>Remove these existing records</h4><RecordList records={proposal.removeRecords} /></>}
        {proposal.plan.changes.map((change, index) => <div key={index}><h4>{change.kind === 'create' ? 'Add record' : 'Update record'}</h4>{change.previous && <><p>Previous value</p><RecordList records={[change.previous]} /></>}<p>New value</p><RecordList records={[change.record]} /></div>)}
        {!proposal.plan.changes.length && !proposal.removeRecords.length && <p>The required DNS records are already present.</p>}
      </details>
      <details><summary>Review delivery routes</summary><RouteSummary rule={proposal.previousCatchAll} title="Previous catch-all" />{proposal.disableRules.map((rule, index) => <RouteSummary key={rule.id || index} rule={rule} title="Disable existing recipient route" />)}<div className="mail-setup-route"><h4>New catch-all</h4><p>Connect incoming mail to EnoughMail. Its address settings determine which recipients accept mail.</p></div></details>
      {proposal.plan.warnings.length > 0 && <details><summary>DNS verification notes</summary><ul>{proposal.plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <div className="mail-setup-backup"><p>Save this review before applying. It includes the previous DNS records and routes for manual rollback; it does not restore them automatically.</p><Button variant="outline" size="sm" disabled={applying} onClick={() => download(proposal, `${proposal.domain}-mail-setup-review.json`)}>Download this review</Button></div>
      {!proposal.blockers.length && <label className="mail-setup-acknowledgment"><MailCheckbox checked={acknowledged} disabled={applying} onChange={event => setAcknowledged(event.target.checked)} /><span>I reviewed these changes and approve connecting this domain to EnoughMail{replacing ? ', including replacing its existing mail delivery' : ''}.</span></label>}
      <div className="mail-setup-actions"><Button disabled={applying || !acknowledged || proposal.blockers.length > 0} onClick={() => void apply()}>{applying ? <><Spinner size="sm" /> Connecting domain…</> : 'Apply reviewed changes'}</Button><Button variant="outline" disabled={applying} onClick={() => setRefresh(value => value + 1)}>Refresh review</Button></div>
    </>}
    {(result || (review && !proposal)) && <SetupStatus value={(result || review)!} />}
    {!loading && !proposal && <div className="mail-setup-actions"><Button variant="outline" disabled={applying} onClick={() => setRefresh(value => value + 1)}>{result ? 'Check current setup and backup' : 'Review current records'}</Button></div>}
  </section>;
}
