// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import DomainSetupReview from '../apps/mail/src/ui/DomainSetupReview';
import type { DomainSetupProposal } from '../apps/mail/src/server/domains';
import type { MailClient } from '../apps/mail/src/ui/jmap';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); dispose = () => {}; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const proposal: DomainSetupProposal = {
  version: 1, domain: 'example.test', zoneId: 'a'.repeat(32), worker: 'enoughmail-ingress', sendingSubdomainId: 'sending',
  dnsSnapshot: 'dns-before', routingSnapshot: 'routes-before', removeRecords: [{ id: 'b'.repeat(32), type: 'MX', name: 'example.test', content: 'mx.old.test', priority: 10 }],
  plan: { domain: 'example.test', snapshot: 'reviewed-dns', requirements: [], changes: [], conflicts: [], warnings: [] },
  disableRules: [], previousCatchAll: { enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'forward', value: ['old@example.test'] }] }, previousRoutingEnabled: true, blockers: [],
};
const recovery = { id: 'domain-setup:receipt', status: 'pending', createdAt: '2026-10-08T12:00:00Z', completed: ['remove-dns:old'], proposal };
async function render(client: MailClient, onComplete = vi.fn()) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  dispose = () => act(() => root.unmount());
  await act(async () => root.render(<DomainSetupReview client={client} accountId="inbox-a" domainId="domain-a" onComplete={onComplete} />));
  return { host, root, onComplete };
}
function button(host: HTMLElement, text: string) { return [...host.querySelectorAll('button')].find(element => element.textContent === text) as HTMLButtonElement; }

test('provider review failure exposes diagnostics and DNS notes while the saved backup remains downloadable', async () => {
  const call = vi.fn(async (method: string) => method === 'Domain/get' ? {} : {
    status: 'pending', newState: 'domain-4', message: 'Cloudflare has not completed the DNS check.', recovery,
    diagnostics: { stage: 'verification', step: 'verifyDns', code: 'cloudflareApiFailure', providerCodes: [1004] },
    checks: [{ type: 'MX', name: 'example.test', status: 'missing' }], warnings: ['DNS verification is waiting for propagation.'],
  });
  const { host } = await render({ call } as unknown as MailClient);
  expect(host.querySelector('[data-slot="alert"]')?.textContent).toContain('Setup is not finished');
  expect(host.textContent).toContain('Verify DNS records'); expect(host.textContent).toContain('cloudflareApiFailure');
  expect(host.textContent).toContain('1004'); expect(host.textContent).toContain('MX · example.test: not found yet');
  expect(host.textContent).toContain('DNS verification is waiting for propagation.');
  expect(button(host, 'Download backup')).toBeDefined(); expect(button(host, 'Apply reviewed changes')).toBeUndefined();
  call.mockImplementation(async method => { if (method === 'Domain/get') return {}; throw new Error('Provider is unavailable.'); });
  await act(async () => button(host, 'Review current records').click());
  expect(host.textContent).toContain('Provider is unavailable.'); expect(button(host, 'Download backup')).toBeDefined();
  expect(call.mock.calls.filter(([method]) => method === 'Domain/setup')).toHaveLength(2);
});

