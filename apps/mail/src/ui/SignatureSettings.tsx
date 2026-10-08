import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle, CardDescription } from '@open-cloud/ui';
import { Input } from '@rebnz/enough-ui/input';
import { Textarea } from '@rebnz/enough-ui/textarea';
import { Spinner } from '@rebnz/enough-ui/spinner';
import { validateSignatures, type MailSignature } from '../domain/signatures';
import { cleanComposeHtml, composePlainText } from './compose-content';
import { safeMailHtml } from './safe-html';
import type { MailClient, Identity, GetResult } from './jmap';

export default function SignatureSettings({ client, accountId, canManage, onChanged }: { client: MailClient; accountId: string; canManage: boolean; onChanged?: () => void }) {
  const [library, setLibrary] = useState<MailSignature[]>([]), [identities, setIdentities] = useState<Identity[]>([]);
  const [editing, setEditing] = useState<MailSignature | null>(null), [source, setSource] = useState(false), [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const editor = useRef<HTMLDivElement>(null), mounted = useRef(true), generation = useRef(0);
  async function load() {
    const version = generation.current;
    setLoading(true); setError('');
    try {
      const [settings, addresses] = await Promise.all([client.call<{ settings: { signatures?: MailSignature[] } }>('Settings/get', {}, accountId), client.call<GetResult<Identity>>('Identity/get', {}, accountId)]);
      if (!mounted.current || version !== generation.current) return;
      setLoaded(true); setLibrary(validateSignatures(settings.settings.signatures || [])); setIdentities(addresses.list);
    } catch (e) { if (mounted.current && version === generation.current) setError(e instanceof Error ? e.message : 'Signatures could not be loaded.'); }
    finally { if (mounted.current && version === generation.current) setLoading(false); }
  }
  useEffect(() => { generation.current++; mounted.current = true; setLoaded(false); setEditing(null); setLibrary([]); setPending(null); void load(); return () => { mounted.current = false; generation.current++; }; }, [accountId]);
  useEffect(() => { if (editor.current && document.activeElement !== editor.current) editor.current.innerHTML = cleanComposeHtml(editing?.html || '',false,true); }, [editing?.id, editing?.html, source]);
  function capture() { if (editor.current) { const html = cleanComposeHtml(editor.current.innerHTML, true); setEditing(value => value ? { ...value, html, text: composePlainText(html) } : null); } }
  async function commit(args: Record<string, unknown>, message: string) {
    const version = generation.current;
    setBusy(true); setError(''); setNotice(''); setPending(args);
    try { await client.call('Settings/set', args, accountId); if (!mounted.current || version !== generation.current) return; setPending(null); setEditing(null); setNotice(message); onChanged?.(); await load(); }
    catch (e) { if (!mounted.current || version !== generation.current) return; if ((e as { confirmed?: boolean })?.confirmed) setPending(null); setError(e instanceof Error ? e.message : 'The save could not be confirmed. Retry the pending save.'); }
    finally { if (mounted.current && version === generation.current) setBusy(false); }
  }
  function save(next: MailSignature[], message: string) {
    try { const signatures = validateSignatures(next); const state = client.states.get(`${accountId}:Settings`); void commit({ settings: { signatures }, operationId: crypto.randomUUID(), ...(state ? { ifInState: state } : {}) }, message); }
    catch (e) { setError(e instanceof Error ? e.message : 'Check the signature details.'); }
  }
  const format = (command: string) => { editor.current?.focus(); document.execCommand(command); capture(); };
  return <div className="mail-signature-settings">
    {error && <p role="alert">{error} {!pending && <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>Reload signatures</Button>}</p>}
    {notice && <p role="status">{notice}</p>}
    {pending && !busy && <div className="mail-settings-inline-empty"><strong>Save confirmation needed</strong><p>Your exact save request is preserved. Retry to confirm it without creating another signature.</p><Button disabled={!canManage} onClick={() => void commit(pending, 'Signature saved.')}>Retry pending save</Button></div>}
    {loading ? <p role="status"><Spinner size="sm" /> Loading signatures…</p> : !loaded ? <div className="mail-settings-inline-empty"><strong>Signatures are unavailable</strong><p>Reload before creating or changing signatures.</p></div> : editing ? <form className="mail-settings-form mail-signature-editor" onSubmit={event => { event.preventDefault(); const html = cleanComposeHtml(editing.html, true); const value = { ...editing, html, text: composePlainText(html) }; save([...library.filter(signature => signature.id !== value.id), value], 'Signature saved. Choose its default email address in Email addresses.'); }}>
      <h4>{library.some(signature => signature.id === editing.id) ? 'Edit signature' : 'New signature'}</h4>
      <label className="mail-settings-field">Signature name<Input required maxLength={100} value={editing.name} disabled={busy || Boolean(pending)} placeholder="e.g. Work or Short reply" onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
      <div className="mail-signature-format" role="toolbar" aria-label="Signature formatting"><Button type="button" variant="ghost" size="sm" disabled={busy || Boolean(pending)} aria-pressed={source} onClick={() => setSource(value => !value)}>{source ? 'Visual editor' : 'HTML source'}</Button>{!source && [['bold','Bold'],['italic','Italic'],['underline','Underline'],['insertUnorderedList','Bullet list']].map(([command,label]) => <Button type="button" variant="ghost" size="sm" key={command} disabled={busy || Boolean(pending)} onMouseDown={event => event.preventDefault()} onClick={() => format(command)}>{label}</Button>)}</div>
      {source ? <label className="mail-settings-field">Signature HTML<Textarea rows={8} disabled={busy || Boolean(pending)} value={editing.html} onChange={event => setEditing({ ...editing, html: event.target.value, text: composePlainText(event.target.value) })} /></label> : <div ref={editor} className="mail-signature-body" role="textbox" aria-label="Signature content" aria-multiline="true" contentEditable={!busy && !pending} suppressContentEditableWarning onInput={capture} onPaste={event => { event.preventDefault(); const html = event.clipboardData.getData('text/html'); editor.current?.focus(); document.execCommand(html ? 'insertHTML' : 'insertText', false, html ? cleanComposeHtml(html,false,true) : event.clipboardData.getData('text/plain')); capture(); }} />}
      <p>Paste a formatted signature, or use HTML source for links, tables and layout. Active content is removed. Each email address can have a default; any saved signature can be selected while composing.</p>
      <div className="mail-settings-form-footer"><Button type="submit" disabled={busy || Boolean(pending) || !editing.name.trim()}>{busy ? 'Saving…' : 'Save signature'}</Button><Button type="button" variant="outline" disabled={busy || Boolean(pending)} onClick={() => setEditing(null)}>Cancel</Button></div>
    </form> : <>
      {canManage && <Button disabled={Boolean(pending)} onClick={() => { setSource(false); setEditing({ id: crypto.randomUUID(), name: '', text: '', html: '' }); }}>New signature</Button>}
      {!library.length && !error && <div className="mail-settings-inline-empty"><strong>No signatures yet</strong><p>{canManage ? 'Create a named signature once, then choose it for any email address in this inbox.' : 'An inbox manager can create named signatures for this inbox.'}</p></div>}
      <div className="mail-signature-library">{library.map(signature => { const defaults = identities.filter(identity => identity.signatureId === signature.id); return <Card key={signature.id}><CardHeader><CardTitle>{signature.name}</CardTitle><CardDescription>{defaults.length ? `Default for ${defaults.map(identity => identity.email).join(', ')}` : 'Available while composing'}</CardDescription></CardHeader><CardContent><iframe title={`${signature.name} preview`} sandbox="" srcDoc={safeMailHtml(signature.html || signature.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>'),true)} />{canManage && <div className="mail-inline-actions"><Button variant="outline" size="sm" disabled={busy || Boolean(pending)} onClick={() => { setSource(false); setEditing(signature); }}>Edit</Button><Button variant="ghost" size="sm" disabled={busy || Boolean(pending) || defaults.length > 0} onClick={() => save(library.filter(value => value.id !== signature.id), 'Signature deleted.')}>Delete</Button>{defaults.length > 0 && <span className="mail-help">Change its email address defaults before deleting.</span>}</div>}</CardContent></Card>; })}</div>
    </>}
  </div>;
}
