import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Principal } from '@open-cloud/contracts';
import { authenticate, AuthenticationError, authenticationErrorResponse } from '@open-cloud/auth';
import { createMailWorker, type MailEnv } from './worker';
import manifest from '../app.manifest.json';
import { mailAuthority } from './server/authority';
export { MailAccount, MailDirectory, MailCredentials, MailPushRegistry } from './worker';
export { StandaloneMailAuthority } from './server/standalone-authority';

/** Composition root: verified identity is added only to a private service request. */
export default {
  ...createMailWorker(),
  async fetch(request: Request, env: MailEnv): Promise<Response> {
    if (new URL(request.url).pathname.replace(/^\/apps\/mail/, '').startsWith('/internal/')) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    try {
      const principal = await authenticate(request, env);
      return serveIdentifiedMail(request, env, principal);
    } catch (error) {
      if (error instanceof AuthenticationError) return authenticationErrorResponse(error);
      return Response.json({ error: 'mail_unavailable' }, { status: 503 });
    }
  },
};

async function serveIdentifiedMail(request: Request, env: MailEnv, principal: Principal): Promise<Response> {
      if (new URL(request.url).pathname === '/api/apps') return Response.json({ apps: [manifest] });
      if (new URL(request.url).pathname === '/workspace/apps') return Response.redirect(new URL('/apps/mail/', request.url).href, 302);
      const authority = mailAuthority(env);
      if (!authority) return Response.json({ error: 'authority_unavailable' }, { status: 503 });
      const trusted = { fetch: (input: Request) => {
        const headers = new Headers(input.headers);
        headers.set('X-Mail-Verified-Principal', JSON.stringify(principal));
        return authority.fetch(new Request(input, { headers }));
      } };
      // The request-scoped adapter cannot leak into alarm/queue execution. Those
      // use the namespace directly and may only revalidate previously issued leases.
      return createMailWorker(async () => principal).fetch(request, { ...env, MAIL_AUTHORITY_SERVICE: trusted });
}
/** Private service-binding entrypoint. The public HTTP handler never trusts this header. */
type BoundFetch = NonNullable<WorkerEntrypoint<MailEnv>['fetch']>;
type BoundRequest = Parameters<BoundFetch>[0];
type BoundResponse = Awaited<ReturnType<BoundFetch>>;
export class NativeMail extends WorkerEntrypoint<MailEnv> {
  async fetch(request: BoundRequest): Promise<BoundResponse> {
    // The runtime objects are identical; the app uses DOM types and the binding
    // exposes Workers' additional Request/Response type properties.
    return await serveNativeMail(request as unknown as Request, this.env) as unknown as BoundResponse;
  }
}
async function serveNativeMail(request: Request, env: MailEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!(path === '/api/apps' || path.startsWith('/apps/mail/')) || path.includes('/internal/')) return Response.json({ error: 'not_found' }, { status: 404 });
    let principal: Principal;
    try {
      const raw = request.headers.get('X-Mail-Native-Principal');
      if (!raw || raw.length > 4096) throw new Error('missing identity');
      principal = JSON.parse(raw);
      if (principal.provider !== 'cloudflare-access' || typeof principal.id !== 'string' || !principal.id || typeof principal.email !== 'string' || !principal.email) throw new Error('invalid identity');
    } catch { return Response.json({ error: 'sign_in_required' }, { status: 401 }); }
    return serveIdentifiedMail(request, env, principal);
}
