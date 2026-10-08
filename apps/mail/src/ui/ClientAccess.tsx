import MailCheckbox from './MailCheckbox';
import { NativeSelect } from '@rebnz/enough-ui/native-select';
import { Spinner } from '@rebnz/enough-ui/spinner';
import { Input } from '@rebnz/enough-ui/input';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@open-cloud/ui';
import { type MailClient } from './jmap';

interface Credential {
  id: string; name: string; accountId: string; actions: string[];
  expiresAt: number; createdAt: number; revokedAt: number | null; version: number;
}
interface ClientInfo { enabled: boolean; sessionUrl: string | null }
const permissions = [
  ['mail.read', 'Read messages and attachments'],
  ['mail.organize', 'Organize messages and mailboxes'],
  ['mail.draft', 'Create drafts and upload attachments'],
  ['mail.send', 'Send messages'],
] as const;

async function request<T>(path: string, body?: unknown, method = 'POST', signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/apps/mail/api/${path}`, {
    method: body === undefined ? 'GET' : method, credentials: 'same-origin', cache: 'no-store', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error?.message || (typeof data.error === 'string' ? data.error.replaceAll('_', ' ') : `Client access unavailable (${response.status}).`));
  return data as T;
}
function configuredSessionUrl(info: ClientInfo): string | null {
  if (!info.enabled || !info.sessionUrl) return null;
  try { const url = new URL(info.sessionUrl); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

export default function ClientAccess({ client, accountId }: { client: MailClient; accountId: string }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [info, setInfo] = useState<ClientInfo>({ enabled: false, sessionUrl: null });
  const [name, setName] = useState('');
  const [actions, setActions] = useState<string[]>(['mail.read']);
  const [days, setDays] = useState(30);
  const [secret, setSecret] = useState<{ credential: Credential; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const capability = client.session.accounts[accountId]?.accountCapabilities['urn:enough:params:jmap:mail'] as { actions?: string[] } | undefined;
  const allowed = capability?.actions || [];
  const canIssue = permissions.some(([action]) => allowed.includes(action));
  const sessionUrl = configuredSessionUrl(info);
  const currentCredentials = credentials.filter(value => value.accountId === accountId);

  async function reload(signal?: AbortSignal) {
    const version = generation.current;
    const [list, configuration] = await Promise.all([
      request<{ credentials: Credential[] }>('credentials', undefined, 'GET', signal),
      request<ClientInfo>('client-info', undefined, 'GET', signal),
    ]);
    if (!signal?.aborted && generation.current === version) { setCredentials(list.credentials); setInfo(configuration); setLoaded(true); }
  }
  useEffect(() => {
    const controller = new AbortController(); const version = ++generation.current;
    setSecret(null); setCredentials([]); setInfo({ enabled: false, sessionUrl: null });
    setName(''); setActions(allowed.includes('mail.read') ? ['mail.read'] : []); setLoading(true); setLoaded(false); setBusy(false); setError(''); setNotice('');
    void reload(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load client access.'); })
      .finally(() => { if (generation.current === version) setLoading(false); });
    return () => { controller.abort(); generation.current++; };
  }, [accountId]);

  async function run(action: () => Promise<void>) {
    const version = generation.current;
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (e) { if (generation.current === version) setError(e instanceof Error ? e.message : 'Client access could not be changed.'); }
    finally { if (generation.current === version) setBusy(false); }
  }
  async function issue(event: React.FormEvent) {
    event.preventDefault(); if (!canIssue || !sessionUrl || !actions.length || actions.some(action => !allowed.includes(action))) return;
    const version = generation.current; setSecret(null);
    await run(async () => {
      const result = await request<{ credential: Credential; token?: string; secretAlreadyIssued?: boolean }>('credentials', {
        operationId: crypto.randomUUID(), accountId, name: name.trim(), actions, expiresAt: Date.now() + days * 86400000,
      });
      if (generation.current !== version) return;
      setCredentials(values => [...values.filter(value => value.id !== result.credential.id), result.credential]);
      if (result.token) setSecret({ credential: result.credential, token: result.token });
      else setNotice('This credential was already issued. Its secret cannot be shown again. Revoke it and create a new credential.');
      setName('');
    });
  }
  async function revoke(credential: Credential) {
    const version = generation.current;
    await run(async () => {
      const result = await request<{ credential: Credential }>(`credentials/${encodeURIComponent(credential.id)}`, {
        operationId: crypto.randomUUID(), expectedVersion: credential.version,
      }, 'DELETE');
      if (generation.current !== version) return;
      setCredentials(values => values.map(value => value.id === result.credential.id ? result.credential : value));
      if (secret?.credential.id === credential.id) setSecret(null);
      setNotice('Credential revoked. It can no longer access mail.');
    });
  }
  function downloadSetup() {
    if (!secret || !sessionUrl) return;
    const text = `Enough Mail JMAP client setup\n\nServer / session URL: ${sessionUrl}\nAccount ID: ${accountId}\nAuthentication: Bearer token\nToken: ${secret.token}\nPermissions: ${secret.credential.actions.join(', ')}\nExpires: ${new Date(secret.credential.expiresAt).toISOString()}\n\nKeep this file private. Use a client that supports JMAP with bearer-token authentication. Outlook cannot connect directly; IMAP and SMTP client access is not currently provided. Revoke this credential in Enough Mail if the file or token is exposed.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'enough-mail-client-setup.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('Setup file downloaded. It contains your secret token; keep it private.');
  }

  return <div className="mail-client-access">
    <div className="mail-settings-inline-empty"><strong>Compatible with JMAP apps</strong><p>Use bearer-token authentication. Outlook, Apple Mail and other apps that require IMAP or SMTP cannot connect directly.</p></div>
    {error && <p role="alert">{error} <Button variant="outline" disabled={busy || loading} onClick={() => void run(() => reload())}>Reload</Button></p>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p role="status"><Spinner size="sm" /> Loading client access…</p> : !loaded ? <div className="mail-settings-inline-empty"><strong>Client access could not be loaded</strong><p>Reload to see the server connection and your existing credentials.</p></div> : <>
      {sessionUrl ? <label className="mail-settings-field">JMAP server / session URL<Input readOnly value={sessionUrl} /></label> : <p role="status">External JMAP access is not configured for this workspace. Ask your workspace administrator to enable its client endpoint.</p>}
      {secret && <section className="mail-settings-subsection" aria-label="New client credential">
        <h4>Save your credential now</h4><p>This secret is shown once. Closing settings or switching accounts removes it from this screen.</p>
        <label className="mail-settings-field">Bearer token<Input readOnly autoComplete="off" spellCheck={false} value={secret.token} /></label>
        <p>In your JMAP client, enter the server URL above and choose bearer-token authentication. Use this token as the credential. Clients that support only password authentication may require a different connection method.</p>
        <Button variant="outline" disabled={busy} onClick={() => void run(async () => { const version = generation.current; await navigator.clipboard.writeText(secret.token); if (version === generation.current) setNotice('Token copied.'); })}>Copy token</Button>{' '}
        <Button variant="outline" disabled={!sessionUrl} onClick={downloadSetup}>Download setup with token</Button>{' '}
        <Button variant="outline" onClick={() => setSecret(null)}>Hide token</Button>
      </section>}
      <h4>Client credentials</h4>
      {!currentCredentials.length ? <p>No client credentials for this account.</p> : <ul className="mail-settings-list">{currentCredentials.map(value => {
        const inactive = Boolean(value.revokedAt) || value.expiresAt <= Date.now();
        return <li key={value.id}><div><strong>{value.name}</strong><p>{value.actions.map(action => permissions.find(([id]) => id === action)?.[1] || action).join(', ')}</p><p>{value.revokedAt ? 'Revoked' : inactive ? 'Expired' : 'Expires'}{!value.revokedAt && <> · <time dateTime={new Date(value.expiresAt).toISOString()}>{new Date(value.expiresAt).toLocaleString()}</time></>}</p></div>{!value.revokedAt && <Button variant="outline" disabled={busy} onClick={() => void revoke(value)}>Revoke</Button>}</li>;
      })}</ul>}
      {canIssue ? <details className="mail-secondary-tools"><summary>Create a client credential</summary><form className="mail-settings-form" onSubmit={issue}>
        <h4>Create a client credential</h4><p>Select only the permissions this client needs. Reading does not permit changes or sending.</p>
        <label className="mail-settings-field">Client name<Input required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="My JMAP client" /></label>
        <fieldset><legend>Account permissions</legend>{permissions.filter(([action]) => allowed.includes(action)).map(([action, label]) => <label key={action} className="mail-settings-check"><MailCheckbox checked={actions.includes(action)} onChange={event => setActions(values => event.target.checked ? [...values, action] : values.filter(value => value !== action))} />{label}</label>)}</fieldset>
        <label className="mail-settings-field">Expires after<NativeSelect value={days} onChange={event => setDays(Number(event.target.value))}>{[1, 7, 30, 90].map(value => <option key={value} value={value}>{value} {value === 1 ? 'day' : 'days'}</option>)}</NativeSelect></label>
        <Button type="submit" disabled={busy || !sessionUrl || !name.trim() || !actions.length || actions.some(action => !allowed.includes(action))}>{busy ? 'Saving…' : 'Create credential'}</Button>
      </form></details> : <p>You do not currently have account permissions that can be granted to a client.</p>}
    </>}
  </div>;
}
