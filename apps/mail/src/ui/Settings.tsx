import {useMailConfirm} from './use-mail-confirm';
import BrowserNotifications from './BrowserNotifications';
import MailCheckbox from './MailCheckbox';
import { NativeSelect } from '@rebnz/enough-ui/native-select';
import './settings.css';
import { Input } from '@rebnz/enough-ui/input';
import { Textarea } from '@rebnz/enough-ui/textarea';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import DomainsSettings from './DomainsSettings';
import DomainForInbox from './DomainForInbox';
import IdentityTransfer, { pendingIdentityTransfers } from './IdentityTransfer';
import { Spinner } from '@rebnz/enough-ui/spinner';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@rebnz/enough-ui/empty';
import { Button } from '@open-cloud/ui';
import StorageSettings from './StorageSettings';
import AutomationHealthPanel from './AutomationHealth';
import OfflinePreferences from './OfflinePreferences';
import RuleFields,{buildRuleValue} from './RuleFields';
import ContactPortability from './ContactPortability';
import Migration from './Migration';
import ClientAccess from './ClientAccess';
import SignatureSettings from './SignatureSettings';
import { PreferenceAutosave, type PreferenceSaveStatus } from './preference-autosave';
import type { MailSignature } from '../domain/signatures';
import {useDialog} from './use-dialog';
import { MailClient, type GetResult, type Mailbox } from './jmap';

