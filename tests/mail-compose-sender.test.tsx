// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import Compose from '../apps/mail/src/ui/Compose';
import SenderInput, { senderSuggestions } from '../apps/mail/src/ui/SenderInput';
import { draftCacheKey, type Email, type MailClient } from '../apps/mail/src/ui/jmap';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); dispose = () => {}; document.body.innerHTML = ''; localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const identities = [{ id: 'main', email: 'main@example.test', name: 'Owner', verified: true }];
const source = (overrides: Partial<Email> = {}) => ({ id: 'source', threadId: 'thread', blobId: 'original', mailboxIds: { inbox: true }, keywords: {},
  from: [{ email: 'sender@elsewhere.test' }], to: [{ email: 'orders@example.test' }], subject: 'Question', receivedAt: '2026-10-08T12:00:00Z',
  preview: 'Question', hasAttachment: false, textBody: [], htmlBody: [], attachments: [], ...overrides } as Email);
function fixture() {
  let count = 0;
  let saved = source({ id: 'draft', blobId: 'draft-bytes', mailboxIds: { drafts: true }, keywords: { $draft: true } });
  const call = vi.fn(async (method: string, args: any): Promise<any> => {
    if (method === 'Domain/get') return { state: 'revision', list: [{ name: 'example.test', sendingVerified: true, enabled: true }] };
    if (method === 'Identity/get') return { state: 'revision', list: [] };
    if (method === 'Identity/resolve') return { oldState: 'revision', newState: 'sender-resolved', identity: { id: 'resolved', email: args.email, name: '' } };
    if (method === 'Email/get') return { state: 'revision', list: args.ids.length ? [saved] : [] };
    if (method === 'Email/set') {
      saved = { ...source(), ...args.create.compose, id: 'draft-' + ++count, blobId: 'bytes-' + count };
      return { created: { compose: { id: saved.id, blobId: saved.blobId } } };
    }
    if (method === 'EmailSubmission/get') return { state: 'revision', list: [] };
    if (method === 'EmailSubmission/set') return { created: { compose: { id: 'submitted' } } };
    return { list: [], settings: {} };
  });
  const client = { session: { actorId: 'actor', username: 'actor', organizationId: 'org', workspaceId: 'workspace', accounts: { account: { name: 'Personal' } } }, states: new Map(), call } as unknown as MailClient;
  return { client, call };
}
async function render(node: React.ReactNode) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  dispose = () => act(() => root.unmount()); await act(async () => root.render(node)); return host;
}
const props = (client: MailClient) => ({ client, accountId: 'account', identities, mailboxes: [{ id: 'drafts', name: 'Drafts', role: 'drafts', totalEmails: 0, unreadEmails: 0 }], onClose: vi.fn(), onSaved: vi.fn(), onSubmitted: vi.fn() });
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')].find(element => element.textContent === label)!;
async function input(host: HTMLElement, label: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}

test('catch-all replies use the trusted original recipient and reply-all excludes that alias', async () => {
  const { client } = fixture();
  const host = await render(<Compose {...props(client)} mode="replyAll" reply={source({ deliveryRecipient: 'blind@example.test', to: [{ email: 'orders@example.test' }, { email: 'blind@example.test' }] })} />);
  expect(host.querySelector<HTMLInputElement>('[aria-label="From"]')!.value).toBe('blind@example.test');
  expect(host.querySelector<HTMLInputElement>('[aria-label="To"]')!.value).toBe('sender@elsewhere.test, orders@example.test');
});

test('legacy replies use one local recipient, ignore forged headers, and keep ambiguous choices empty', async () => {
  const { client } = fixture();
  const host = await render(<Compose {...props(client)} reply={source({ headers: [{ name: 'Delivered-To', value: 'forged@example.test' }] })} />);
  expect(host.querySelector<HTMLInputElement>('[aria-label="From"]')!.value).toBe('orders@example.test');
  dispose(); dispose = () => {}; localStorage.clear();
  const second = await render(<Compose {...props(client)} reply={source({ to: [{ email: 'orders@example.test' }, { email: 'other@example.test' }] })} />);
  expect(second.querySelector<HTMLInputElement>('[aria-label="From"]')!.value).toBe('');
});

