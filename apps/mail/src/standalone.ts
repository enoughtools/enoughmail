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
    } catch (error) {
      if (error instanceof AuthenticationError) return authenticationErrorResponse(error);
      return Response.json({ error: 'mail_unavailable' }, { status: 503 });
    }
  },
};