test('applying uses the exact reviewed proposal and revision once, then surfaces pending recovery without automatically retrying', async () => {
  let resolveApply!: (value: unknown) => void;
  const call = vi.fn(async (method: string, args: any) => {
    if (method === 'Domain/get') return {};
    if (args.reviewOnly) return { status: 'review', newState: 'domain-reviewed', message: 'Review changes.', proposal };
    return new Promise(resolve => { resolveApply = resolve; });
  });
  const { host, onComplete } = await render({ call } as unknown as MailClient);
  await act(async () => (host.querySelector('[role="checkbox"]') as HTMLElement).click());
  const apply = button(host, 'Apply reviewed changes'); expect(apply.disabled).toBe(false);
  await act(async () => { apply.click(); apply.click(); });
  const requests = call.mock.calls.filter(([method, args]) => method === 'Domain/setup' && !args.reviewOnly);
  expect(requests).toHaveLength(1); expect(requests[0][1]).toEqual({ domainId: 'domain-a', reviewedProposal: proposal, ifInState: 'domain-reviewed', operationId: expect.any(String) });
  expect((requests[0] as unknown[])[2]).toBe('inbox-a');
  const pending = { status: 'pending', newState: 'domain-5', message: 'Some reviewed changes could not be confirmed.', recoveryId: recovery.id, recovery,
    diagnostics: { stage: 'dns', step: 'applyDns', code: 'reviewedMutationOutcomeUnknown' } };
  await act(async () => resolveApply(pending));
  expect(host.textContent).toContain('Some reviewed changes could not be confirmed.'); expect(host.textContent).toContain('reviewedMutationOutcomeUnknown');
  expect(button(host, 'Download backup')).toBeDefined(); expect(button(host, 'Apply reviewed changes')).toBeUndefined();
  expect(button(host, 'Check current setup and backup')).toBeDefined(); expect(onComplete).toHaveBeenCalledWith(pending);
  expect(call.mock.calls.filter(([method]) => method === 'Domain/setup')).toHaveLength(2);
});

test('an ambiguous apply response requires another review and never resubmits the destructive command', async () => {
  const call = vi.fn(async (method: string, args: any) => {
    if (method === 'Domain/get') return {};
    if (args.reviewOnly) return { status: 'review', newState: 'domain-reviewed', message: 'Review changes.', proposal, recovery };
    throw new Error('The response was lost.');
  });
  const { host, onComplete } = await render({ call } as unknown as MailClient);
  await act(async () => (host.querySelector('[role="checkbox"]') as HTMLElement).click());
  await act(async () => button(host, 'Apply reviewed changes').click());
  expect(host.textContent).toContain('Changes may already have applied. Review the current records before continuing.');
  expect(button(host, 'Download backup')).toBeDefined(); expect(button(host, 'Apply reviewed changes')).toBeUndefined();
  expect(onComplete).not.toHaveBeenCalled(); expect(call.mock.calls.filter(([method, args]) => method === 'Domain/setup' && !args.reviewOnly)).toHaveLength(1);
});

test('a retained recovery backup never follows the review to another domain', async () => {
  const call = vi.fn(async (method: string, args: any) => method === 'Domain/get' ? {} : {
    status: 'pending', newState: 'domain-6', message: 'Setup is awaiting verification.', ...(args.domainId === 'domain-a' ? { recovery } : {}),
  });
  const client = { call } as unknown as MailClient;
  const { host, root } = await render(client);
  expect(button(host, 'Download backup')).toBeDefined();
  await act(async () => root.render(<DomainSetupReview client={client} accountId="inbox-a" domainId="domain-b" />));
  expect(button(host, 'Download backup')).toBeUndefined();
  expect(host.textContent).not.toContain('Original setup backup');
});

test('a completed continuation shows its latest progress while downloading the original pre-adoption backup', async () => {
  const progress = { id: 'domain-setup:continuation', status: 'complete', createdAt: '2026-10-08T13:00:00Z', completed: ['enable-routing-dns', 'set-catch-all'], originalRecoveryId: recovery.id, previousRecoveryId: recovery.id };
  const call = vi.fn(async (method: string) => method === 'Domain/get' ? {} : {
    status: 'ready', newState: 'domain-7', message: 'Sending and receiving are connected.', recovery, recoveryProgress: progress,
  });
  const { host } = await render({ call } as unknown as MailClient);
  const backup = host.querySelector('.mail-setup-backup'); expect(backup?.textContent).toContain('Original setup backup');
  expect(backup?.textContent).not.toContain('pending');
  expect(host.querySelector('[aria-label="Latest setup attempt"]')?.textContent).toContain('Complete · 2 confirmed operations');
  let saved!: Blob;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(value => { saved = value as Blob; return 'blob:original-backup'; });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await act(async () => button(host, 'Download backup').click());
  expect(JSON.parse(await saved.text())).toEqual(recovery);
});