test('late domain suggestions reveal ambiguity without swallowing body edits or pausing autosave', async () => {
  vi.useFakeTimers();
  const { client, call } = fixture(); const original = call.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  const domains = new Promise(resolve => { finish = resolve; });
  call.mockImplementation(async (method, args) => method === 'Domain/get' ? domains : original(method, args));
  const host = await render(<Compose {...props(client)} reply={source({ to: [{ email: 'main@example.test' }], cc: [{ email: 'orders@example.test' }] })} />);
  expect(host.querySelector<HTMLInputElement>('[aria-label="From"]')!.value).toBe('main@example.test');
  const editor = host.querySelector<HTMLElement>('[aria-label="Message"]')!;
  await act(async () => { editor.innerText = 'Edited while loading'; editor.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => finish({ list: [{ name: 'example.test', sendingVerified: true, enabled: true }] }));
  expect(host.querySelector<HTMLInputElement>('[aria-label="From"]')!.value).toBe('');
  expect(editor.innerText).toBe('Edited while loading');
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  expect(call.mock.calls.find(([method]) => method === 'Email/set')![1].create.compose.bodyValues.text.value).toBe('Edited while loading');
});

test('late domain suggestions preserve an explicitly edited From', async () => {
  const { client, call } = fixture(); const original = call.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  const domains = new Promise(resolve => { finish = resolve; });
  call.mockImplementation(async (method, args) => method === 'Domain/get' ? domains : original(method, args));
  const host = await render(<Compose {...props(client)} reply={source()} />);
  await input(host, 'From', 'chosen@example.test');
  await act(async () => finish({ list: [{ name: 'example.test', sendingVerified: true, enabled: true }] }));
  expect(host.querySelector<HTMLInputElement>('[aria-label="From"]')!.value).toBe('chosen@example.test');
});

test('an unfinished custom From saves and reopens without reserving an identity', async () => {
  const { client, call } = fixture();
  const host = await render(<Compose {...props(client)} />);
  await input(host, 'From', 'unfinished@'); await input(host, 'Subject', 'Keep my work');
  await act(async () => button(host, 'Save & close').click());
  const saved = call.mock.calls.find(([method]) => method === 'Email/set')![1].create.compose;
  expect(saved.draftFrom).toBe('unfinished@'); expect(saved.from).toEqual([]);
  expect(call.mock.calls.some(([method]) => method === 'Identity/resolve')).toBe(false);
  dispose(); dispose = () => {};
  const reopened = await render(<Compose {...props(client)} draft={source({ ...saved, id: 'saved', blobId: 'saved-bytes' })} />);
  expect(reopened.querySelector<HTMLInputElement>('[aria-label="From"]')!.value).toBe('unfinished@');
});

test('local recovery preserves a custom sender and older identity-only recovery migrates safely', async () => {
  const { client } = fixture();
  const fields = { identityId: '', fromEmail: 'custom@example.test', to: '', cc: '', bcc: '', subject: 'Recovered', body: 'Keep', attachments: [], sendAt: '' };
  localStorage.setItem(draftCacheKey(client.session, 'account'), JSON.stringify({ new: { fields } }));
  const host = await render(<Compose {...props(client)} />);
  expect(host.querySelector<HTMLInputElement>('[aria-label="From"]')!.value).toBe('custom@example.test');
  dispose(); dispose = () => {};
  localStorage.setItem(draftCacheKey(client.session, 'account'), JSON.stringify({ new: { fields: { ...fields, fromEmail: undefined, identityId: 'main' } } }));
  const legacy = await render(<Compose {...props(client)} />);
  expect(legacy.querySelector<HTMLInputElement>('[aria-label="From"]')!.value).toBe('main@example.test');
});

test('an older conflict backup without From text can be restored as a new draft', async () => {
  const { client, call } = fixture();
  const fields = { identityId: 'main', to: '', cc: '', bcc: '', subject: 'Old backup', body: 'Preserved old text', attachments: [], sendAt: '' };
  localStorage.setItem(draftCacheKey(client.session, 'account'), JSON.stringify({ 'new:conflict-backup': { fields } }));
  const host = await render(<Compose {...props(client)} />);
  await act(async () => button(host, 'Restore as a new draft').click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="From"]')!.value).toBe('main@example.test');
  const saved = call.mock.calls.find(([method]) => method === 'Email/set')![1].create.compose;
  expect(saved.draftFrom).toBe('main@example.test'); expect(saved.bodyValues.text.value).toBe('Preserved old text');
});

test('fresh sending suggestions include previously created aliases without replacing draft From', async () => {
  const { client, call } = fixture(); const original = call.getMockImplementation()!;
  call.mockImplementation(async (method, args) => method === 'Identity/get' ? { state: 'revision', list: [{ id: 'previous', email: 'previous@example.test', name: 'Previous alias' }] } : original(method, args));
  const host = await render(<Compose {...props(client)} draft={source({ keywords: { $draft: true }, draftFrom: 'unfinished@' })} />);
  const field = host.querySelector<HTMLInputElement>('[aria-label="From"]')!;
  expect(field.value).toBe('unfinished@');
  await input(host, 'From', 'previous');
  await act(async () => field.focus());
  expect(host.querySelector('[role="listbox"]')?.textContent).toContain('previous@example.test');
});

test('Send confirms a custom sender before saving and submitting the exact From', async () => {
  const { client, call } = fixture(); const options = props(client);
  const host = await render(<Compose {...options} reply={source({ deliveryRecipient: 'orders@example.test' })} />);
  expect(call.mock.calls.some(([method]) => method === 'Identity/resolve')).toBe(false);
  await act(async () => button(host, 'Send').click());
  expect(call.mock.calls.map(([method]) => method).filter(method => ['Identity/resolve', 'Email/set', 'EmailSubmission/set'].includes(method))).toEqual(['Identity/resolve', 'Email/set', 'EmailSubmission/set']);
  const resolution = call.mock.calls.find(([method]) => method === 'Identity/resolve')![1];
  expect(resolution.email).toBe('orders@example.test'); expect(resolution.ifInState).toBe('revision'); expect(resolution.operationId).toBeTruthy();
  const saved = call.mock.calls.find(([method]) => method === 'Email/set')![1].create.compose;
  expect(saved.from).toEqual([{ email: 'orders@example.test' }]); expect(saved.draftFrom).toBe('orders@example.test');
  expect(call.mock.calls.find(([method]) => method === 'EmailSubmission/set')![1].create.compose.identityId).toBe('resolved');
  expect(options.onSubmitted).toHaveBeenCalledWith('submitted', 'draft-1');
});

test('an address owned by another inbox is explained without submitting or losing the draft', async () => {
  const { client, call } = fixture(); const original = call.getMockImplementation()!;
  call.mockImplementation(async (method, args) => {
    if (method === 'Identity/resolve') throw Object.assign(new Error('This address belongs to another inbox.'), { confirmed: true, errorType: 'forbidden' });
    return original(method, args);
  });
  const host = await render(<Compose {...props(client)} reply={source({ deliveryRecipient: 'reserved@example.test' })} />);
  await act(async () => button(host, 'Send').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('belongs to another inbox');
  expect(call.mock.calls.some(([method]) => method === 'EmailSubmission/set')).toBe(false);
  const recovered = JSON.parse(localStorage.getItem(draftCacheKey(client.session, 'account'))!)['reply:source'];
  expect(recovered.fields.fromEmail).toBe('reserved@example.test'); expect(recovered.pendingIdentity).toBeUndefined();
  expect(host.querySelector<HTMLInputElement>('[aria-label="From"]')!.disabled).toBe(false);
});

test('an unfinished recipient cannot reserve the new sending address', async () => {
  const { client, call } = fixture();
  const host = await render(<Compose {...props(client)} reply={source({ deliveryRecipient: 'orders@example.test' })} />);
  await input(host, 'To', 'unfinished@');
  await act(async () => button(host, 'Send').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('valid recipient');
  expect(call.mock.calls.some(([method]) => method === 'Identity/resolve')).toBe(false);
});

test('an uncertain sender result survives reload and replays before mail can send', async () => {
  const { client, call } = fixture(); const original = call.getMockImplementation()!; let lost = true;
  call.mockImplementation(async (method, args) => { if (method === 'Identity/resolve' && lost) { lost = false; throw new TypeError('Lost result'); } return original(method, args); });
  const host = await render(<Compose {...props(client)} reply={source({ deliveryRecipient: 'orders@example.test' })} />);
  await act(async () => button(host, 'Send').click());
  const first = call.mock.calls.find(([method]) => method === 'Identity/resolve')![1];
  expect(host.textContent).toContain('Your message has not been sent.');
  expect(call.mock.calls.some(([method]) => method === 'EmailSubmission/set')).toBe(false);
  dispose(); dispose = () => {};
  const restored = await render(<Compose {...props(client)} reply={source({ deliveryRecipient: 'orders@example.test' })} />);
  expect(restored.querySelector<HTMLInputElement>('[aria-label="From"]')!.disabled).toBe(true);
  await act(async () => button(restored, 'Confirm sending address').click());
  expect(call.mock.calls.filter(([method]) => method === 'Identity/resolve').map(([, args]) => args)).toEqual([first, first]);
  expect(call.mock.calls.filter(([method]) => method === 'EmailSubmission/set')).toHaveLength(1);
});

test('an uncertain sender receipt can be checked separately before resolving a recovered draft conflict', async () => {
  const { client, call } = fixture();
  const fields = { identityId: '', fromEmail: 'orders@example.test', to: 'recipient@elsewhere.test', cc: '', bcc: '', subject: 'Recovered', body: 'Keep', attachments: [], sendAt: '' };
  const pendingIdentity = { operationId: '00000000-0000-4000-8000-000000000001', fingerprint: 'orders@example.test', args: { email: 'orders@example.test', operationId: '00000000-0000-4000-8000-000000000001', ifInState: 'original-state' } };
  localStorage.setItem(draftCacheKey(client.session, 'account'), JSON.stringify({ new: { fields, conflicted: true, pendingIdentity } }));
  const host = await render(<Compose {...props(client)} />);
  expect(button(host, 'Keep my version as a new draft')).toBeTruthy();
  await act(async () => button(host, 'Check sending address').click());
  expect(call.mock.calls.find(([method]) => method === 'Identity/resolve')![1]).toEqual(pendingIdentity.args);
  expect(call.mock.calls.some(([method]) => method === 'EmailSubmission/set')).toBe(false);
  await act(async () => button(host, 'Keep my version as a new draft').click());
  expect(call.mock.calls.some(([method]) => method === 'Email/set')).toBe(true);
  expect(host.querySelector<HTMLInputElement>('[aria-label="From"]')!.value).toBe('orders@example.test');
});

test('From suggestions accept keyboard selection without trapping Tab or overwriting raw text', async () => {
  expect(senderSuggestions('orders', identities, ['example.test'])).toEqual([{ email: 'orders@example.test' }]);
  let value = 'orders'; const changed = vi.fn();
  const host = await render(<SenderInput id="from" value={value} onChange={changed} identities={identities} domains={['example.test']} />);
  const field = host.querySelector<HTMLInputElement>('input')!;
  await act(async () => { field.focus(); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); });
  expect(changed).not.toHaveBeenCalled();
  await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
  expect(field.getAttribute('aria-activedescendant')).toBeTruthy();
  await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  expect(changed).toHaveBeenCalledWith('orders@example.test');
});
