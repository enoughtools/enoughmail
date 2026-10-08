import { receiveMail, type CloudflareMailEnvironment } from './server/delivery';
import type { DirectoryRoute } from './server/directory';
import { handlePublicClient } from './server/public-client';

interface Namespace { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }
interface IngressEnv extends CloudflareMailEnvironment { MAIL_DIRECTORY: Namespace; MAIL_ACCOUNTS: Namespace; MAIL_CREDENTIALS: Namespace }
interface IncomingMessage {
  from: string; to: string; raw: ReadableStream<Uint8Array>;
  headers?: Headers;
  forward(address: string, headers?: Headers): Promise<void>;
  setReject(reason: string): void;
}

/** Bounded recipient surface: no workspace identity, Core binding or public UI. */
export default {
  async fetch(request: Request, env: IngressEnv): Promise<Response> { return handlePublicClient(request, env); },
  async email(message: IncomingMessage, env: IngressEnv): Promise<void> {
    try {
      const directory = env.MAIL_DIRECTORY.get(env.MAIL_DIRECTORY.idFromName('directory'));
      const resolved = await directory.fetch(new Request('https://mail-directory.internal/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: message.to }),
      }));
      if (!resolved.ok) throw new Error('Recipient unavailable');
      const { route } = await resolved.json() as { route: DirectoryRoute | null };
      if (!route?.enabled) { message.setReject('Recipient unavailable'); return; }
      // SMTP envelope controls routing. MIME To/Cc headers never grant a mailbox.
      await receiveMail(env, { accountId: route.accountId, from: message.from, to: message.to, raw: message.raw }, async stored => {
        const account = env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(route.accountId));
        const headers = {
            'Content-Type': 'application/json',
            'X-Mail-Account-Context': JSON.stringify({ accountId: route.accountId, organizationId: route.organizationId, workspaceId: route.workspaceId, actor: { id: `recipient:${route.address}`, actions: ['mail.ingest'] } }),
        };
        const response = await account.fetch(new Request('https://mail-account.internal/ingest', {
          method: 'POST', headers, body: JSON.stringify({ ...stored, receivedAt: new Date().toISOString() }),
        }));
        if (!response.ok) throw new Error('Recipient persistence unavailable');
        const value = await response.json() as { forwarding?: { address: string; keepCopy: boolean; jobId: string } | null; forwardingJobs?: { address: string; keepCopy: boolean; jobId: string }[] };
        const jobs = [...(value.forwarding ? [value.forwarding] : []), ...(Array.isArray(value.forwardingJobs) ? value.forwardingJobs : [])].slice(0, 50);
        const seen = new Set<string>();
        for (const forwarding of jobs) {
        if (forwarding && typeof forwarding.address === 'string' && !seen.has(forwarding.address.toLowerCase()) && /^[^\s<>@\r\n]+@[^\s<>@\r\n]+\.[^\s<>@\r\n]+$/.test(forwarding.address) &&
            forwarding.address.toLowerCase() !== message.to.toLowerCase() &&
            !message.headers?.has('X-Enough-Mail-Forwarded') && !message.headers?.has('Auto-Submitted')) {
          // The account reserved quota and verified the destination and current
          // authority before producing this directive. Native forwarding retains SRS.
          seen.add(forwarding.address.toLowerCase());
          let status: 'forwarded' | 'unknown' = 'unknown';
          try { await message.forward(forwarding.address, new Headers({ 'X-Enough-Mail-Forwarded': '1' })); status = 'forwarded'; }
          catch { /* An ambiguous forwarding attempt is never retried automatically. */ }
          await account.fetch(new Request('https://mail-account.internal/forwarding-result', {
            method: 'POST', headers, body: JSON.stringify({ jobId: forwarding.jobId, status, ...(status === 'unknown' ? { error: 'forwardingOutcomeUnknown' } : {}) }),
          }));
        }
        }
      });
    } catch { message.setReject('Mail could not be stored. Please retry later.'); }
  },
};
