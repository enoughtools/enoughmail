// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import DomainsSettings, { domainManagers, loadDomains } from '../apps/mail/src/ui/DomainsSettings';
import DomainForInbox from '../apps/mail/src/ui/DomainForInbox';
import Settings from '../apps/mail/src/ui/Settings';
import type { MailClient } from '../apps/mail/src/ui/jmap';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); dispose = () => {}; document.body.innerHTML = ''; vi.unstubAllGlobals(); });
function fixture() {
 const account = (name: string, actions: string[], isReadOnly = false) => ({ name, isReadOnly, accountCapabilities: { 'urn:enough:params:jmap:mail': { actions } } });
 const call = vi.fn(async (method: string, _args: unknown, id: string) => method === 'Domain/get' ? { list: [{ id: 'same-local-id', name: `${id}.test`, zoneId: `${id}-zone` }] } : { list: [{ id: id+'-address', email: `${id}@example.test`, name: id }], settings: {} });
 return { session: { accounts: { a: account('Personal', ['mail.manage']), b: account('Work', ['mail.read'], true) }, actorId: 'actor', organizationId: 'org', workspaceId: 'space' }, states: new Map(), call } as unknown as MailClient;
}
async function render(node: React.ReactNode) { const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); dispose = () => act(() => root.unmount()); await act(async () => root.render(node)); return host; }
test('all accessible domain configurations retain their account ownership, including colliding local ids', async () => {
 const client = fixture(); const result = await loadDomains(client);
 expect(result.domains.map(d => [d.id, d.accountId, d.name])).toEqual([['same-local-id','a','a.test'],['same-local-id','b','b.test']]);
 expect(domainManagers(client)).toEqual(['a']);
});
test('a failed account load is reported and blocks new discovery rather than hiding existing configuration', async () => {
 const client = fixture(); const original = client.call; client.call = vi.fn((method, args, id) => id === 'b' ? Promise.reject(new Error('offline')) : original(method, args, id)) as typeof client.call;
 const host = await render(<DomainsSettings client={client} onAddresses={() => {}} onBusy={() => {}} />);
 expect(host.textContent).toContain('a.test'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('Work');
 expect(host.textContent).not.toContain('Find your domains');
});
test('domain review dispatches to its owning account and read-only records have no setup action', async () => {
 const client = fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ revision: 1, domains: [], pages: 1 }))));
 const host = await render(<DomainsSettings client={client} onAddresses={() => {}} onBusy={() => {}} />);
 const rows = host.querySelectorAll('.mail-settings-list li'); expect(rows).toHaveLength(2);
 expect(rows[1].querySelector('button')).toBeNull();
 await act(async () => (rows[0].querySelector('button') as HTMLElement).click());
 expect(client.call).toHaveBeenCalledWith('Domain/setup', { domainId: 'same-local-id', reviewOnly: true }, 'a');
 expect(JSON.parse((fetch as any).mock.calls.find((c: any[]) => c[0].endsWith('/approve'))[1].body).accountId).toBe('a');
});
test('Domains has no inbox selector; Email addresses restores switching and loads the chosen inbox', async () => {
 const client = fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ domains: [], pages: 1 }))));
 const host = await render(<Settings client={client} accountId="a" initialSection="Domains" onClose={() => {}} />);
 expect(host.querySelector('[aria-label="Settings inbox"]')).toBeNull();
 const addresses = [...host.querySelectorAll('nav button')].find(button => button.textContent === 'Email addresses') as HTMLElement;
 await act(async () => addresses.click());
 const select = host.querySelector('[aria-label="Settings inbox"]') as HTMLSelectElement; expect(select.value).toBe('a');
 await act(async () => { select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
 expect(client.call).toHaveBeenCalledWith('Identity/get', {}, 'b'); expect(host.textContent).toContain('b@example.test');
});

test('existing domains from other inboxes remain available for address assignment', async () => {
 const client = fixture();
 const host = await render(<DomainForInbox client={client} accountId="a" configured={[{id:'same-local-id',name:'a.test'}]} onChanged={() => {}} onBusy={() => {}} />);
 const options = [...host.querySelectorAll('option')].map(option => option.value);
 expect(options).toContain('b.test'); expect(options).not.toContain('a.test');
});