type AutomationHealth = { status: 'healthy' | 'renewRequired' | 'unavailable'; expiresAt: number | null; renewRequired: boolean };
type RuleApplication = { jobId: string; processed: number; total: number | null; status: 'running' | 'paused' | 'complete' | 'canceled'; pendingArgs: Record<string, unknown> };
type Entry = { id: string; [key: string]: unknown };
type Section = 'Accounts' | 'Mailboxes' | 'Identities' | 'Rules' | 'Contacts' | 'Domains' | 'Preferences' | 'Templates' | 'Vacation reply' | 'Delegation' | 'Client access' | 'Migration' | 'Offline' | 'Storage & retention' | 'Signatures' | 'Administration' | 'Notifications';
const sections: Section[] = ['Accounts', 'Mailboxes', 'Identities', 'Rules', 'Contacts', 'Domains', 'Preferences', 'Templates', 'Vacation reply', 'Delegation','Client access','Migration','Offline','Storage & retention','Signatures','Administration','Notifications'];
const entityNames: Partial<Record<Section, string>> = { Mailboxes: 'Mailbox', Identities: 'Identity', Rules: 'Rule', Contacts: 'Contact', Templates: 'Template', 'Vacation reply': 'VacationResponse' };
const itemLabels: Partial<Record<Section, string>> = { Domains: 'domain', Identities: 'email address', Mailboxes: 'folder or label', Contacts: 'contact', Rules: 'rule', Templates: 'template', 'Vacation reply': 'vacation reply' };
const sectionDescriptions: Partial<Record<Section, string>> = {
  Accounts: 'Separate personal, work and shared mail into inboxes, each with its own addresses and access.',
  Domains: 'Connect your domains, check existing delivery and set up sending and receiving.',
  Signatures: 'Create named, formatted signatures. Choose a default for each email address or select any signature while composing.',
  Administration: 'Manage this inbox’s service status separately from everyday mail preferences.',
  Identities: 'Assign email addresses to inboxes and choose the name and signature you send with.',
  Rules: 'Automatically sort incoming mail. Rules run in the order shown below.',
  Preferences: 'Make reading, sending and forwarding work the way you want.',
  Delegation: 'Give workspace members access to this inbox with only the permissions they need.',
  'Client access': 'Connect a compatible JMAP app with credentials you can expire or revoke.',
  Migration: 'Bring your existing mail with you or download an archive of this inbox.',
  Offline: 'Choose what this browser keeps available when you are offline.',
  'Storage & retention': 'Monitor storage, choose how long discarded mail is kept and manage this inbox.',
  Mailboxes: 'Organize mail with your own folders and labels. Standard mail folders are always available.',
  Contacts: 'Keep the people you write to close at hand. Saved addresses appear as you compose.',
  Templates: 'Save messages you write often, then insert them while composing.',
  'Vacation reply': 'Let people know when you are away. Choose a message and when it should run.',
};
export default function Settings({ client, accountId: initialAccountId, onClose, initialSection, initialRuleQuery }: { client: MailClient; accountId: string; onClose: () => void; initialSection?: Section; initialRuleQuery?: string }) {
 const [accountId, setAccountId] = useState(initialAccountId || Object.keys(client.session.accounts)[0] || '');
 const {confirm,dialog:confirmationDialog}=useMailConfirm();
  const dialogRef=useRef<HTMLElement>(null);useDialog(dialogRef, false);
  const [section, setSection] = useState<Section>(accountId ? initialSection || 'Domains' : 'Accounts');
  const [filter, setFilter] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [verifiedForwardingAddresses, setVerifiedForwardingAddresses] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [ruleApplication, setRuleApplication] = useState<RuleApplication | null>(null);
  const ruleSeeded = useRef(false);
  const ruleRun = useRef({ running: false, stop: false });
  const ruleJobKey = `enough-mail:rule-job:${encodeURIComponent(client.session.organizationId)}:${encodeURIComponent(client.session.workspaceId)}:${encodeURIComponent(client.session.actorId)}:${encodeURIComponent(accountId)}`;
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scopeAddresses, setScopeAddresses] = useState<{ status: 'loading' | 'ready' | 'error'; addresses: string[] }>({ status: 'loading', addresses: [] });
  const [configuredDomains, setConfiguredDomains] = useState<Entry[]>([]);
  const [signatureLibrary, setSignatureLibrary] = useState<MailSignature[]>([]);
  const [autoStatus, setAutoStatus] = useState<PreferenceSaveStatus>('saved');
  const [autoError, setAutoError] = useState('');
  const preferenceForm = useRef<HTMLFormElement>(null);
  const [preferences, setPreferences] = useState<Record<string, unknown>>({});
  const [transferIdentity, setTransferIdentity] = useState<Entry | null>(null);
  const [automationHealth, setAutomationHealth] = useState<AutomationHealth | null>(null);
  const [forwardingVerified, setForwardingVerified] = useState(false);
  const loadSequence = useRef(0);
  const entity = entityNames[section];
  const account = client.session.accounts[accountId];
  const actions = (account?.accountCapabilities['urn:enough:params:jmap:mail'] as { actions?: string[] } | undefined)?.actions || [];
  const permits = (action: string) => account?.isReadOnly !== true && (actions.includes(action) || actions.includes('mail.edit'));
  const canManage = permits('mail.manage');
  const canEdit = permits(section === 'Rules' || section === 'Mailboxes' ? 'mail.organize' : 'mail.manage');
  const preferenceAutosave = useMemo(() => new PreferenceAutosave(args => client.call('Settings/set', args, accountId), () => client.states.get(`${accountId}:Settings`), (status, message) => { setAutoStatus(status); setAutoError(message || ''); }), [client, accountId]);
  useEffect(() => { preferenceAutosave.activate(); return () => preferenceAutosave.dispose(); }, [preferenceAutosave]);
  useEffect(() => { if (section === 'Preferences' && !loading && !loadFailed && canManage) { if (preferenceForm.current?.checkValidity() === false) { setAutoStatus('waiting'); return; } preferenceAutosave.update(preferences); } }, [preferences, section, loading, loadFailed, canManage, preferenceAutosave]);
  useEffect(() => { if (!accountId) return; let active = true; setScopeAddresses({ status: 'loading', addresses: [] }); void client.call<GetResult<Entry>>('Identity/get', {}, accountId).then(result => { if (active) setScopeAddresses({ status: 'ready', addresses: result.list.map(value => String(value.email || '')).filter(Boolean) }); }).catch(() => { if (active) setScopeAddresses({ status: 'error', addresses: [] }); }); return () => { active = false; }; }, [client, accountId, section]);
  async function leavePreferences() { if (section !== 'Preferences' || loading || loadFailed || !canManage) return true; if (preferenceForm.current?.checkValidity() === false) { preferenceForm.current.reportValidity(); return false; } preferenceAutosave.update(preferences); return preferenceAutosave.flush(); }
  async function navigateSection(next: Section) { if (await leavePreferences()) setSection(next); }
  async function closeSettings() { if (await leavePreferences()) onClose(); }

  useEffect(() => { try { const value = sessionStorage.getItem(ruleJobKey); if (value) { const saved = JSON.parse(value) as RuleApplication; if (saved.jobId && saved.pendingArgs) setRuleApplication({ ...saved, status: saved.status === 'running' ? 'paused' : saved.status }); } } catch { /* The server job remains resumable in this open session. */ } return () => { ruleRun.current.stop = true; }; }, [ruleJobKey]);
  function saveRuleProgress(value: RuleApplication) { setRuleApplication(value); try { if (value.status === 'complete' || value.status === 'canceled') sessionStorage.removeItem(ruleJobKey); else sessionStorage.setItem(ruleJobKey, JSON.stringify(value)); } catch { /* Storage restrictions do not affect server execution. */ } }
  async function runRuleApplication(initial: RuleApplication) {
    if (ruleRun.current.running) return; ruleRun.current = { running: true, stop: false }; setBusy(true); setError(''); setNotice(''); let progress = initial;
    try {
      while (!ruleRun.current.stop) {
        saveRuleProgress({ ...progress, status: 'running' });
        const result = await client.call<{ jobId: string; total: number; processed: number; hasMore: boolean }>('Rule/apply', progress.pendingArgs, accountId);
        const state = client.states.get(`${accountId}:Rule`);
        progress = { jobId: result.jobId, total: result.total, processed: result.processed, status: result.hasMore ? 'running' : 'complete', pendingArgs: { jobId: result.jobId, operationId: crypto.randomUUID(), ...(state ? { ifInState: state } : {}) } };
        saveRuleProgress(progress);
        if (!result.hasMore) { setNotice(`Rule application completed. Processed ${result.processed} messages.`); break; }
      }
      if (ruleRun.current.stop && progress.status !== 'complete') { progress = { ...progress, status: 'paused' }; saveRuleProgress(progress); setNotice('Rule application paused. Resume to process the remaining messages.'); }
    } catch (e) {
      if (e instanceof Error && /stateMismatch/.test(e.message)) {
        try { await client.call('Rule/get', {}, accountId); const state = client.states.get(`${accountId}:Rule`); progress = { ...progress, pendingArgs: { ...progress.pendingArgs, operationId: crypto.randomUUID(), ...(state ? { ifInState: state } : {}) } }; } catch { /* Preserve the original page if state refresh fails. */ }
      }
      saveRuleProgress({ ...progress, status: 'paused' }); setError(e instanceof Error ? `${e.message}. Rule application paused; resume to retry the pending page.` : 'Rule application paused. Resume to retry the same page.');
    }
    finally { ruleRun.current.running = false; setBusy(false); }
  }
  function startRuleApplication(entry: Entry) { const operationId = crypto.randomUUID(); const state = client.states.get(`${accountId}:Rule`); void runRuleApplication({ jobId: operationId, processed: 0, total: null, status: 'running', pendingArgs: { ruleIds: [entry.id], operationId, ...(state ? { ifInState: state } : {}) } }); }
  async function cancelRuleApplication() {
    if (!ruleApplication || ruleRun.current.running) return; setBusy(true); setError('');
    try { await client.call('Rule/cancel', { jobId: ruleApplication.jobId, operationId: crypto.randomUUID() }, accountId); saveRuleProgress({ ...ruleApplication, status: 'canceled' }); setNotice('Rule application canceled. Changes already applied remain; message content is preserved.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not cancel this rule application. Resume or retry cancellation.'); }
    finally { setBusy(false); }
  }

  async function load() {
    const sequence = ++loadSequence.current;
    setLoading(true); setLoadFailed(false); setError('');
    try {
      if (section === 'Preferences') {
        const response = await client.call<{ settings: Record<string, unknown>; automationHealth?: AutomationHealth }>('Settings/get', {}, accountId);
        if (sequence === loadSequence.current) { const { id: _id, ...settings } = response.settings || {}; preferenceAutosave.reset(settings); setPreferences(settings); setAutomationHealth(response.automationHealth || null); }
      } else if (entity && section !== 'Domains') {
        const response = await client.call<GetResult<Entry>>(`${entity}/get`, {}, accountId);
        if (sequence === loadSequence.current) {
          setEntries(section === 'Rules' ? [...response.list].sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) : section === 'Mailboxes' ? [...response.list].sort((a,b) => Number(Boolean(b.role)) - Number(Boolean(a.role))) : response.list);
          if (section === 'Vacation reply' && canEdit) {
            const entry = response.list[0];
            setEditing(entry?.id || 'new');
            setFields({ subject: String(entry?.subject || ''), textBody: String(entry?.textBody || ''), isEnabled: String(entry?.isEnabled === true), fromDate: typeof entry?.fromDate === 'string' ? localDateTime(entry.fromDate) : '', toDate: typeof entry?.toDate === 'string' ? localDateTime(entry.toDate) : '' });
          }
        }
      }
      if (section === 'Identities') { const [domains, settings] = await Promise.all([client.call<GetResult<Entry>>('Domain/get', {}, accountId), client.call<{ settings: { signatures?: MailSignature[] } }>('Settings/get', {}, accountId)]); if (sequence === loadSequence.current) { setConfiguredDomains(domains.list); setSignatureLibrary(settings.settings.signatures || []); } }
      if (section === 'Rules') { const response = await client.call<{ list: { address: string; status: string; verified: boolean }[] }>('Forwarding/get', {}, accountId); if (sequence === loadSequence.current) setVerifiedForwardingAddresses(response.list.filter(value => value.verified && value.status === 'verified').map(value => value.address)); }
      if (section === 'Rules' || section === 'Mailboxes'||section==='Migration') { const response = await client.call<GetResult<Mailbox>>('Mailbox/get', {}, accountId); if (sequence === loadSequence.current) { setMailboxes(response.list); if (section === 'Rules' && initialRuleQuery && !ruleSeeded.current) { ruleSeeded.current = true; setEditing('new'); setFields({ name: '', rule_query: initialRuleQuery, ruleConditionDirty: 'true', enabled: 'true', rule_operator: 'AND' }); } } }
    } catch (e) { if (sequence === loadSequence.current) { setLoadFailed(true); setError(e instanceof Error ? e.message : 'Could not load settings.'); } }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }
  useEffect(() => { setEntries([]); setFilter(''); setVerifiedForwardingAddresses([]); setEditing(null); setFields({}); setTransferIdentity(null); setForwardingVerified(false); setNotice(''); void load(); return () => { loadSequence.current++; }; }, [section, accountId]);
  const field = (name: string, label: string, type = 'text', required = false) => <label className="mail-settings-field">{label}<Input type={type} required={required} value={fields[name] || ''} onChange={e => setFields(v => ({ ...v, [name]: e.target.value }))} /></label>;
  const check = (name: string, label: string, defaultChecked = false) => <label className="mail-settings-check"><MailCheckbox checked={fields[name] === undefined ? defaultChecked : fields[name] === 'true'} onChange={e => setFields(v => ({ ...v, [name]: String(e.target.checked) }))} />{label}</label>;
  function edit(entry?: Entry) {
    setEditing(entry?.id || 'new'); setNotice('');
    const next: Record<string, string> = {};
    if (entry) for (const [key, value] of Object.entries(entry)) if (typeof value === 'string' || typeof value === 'boolean') next[key] = String(value);
    if (section === 'Identities') { next.signatureId = typeof entry?.signatureId === 'string' ? entry.signatureId : entry?.textSignature || entry?.htmlSignature ? '__legacy' : ''; const email = typeof entry?.email === 'string' ? entry.email : ''; next.localPart = email.split('@')[0] || ''; next.emailDomain = email.split('@')[1] || String(configuredDomains.find(domain => domain.enabled !== false)?.name || ''); }
    if (section === 'Rules' && entry) {
      const condition = (entry.condition || {}) as Record<string, string>;
      const matchKey = ['from', 'to', 'subject', 'text'].find(key => condition[key]) || 'from';
      next.matchField = matchKey; next.matchValue = condition[matchKey] || ''; next.originalMatchValue = next.matchValue; next.originalMatchField = matchKey;
      const actions = (entry.actions || {}) as { addMailboxIds?: string[]; keywords?: Record<string, boolean> };
      next.mailbox = actions.addMailboxIds?.[0] || ''; next.archive = String(Boolean((actions as { removeMailboxIds?: string[] }).removeMailboxIds?.includes('folder-inbox'))); next.flagged = String(Boolean(actions.keywords?.['$flagged'])); next.read = String(Boolean(actions.keywords?.['$seen']));
      // Preserve compound conditions and actions when editing only the rule name or status.
      next.advancedCondition = JSON.stringify(entry.condition || {}); next.advancedActions = JSON.stringify(entry.actions || {});
    }
    for (const key of ['fromDate', 'toDate']) if (next[key]) next[key] = localDateTime(next[key]);
    setFields(next);
  }
  async function execute(action: () => Promise<unknown>, message: string, reload = true) {
    if (section === 'Preferences' && !await leavePreferences()) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (section === 'Preferences' && !reload) await client.call('Settings/get', {}, accountId); if (message) setNotice(message); if (reload) { setEditing(null); await load(); } }
    catch (e) { setError(e instanceof Error ? e.message : 'The change could not be saved.'); }
    finally { setBusy(false); }
  }
  function valueForSave(): Record<string, unknown> {
    if (section === 'Mailboxes') return { name: fields.name, parentId: fields.parentId || null, color: fields.color || '#385c47', isSubscribed: true };
    if (section === 'Identities') { const signature = signatureLibrary.find(value => value.id === fields.signatureId); return { name: fields.name || '', email: `${fields.localPart || ''}@${fields.emailDomain || ''}`, ...(fields.signatureId === '__legacy' ? { textSignature: fields.textSignature || '', htmlSignature: fields.htmlSignature || '' } : { signatureId: signature?.id || null, textSignature: signature?.text || '', htmlSignature: signature?.html || '' }) }; }
    if (section === 'Contacts') return { name: fields.name || '', email: fields.email };
    if (section === 'Templates') return { name: fields.name, subject: fields.subject || '', textBody: fields.textBody || '' };
    if (section === 'Vacation reply') return { isEnabled: fields.isEnabled === 'true', subject: fields.subject || '', textBody: fields.textBody || '', fromDate: fields.fromDate ? new Date(fields.fromDate).toISOString() : null, toDate: fields.toDate ? new Date(fields.toDate).toISOString() : null };
    return {...buildRuleValue(fields,mailboxes,editing),...(editing==='new'?{sortOrder:entries.length}:{})};
  }
  async function moveRule(id: string, direction: number) {
    const index = entries.findIndex(entry => entry.id === id); const next = index + direction;
    if (next < 0 || next >= entries.length) return;
    const ordered = [...entries]; [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
    await client.call('Rule/set', { update: Object.fromEntries(ordered.map((entry, sortOrder) => [entry.id, { sortOrder }])) }, accountId);
  }
  function save(event: React.FormEvent) {
    event.preventDefault();
    void execute(async () => {
      const value = valueForSave();
      await client.call(`${entity}/set`, editing === 'new' ? { create: { new: value } } : { update: { [editing!]: value } }, accountId);
    }, 'Saved.');
  }
  const visibleEntries = entries.filter(entry => [entry.name,entry.email,entry.subject].some(value => String(value || '').toLowerCase().includes(filter.toLowerCase())));
  return <section ref={dialogRef} role="region" tabIndex={-1} className="mail-settings" aria-label="Mail settings">{confirmationDialog}
    <header className="mail-settings-header"><h2>Mail settings</h2><Button variant="outline" disabled={busy} onClick={() => void closeSettings()}>Back to mail</Button></header>
    <label className="mail-settings-mobile-nav">Settings section<NativeSelect value={section} disabled={busy} onChange={event => void navigateSection(event.target.value as Section)}>{sections.filter(value => accountId || value === 'Accounts').map(value => <option key={value} value={value}>{({Accounts:'Inboxes',Identities:'Email addresses',Mailboxes:'Folders & labels'} as Record<string,string>)[value] || value}</option>)}</NativeSelect></label>
    <div className="mail-settings-layout"><nav className="mail-settings-tabs" aria-label="Settings sections">
      <p>Inbox setup</p>{(['Accounts','Domains','Identities','Mailboxes'] as Section[]).filter(value=>accountId || value==='Accounts').map(tab=><Button variant={section === tab ? 'secondary' : 'ghost'} size="sm" key={tab} disabled={busy} onClick={()=>void navigateSection(tab)} aria-pressed={section===tab}>{({Accounts:'Inboxes',Domains:'Domains',Identities:'Email addresses',Mailboxes:'Folders & labels'} as Record<string,string>)[tab]}</Button>)}
      {accountId && <><p>Personal</p>{(['Preferences','Notifications','Contacts','Rules','Templates','Signatures','Vacation reply'] as Section[]).map(tab=><Button variant={section === tab ? 'secondary' : 'ghost'} size="sm" key={tab} disabled={busy} onClick={()=>void navigateSection(tab)} aria-pressed={section===tab}>{tab}</Button>)}<details open={['Delegation','Client access','Migration','Offline','Storage & retention','Administration'].includes(section) || undefined}><summary>Advanced</summary>{(['Delegation','Client access','Migration','Offline','Storage & retention','Administration'] as Section[]).map(tab=><Button variant={section === tab ? 'secondary' : 'ghost'} size="sm" key={tab} disabled={busy} onClick={()=>void navigateSection(tab)} aria-pressed={section===tab}>{tab}</Button>)}</details></>}
    </nav><div className="mail-settings-body">{accountId && !['Domains', 'Accounts', 'Notifications', 'Offline'].includes(section) && <div className="mail-settings-inbox-scope"><label>Inbox<NativeSelect aria-label="Settings inbox" value={accountId} disabled={busy || Boolean(editing) || Boolean(transferIdentity)} onChange={event => { const next = event.target.value; void leavePreferences().then(saved => { if (saved) setAccountId(next); }); }}>{Object.entries(client.session.accounts).map(([id, value]) => <option key={id} value={id}>{value.name}</option>)}</NativeSelect></label><p>{scopeAddresses.status === 'ready' ? scopeAddresses.addresses.length ? scopeAddresses.addresses.join(', ') : 'No email addresses in this inbox yet' : scopeAddresses.status === 'loading' ? 'Loading email addresses…' : 'Email addresses could not be loaded'}</p></div>}<header className="mail-settings-page-heading"><div><h3>{({Accounts:'Inboxes',Identities:'Email addresses',Mailboxes:'Folders & labels'} as Record<string,string>)[section] || section}</h3><p>{sectionDescriptions[section]}</p></div>{entity && canEdit && !loading && !loadFailed && !editing && !(section === 'Vacation reply' && entries.length > 0) && section !== 'Domains' && <Button disabled={busy} onClick={() => edit()}>Add {itemLabels[section]}</Button>}</header>
    {error && <p role="alert">{error} <Button variant="outline" disabled={busy} onClick={() => void load()}>Reload</Button></p>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p role="status"><Spinner size="sm" /> Loading settings…</p> : loadFailed ? <div className="mail-settings-inline-empty"><strong>Settings could not be loaded</strong><p>Reload to view your saved settings and make changes.</p></div> : <>
      {section === 'Domains' && <DomainsSettings client={client} onAddresses={() => void navigateSection('Identities')} onBusy={setBusy} />}
      {section==='Storage & retention'&&<><StorageSettings mode="storage" client={client} accountId={accountId} onChanged={()=>void load()}/><AutomationHealthPanel client={client} accountId={accountId}/></>}
      {section==='Administration'&&<StorageSettings mode="administration" client={client} accountId={accountId} onChanged={()=>void load()}/>}
      {section==='Signatures'&&<SignatureSettings client={client} accountId={accountId} canManage={canManage}/>}
      {section==='Notifications'&&<BrowserNotifications client={client}/>}
      {section==='Offline'&&<OfflinePreferences session={client.session} onChanged={()=>{setNotice('Offline settings saved. Close settings to update the cached view.');}}/>}
      {section === 'Identities' && canManage && !editing && !transferIdentity && <DomainForInbox key={accountId} client={client} accountId={accountId} configured={configuredDomains.map(domain => ({ id: domain.id, name: String(domain.name), catchAllAccountId: typeof domain.catchAllAccountId === 'string' ? domain.catchAllAccountId : null }))} onChanged={() => void load()} onDeliveryChanged={(domainId, catchAllAccountId) => setConfiguredDomains(domains => domains.map(domain => domain.id === domainId ? { ...domain, catchAllAccountId } : domain))} onBusy={setBusy} />}
      {section==='Contacts'&&!editing&&<details className="mail-secondary-tools"><summary>Import or export contacts</summary><ContactPortability canImport={canManage} client={client} accountId={accountId} onImported={()=>void load()}/></details>}
      {section==='Migration'&&<Migration readOnly={!canManage || !permits('mail.draft') || !permits('mail.organize')} client={client} accountId={accountId} mailboxes={mailboxes}/>}
      {section==='Client access'&&<ClientAccess client={client} accountId={accountId}/>}
      {(section === 'Delegation' || section === 'Accounts') && <AccountSettings canCreate={!accountId || canManage} mode={section} accountId={accountId} client={client} />}
      {section === 'Preferences' && <details className="mail-secondary-tools"><summary>Automatic sending authorization</summary><div className="mail-automation-health"><h4>Automatic mail actions</h4>{automationHealth ? <><p>{automationHealth.status === 'healthy' ? 'Automatic sending and forwarding are connected.' : automationHealth.status === 'renewRequired' ? 'Automatic sending and forwarding need renewed authorization.' : 'Automatic sending and forwarding are unavailable. Reconnect with an account manager who can send mail.'}{automationHealth.expiresAt && ` Authorization expires ${new Date(automationHealth.expiresAt).toLocaleString()}.`}</p><Button variant="outline" disabled={busy} onClick={() => void navigateSection('Storage & retention')}>Manage authorization</Button><p>Renewal requires permission to manage this account and send mail. Sign in with an account manager to reconnect if your permissions have changed.</p></> : <p>Automatic action connection status is unavailable.</p>}</div></details>}
      {section === 'Preferences' && <form ref={preferenceForm} className="mail-preferences-form" onSubmit={event => { event.preventDefault(); void preferenceAutosave.flush(); }}><div className="mail-preference-save-status" role="status">{autoStatus === 'saving' ? <><Spinner size="sm" /> Saving changes…</> : autoStatus === 'waiting' ? 'Changes save automatically when the fields are complete.' : autoStatus === 'error' ? 'Changes have not been saved.' : 'All changes saved'}</div>{autoError && <div role="alert"><p>{autoError}</p>{preferenceAutosave.retryable ? <Button type="button" variant="outline" onClick={() => void preferenceAutosave.retry()}>Retry pending save</Button> : <><p>Reload saved preferences before editing again. This replaces the unsaved values on this page.</p><Button type="button" variant="outline" onClick={() => void load()}>Reload saved preferences</Button></>}</div>}
        {!canManage && <p className="mail-settings-permission-note">You can view these preferences. Managing this inbox is required to change them.</p>}<fieldset disabled={!canManage || busy} className="mail-preferences-authority"><legend className="sr-only">Inbox preferences</legend><fieldset><legend>Reading & appearance</legend><label className="mail-settings-field">Display density<NativeSelect value={String(preferences.density || 'comfortable')} onChange={e => setPreferences(v => ({ ...v, density: e.target.value }))}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></NativeSelect></label><label className="mail-settings-check"><MailCheckbox checked={preferences.remoteImages === true} onChange={e => setPreferences(v => ({ ...v, remoteImages: e.target.checked }))} />Automatically load remote images (senders may see opens)</label><label className="mail-settings-field">Undo send window (seconds)<Input type="number" min="0" max="30" value={Number(preferences.undoSeconds ?? 10)} onChange={e => setPreferences(v => ({ ...v, undoSeconds: Number(e.target.value) }))} /></label>
        <label className="mail-settings-field">Messages per page<NativeSelect value={String(preferences.pageSize || 50)} onChange={e => setPreferences(v => ({ ...v, pageSize: Number(e.target.value) }))}><option value="25">25</option><option value="50">50</option><option value="100">100</option></NativeSelect></label>
        <label className="mail-settings-check"><MailCheckbox checked={preferences.confirmDelete !== false} onChange={e => setPreferences(v => ({ ...v, confirmDelete: e.target.checked }))} />Confirm before moving mail to Trash</label>
        <label className="mail-settings-check"><MailCheckbox checked={preferences.showPreview !== false} onChange={e => setPreferences(v => ({ ...v, showPreview: e.target.checked }))} />Show message previews</label>
        </fieldset><fieldset><legend>Forwarding</legend><p>Save a forwarding destination. Delivery requires confirmation of that address before forwarding can be enabled.</p><label className="mail-settings-field">Destination email address<Input type="email" required={Boolean((preferences.forwarding as { enabled?: boolean } | undefined)?.enabled)} value={String((preferences.forwarding as { address?: string } | undefined)?.address || '')} onChange={e => { setForwardingVerified(false); setPreferences(v => ({ ...v, forwarding: { ...{ enabled: false, address: '', keepCopy: true }, ...(v.forwarding as object || {}), address: e.target.value, enabled: false } })); }} /></label><label className="mail-settings-check"><MailCheckbox checked={(preferences.forwarding as { keepCopy?: boolean } | undefined)?.keepCopy !== false} onChange={e => setPreferences(v => ({ ...v, forwarding: { ...{ enabled: false, address: '', keepCopy: true }, ...(v.forwarding as object || {}), keepCopy: e.target.checked } }))} />Keep a copy in Enough Mail</label><div className="mail-forwarding-actions"><Button variant="outline" type="button" disabled={busy || !(preferences.forwarding as { address?: string } | undefined)?.address} onClick={() => void execute(async () => { const result = await client.call<{ status: string; error?: string }>('Forwarding/requestVerification', { address: (preferences.forwarding as { address: string }).address }, accountId); if (result.status === 'rejected' || result.status === 'unknown') throw new Error(result.error || 'Verification email could not be confirmed. Try again later.'); setNotice('Check the destination inbox for the confirmation email, then check verification here.'); }, '', false)}>Send confirmation email</Button><Button variant="outline" type="button" disabled={busy || !(preferences.forwarding as { address?: string } | undefined)?.address} onClick={() => void execute(async () => { const result = await client.call<{ status: string; error?: string }>('Forwarding/verify', { address: (preferences.forwarding as { address: string }).address }, accountId); setForwardingVerified(result.status === 'verified'); setNotice(result.status === 'verified' ? 'Destination verified. Enable forwarding when you are ready; changes save automatically.' : 'Destination not verified yet. Follow the link in the confirmation email.'); }, '', false)}>Check verification</Button></div><label className="mail-settings-check"><MailCheckbox disabled={!forwardingVerified && !(preferences.forwarding as { enabled?: boolean } | undefined)?.enabled} checked={Boolean((preferences.forwarding as { enabled?: boolean } | undefined)?.enabled)} onChange={e => setPreferences(v => ({ ...v, forwarding: { ...{ enabled: false, address: '', keepCopy: true }, ...(v.forwarding as object || {}), enabled: e.target.checked } }))} />Enable forwarding</label>{Boolean((preferences.forwarding as { enabled?: boolean } | undefined)?.enabled) && <Button variant="outline" type="button" disabled={busy} onClick={() => { setPreferences(v => ({ ...v, forwarding: { ...(v.forwarding as object), enabled: false } })); }}>Disable forwarding</Button>}</fieldset>
        <fieldset><legend>Privacy & blocked senders</legend><label className="mail-settings-field">Blocked senders (one email address per line)<Textarea value={Array.isArray(preferences.blockedSenders) ? preferences.blockedSenders.join('\n') : ''} onChange={e => setPreferences(v => ({ ...v, blockedSenders: e.target.value.split(/\n/).map(value => value.trim()).filter(Boolean) }))} /></label>
        </fieldset><fieldset><legend>Follow-up reminders</legend><label className="mail-settings-check"><MailCheckbox checked={Boolean((preferences.followUp as { defaultIfNoReply?: boolean } | undefined)?.defaultIfNoReply)} onChange={e => setPreferences(v => ({ ...v, followUp: { ...{ defaultIfNoReply: false, defaultDelayHours: 48 }, ...(v.followUp as object || {}), defaultIfNoReply: e.target.checked } }))} />Remind me when sent mail has no reply</label>
        <label className="mail-settings-field">Default follow-up delay (hours)<Input type="number" min="1" max="720" value={Number((preferences.followUp as { defaultDelayHours?: number } | undefined)?.defaultDelayHours || 48)} onChange={e => setPreferences(v => ({ ...v, followUp: { ...{ defaultIfNoReply: false, defaultDelayHours: 48 }, ...(v.followUp as object || {}), defaultDelayHours: Number(e.target.value) } }))} /></label>
        </fieldset></fieldset>
      </form>}
      {entity && <>
        {!canEdit && <p className="mail-settings-permission-note">You have read-only access to these settings. Ask an inbox manager to make changes.</p>}




        {section === 'Rules' && canEdit && !editing && ruleApplication && <div aria-live="polite"><p>Rule application: {ruleApplication.status}. {ruleApplication.processed}{ruleApplication.total === null ? '' : ` of ${ruleApplication.total}`} messages processed.</p>{ruleApplication.total !== null && <progress max={Math.max(1, ruleApplication.total)} value={ruleApplication.processed} aria-label="Rule application progress" />}{ruleApplication.status === 'running' && <Button variant="outline" onClick={() => { ruleRun.current.stop = true; setNotice('Pausing after the current page completes…'); }}>Pause</Button>}{ruleApplication.status === 'paused' && <><Button variant="outline" disabled={busy} onClick={() => void runRuleApplication(ruleApplication)}>Resume</Button><Button variant="outline" disabled={busy} onClick={() => void cancelRuleApplication()}>Cancel remaining work</Button></>}</div>}
        {section === 'Rules' && !editing && <><details className="mail-secondary-tools"><summary>Import or export rules</summary><Button variant="outline" disabled={busy} onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'enough-mail-rules-v1', rules: entries }, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'enough-mail-rules.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export rules</Button><label className="mail-settings-field">Import rules<Input type="file" accept="application/json,.json" disabled={busy || !canEdit} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; void execute(async () => { if (file.size > 1_048_576) throw new Error('Rule files must be smaller than 1 MB.'); const data = JSON.parse(await file.text()); if (data.format !== 'enough-mail-rules-v1' || !Array.isArray(data.rules) || !data.rules.length || data.rules.length > 100) throw new Error('Choose an Enough Mail rule export with 1–100 rules.'); const create = Object.fromEntries(data.rules.map((rule: Entry, index: number) => { const { id: _id, ...value } = rule; return [`import-${index}`, value]; })); await client.call('Rule/set', { create }, accountId); }, 'Rules imported.'); }} /></label></details></>}
        {!editing && <>{entries.length > 4 && <label className="mail-settings-search"><span>Search {section.toLowerCase()}</span><Input type="search" placeholder={section === 'Contacts' ? 'Search names or email addresses' : 'Search by name'} value={filter} onChange={event => setFilter(event.target.value)} /></label>}<ul className="mail-settings-list">{visibleEntries.map((entry,index) => <React.Fragment key={entry.id}>{section === 'Mailboxes' && (index === 0 || Boolean(visibleEntries[index-1].role) !== Boolean(entry.role)) && <li className="mail-folder-group-heading">{entry.role ? 'Built-in folders' : 'Your folders & labels'}</li>}<li data-standard={section === 'Mailboxes' && Boolean(entry.role) ? 'true' : undefined}><div>{section === 'Mailboxes' && !entry.role && <span className="mail-folder-color" aria-hidden="true" style={{ backgroundColor: String(entry.color || '#4854df') }} />}<strong>{String((section === 'Identities' ? entry.email : '') || entry.name || entry.email || entry.subject || 'Vacation reply')}</strong>{Boolean(entry.email) && <span className="mail-setting-secondary">{String(section === 'Identities' ? entry.name || 'No display name' : entry.email)}</span>}{section === 'Identities' && <><span className="mail-setting-secondary">{entry.verified ? 'Ready to send' : 'Domain setup required before sending'}</span>{Boolean(entry.textSignature) && <p className="mail-signature-preview">{String(entry.textSignature).slice(0,180)}</p>}</>}{section === 'Mailboxes' && <span className="mail-setting-secondary">{entry.role ? 'Standard folder' : entry.parentId ? `Inside ${mailboxes.find(box => box.id === entry.parentId)?.name || 'another folder'}` : 'Top-level folder or label'}</span>}{section === 'Templates' && <span className="mail-setting-secondary">{String(entry.subject || 'No subject')}</span>}{section === 'Templates' && <p className="mail-template-preview">{String(entry.textBody || '').slice(0,180)}</p>}{section === 'Vacation reply' && <span className="mail-setting-secondary">{entry.isEnabled ? 'Automatic reply enabled' : 'Automatic reply off'}</span>}{section === 'Rules' && <><span className="mail-setting-secondary">{entry.enabled !== false ? 'Enabled' : 'Paused'}</span><p>{ruleSummary(entry, mailboxes)}</p></>}</div><div>{section === 'Identities' && canManage && !entry.verified && <Button variant="outline" size="sm" onClick={() => void navigateSection('Domains')}>Set up domain</Button>}{section === 'Identities' && canManage && actions.includes('mail.manage') && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setTransferIdentity(entry)}>Move to another inbox</Button>}{canEdit && !(section === 'Mailboxes' && entry.role) && <Button variant="outline" size="sm" disabled={busy} onClick={() => edit(entry)}>Edit</Button>}{section === 'Rules' && canEdit && <details className="mail-setting-actions-menu"><summary>Rule actions</summary><div><Button variant="outline" disabled={busy || entries[0]?.id === entry.id} onClick={() => void execute(() => moveRule(entry.id, -1), 'Rule moved.')}>Move up</Button><Button variant="outline" disabled={busy || entries.at(-1)?.id === entry.id} onClick={() => void execute(() => moveRule(entry.id, 1), 'Rule moved.')}>Move down</Button><Button variant="outline" disabled={busy} onClick={() => void execute(async () => { const result = await client.call<{ total: number }>('Rule/preview', { rules: [entry] }, accountId); setNotice(`${result.total} messages would change.`); }, '', false)}>Preview</Button><Button variant="outline" disabled={busy || Boolean(ruleApplication && ['running','paused'].includes(ruleApplication.status))} onClick={() => startRuleApplication(entry)}>Apply to existing mail</Button></div></details>}{canEdit && !(section === 'Mailboxes' && entry.role) && <Button variant="ghost" size="sm" disabled={busy} onClick={async () => { if (await confirm(`Delete ${String(entry.name || entry.email || 'this setting')}?`)) void execute(() => client.call(`${entity}/set`, { destroy: [entry.id] }, accountId), 'Deleted.'); }}>Delete</Button>}</div></li></React.Fragment>)}</ul>{filter && !entries.some(entry => [entry.name,entry.email,entry.subject].some(value => String(value || '').toLowerCase().includes(filter.toLowerCase()))) && <p className="mail-help">No matching items. Try another search.</p>}</>}
        {!entries.length && section !== 'Domains' && !editing && <Empty className="mail-settings-empty"><EmptyHeader><EmptyTitle>{`No ${section === 'Identities' ? 'email addresses' : section.toLowerCase()} yet`}</EmptyTitle><EmptyDescription>{canEdit ? section === 'Identities' ? `Add an email address to ${account?.name || 'this inbox'} to get started. Addresses in other inboxes are managed separately.` : `Add a ${itemLabels[section]} to get started.` : 'Nothing has been configured for this inbox.'}</EmptyDescription></EmptyHeader></Empty>}

        {editing && canEdit && <form className="mail-settings-form mail-settings-editor" onSubmit={save}><h4>{section === 'Vacation reply' ? 'Automatic reply' : `${editing === 'new' ? 'Add' : 'Edit'} ${itemLabels[section]}`}</h4>
          {(section !== 'Vacation reply') && field('name', section === 'Domains' ? 'Domain name' : 'Name', 'text', section !== 'Identities' && section !== 'Contacts')}
          {section === 'Contacts' && field('email', 'Email address', 'email', true)}{section === 'Identities' && <><div className="mail-identity-address-fields"><label className="mail-settings-field">Address name<Input required pattern="[^ @<>]+" value={fields.localPart || ''} placeholder="e.g. hello" onChange={event => setFields(value => ({ ...value, localPart: event.target.value }))} /></label><span aria-hidden="true">@</span><label className="mail-settings-field">Domain<NativeSelect required value={fields.emailDomain || ''} onChange={event => setFields(value => ({ ...value, emailDomain: event.target.value }))}><option value="">Choose a configured domain</option>{configuredDomains.filter(domain => domain.enabled !== false || domain.name === fields.emailDomain).map(domain => <option key={domain.id} value={String(domain.name)}>{String(domain.name)}{domain.sendingVerified ? '' : ' · Setup incomplete'}</option>)}</NativeSelect></label></div>{!configuredDomains.length && <p>Connect a domain before adding an email address. <Button type="button" variant="outline" onClick={() => void navigateSection('Domains')}>Set up a domain</Button></p>}</>}
          {section === 'Mailboxes' && <><label className="mail-settings-field">Label color<Input type="color" value={fields.color || '#385c47'} onChange={e => setFields(v => ({ ...v, color: e.target.value }))} /></label><label className="mail-settings-field">Parent mailbox<NativeSelect value={fields.parentId || ''} onChange={e => setFields(v => ({ ...v, parentId: e.target.value }))}><option value="">Top level</option>{mailboxes.filter(box => box.id !== editing).map(box => <option key={box.id} value={box.id}>{box.name}</option>)}</NativeSelect></label></>}
          {section === 'Identities' && <><label className="mail-settings-field">Default signature<NativeSelect value={fields.signatureId || ''} onChange={event => setFields(value => ({ ...value, signatureId: event.target.value }))}><option value="">No default signature</option>{fields.signatureId === '__legacy' && <option value="__legacy">Existing signature</option>}{signatureLibrary.map(signature => <option key={signature.id} value={signature.id}>{signature.name}</option>)}</NativeSelect></label><p>Manage named signatures in <Button type="button" variant="ghost" size="sm" onClick={() => void navigateSection('Signatures')}>Signatures</Button>. You can choose another signature while composing.</p></>}
          {section === 'Rules'&&<RuleFields fields={fields} setFields={setFields} mailboxes={mailboxes} verifiedForwardingAddresses={verifiedForwardingAddresses}/>}
          {(section === 'Templates' || section === 'Vacation reply') && <>{field('subject', 'Subject')}<label className="mail-settings-field">Message<Textarea value={fields.textBody || ''} onChange={e => setFields(v => ({ ...v, textBody: e.target.value }))} /></label></>}
          {section === 'Vacation reply' && <>{check('isEnabled', 'Enable vacation reply')}{field('fromDate', 'Start', 'datetime-local')}{field('toDate', 'End', 'datetime-local')}</>}
          <div className="mail-settings-form-footer"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button><Button variant="outline" type="button" disabled={busy} onClick={() => { if (section === 'Vacation reply') void load(); else setEditing(null); }}>{section === 'Vacation reply' ? 'Reset changes' : 'Cancel'}</Button></div>
        </form>}
      </>}
      {section === 'Identities' && !transferIdentity && pendingIdentityTransfers(client, accountId).map(value => <div key={value.id} className="mail-settings-inline-empty"><strong>{value.email}</strong><p>An address move is awaiting confirmation. Resume it before starting another move.</p><Button variant="outline" onClick={() => setTransferIdentity(value)}>Resume pending move</Button></div>)}{section === 'Identities' && transferIdentity && <IdentityTransfer client={client} accountId={accountId} identity={{ id: transferIdentity.id, email: String(transferIdentity.email || ''), signatureId: typeof transferIdentity.signatureId === 'string' ? transferIdentity.signatureId : null }} onClose={() => setTransferIdentity(null)} onComplete={() => { setTransferIdentity(null); setNotice('Email address moved. Existing messages stay in this inbox; future mail goes to the destination inbox.'); void load(); }} />}{section === 'Vacation reply' && <AutomationHealthPanel client={client} accountId={accountId}/>}
    </>}
  </div></div></section>;
}

