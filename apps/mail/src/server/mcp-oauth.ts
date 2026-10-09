import { boundedBytes, issueWorkspaceMcpCredential, credentialsStore, type Credential, type CredentialsEnv } from './credentials';
import { MailAuthorityClient, type MailWorkspaceAccount } from './core';
import { mailAuthority } from './authority';

export interface MailOAuthEnv {
  MAIL_MCP_PUBLIC_ORIGIN?: string;
  MAIL_MCP_WORKSPACE_ORIGIN?: string;
  MAIL_MCP_CLIENT_ID?: string;
  /** Exact production redirect URIs copied from the plugin management page. */
  MAIL_MCP_REDIRECT_URIS?: string;
}
const ACTIONS = ['mail.read', 'mail.organize', 'mail.draft', 'mail.send', 'mail.manage'];
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export function oauthOrigin(value?: string): string {
  if (!value) throw new Error('MCP OAuth origin is not configured');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('Invalid MCP OAuth origin');
  return value;
}
function plan(params: URLSearchParams, env: MailOAuthEnv) {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !['client_id','redirect_uri','response_type','scope','state','code_challenge','code_challenge_method','resource','accountId','operationId','approve','ui_locales'].includes(key))) throw new Error('Invalid OAuth parameters');
  if (params.has('ui_locales') && !/^[A-Za-z0-9 -]{1,128}$/.test(params.get('ui_locales')!)) throw new Error('Invalid OAuth locale');
  const origin = oauthOrigin(env.MAIL_MCP_PUBLIC_ORIGIN);
  const clientId = env.MAIL_MCP_CLIENT_ID ?? 'enoughmail-chatgpt';
  const redirectUri = params.get('redirect_uri') ?? '';
  if (params.get('client_id') !== clientId || !(env.MAIL_MCP_REDIRECT_URIS ?? '').split(',').map(item => item.trim()).includes(redirectUri) || !redirectUri.startsWith('https://') || new URL(redirectUri).hash || params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') ?? '') || params.get('resource') !== origin + '/mcp') throw new Error('Invalid OAuth authorization request');
  const actions = [...new Set((params.get('scope') || 'mail.read').split(' '))];
  if (!actions.length || actions.some(action => !ACTIONS.includes(action)) || (params.get('state')?.length ?? 0) > 2048) throw new Error('Invalid OAuth scope or state');
  return { clientId, redirectUri, resource: origin + '/mcp', challenge: params.get('code_challenge')!, state: params.get('state') ?? '', actions };
}
export const isMailOAuthPath = (path: string) => ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/oauth/authorize', '/oauth/token'].includes(path);
/** Public OAuth surface has no workspace identity or account-storage bindings. */
export async function handleMailOAuth(request: Request, env: MailOAuthEnv & Pick<CredentialsEnv, 'MAIL_CREDENTIALS'>): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  try {
    const origin = oauthOrigin(env.MAIL_MCP_PUBLIC_ORIGIN);
    if (url.origin !== origin) return Response.json({ error: 'invalid_origin' }, { status: 400 });
    if (path.startsWith('/.well-known/') && request.method === 'GET') {
      return Response.json(path.includes('oauth-protected-resource')
        ? { resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ACTIONS, bearer_methods_supported: ['header'] }
        : { issuer: origin, authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token', response_types_supported: ['code'], grant_types_supported: ['authorization_code'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true, scopes_supported: ACTIONS }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (path === '/oauth/authorize' && request.method === 'GET') {
      plan(url.searchParams, env);
      const workspace = oauthOrigin(env.MAIL_MCP_WORKSPACE_ORIGIN);
      return Response.redirect(workspace + '/apps/mail/api/mcp/authorize?' + url.searchParams.toString(), 302);
    }
    if (path === '/oauth/token' && request.method === 'POST') {
      if (!(request.headers.get('Content-Type') ?? '').startsWith('application/x-www-form-urlencoded')) return Response.json({ error: 'invalid_request' }, { status: 400 });
      const params = new URLSearchParams(new TextDecoder().decode(await boundedBytes(request, 8192)));
      if (params.get('grant_type') !== 'authorization_code' || params.get('client_id') !== (env.MAIL_MCP_CLIENT_ID ?? 'enoughmail-chatgpt') || params.get('resource') !== origin + '/mcp' || !/^[A-Za-z0-9._~-]{43,128}$/.test(params.get('code_verifier') ?? '') || !/^[a-f0-9]{64}$/.test(params.get('code') ?? '')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const store = env.MAIL_CREDENTIALS.get(env.MAIL_CREDENTIALS.idFromName('mail-client-credentials-v1'));
      return store.fetch(new Request('https://mail-credentials.internal/oauth-exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: params.get('code'), verifier: params.get('code_verifier'), clientId: params.get('client_id'), redirectUri: params.get('redirect_uri'), resource: params.get('resource') }) }));
    }
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
}
/** Authenticated consent stays on the private Mail Worker behind verified identity. */
export async function handleMailOAuthConsent(request: Request, env: CredentialsEnv & MailOAuthEnv, context: MailWorkspaceAccount): Promise<Response> {
  const params = request.method === 'POST' ? new URLSearchParams(new TextDecoder().decode(await boundedBytes(request, 16_384))) : new URL(request.url).searchParams;
  const selected = plan(params, env);
  if (params.has('accountId')) throw new Error('Reload consent to connect all accessible mail accounts');
  if (oauthOrigin(env.MAIL_MCP_WORKSPACE_ORIGIN) !== new URL(request.url).origin) throw new Error('Invalid workspace origin');
  const core = new MailAuthorityClient(mailAuthority(env));
  if (request.method === 'GET') {
    const accounts = (await core.accounts(request)).filter(account => selected.actions.some(action => account.effectiveActions.includes(action)));
    if (['accountId','operationId','approve'].some(key=>params.has(key))) throw new Error('Invalid consent parameters');
    const fields = [...params].map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join('');
    const accountNames = accounts.map(account => `<li>${escape(account.name)}</li>`).join('');
    // Keep the form's Origin intact for CSRF checks; no-referrer turns it into null.
    // same-origin still omits the Referer on the external OAuth callback.
    // Browsers enforce form-action across the POST's OAuth redirect as well.
    // Permit only the callback already checked against the exact URI allowlist.
    const callback = new URL(selected.redirectUri);
    const formAction = callback.origin + callback.pathname;
    const permissions: Record<string,string> = { 'mail.read':'Read mail and monitor incoming messages', 'mail.organize':'Organize messages and mailboxes', 'mail.draft':'Create and edit drafts', 'mail.send':'Send and schedule mail', 'mail.manage':'Manage account settings, contacts, and templates' };
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect EnoughMail</title><body><main><h1>Connect EnoughMail</h1><p>Allow ChatGPT to use all mail accounts you have access to for 30 days, including accounts added later. Each account keeps its current permissions.</p><ul>${selected.actions.map(action=>`<li>${permissions[action]}</li>`).join('')}</ul><h2>All accessible accounts</h2>${accounts.length ? `<ul>${accountNames}</ul>` : '<p>No accessible accounts yet. Accounts become available when you receive permission.</p>'}<form method="post" action="/apps/mail/api/mcp/authorize">${fields}<input type="hidden" name="operationId" value="${crypto.randomUUID()}"><p>You can revoke this connection in Mail settings under client credentials.</p><button name="approve" value="yes">Allow connection</button></form></main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; form-action 'self' ${formAction}; frame-ancestors 'none'; base-uri 'none'`, 'Referrer-Policy': 'same-origin' } });
  }
  if (request.method !== 'POST' || request.headers.get('Origin') !== new URL(request.url).origin || params.get('approve') !== 'yes') return Response.json({ error: 'consent_required' }, { status: 403 });
  const issued = await issueWorkspaceMcpCredential(request, env, context, selected.actions, params.get('operationId') ?? '');
  if (!issued.ok) return issued;
  const value = await issued.json() as { credential: Pick<Credential, 'id' | 'version'> };
  const response = await credentialsStore(env).fetch(new Request('https://mail-credentials.internal/oauth-create-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context, credentialId: value.credential.id, credentialVersion: value.credential.version, ...selected }) }));
  if (!response.ok) return response;
  const { code } = await response.json() as { code: string };
  const redirect = new URL(selected.redirectUri); redirect.searchParams.set('code', code); redirect.searchParams.set('state', selected.state); redirect.searchParams.set('iss', oauthOrigin(env.MAIL_MCP_PUBLIC_ORIGIN));
  return new Response(null, { status: 302, headers: { Location: redirect.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
