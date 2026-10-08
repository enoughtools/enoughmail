import MailCheckbox from './MailCheckbox';
import { NativeSelect } from '@rebnz/enough-ui/native-select';
import { Input } from '@rebnz/enough-ui/input';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@open-cloud/ui';
import { MailClient, type Mailbox, type GetResult, type SetResult } from './jmap';
import { importCheckpointKey, fileFingerprint, readImportCheckpoint, saveImportCheckpoint, clearImportCheckpoint, type ImportCheckpoint } from './migration-checkpoint';
import { stepRemoteMigration, migrationProgressChanged, type RemoteMigrationJob } from './migration-remote';
import { orderMigrationMailboxes, matchMigrationMailbox, mailboxDefinitions } from './migration-labels';
import { MAX_IMPORT_BYTES, parseImport, mboxMessage, type ImportMessage } from './migration-format';

interface ImportJob { checkpoint: ImportCheckpoint; checkpointKey: string; accountId: string; mailboxId: string; name: string; messages: ImportMessage[]; position: number; operationIds: string[]; uploads: Map<number, string>; args: Map<number, Record<string, unknown>> }
interface ExportEmail { id: string; blobId: string; receivedAt: string; keywords: Record<string, boolean>; mailboxIds: Record<string, boolean> }
interface ExportPage { list: ExportEmail[]; total: number; hasMore: boolean; nextPosition: number }
interface FileSink { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
export default function Migration({ client, accountId, mailboxes, readOnly = false }: { readOnly?: boolean; client: MailClient; accountId: string; mailboxes: Mailbox[] }) {
  const [remoteJobs, setRemoteJobs] = useState<RemoteMigrationJob[]>([]);
  const [sourceUrl, setSourceUrl] = useState(''); const [sourceCredential, setSourceCredential] = useState(''); const [sourceAccountId, setSourceAccountId] = useState('');
  const [remoteBusy, setRemoteBusy] = useState<string | null>(null); const [remoteError, setRemoteError] = useState(''); const [remoteNotice, setRemoteNotice] = useState('');
  const remoteStopped = useRef(false); const pendingSteps = useRef(new Map<string, string>());
  const [restoreLabels, setRestoreLabels] = useState(true);
  const [duplicatePolicy, setDuplicatePolicy] = useState<'skipIdentical' | 'keep'>('skipIdentical');
  const [mailboxId, setMailboxId] = useState(mailboxes.find(box => box.role === 'inbox')?.id || mailboxes[0]?.id || '');
  const checkpointKey = importCheckpointKey(client.session, accountId);
  const [checkpoint, setCheckpoint] = useState<ImportCheckpoint | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [progress, setProgress] = useState({ done: 0, total: 0 });
  const job = useRef<ImportJob | null>(null); const stopped = useRef(false); const mounted = useRef(true); const account = useRef(accountId); const scope = useRef(checkpointKey);
  useEffect(() => { mounted.current = true; account.current = accountId; scope.current = checkpointKey; remoteStopped.current = true; pendingSteps.current.clear(); setRemoteJobs([]); setSourceCredential(''); setSourceUrl(''); setSourceAccountId(''); setRemoteBusy(null); setRemoteError(''); setRemoteNotice(''); void reloadRemoteJobs(); job.current = null; stopped.current = true; setBusy(false); setProgress({ done: 0, total: 0 }); setNotice(''); setError(''); setMailboxId(mailboxes.find(box => box.role === 'inbox')?.id || mailboxes[0]?.id || ''); try { const saved = readImportCheckpoint(checkpointKey); setCheckpoint(saved); if (saved) { setProgress({ done: saved.position, total: saved.total }); setMailboxId(saved.mailboxId); setRestoreLabels(saved.restoreLabels !== false); setDuplicatePolicy(saved.duplicatePolicy || 'keep'); } } catch (e) { setError(e instanceof Error ? e.message : 'Cannot read import progress.'); } return () => { mounted.current = false; stopped.current = true; remoteStopped.current = true; }; }, [accountId, checkpointKey]);
  const current = (id: string) => mounted.current && account.current === id && scope.current === checkpointKey;
  async function reloadRemoteJobs() {
    const id = accountId;
    try { const response = await client.call<{ list: RemoteMigrationJob[] }>('Migration/get', {}, id); if (current(id)) { setRemoteJobs(response.list); setRemoteError(''); } }
    catch (e) { if (current(id)) setRemoteError(e instanceof Error ? e.message : 'Could not load source migrations.'); }
  }
  function updateRemoteJob(next: RemoteMigrationJob) { setRemoteJobs(values => [next, ...values.filter(value => value.id !== next.id)]); }
  async function startRemoteMigration(event: React.FormEvent) {
    event.preventDefault(); const id = accountId; const credential = sourceCredential; setSourceCredential(''); setRemoteBusy('start'); setRemoteError(''); setRemoteNotice('');
    try {
      const response = await client.call<{ job: RemoteMigrationJob }>('Migration/start', { sessionUrl: sourceUrl, credential, ...(sourceAccountId ? { sourceAccountId } : {}), operationId: crypto.randomUUID() }, id);
      if (current(id)) { updateRemoteJob(response.job); setRemoteNotice('Source migration created. Continue it below to import mail. Credentials are stored encrypted on the server and removed when the job completes or is cancelled.'); }
    } catch (e) { if (current(id)) setRemoteError(`${e instanceof Error ? e.message : 'Could not start migration.'} Reload jobs before retrying if the connection was interrupted.`); }
    finally { if (current(id)) setRemoteBusy(null); }
  }
  async function continueRemoteMigration(initial: RemoteMigrationJob) {
    const id = accountId; setRemoteBusy(initial.id); setRemoteError(''); setRemoteNotice(''); remoteStopped.current = false; let previous = initial;
    try {
      while (!remoteStopped.current && current(id)) {
        const next = await stepRemoteMigration(client, id, initial.id, pendingSteps.current);
        if (!current(id)) return; updateRemoteJob(next);
        if (next.state === 'failed') { setRemoteError(next.error || 'The source migration paused. Retry to resume.'); break; }
        if (next.state === 'completed') { setRemoteNotice(`Source migration complete: ${next.imported} messages imported, ${next.duplicates} identical duplicates skipped. Source mail is unchanged.`); break; }
        if (next.state === 'cancelled') { setRemoteNotice('Source migration cancelled. Completed imports and source mail are retained.'); break; }
        if (!migrationProgressChanged(previous, next)) { setRemoteNotice('The server has not advanced this job yet. Reload its status and continue when the active step finishes.'); break; }
        previous = next;
      }
      if (remoteStopped.current && current(id)) setRemoteNotice('Source migration paused after the current step. Continue later; its progress is saved on the server.');
    } catch (e) { if (current(id)) setRemoteError(e instanceof Error ? e.message : 'Source migration interrupted. Continue retries the pending operation safely.'); }
    finally { if (current(id)) setRemoteBusy(null); }
  }
  async function cancelRemoteMigration(value: RemoteMigrationJob) {
    const id = accountId; setRemoteBusy(value.id); setRemoteError('');
    try { const response = await client.call<{ job: RemoteMigrationJob }>('Migration/cancel', { jobId: value.id, operationId: crypto.randomUUID() }, id); if (current(id)) { updateRemoteJob(response.job); pendingSteps.current.delete(value.id); setRemoteNotice('Source migration cancelled. Source mail and completed imports are retained.'); } }
    catch (e) { if (current(id)) setRemoteError(e instanceof Error ? e.message : 'Could not cancel migration. Reload its status before retrying.'); }
    finally { if (current(id)) setRemoteBusy(null); }
  }
  async function runImport(value: ImportJob) {
    stopped.current = false; setBusy(true); setError('');
    try {
      if (value.checkpoint.restoreLabels !== false) {
        const definitions = orderMigrationMailboxes(value.messages.flatMap(message => message.mailboxes || []));
        const result = await client.call<GetResult<Mailbox>>('Mailbox/get', {}, value.accountId);
        const existing = [...result.list]; const mapping = value.checkpoint.labelMap ||= {}; const operations = value.checkpoint.labelOperations ||= {};
        for (const box of definitions) {
          if (stopped.current || !current(value.accountId)) break;
          if (mapping[box.id]) { if (!existing.some(item => item.id === mapping[box.id])) throw new Error('A restored label was removed. Cancel the checkpoint before retrying.'); continue; }
          let pending = value.checkpoint.pendingLabel;
          if (pending && pending.sourceId !== box.id) throw new Error('Saved label progress does not match this archive.');
          if (!pending) {
            const found = matchMigrationMailbox(box, existing, mapping);
            if (found) { mapping[box.id] = found; saveImportCheckpoint(value.checkpointKey, value.checkpoint); continue; }
            if (box.role) throw new Error(`No destination mailbox exists for the ${box.role} role.`);
            const operationId = operations[box.id] ||= crypto.randomUUID();
            pending = { sourceId: box.id, args: { operationId, ifInState: client.states.get(`${value.accountId}:Mailbox`), create: { label: { name: box.name, parentId: box.parentId ? mapping[box.parentId] : null, role: null, isSubscribed: true, ...(box.color ? { color: box.color } : {}) } } } };
            value.checkpoint.pendingLabel = pending; saveImportCheckpoint(value.checkpointKey, value.checkpoint);
          }
          const created = await client.call<SetResult>('Mailbox/set', pending.args, value.accountId);
          const labelId = created.created?.label?.id; if (!labelId) throw new Error('The server did not confirm label creation. Resume safely retries it.');
          mapping[box.id] = labelId; existing.push({ ...box, id: labelId, parentId: box.parentId ? mapping[box.parentId] : null, totalEmails: 0, unreadEmails: 0, role: null }); delete value.checkpoint.pendingLabel; saveImportCheckpoint(value.checkpointKey, value.checkpoint);
        }
      }
      while (value.position < value.messages.length && !stopped.current) {
        const index = value.position; const message = value.messages[index];
        saveImportCheckpoint(value.checkpointKey, value.checkpoint);
        let blobId = value.uploads.get(index);
        if (!blobId) { blobId = (await client.upload(new File([message.bytes as BlobPart], `message-${index + 1}.eml`, { type: 'message/rfc822' }), value.accountId)).blobId; value.uploads.set(index, blobId); value.checkpoint.pendingBlobId = blobId; saveImportCheckpoint(value.checkpointKey, value.checkpoint); }
        if (!current(value.accountId)) return;
        // Keep exact arguments and operation IDs on retry, including an uncertain network response.
        let args = value.args.get(index);
        if (!args) {
          const restored = value.checkpoint.restoreLabels !== false && message.mailboxes?.length && message.mailboxIds ? Object.fromEntries(Object.keys(message.mailboxIds).map(sourceId => { const mapped = value.checkpoint.labelMap?.[sourceId]; if (!mapped) throw new Error('Archive label mapping is incomplete.'); return [mapped, true]; })) : { [value.mailboxId]: true };
          args = { operationId: value.operationIds[index], duplicatePolicy: value.checkpoint.duplicatePolicy || 'keep', emails: { message: { blobId, mailboxIds: restored, keywords: message.keywords, ...(message.receivedAt ? { receivedAt: message.receivedAt } : {}) } }, ...(client.states.get(`${value.accountId}:Email`) ? { ifInState: client.states.get(`${value.accountId}:Email`) } : {}) }; value.args.set(index, args); }
        value.checkpoint.pendingArgs = args; saveImportCheckpoint(value.checkpointKey, value.checkpoint);
        const response = await client.call<SetResult>('Email/import', args, value.accountId);
        if (!response.created?.message?.id) throw new Error('The server did not confirm this imported message. Resume retries the same operation.');
        if ((response.created.message as { isDuplicate?: boolean }).isDuplicate) value.checkpoint.skipped = (value.checkpoint.skipped || 0) + 1;
        value.position++; value.checkpoint.position = value.position; delete value.checkpoint.pendingArgs; delete value.checkpoint.pendingBlobId; saveImportCheckpoint(value.checkpointKey, value.checkpoint); if (current(value.accountId)) setProgress({ done: value.position, total: value.messages.length });
      }
      if (value.position === value.messages.length) { clearImportCheckpoint(value.checkpointKey); if (current(value.accountId)) setCheckpoint(null); }
      if (current(value.accountId)) setNotice(value.position === value.messages.length ? `${value.position - (value.checkpoint.skipped || 0)} messages imported; ${value.checkpoint.skipped || 0} identical duplicates skipped. Your source file is unchanged.` : `Paused after ${value.position} messages. Resume continues with the next message.`);
    } catch (e) { if (current(value.accountId)) setError(e instanceof Error ? e.message : 'Import failed. Resume retries this message.'); }
    finally { if (current(value.accountId)) setBusy(false); }
  }
  async function selectFile(file: File) {
    setError(''); setNotice(''); setBusy(true); stopped.current = false; const id = accountId;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('Choose a file up to 100 MB. Split larger mbox archives first.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const fingerprint = await fileFingerprint(bytes);
      const saved = readImportCheckpoint(checkpointKey);
      if (saved && (saved.fingerprint !== fingerprint || saved.size !== file.size)) throw new Error('This file differs from the saved import. Reselect the original file to resume, or cancel its checkpoint before starting a fresh import.');
      const messages = parseImport(bytes, /\.mbox$/i.test(file.name));
      if (saved && saved.total !== messages.length) throw new Error('This file no longer matches the saved message count. Cancel the checkpoint to start a fresh import.');
      if (!current(id) || stopped.current) return;
      const progress = saved || { version: 1 as const, fingerprint, size: file.size, name: file.name, mailboxId, restoreLabels, duplicatePolicy, total: messages.length, position: 0, operationIds: messages.map(() => crypto.randomUUID()) };
      if (!mailboxes.some(box => box.id === progress.mailboxId)) throw new Error('The import destination no longer exists. Cancel this checkpoint and choose another mailbox.');
      saveImportCheckpoint(checkpointKey, progress); setCheckpoint(progress);
      const value: ImportJob = { checkpoint: progress, checkpointKey, accountId: id, mailboxId: progress.mailboxId, name: file.name, messages, position: progress.position, operationIds: progress.operationIds, uploads: new Map(progress.pendingBlobId ? [[progress.position, progress.pendingBlobId]] : []), args: new Map(progress.pendingArgs ? [[progress.position, progress.pendingArgs]] : []) };
      job.current = value; setProgress({ done: progress.position, total: messages.length }); await runImport(value);
    } catch (e) { if (current(id)) setError(e instanceof Error ? e.message : 'Cannot read this file.'); }
    finally { if (current(id)) setBusy(false); }
  }
  async function exportMail() {
    const id = accountId; stopped.current = false; setBusy(true); setError(''); setNotice(''); let exportId = ''; let sink: FileSink | undefined;
    try {
      // The file picker must be called during the user gesture, before network requests.
      const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable(): Promise<FileSink> }> }).showSaveFilePicker;
      if (picker) sink = await (await picker({ suggestedName: 'enough-mail.mbox', types: [{ description: 'Mailbox archive', accept: { 'application/mbox': ['.mbox'] } }] })).createWritable();
      const start = await client.call<{ exportId: string; total: number; mailboxes: Mailbox[] }>('Export/start', { format: 'mbox', operationId: crypto.randomUUID() }, id); exportId = start.exportId;
      if (!exportId) throw new Error('The server did not create an export job.');
      if (!current(id)) throw new Error('Export cancelled.');
      setProgress({ done: 0, total: start.total }); const parts: Uint8Array[] = []; let size = 0; let position = 0;
      for (;;) {
        if (stopped.current || !current(id)) throw new Error('Export cancelled. Source messages are unchanged.');
        const page = await client.call<ExportPage>('Export/page', { exportId, position, limit: 25 }, id);
        for (const email of page.list) {
          if (stopped.current || !current(id)) throw new Error('Export cancelled. Source messages are unchanged.');
          const response = await fetch(client.download(id, email.blobId, `${email.id}.eml`, 'message/rfc822'), { credentials: 'same-origin' });
          if (!response.ok) throw new Error(`Could not download message ${position + 1}. No completed archive was saved.`);
          const chunks = mboxMessage(new Uint8Array(await response.arrayBuffer()), { ...email, mailboxes: mailboxDefinitions(email.mailboxIds, start.mailboxes) });
          if (sink) await sink.write(new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer()));
          else for (const chunk of chunks) { size += chunk.length; if (size > MAX_IMPORT_BYTES) throw new Error('This archive exceeds the 100 MB browser memory limit. Export using a browser with Save File support, such as desktop Chrome or Edge.'); parts.push(chunk); }
          position++; if (current(id)) setProgress({ done: position, total: page.total });
        }
        if (!page.hasMore) break;
        if (page.nextPosition <= position - page.list.length || !page.list.length) throw new Error('The export could not advance. Try again.');
        position = page.nextPosition;
      }
      if (sink) { await sink.close(); sink = undefined; } else { const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: 'application/mbox' })); const link = document.createElement('a'); link.href = url; link.download = 'enough-mail.mbox'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
      if (current(id)) setNotice('Full account archive exported with message bodies, attachments, dates, flags and mailbox metadata. Your mail is unchanged.');
    } catch (e) { if (sink) await sink.abort().catch(() => {}); if (current(id)) setError(e instanceof Error ? e.message : 'Export failed. Your mail is unchanged.'); }
    finally { if (exportId) await client.call('Export/cancel', { exportId, operationId: crypto.randomUUID() }, id).catch(() => {}); if (current(id)) setBusy(false); }
  }
  return <div className="mail-migration"><fieldset disabled={readOnly} className="mail-settings-subsection mail-migration-file-import"><h4>Import email files</h4><p>Choose an .eml message or mbox archive. Imports preserve attachments, dates and flags and keep your source files. To resume after a reload, select the same file again.</p><label className="mail-settings-check"><MailCheckbox checked={restoreLabels} disabled={busy || Boolean(remoteBusy) || Boolean(checkpoint)} onChange={e => setRestoreLabels(e.target.checked)} />Restore archived labels, hierarchy and standard mailboxes</label><label className="mail-settings-field">Duplicate messages<NativeSelect value={duplicatePolicy} disabled={busy || Boolean(remoteBusy) || Boolean(checkpoint)} onChange={e => setDuplicatePolicy(e.target.value as 'skipIdentical' | 'keep')}><option value="skipIdentical">Skip identical messages</option><option value="keep">Keep every message</option></NativeSelect></label><label className="mail-settings-field">Fallback mailbox (when archive has no labels)<NativeSelect value={mailboxId} disabled={busy || Boolean(remoteBusy) || Boolean(checkpoint)} onChange={e => setMailboxId(e.target.value)}>{mailboxes.map(box => <option value={box.id} key={box.id}>{box.name}</option>)}</NativeSelect></label><label className="mail-settings-field">Email file (up to 100 MB)<Input type="file" accept=".eml,.mbox,message/rfc822,application/mbox" disabled={busy || Boolean(remoteBusy) || !mailboxId} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void selectFile(file); }} /></label>{checkpoint && !busy && <p role="status">Saved import: {checkpoint.name}. Reselect this exact file to continue.</p>}{!busy && checkpoint && <Button variant="outline" onClick={() => { clearImportCheckpoint(checkpointKey); job.current = null; setCheckpoint(null); setProgress({ done: 0, total: 0 }); setNotice('Import checkpoint cancelled. Source files and already imported messages are retained.'); }}>Cancel saved import</Button>}{progress.total > 0 && <p role="status" aria-live="polite">{progress.done} of {progress.total} messages completed</p>}{busy && <Button variant="outline" onClick={() => { stopped.current = true; }}>Pause or cancel</Button>}{!busy && job.current && job.current.position < job.current.messages.length && <Button variant="outline" disabled={Boolean(remoteBusy)} onClick={() => void runImport(job.current!)}>Resume import</Button>}</fieldset><section className="mail-settings-subsection"><h4>Download your mail</h4><p>Keep a complete archive of this inbox, including its folders and metadata.</p><Button variant="outline" disabled={busy || Boolean(remoteBusy)} onClick={() => void exportMail()}>Export full account as mbox</Button><p>Large exports stream directly to disk in supported browsers; other browsers support archives up to 100 MB.</p></section><details className="mail-secondary-tools"><summary>Import from another mail provider</summary><h4>Import from a JMAP provider</h4><p>Copy mail, attachments, dates, flags and mailbox hierarchy from an approved JMAP provider. Identical messages are skipped. Source mail is never changed. Jobs are saved on Cloudflare and can be resumed after leaving this page.</p><p>The workspace operator must configure encrypted migration credentials and approve the provider origin before this service is available.</p><form onSubmit={event => void startRemoteMigration(event)} autoComplete="off"><fieldset disabled={readOnly}><label className="mail-settings-field">Source JMAP session URL<Input type="url" required value={sourceUrl} autoComplete="off" disabled={Boolean(remoteBusy) || busy} onChange={e => setSourceUrl(e.target.value)} placeholder="https://mail.example/.well-known/jmap" /></label><label className="mail-settings-field">Source API token<Input type="password" required value={sourceCredential} autoComplete="off" disabled={Boolean(remoteBusy) || busy} onChange={e => setSourceCredential(e.target.value)} /></label><label className="mail-settings-field">Source account ID (optional)<Input value={sourceAccountId} autoComplete="off" disabled={Boolean(remoteBusy) || busy} onChange={e => setSourceAccountId(e.target.value)} /></label><Button type="submit" disabled={Boolean(remoteBusy) || busy}>Create source migration</Button></fieldset></form><Button variant="outline" disabled={Boolean(remoteBusy)} onClick={() => void reloadRemoteJobs()}>Reload source migrations</Button>{remoteBusy && remoteBusy !== 'start' && <Button variant="outline" onClick={() => { remoteStopped.current = true; }}>Pause after current step</Button>}<ul className="mail-settings-list">{remoteJobs.map(value => <li key={value.id}><div><strong>{value.sourceUrl}</strong><p role="status" aria-live="polite">{value.state} · {value.phase} · {value.imported} imported · {value.duplicates} duplicates skipped{value.total !== null ? ` · ${value.cursor} of ${value.total} processed` : ''}</p>{value.error && <p role="alert">{value.error}</p>}</div>{!['completed', 'cancelled'].includes(value.state) && <div><Button variant="outline" disabled={readOnly || Boolean(remoteBusy) || busy} onClick={() => void continueRemoteMigration(value)}>Continue migration</Button><Button variant="outline" disabled={readOnly || Boolean(remoteBusy) || busy} onClick={() => void cancelRemoteMigration(value)}>Cancel source migration</Button></div>}</li>)}</ul>{remoteError && <p role="alert">{remoteError}</p>}{remoteNotice && <p role="status">{remoteNotice}</p>}</details>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</div>;
}
