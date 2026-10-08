import { NativeSelect } from '@rebnz/enough-ui/native-select';
import { Input } from '@rebnz/enough-ui/input';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@open-cloud/ui';
import { type MailClient, type GetResult, type SetResult } from './jmap';
import { MAX_CONTACT_BYTES, parseContacts, exportContacts, contactDuplicates, contactImportPlan, type PortableContact, type StoredContact, type DuplicateChoice } from './contact-format';
interface Preview { incoming: PortableContact[]; existing: StoredContact[]; state: string; duplicates: (string | undefined)[] }
interface ImportJob { accountId: string; batches: Record<string, unknown>[]; position: number; confirmedFailure: boolean; total: number }
export default function ContactPortability({ client, accountId, onImported, canImport = true }: { canImport?: boolean; client: MailClient; accountId: string; onImported: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null), [choices, setChoices] = useState<Record<number, DuplicateChoice>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, setPending] = useState(false);
  const job = useRef<ImportJob | null>(null), scope = useRef(accountId), mounted = useRef(true);
  useEffect(() => { mounted.current = true; scope.current = accountId; job.current = null; setPreview(null); setChoices({}); setError(''); setNotice(''); setPending(false); setBusy(false); return () => { mounted.current = false; }; }, [accountId]);
  const current = (id: string) => mounted.current && scope.current === id;
  async function readFile(file: File) {
    const id = accountId; setBusy(true); setError(''); setNotice(''); setPreview(null); setChoices({}); job.current = null; setPending(false);
    try {
      if (file.size > MAX_CONTACT_BYTES) throw new Error('Choose a contacts file up to 5 MB.');
      const format = /\.vcf$/i.test(file.name) ? 'vcf' : /\.json$/i.test(file.name) ? 'json' : /\.csv$/i.test(file.name) ? 'csv' : null;
      if (!format) throw new Error('Choose a CSV, vCard (.vcf), or JSON contacts file.');
      const incoming = parseContacts(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()), format);
      const result = await client.call<GetResult<StoredContact>>('Contact/get', {}, id);
      if (current(id)) setPreview({ incoming, existing: result.list, state: result.state, duplicates: contactDuplicates(incoming, result.list) });
    } catch (e) { if (current(id)) setError(e instanceof Error ? e.message : 'Cannot read contacts.'); }
    finally { if (current(id)) setBusy(false); }
  }
  async function run(value: ImportJob) {
    const id = value.accountId; setBusy(true); setError('');
    try {
      while (value.position < value.batches.length && current(id)) {
        const args = value.batches[value.position];
        // Freeze state as well as operation ID before sending: retries must be byte-for-byte equivalent.
        if (!('ifInState' in args)) { const state = client.states.get(`${id}:Contact`); if (!state) throw new Error('Reload contact preview before importing.'); args.ifInState = state; }
        const result = await client.call<SetResult>('Contact/set', args, id);
        const created = Object.keys(args.create as object), updated = Object.keys(args.update as object);
        if (created.some(key => !result.created?.[key]?.id) || updated.some(key => !Object.hasOwn(result.updated || {}, key))) throw new Error('The server did not confirm every imported contact. Retry uses the same operation.');
        value.position++;
        if (current(id)) setNotice(`${value.position} of ${value.batches.length} import batches completed.`);
      }
      if (!current(id)) return;
      job.current = null; setPending(false); setPreview(null); setChoices({}); setNotice(`${value.total} contacts imported or merged. Existing contacts were retained.`); onImported();
    } catch (e) {
      if (!current(id)) return;
      value.confirmedFailure = Boolean((e as { confirmed?: boolean })?.confirmed); setPending(!value.confirmedFailure);
      setError(`${e instanceof Error ? e.message : 'Import failed.'} ${value.confirmedFailure ? 'Reselect the file to review against current contacts. Any successfully imported contacts remain.' : 'Retry continues this exact operation. Keep this page open until the result is confirmed.'}`);
      if (value.confirmedFailure) { job.current = null; setPreview(null); onImported(); }
    } finally { if (current(id)) setBusy(false); }
  }
  function begin() {
    if (!preview) return;
    try {
      // Every detected duplicate requires an explicit choice, even if an earlier row is skipped.
      if (preview.duplicates.some((duplicate, index) => duplicate !== undefined && !choices[index])) throw new Error('Choose skip, merge, or keep for every duplicate.');
      const plan = contactImportPlan(preview.incoming, preview.existing, choices);
      const entries = [...Object.entries(plan.create).map(([key, value]) => ({ kind: 'create' as const, key, value })), ...Object.entries(plan.update).map(([key, value]) => ({ kind: 'update' as const, key, value }))];
      if (!entries.length) { setNotice('All contacts skipped. Existing contacts are unchanged.'); setPreview(null); return; }
      const batches: Record<string, unknown>[] = [];
      for (let index = 0; index < entries.length; index += 500) {
        const slice = entries.slice(index, index + 500);
        batches.push({ operationId: crypto.randomUUID(), ...(index === 0 ? { ifInState: preview.state } : {}), create: Object.fromEntries(slice.filter(entry => entry.kind === 'create').map(entry => [entry.key, entry.value])), update: Object.fromEntries(slice.filter(entry => entry.kind === 'update').map(entry => [entry.key, entry.value])) });
      }
      const value: ImportJob = { accountId, batches, position: 0, confirmedFailure: false, total: entries.length }; job.current = value; setPending(true); void run(value);
    } catch (e) { setError(e instanceof Error ? e.message : 'Cannot import contacts.'); }
  }
  async function download(format: 'csv' | 'vcf') {
    const id = accountId; setBusy(true); setError(''); setNotice('');
    try {
      const result = await client.call<GetResult<StoredContact>>('Contact/get', {}, id); if (!current(id)) return;
      const url = URL.createObjectURL(new Blob([exportContacts(result.list, format)], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/vcard;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `enough-mail-contacts.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      setNotice(`${result.list.length} contacts exported, including names, email addresses, company, notes and favorites.`);
    } catch (e) { if (current(id)) setError(e instanceof Error ? e.message : 'Contact export failed.'); }
    finally { if (current(id)) setBusy(false); }
  }
  return <div className="mail-contact-portability"><h4>Bring your contacts</h4><p>Choose a CSV, vCard or JSON file. You will review duplicate email addresses before anything is saved.</p><details className="mail-secondary-tools"><summary>Supported files and duplicate handling</summary><p>Use UTF-8 CSV with name, email, company, notes and favorite columns, a vCard file, or an EnoughMail JSON export. Files can include up to 10,000 contacts and be up to 5 MB. Merge fills supplied fields on the matching contact; blank details preserve existing values. Your source file and existing contacts are retained.</p></details>
    <label className="mail-settings-field">Contacts file (up to 5 MB and 10,000 contacts)<Input type="file" accept=".csv,.vcf,.json,text/csv,text/vcard,application/json" disabled={busy || pending || !canImport} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void readFile(file); }} /></label>
    {preview && <div><p role="status">{preview.incoming.length} contacts found. {preview.duplicates.filter(value => value !== undefined).length} duplicate email addresses need review.</p><div className="mail-contacts-preview-table"><table><thead><tr><th>Name</th><th>Email</th><th>Duplicate action</th></tr></thead><tbody>{preview.incoming.map((contact, index) => <tr key={index}><td>{contact.name || 'Unnamed'}</td><td>{contact.email}</td><td>{preview.duplicates[index] !== undefined ? <><span>Matches {preview.duplicates[index]}</span><NativeSelect aria-label={`Duplicate action for ${contact.email}, row ${index + 1}`} disabled={busy || pending || !canImport} value={choices[index] || ''} onChange={event => setChoices(previous => ({ ...previous, [index]: event.target.value as DuplicateChoice }))}><option value="">Choose an action</option><option value="skip">Skip this contact</option><option value="merge">Merge into matching contact</option><option value="keep">Keep as a separate contact</option></NativeSelect></> : 'New contact'}</td></tr>)}</tbody></table></div><Button variant="outline" disabled={busy || pending || !canImport} onClick={begin}>Import reviewed contacts</Button><Button variant="outline" disabled={busy || pending} onClick={() => { setPreview(null); setChoices({}); setError(''); }}>Cancel preview</Button></div>}
    {pending && !busy && <Button variant="outline" onClick={() => job.current && void run(job.current)}>Retry contact import</Button>}
    <h4>Download your contacts</h4><p>Export all contacts with their names, email addresses, company, notes and favorites.</p><Button variant="outline" disabled={busy || pending} onClick={() => void download('csv')}>Export all contacts as CSV</Button><Button variant="outline" disabled={busy || pending} onClick={() => void download('vcf')}>Export all contacts as vCard</Button>
    {busy && <p role="status">Working with contacts…</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>;
}