function localDateTime(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16) : ''; }

function ruleSummary(entry: Entry, mailboxes: Mailbox[]): string {
  const condition = entry.condition as Record<string, unknown> | undefined;
  const actions = entry.actions as { addMailboxIds?: string[]; keywords?: Record<string,boolean>; forwardTo?: string[] } | undefined;
  const simple = condition && Object.entries(condition).find(([key,value]) => ['from','to','subject','text','body'].includes(key) && typeof value === 'string');
  const match = simple ? `${({from:'From',to:'To',subject:'Subject',text:'Message',body:'Body'} as Record<string,string>)[simple[0]]} contains “${simple[1]}”` : condition && !Object.keys(condition).length ? 'All incoming messages' : 'Custom conditions';
  const changes: string[] = [];
  if (actions?.addMailboxIds?.length) changes.push(`add ${actions.addMailboxIds.map(id => mailboxes.find(box => box.id === id)?.name || 'a label').join(', ')}`);
  if (actions?.keywords?.$seen === true) changes.push('mark read');
  if (actions?.keywords?.$seen === false) changes.push('mark unread');
  if (actions?.keywords?.$flagged === true) changes.push('star');
  if (actions?.forwardTo?.length) changes.push('forward');
  return `${match}${changes.length ? ` → ${changes.join(', ')}` : ''}`;
}

function DnsPlan({ value }: { value: unknown }) {
  type Evidence = { content: string; rawLength: number; canonicalLength: number; quoteCount: number; backslashCount: number; firstDifference?: number };
  const envelope = value as { plan?: unknown };
  const plan = (envelope.plan || value) as { requirements?: { type: string; name: string; content: string; priority?: number }[]; conflicts?: string[]; warnings?: string[]; conflictDetails?: { name: string; type: string; required: Evidence; existing: Evidence[] }[] };
  return <div className="mail-dns-plan"><h4>Required DNS records</h4><table><thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Priority</th></tr></thead><tbody>{(plan.requirements || []).map((record, index) => <tr key={index}><td>{record.type}</td><td>{record.name}</td><td>{record.content}</td><td>{record.priority ?? '—'}</td></tr>)}</tbody></table>{plan.conflicts?.map((text, index) => <p role="alert" key={`conflict-${index}`}>{text}</p>)}{plan.conflictDetails?.map((detail, index) => <details key={`detail-${index}`} className="mail-dns-conflict-details"><summary>Compare existing and required {detail.type} record</summary><p><strong>{detail.name}</strong></p><p>The existing record is preserved. These public DNS values show why setup requested a review.</p>{[{ label: 'Required by Cloudflare', record: detail.required }, ...detail.existing.map((record, position) => ({ label: `Existing record${detail.existing.length > 1 ? ` ${position + 1}` : ''}`, record }))].map(({ label, record }) => <div key={label}><h5>{label}</h5><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', fontSize: '12px', padding: '12px', border: '1px solid var(--border, #dedfe4)' }}>{record.content}</pre><p className="mail-help">{record.rawLength} characters · {record.canonicalLength} after joining DNS chunks · {record.quoteCount} quotes · {record.backslashCount} escapes{record.firstDifference !== undefined ? record.firstDifference === -1 ? ' · Same text; check record settings' : ` · First difference at character ${record.firstDifference + 1}` : ''}{record.rawLength > record.content.length ? ' · Value truncated for display' : ''}</p></div>)}</details>)}{plan.warnings?.map((text, index) => <p key={`warning-${index}`}>{text}</p>)}</div>;
}

interface AccountAccess { ownerActorId?: string; id: string; name: string; version: number; effectiveActions: string[]; grants?: { actorId: string; actions: string[] }[]; canManage?: boolean }
async function accountRequest<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/apps/mail/api/${path}`, { method: body ? method : 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) { const known: Record<string, string> = { zone_in_use: 'This domain is already attached to another workspace.', operation_conflict: 'Reload settings before retrying this change.' }; throw new Error(data.error?.message || data.message || data.description || known[String(data.error)] || `This workspace operation is unavailable (${response.status}).`); }
  return data as T;
}
function AccountSettings({ mode, accountId, client, canCreate }: { canCreate: boolean; mode: 'Accounts' | 'Delegation' | 'Client access' | 'Migration' | 'Offline' | 'Storage & retention'; accountId: string; client: MailClient }) {
  const [accounts, setAccounts] = useState<AccountAccess[]>([]);
  const [members, setMembers] = useState<{ actorId?: string; id?: string; displayName?: string; name?: string; email?: string }[]>([]);
  const [accountLoading, setAccountLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState(''); const [selectedActor, setSelectedActor] = useState(''); const [grantActions, setGrantActions] = useState<string[]>(['mail.read']);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const account = accounts.find(value => value.id === accountId);
  async function reload() {
    const data = await accountRequest<{ accounts: AccountAccess[] }>('accounts'); setAccounts(data.accounts);
    if (mode === 'Delegation') { const detail = await accountRequest<{ account: AccountAccess; grants?: AccountAccess['grants']; canManage?: boolean }>(`accounts/${encodeURIComponent(accountId)}`); setAccounts(values => values.map(value => value.id === accountId ? { ...detail.account, grants: detail.grants || detail.account.grants || [], canManage: detail.canManage === true } : value)); const directory = await accountRequest<{ members: (typeof members[number] & { actor?: { id: string; displayName?: string; email?: string }; status?: string })[] }>('members'); setMembers(directory.members.filter(member => member.status !== 'suspended').map(member => ({ ...member, ...(member.actor ? { actorId: member.actor.id, displayName: member.actor.displayName, email: member.actor.email } : {}) }))); }
  }
  async function retryLoad() { setAccountLoading(true); setError(''); try { await reload(); setLoaded(true); } catch (e) { setLoaded(false); setError(e instanceof Error ? e.message : 'Inbox access could not be loaded.'); } finally { setAccountLoading(false); } }
  useEffect(() => { setLoaded(false); setAccountLoading(true); void reload().then(() => setLoaded(true)).catch(e => setError(e.message)).finally(() => setAccountLoading(false)); }, [mode, accountId]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await action(); await reload(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save account.'); } finally { setBusy(false); } }
  async function saveGrants(grants: NonNullable<AccountAccess['grants']>) { if (!account) throw new Error('Reload the account before changing access.'); await accountRequest(`accounts/${encodeURIComponent(accountId)}/grants`, { operationId: crypto.randomUUID(), expectedVersion: account.version, grants }, 'PUT'); setNotice('Access saved.'); }
  return <div className="mail-account-settings"><p className="mail-account-intro">{mode === 'Accounts' ? 'Keep separate inboxes for personal mail, work, or any other purpose. Each inbox can use multiple domains and email addresses.' : `Sharing applies to all email addresses in ${client.session.accounts[accountId]?.name || 'this inbox'}, including addresses added later. Other inboxes are separate. To share only one address, put it in its own inbox before granting access.`}</p>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {accountLoading ? <p role="status"><Spinner size="sm" /> Loading inbox access…</p> : !loaded ? <div className="mail-settings-inline-empty"><strong>Inbox access is unavailable</strong><p>Reload before creating inboxes or changing access.</p><Button variant="outline" disabled={busy} onClick={() => void retryLoad()}>Reload inbox access</Button></div> : mode === 'Accounts' ? <><ul className="mail-account-list">{accounts.map(value => <li key={value.id}><div className="mail-account-avatar" aria-hidden="true">{value.name.slice(0,1).toUpperCase()}</div><div><strong>{value.name}</strong><span>{value.id === accountId ? 'Current inbox' : 'Available in the inbox switcher'}</span></div></li>)}</ul>{canCreate && <form className="mail-settings-form" onSubmit={e => { e.preventDefault(); void run(async () => { await accountRequest('accounts', { name, operationId: crypto.randomUUID() }); await client.discover(); setName(''); setNotice('Inbox created. Return to mail to choose it from the inbox switcher.'); }); }}><h4>Create an inbox</h4><p>Give this inbox a name you will recognize in the switcher.</p><label className="mail-settings-field">Inbox name<Input required value={name} placeholder="e.g. Personal or Work" onChange={e => setName(e.target.value)} /></label><Button type="submit" disabled={busy}>Create inbox</Button></form>}</> : account?.canManage ? <><ul className="mail-delegation-list">{(account.grants || []).map(grant => <li key={grant.actorId}>{members.find(member => (member.actorId || member.id) === grant.actorId)?.displayName || members.find(member => (member.actorId || member.id) === grant.actorId)?.name || 'Workspace member'} · {grant.actions.map(value => value.replace('mail.', '')).join(', ')} <Button variant="outline" disabled={busy} onClick={() => void run(() => saveGrants((account.grants || []).filter(value => value.actorId !== grant.actorId)))}>Remove access</Button></li>)}</ul>{!(account.grants || []).length && <div className="mail-settings-inline-empty"><strong>Only you have access</strong><p>Add a workspace member below to share this inbox.</p></div>}<form className="mail-settings-form" onSubmit={e => { e.preventDefault(); void run(() => saveGrants([...(account.grants || []).filter(value => value.actorId !== selectedActor), { actorId: selectedActor, actions: grantActions }])); }}><h4>Share this inbox</h4><label className="mail-settings-field">Workspace member<NativeSelect required value={selectedActor} onChange={e => setSelectedActor(e.target.value)}><option value="">Choose a member</option>{members.filter(member => (member.actorId || member.id) !== account.ownerActorId).map(member => <option key={member.actorId || member.id} value={member.actorId || member.id}>{member.displayName || member.name || member.email || 'Workspace member'}</option>)}</NativeSelect></label>{[['mail.read','Read mail'],['mail.organize','Organize mail'],['mail.draft','Edit drafts'],['mail.send','Send mail'],['mail.manage','Manage account access']].map(([value,label]) => <label className="mail-settings-check" key={value}><MailCheckbox checked={grantActions.includes(value)} onChange={e => setGrantActions(actions => e.target.checked ? [...actions,value] : actions.filter(action => action !== value))} />{label}</label>)}<Button type="submit" disabled={busy || !selectedActor || !grantActions.length}>Save access</Button></form></> : <p>You need account management permission to change delegation.</p>}
  </div>;
}
