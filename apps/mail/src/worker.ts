import { runIdentityTransfer, validateIdentityTransfer, IdentityTransferError } from './server/identity-transfer';
import { CloudflareDomainDiscovery, DomainDiscoveryError } from './server/domain-discovery';
import { MAIL_EVENT_TYPES } from './domain/events';
import { mailAuthority, type MailAuthorityEnvironment } from './server/authority';
import { authenticate, AuthenticationError, authenticationErrorResponse, type AuthenticationEnv, type Authenticator } from '@open-cloud/auth';
import { protectResponse, type AssetFetcher } from '@open-cloud/worker';
import manifest from '../app.manifest.json';
import { authorizeMailWorkspace, MailAccessError, MailAuthorityClient, type MailWorkspaceAccount } from './server/core';
import { MailAccount } from './server/account';
import { MailDirectory } from './server/directory';
import { handleMailMcp } from './server/mcp';
import { MailCredentials, handleCredentialsApi } from './server/credentials';
import { handleClientJmap } from './server/public-client';
import { boundedUploadStream, UploadTooLarge } from './server/bounded-stream';
import type { NativeResource } from '@open-cloud/contracts';
import { parseProviderDeliveryEvent } from './server/provider-events';
import type { DirectoryAccount } from './server/directory';
import { executeAuthorizedJmap, type JmapRequest, type JmapResponse } from './server/jmap-router';
import type { MailContext } from './domain/model';
import { MailPushRegistry, handlePushJmap, type PushAuthorityProof } from './server/push';

export { MailAccount, MailDirectory, MailCredentials, MailPushRegistry };

interface AccountNamespace { idFromName(name: string): unknown; get(id: unknown): AssetFetcher; }
export interface MailEnv extends AuthenticationEnv, MailAuthorityEnvironment {
  ASSETS: AssetFetcher;
  
  MCP_SIGNING_KEY?: string;
  MAIL_CLIENT_ORIGIN?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  MAIL_INGRESS_WORKER?: string;
  MAIL_DELIVERY_EVENTS_QUEUE?: string;
  MAIL_DELIVERY_EVENT_SUBSCRIPTION_IDS?: string;
  MAIL_ACCOUNTS: AccountNamespace;
  MAIL_DIRECTORY: AccountNamespace;
  MAIL_CREDENTIALS: AccountNamespace;
  MAIL_PUSH_REGISTRY?: AccountNamespace;
  MAIL_PUSH_ORIGINS?: string;
  MAIL_PUSH_SUBJECT?: string;
}

const CORE_CAP = 'urn:ietf:params:jmap:core';
const MAIL_CAP = 'urn:ietf:params:jmap:mail';
const SUBMISSION_CAP = 'urn:ietf:params:jmap:submission';
const MAX_REQUEST = 1_048_576;
const MAX_UPLOAD = 67_108_864;
const supportsMailData = (actions: readonly string[]) => actions.some(action => ['mail.read', 'mail.draft', 'mail.edit'].includes(action));

function accountSessionState(resources: NativeResource[]): string { return `${Math.floor(Date.now() / 86400000)}:${resources.map(resource => `${resource.id}:${resource.version}:${resource.effectiveActions.join(',')}`).join('|') || 'empty'}`; }

function json(value: unknown, status = 200): Response { return Response.json(value, { status }); }
function methodAllowed(method: string, methods: string[]): void {
  if (!methods.includes(method)) throw new MailAccessError('method_not_allowed', `Use ${methods.join(' or ')}.`, 405);
}
function accountHeaders(account: MailWorkspaceAccount, actions: string[]): Headers {
  return new Headers({
    'X-Mail-Account-Context': JSON.stringify({ ...account, actor: { id: account.actorId, actions, workspaceRole: account.membershipRole } }),
    'X-Mail-Account-Id': account.accountId,
    'X-Mail-Organization-Id': account.organizationId,
    'X-Mail-Workspace-Id': account.workspaceId,
    'X-Mail-Actor-Id': account.actorId,
    'X-Mail-Actions': actions.join(','),
  });
}

/** Bound actual bytes, including chunked requests without Content-Length. */
export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const advertised = request.headers.get('Content-Length');
  if (advertised && Number(advertised) > limit) throw new MailAccessError('request_too_large', 'Mail request is too large.', 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new MailAccessError('request_too_large', 'Mail request is too large.', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export function createMailWorker(identify: Authenticator = authenticate) {
  return {
    async queue(batch: { queue: string; messages: { body: unknown; ack(): void; retry(): void }[] }, env: MailEnv): Promise<void> {
      if (!env.MAIL_DELIVERY_EVENTS_QUEUE || batch.queue !== env.MAIL_DELIVERY_EVENTS_QUEUE) { for (const message of batch.messages) message.retry(); return; }
      const directory = env.MAIL_DIRECTORY.get(env.MAIL_DIRECTORY.idFromName('directory'));
      for (const message of batch.messages) {
        try {
          const event = parseProviderDeliveryEvent(message.body, env);
          const response = await directory.fetch(new Request('https://mail-directory.internal/resolve-provider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: event.providerId }) }));
          const { route } = await response.json() as { route: (DirectoryAccount & { sender: string }) | null };
          if (!response.ok || !route || route.sender.toLowerCase() !== event.sender) throw new Error('Unknown provider receipt');
          const result = await env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(route.accountId)).fetch(new Request('https://mail-account.internal/provider-event', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mail-Account-Context': JSON.stringify({ accountId: route.accountId, organizationId: route.organizationId, workspaceId: route.workspaceId, actor: { id: `provider:${event.subscriptionId}`, actions: ['mail.provider-event'] } }) }, body: JSON.stringify(event) }));
          if (!result.ok) throw new Error('Provider receipt not committed');
          message.ack();
        } catch { message.retry(); }
      }
    },
    async fetch(request: Request, env: MailEnv): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/apps\/mail(?=\/|$)/, '') || '/';
      const api = path.startsWith('/jmap') || path.startsWith('/api') || path.startsWith('/internal') || path === '/health';
      try {
        if (path === '/internal/client-jmap') return protectResponse(request, await handleClientJmap(request, env), { api: true });
        if (path === '/internal/mcp') return protectResponse(request, await handleMailMcp(request, env), { api: true });
        if (path.startsWith('/internal/')) throw new MailAccessError('forbidden', 'Internal routes are unavailable publicly.');
        const user = await identify(request, env);
        const workspace = await authorizeMailWorkspace(request, mailAuthority(env));
        const core = new MailAuthorityClient(mailAuthority(env));
        let account = workspace;
        let actions: string[] = [];
        const select = async (id: string, required: string[] = []) => {
          const resource = required.length ? await core.authorize(request, id, required) : (await core.account(request, id)).account;
          if (resource.organizationId !== workspace.organizationId || resource.workspaceId !== workspace.workspaceId) throw new MailAccessError('account_not_found', 'This account is unavailable.', 404);
          account = { ...workspace, accountId: resource.id }; actions = resource.effectiveActions; return resource;
        };
        // Browser cookies cannot authorize a mutation from another origin.
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
          const origin = request.headers.get('Origin');
          if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
            throw new MailAccessError('cross_origin_request', 'Use Mail from this workspace.');
          }
        }
        const stub = () => env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(account.accountId));
        let response: Response;
        if (path === '/health') {
          methodAllowed(request.method, ['GET', 'HEAD']);
          response = json({ ok: true, appId: 'mail' });
        } else if (path === '/api/manifest') {
          methodAllowed(request.method, ['GET', 'HEAD']); response = json(manifest);
        } else if (path === '/api/domains/discovery') {
          methodAllowed(request.method, ['GET']);
          if (!['owner', 'administrator'].includes(workspace.membershipRole ?? '')) throw new MailAccessError('domain_administrator_required', 'Ask a workspace administrator to discover domains.');
          await select(url.searchParams.get('accountId') || '', ['mail.manage']);
          if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) throw new MailAccessError('domain_setup_unavailable', 'Connect Cloudflare domain management to discover and set up your domains.', 503);
          const page = Number(url.searchParams.get('page') || 1), zoneId = url.searchParams.get('zoneId');
          if ((!zoneId && (!Number.isInteger(page) || page < 1 || page > 10000)) || (zoneId && !/^[a-f0-9]{32}$/i.test(zoneId))) throw new MailAccessError('invalid_domain', 'Choose a valid domain or page.', 400);
          const discovery = new CloudflareDomainDiscovery(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, undefined, env.MAIL_INGRESS_WORKER);
          try { response = json(zoneId ? await discovery.inspect(zoneId) : await discovery.list(page)); }
          catch (error) { throw new MailAccessError('domain_discovery_failed', error instanceof DomainDiscoveryError ? error.message : 'Cloudflare could not read your domains. Check the domain connection permissions and try again.', 502); }
        } else if (path === '/api/domains/approval') {
          methodAllowed(request.method, ['GET']);
          if (!['owner', 'administrator'].includes(workspace.membershipRole ?? '')) throw new MailAccessError('domain_administrator_required', 'Ask a workspace administrator to approve this domain.');
          const domain = url.searchParams.get('domain') ?? '', zoneId = url.searchParams.get('zoneId') ?? '', accountId = url.searchParams.get('accountId') ?? '';
          const resource = await select(accountId);
          response = await env.MAIL_DIRECTORY.get(env.MAIL_DIRECTORY.idFromName('directory')).fetch(new Request('https://mail-directory.internal/zone-approval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain, zoneId, account: { accountId: resource.id, organizationId: resource.organizationId, workspaceId: resource.workspaceId, ownerActorId: resource.ownerActorId } }) }));
        } else if (path === '/api/domains/approve') {
          methodAllowed(request.method, ['POST']);
          if (!['owner', 'administrator'].includes(workspace.membershipRole ?? '')) throw new MailAccessError('domain_administrator_required', 'Ask a workspace administrator to approve this domain.');
          const body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 16384))) as { accountId: string; domain: string; zoneId: string; operationId: string; expectedRevision: number };
          if (!/^[a-f0-9]{32}$/i.test(body.zoneId) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(body.domain) || !/^[0-9a-f-]{36}$/i.test(body.operationId)) throw new MailAccessError('invalid_domain', 'Provide a valid domain, zone and command.', 400);
          const resource = await select(body.accountId);
          if (!env.CF_API_TOKEN) throw new MailAccessError('domain_setup_unavailable', 'Domain setup is not configured.', 503);
          const zoneResponse = await fetch(`https://api.cloudflare.com/client/v4/zones/${body.zoneId}`, { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, redirect: 'manual' });
          if (!zoneResponse.ok) throw new MailAccessError('domain_zone_unavailable', 'The configured Cloudflare account cannot verify this zone.');
          const zone = await zoneResponse.json() as { success?: boolean; result?: { name: string; account?: { id: string } } };
          if (zone.success !== true || zone.result?.name.toLowerCase() !== body.domain.toLowerCase()) throw new MailAccessError('zone_domain_mismatch', 'The Cloudflare zone does not match this domain.', 400);
          if (env.CF_ACCOUNT_ID && zone.result?.account?.id !== env.CF_ACCOUNT_ID) throw new MailAccessError('zone_account_mismatch', 'The zone must belong to the configured Cloudflare account.', 400);
          const currentWorkspace = await authorizeMailWorkspace(request, mailAuthority(env));
          if (!['owner', 'administrator'].includes(currentWorkspace.membershipRole ?? '') || currentWorkspace.actorId !== workspace.actorId || currentWorkspace.organizationId !== workspace.organizationId || currentWorkspace.workspaceId !== workspace.workspaceId) throw new MailAccessError('domain_administrator_required', 'Workspace administration changed. Refresh and try again.');
          await core.account(request, body.accountId);
          response = await env.MAIL_DIRECTORY.get(env.MAIL_DIRECTORY.idFromName('directory')).fetch(new Request('https://mail-directory.internal/approve-zone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: body.domain.toLowerCase(), zoneId: body.zoneId.toLowerCase(), operationId: body.operationId, expectedRevision: body.expectedRevision, approvedBy: workspace.actorId, account: { accountId: resource.id, organizationId: resource.organizationId, workspaceId: resource.workspaceId, ownerActorId: resource.ownerActorId } }) }));
        } else if (path === '/api/client-info') {
          methodAllowed(request.method, ['GET']);
          let origin: string | null = null;
          if (env.MAIL_CLIENT_ORIGIN) {
            const configured = new URL(env.MAIL_CLIENT_ORIGIN);
            if (configured.protocol === 'https:' && configured.pathname === '/' && !configured.username && !configured.password && !configured.search && !configured.hash) origin = configured.origin;
          }
          response = json({ enabled: origin !== null, sessionUrl: origin ? `${origin}/.well-known/jmap` : null });
        } else if (path === '/api/credentials' || path.startsWith('/api/credentials/')) {
          response = await handleCredentialsApi(request, env, workspace);
        } else if (path === '/api/identities/transfer') {
          methodAllowed(request.method, ['POST']);
          try {
            const command=validateIdentityTransfer(JSON.parse(new TextDecoder().decode(await readBoundedBody(request,16384))));
            const resources=new Map<string,NativeResource>();
            const authorizeBoth=async()=>{
              const results=await Promise.allSettled([command.sourceAccountId,command.destinationAccountId].map(id=>core.authorize(request,id,['mail.manage'])));
              for(const result of results){if(result.status==='rejected')throw new IdentityTransferError('forbidden','Current management permission is required on both inboxes.',403);const resource=result.value;if(resource.organizationId!==workspace.organizationId||resource.workspaceId!==workspace.workspaceId)throw new IdentityTransferError('forbidden','Both inboxes must belong to this workspace.',403);resources.set(resource.id,resource);}
            };
            await authorizeBoth();
            const descriptor=(id:string):DirectoryAccount=>{const resource=resources.get(id)!;return {accountId:id,organizationId:resource.organizationId,workspaceId:resource.workspaceId,ownerActorId:resource.ownerActorId};};
            const checked=async(response:Response)=>{let value:any;try{value=await response.json();}catch{throw new IdentityTransferError('transfer_unavailable','The move response could not be confirmed. Retry the same move.',503);}if(!response.ok)throw new IdentityTransferError(value.error||'transfer_failed',value.message||value.description||'The address move could not finish.',response.status>=500?503:response.status);return value;};
            response=json(await runIdentityTransfer(command,{authorizeBoth,source:descriptor(command.sourceAccountId),destination:descriptor(command.destinationAccountId),actorId:workspace.actorId,
              account:async(id,body)=>{const resource=resources.get(id)!;const context:MailContext={accountId:id,organizationId:workspace.organizationId,workspaceId:workspace.workspaceId,actor:{id:workspace.actorId,actions:resource.effectiveActions}};return checked(await env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(id)).fetch(new Request('https://mail-account/identity-transfer',{method:'POST',headers:{'content-type':'application/json','x-mail-account-context':JSON.stringify(context)},body:JSON.stringify(body)})));},
              directory:body=>checkedDirectory(body),
            }));
            async function checkedDirectory(body:unknown){return checked(await env.MAIL_DIRECTORY.get(env.MAIL_DIRECTORY.idFromName('directory')).fetch(new Request('https://mail-directory/identity-transfer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body as object,account:descriptor(command.sourceAccountId)})})));}
          } catch(error){if(error instanceof IdentityTransferError)throw new MailAccessError(error.code,error.message,error.status);throw error;}
        } else if (path === '/api/accounts') {
          methodAllowed(request.method, ['GET', 'POST']);
          if (request.method === 'GET') response = json({ accounts: await core.accounts(request) });
          else {
            const body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 16384)));
            const result = await core.call<{ resourceId: string }>(request, '/api/native-resources', 'POST', { operationId: body.operationId, ownerAppId: 'mail', resourceType: 'mail.account', name: body.name });
            response = json(await core.account(request, result.resourceId), 201);
          }
        } else if (/^\/api\/accounts\/[^/]+(?:\/grants)?$/.test(path)) {
          const id = decodeURIComponent(path.split('/')[3]);
          if (path.endsWith('/grants')) {
            methodAllowed(request.method, ['PUT']);
            const body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 16384)));
            await core.call(request, `/api/native-resources/${encodeURIComponent(id)}/grants`, 'PUT', body);
          } else methodAllowed(request.method, ['GET']);
          response = json(await core.account(request, id));
        } else if (path === '/api/members') {
          methodAllowed(request.method, ['GET']); const people = await core.call<{ people: unknown[] }>(request, '/api/people'); response = json({ members: people.people });
        } else if (path === '/api/session') {
          methodAllowed(request.method, ['GET', 'HEAD']); response = json({ user, actorId: workspace.actorId, organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, workspaceRole: workspace.membershipRole });
        } else if (path === '/jmap/session' || path === '/.well-known/jmap') {
          methodAllowed(request.method, ['GET', 'HEAD']);
          const resources = await core.accounts(request);
          const primaryMail = resources.find(resource => resource.ownerActorId === workspace.actorId && supportsMailData(resource.effectiveActions)) ?? resources.find(resource => supportsMailData(resource.effectiveActions));
          const primarySend = resources.find(resource => resource.ownerActorId === workspace.actorId && resource.effectiveActions.includes('mail.send')) ?? resources.find(resource => resource.effectiveActions.includes('mail.send'));
          const base = `${url.origin}/apps/mail/jmap`;
          const capabilities = {
            [CORE_CAP]: { maxSizeUpload: MAX_UPLOAD, maxConcurrentUpload: 4, maxSizeRequest: MAX_REQUEST, maxConcurrentRequests: 4, maxCallsInRequest: 32, maxObjectsInGet: 500, maxObjectsInSet: 500, collationAlgorithms: ['i;unicode-casemap'] },
            ...(primaryMail ? { [MAIL_CAP]: {} } : {}), ...(primarySend ? { [SUBMISSION_CAP]: {} } : {}), 'urn:enough:params:jmap:mail': {},
          };
          response = json({ capabilities,
            accounts: Object.fromEntries(resources.map(resource => [resource.id, {
              name: resource.name, isPersonal: resource.ownerActorId === workspace.actorId,
              isReadOnly: !resource.effectiveActions.some(action => ['mail.organize', 'mail.draft', 'mail.send', 'mail.manage'].includes(action)),
              accountCapabilities: {
                ...(supportsMailData(resource.effectiveActions) ? { [MAIL_CAP]: { maxMailboxesPerEmail: null, maxMailboxDepth: 20, maxSizeMailboxName: 255, maxSizeAttachmentsPerEmail: MAX_UPLOAD, emailQuerySortOptions: ['receivedAt', 'subject', 'from', 'to', 'size'], mayCreateTopLevelMailbox: resource.effectiveActions.includes('mail.organize') } } : {}),
                ...(resource.effectiveActions.includes('mail.send') ? { [SUBMISSION_CAP]: { maxDelayedSend: 89 * 86400, submissionExtensions: { FUTURERELEASE: [String(89 * 86400), new Date((Math.floor(Date.now() / 86400000) + 89) * 86400000).toISOString().replace('.000Z', 'Z')] } } } : {}),
                'urn:enough:params:jmap:mail': { actions: resource.effectiveActions },
              },
            }])),
            primaryAccounts: { ...(primaryMail ? { [MAIL_CAP]: primaryMail.id } : {}), ...(primarySend ? { [SUBMISSION_CAP]: primarySend.id } : {}) },
            username: user.email, workspaceRole: workspace.membershipRole, actorId: workspace.actorId, organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, apiUrl: `${base}/api`, uploadUrl: `${base}/upload/{accountId}`,
            downloadUrl: `${base}/download/{accountId}/{blobId}/{name}?type={type}`,
            eventSourceUrl: `${base}/events?types={types}&closeafter={closeafter}&ping={ping}`,
            state: accountSessionState(resources),
          });
        } else if (path === '/jmap/events') {
          methodAllowed(request.method, ['GET']);
          const closeAfter = url.searchParams.get('closeafter');
          if (closeAfter && !['state', 'no'].includes(closeAfter)) throw new MailAccessError('invalid_closeafter', 'Invalid event close behavior.', 400);
          const requested = url.searchParams.get('types');
          const eventTypes = MAIL_EVENT_TYPES;
          const types = requested && requested !== '*' ? requested.split(',') : eventTypes;
          if (types.some(type => !eventTypes.includes(type))) throw new MailAccessError('invalid_event_types', 'Unknown mail event type.', 400);
          let cancelled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
          let wakeAbort: AbortController | undefined;
          const cleanup = () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            if (lifetimeTimer) clearTimeout(lifetimeTimer);
            wakeAbort?.abort();
          };
          const previous = new Map<string, string>();
          const requestedPing = Number(url.searchParams.get('ping') ?? 30);
          if (!Number.isFinite(requestedPing) || requestedPing < 0) throw new MailAccessError('invalid_ping', 'Invalid event ping interval.', 400);
          const pingInterval = requestedPing === 0 ? 0 : Math.min(3600, Math.max(30, requestedPing));
          let lastPing = 0;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const close = () => { if (!cancelled) { cleanup(); controller.close(); } };
              // EventSource reconnects after EOF. Periodically release the old
              // Worker/DO deployment even when this tab stays open indefinitely.
              lifetimeTimer = setTimeout(close, 60_000);
              const tick = async () => {
                try {
                  const eventWorkspace = await authorizeMailWorkspace(request, mailAuthority(env));
                  if (cancelled) return;
                  if (eventWorkspace.actorId !== workspace.actorId || eventWorkspace.organizationId !== workspace.organizationId || eventWorkspace.workspaceId !== workspace.workspaceId) throw new MailAccessError('workspace_access_changed', 'Workspace access changed.');
                  const resources = await core.accounts(request);
                  if (cancelled) return;
                  const readable = resources.filter(resource => resource.effectiveActions.includes('mail.read'));
                  if (!readable.length || [...previous.keys()].some(key => !readable.some(resource => key.startsWith(resource.id + ':')))) { close(); return; }
                  const changed: Record<string, Record<string, string>> = {};
                  const cursors: { accountId: string; cursor: string }[] = [];
                  for (const resource of resources) {
                    if (!resource.effectiveActions.includes('mail.read')) continue;
                    const headers = accountHeaders({ ...workspace, accountId: resource.id }, ['mail.read']);
                    headers.set('Content-Type', 'application/json');
                    const result = await env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(resource.id)).fetch(new Request('https://mail-account.internal/event-state', { method: 'POST', headers, body: JSON.stringify({ types }) }));
                    if (cancelled) return;
                    if (!result.ok) throw new Error('Mail event stream unavailable');
                    const data = await result.json() as { cursor?: string; states: Record<string, string> };
                    if (cancelled) return;
                    if (typeof data.cursor === 'string' && cursors.length < 100) cursors.push({ accountId:resource.id, cursor:data.cursor });
                    for (const [type, state] of Object.entries(data.states ?? {})) {
                      if (!types.includes(type) || typeof state !== 'string') continue;
                      const key = `${resource.id}:${type}`;
                      if (previous.get(key) !== state) { (changed[resource.id] ??= {})[type] = state; previous.set(key, state); }
                    }
                  }
                  const latestWorkspace = await authorizeMailWorkspace(request, mailAuthority(env));
                  if (cancelled) return;
                  if (latestWorkspace.actorId !== workspace.actorId || latestWorkspace.organizationId !== workspace.organizationId || latestWorkspace.workspaceId !== workspace.workspaceId) throw new MailAccessError('workspace_access_changed', 'Workspace access changed.');
                  const latest = await core.accounts(request);
                  if ([...previous.keys()].some(key => !latest.some(resource => resource.effectiveActions.includes('mail.read') && key.startsWith(resource.id + ':')))) { close(); return; }
                  if (cancelled) return;
                  if (Object.keys(changed).length) controller.enqueue(new TextEncoder().encode(`event: state\ndata: ${JSON.stringify({ '@type': 'StateChange', changed })}\n\n`));
                  if (pingInterval && Date.now() - lastPing >= pingInterval * 1000) { controller.enqueue(new TextEncoder().encode(`event: ping\ndata: ${JSON.stringify({ interval: pingInterval })}\n\n`)); lastPing = Date.now(); }
                  if (url.searchParams.get('closeafter') === 'state' && Object.keys(changed).length) { close(); return; }
                  timer = setTimeout(tick, 15000);
                  // Account commit notifications only wake this checker. Every
                  // emission still passes fresh workspace and resource checks.
                  if (cursors.length) {
                    const abort = new AbortController(); wakeAbort = abort;
                    const wake = () => {
                      if (cancelled || abort.signal.aborted) return;
                      if (timer) clearTimeout(timer);
                      abort.abort();
                      void tick();
                    };
                    // The periodic path also releases outstanding waiters.
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(() => { abort.abort(); if (!cancelled) void tick(); }, 15000);
                    for (const { accountId, cursor } of cursors) {
                      const headers = accountHeaders({ ...workspace, accountId }, ['mail.read']);
                      headers.set('Content-Type','application/json');
                      void env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(accountId)).fetch(new Request('https://mail-account.internal/event-wait', {
                        method:'POST', headers, signal:abort.signal, body:JSON.stringify({ after:cursor }),
                      })).then(async result => {
                        if (result.ok && (await result.json() as {changed?:boolean}).changed === true) wake();
                      }).catch(() => { /* bounded polling remains available */ });
                    }
                  }
                } catch {
                  close();
                }
              };
              void tick();
            },
            cancel: cleanup,
          });
          response = new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
        } else if (path === '/jmap/api') {
          methodAllowed(request.method, ['POST']);
          if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) throw new MailAccessError('invalid_content_type', 'Send JSON.', 415);
          const text = new TextDecoder().decode(await readBoundedBody(request, MAX_REQUEST));
          let body: unknown;
          try { body = JSON.parse(text); } catch { throw new MailAccessError('invalid_json', 'Send valid JSON.', 400); }
          const jmap = body as JmapRequest;
          if (!Array.isArray(jmap.using) || jmap.using.some(capability => ![CORE_CAP, MAIL_CAP, SUBMISSION_CAP, 'urn:enough:params:jmap:mail'].includes(capability))) throw new MailAccessError('unknown_capability', 'An unsupported mail capability was requested.', 400);
          const result = await executeAuthorizedJmap({
            request: jmap, workspace,
            authorizeAccount: async id => {
              const currentWorkspace = await authorizeMailWorkspace(request, mailAuthority(env));
              if (currentWorkspace.actorId !== workspace.actorId || currentWorkspace.organizationId !== workspace.organizationId || currentWorkspace.workspaceId !== workspace.workspaceId) throw new MailAccessError('workspace_access_changed', 'Workspace access changed.');
              const resource = (await core.account(request, id)).account;
              return { accountId: resource.id, organizationId: resource.organizationId, workspaceId: resource.workspaceId, actor: { id: workspace.actorId, actions: resource.effectiveActions, workspaceRole: currentWorkspace.membershipRole } };
            },
            callGlobal: async (name, args, callId) => {
              let pushStage='authorizeWorkspace';try{
              const currentWorkspace = await authorizeMailWorkspace(request, mailAuthority(env));
              if (currentWorkspace.actorId !== workspace.actorId || currentWorkspace.organizationId !== workspace.organizationId || currentWorkspace.workspaceId !== workspace.workspaceId) throw new MailAccessError('workspace_access_changed', 'Workspace access changed.');
              const resources = (await core.accounts(request)).filter(resource => resource.effectiveActions.includes('mail.read'));
              if (!resources.length || resources.length > 100) return { methodResponses: [['error', { type: 'forbidden' }, callId]], sessionState: accountSessionState(resources) };
              const accounts: { accountId: string; lease: string; jobId: string }[] = [];
              pushStage='issueReadLease';
              for (const resource of resources) {
                const jobId = crypto.randomUUID();
                const lease = await core.call<{ lease: string }>(request, `/api/native-resources/${encodeURIComponent(resource.id)}/lease`, 'POST', { jobId, actions: ['mail.read'], expiresAt: Date.now() + 31 * 86400000 });
                accounts.push({ accountId: resource.id, lease: lease.lease, jobId });
              }
              const proof: PushAuthorityProof = { kind: 'browser', actorId: workspace.actorId, organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, accounts };
              const scopeDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['browser', workspace.organizationId, workspace.workspaceId, workspace.actorId]))));
              const scope = 'browser:' + Array.from(scopeDigest, byte => byte.toString(16).padStart(2, '0')).join('');
              const { operationId, ...parameters } = args;
              pushStage='registerPush';
              const value = await handlePushJmap({ scope, proof, operationId }, name, parameters, env);
              return { methodResponses: [[typeof value.type === 'string' ? 'error' : name, value, callId]], sessionState: accountSessionState(await core.accounts(request)) };
              }catch(error){console.warn('Mail push command failed',{stage:pushStage,method:name,code:error instanceof MailAccessError?error.code:'unexpectedFailure',...(error instanceof MailAccessError?{status:error.status}:{})});throw error;}
            },
            callAccount: async (context, single) => {
              const name = single.methodCalls[0][0];
              let stage = 'issueAuthority';
              try {
              let authorityProof: MailContext['authorityProof'];
              if (name === 'EmailSubmission/set' || (context.actor.actions.includes('mail.send') && context.actor.actions.includes('mail.manage') && ['Settings/set', 'Settings/renew', 'VacationResponse/set', 'Rule/set'].includes(name))) {
                const jobId = crypto.randomUUID();
                const expiresAt = Date.now() + 90 * 86400000 - 60000; // Stay below the authority limit despite clock skew.
                const authorityActions = name === 'EmailSubmission/set'
                  ? [...(context.actor.actions.includes('mail.read') ? ['mail.read'] : []), 'mail.send']
                  : ['mail.manage', 'mail.send'];
                const lease = await core.call<{ lease: string }>(request, `/api/native-resources/${encodeURIComponent(context.accountId)}/lease`, 'POST', { jobId, actions: authorityActions, expiresAt });
                authorityProof = { lease: lease.lease, jobId, expiresAt, actions: authorityActions };
              }
              stage = 'invokeAccount';
              const response = await env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(context.accountId)).fetch(new Request('https://mail-account.internal/jmap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...context, authorityProof, request: single }) }));
              if (!response.ok) throw new MailAccessError('mail_operation_failed', 'The mail operation failed.', response.status);
              stage = 'readAccountResponse';
              const value = await response.json() as JmapResponse;
              stage = 'recheckAuthority';
              const current = (await core.account(request, context.accountId)).account;
              if (!context.actor.actions.every(action => current.effectiveActions.includes(action))) throw new MailAccessError('account_permission_changed', 'Account permissions changed.');
              return value;
              } catch (error) {
                // Fixed stages/statuses only: never log mail content, tokens or provider bodies.
                console.warn('Mail account dispatch failed', {
                  method: name, stage,
                  code: error instanceof MailAccessError ? error.code : 'unexpectedFailure',
                  ...(error instanceof MailAccessError ? { status: error.status } : {}),
                });
                // No account request has been dispatched in this stage. A replay must still
                // preserve its operation ID: an earlier attempt may have committed.
                if (name === 'EmailSubmission/set' && stage === 'issueAuthority') return {
                  methodResponses: [['error', { type: 'serverFail', submissionNotDispatched: true, description: 'Sending authorization is unavailable. The submission handler was not called.' }, single.methodCalls[0][2]]], sessionState: '',
                };
                throw error;
              }
            },
            transferEmail: async ({ source, destination, args, request: single }) => {
              const ids = Object.values(args.create ?? {}).map((value: any) => value.id);
              if (ids.length > 500 || ids.some(id => typeof id !== 'string')) throw new MailAccessError('invalid_copy', 'Invalid email copy selection.', 400);
              const jobId = crypto.randomUUID();
              const sourceAuthorityActions = ['mail.read', ...(args.onSuccessDestroyOriginal ? ['mail.organize'] : [])];
              const sourceAuthorityExpiresAt = Date.now() + 5 * 60000;
              const authority = await core.call<{ lease: string }>(request, `/api/native-resources/${encodeURIComponent(source.accountId)}/lease`, 'POST', { jobId, actions: sourceAuthorityActions, expiresAt: sourceAuthorityExpiresAt });
              const sourceStub = env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(source.accountId));
              const read = await sourceStub.fetch(new Request('https://mail-account.internal/transfer/read', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mail-Account-Context': JSON.stringify(source) }, body: JSON.stringify({ ids }) }));
              if (!read.ok) throw new MailAccessError('copy_source_unavailable', 'Source email is unavailable.', read.status);
              const sourceData = await read.json() as { emails: Record<string, unknown>[]; state: string };
              const transferSource = { ...source, actorId: source.actor.id, actions: source.actor.actions, emails: sourceData.emails, state: sourceData.state, authorityProof: { lease: authority.lease, jobId, expiresAt: sourceAuthorityExpiresAt, actions: sourceAuthorityActions } };
              const result = await env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(destination.accountId)).fetch(new Request('https://mail-account.internal/jmap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...destination, transferSource, request: single }) }));
              if (!result.ok) throw new MailAccessError('copy_destination_unavailable', 'The copy could not be committed.', result.status);
              const value = await result.json() as JmapResponse;
              if (args.onSuccessDestroyOriginal) {
                const copied = value.methodResponses.find(tuple => tuple[0] === 'Email/copy')?.[1];
                const destroy = Object.keys(copied?.created ?? {}).map(key => args.create[key].id);
                if (destroy.length) {
                  const sourceCurrent = await core.authorize(request, source.accountId, ['mail.organize']);
                  const response = await sourceStub.fetch(new Request('https://mail-account.internal/jmap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...source, actor: { ...source.actor, actions: sourceCurrent.effectiveActions }, request: { using: single.using, methodCalls: [['Email/set', { accountId: source.accountId, ifInState: args.destroyFromIfInState ?? sourceData.state, destroy, ...(args.operationId ? { operationId: args.operationId } : {}) }, single.methodCalls[0][2]]] } }) }));
                  if (response.ok) value.methodResponses.push(...((await response.json()) as JmapResponse).methodResponses);
                }
              }
              for (const context of [source, destination]) {
                const current = (await core.account(request, context.accountId)).account;
                if (!context.actor.actions.every(action => current.effectiveActions.includes(action))) throw new MailAccessError('copy_permissions_changed', 'Account permissions changed.');
              }
              return value;
            },
            sessionState: async () => accountSessionState(await core.accounts(request)),
          });
          if(jmap.methodCalls.some(([method])=>method==='EmailSubmission/set'))console.info('Mail submission result',{
            results:result.methodResponses.map(([method,value])=>({method,type:typeof value.type==='string'?value.type:null,created:Object.keys(value.created||{}).length,rejected:Object.values(value.notCreated||{}).map((failure:any)=>failure.type)})),
          });
          response = json(result);
        } else if (/^\/jmap\/upload\/[^/]+$/.test(path)) {
          methodAllowed(request.method, ['POST']);
          await select(decodeURIComponent(path.split('/')[3]), ['mail.draft']);
          const body = boundedUploadStream(request, MAX_UPLOAD);
          const headers = accountHeaders(account, actions);
          if (request.headers.has('Content-Length')) headers.set('Content-Length', request.headers.get('Content-Length')!);
          headers.set('Content-Type', request.headers.get('Content-Type') || 'application/octet-stream');
          response = await stub().fetch(new Request('https://mail-account.internal/upload', { method: 'POST', headers, body, duplex: 'half' } as RequestInit));
        } else if (/^\/jmap\/download\/[^/]+\/[^/]+\/[^/]+$/.test(path)) {
          methodAllowed(request.method, ['GET', 'HEAD']);
          const segments = path.split('/').map(decodeURIComponent);
          await select(segments[3], ['mail.read']);
          response = await stub().fetch(new Request(`https://mail-account.internal/blob/${encodeURIComponent(segments[4])}`, { headers: accountHeaders(account, actions) }));
          if (response.ok) {
            const headers = new Headers(response.headers);
            headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(segments[5])}`);
            response = new Response(response.body, { status: response.status, headers });
          }
        } else if (api) {
          response = json({ error: 'not_found', message: 'Mail route not found.' }, 404);
        } else {
          methodAllowed(request.method, ['GET', 'HEAD']);
          const assetsUrl = new URL(request.url); assetsUrl.pathname = path;
          response = await env.ASSETS.fetch(new Request(assetsUrl, request));
        }
        if (request.method === 'HEAD') response = new Response(null, { status: response.status, headers: response.headers });
        const protectedResponse = protectResponse(request, response, { api });
        // Sanitized message frames inherit this policy. Remote image sources
        // remain absent until the reader explicitly opts in to loading images.
        if (!api && protectedResponse.ok && protectedResponse.headers.get('Content-Type')?.split(';')[0].trim() === 'text/html') {
          protectedResponse.headers.set('Content-Security-Policy', protectedResponse.headers.get('Content-Security-Policy')!.replace("img-src 'self' data:", "img-src 'self' data: blob: https:"));
          protectedResponse.headers.set('Referrer-Policy', 'no-referrer');
        }
        return protectedResponse;
      } catch (error) {
        const response = error instanceof AuthenticationError ? authenticationErrorResponse(error)
          : (error instanceof MailAccessError || error instanceof UploadTooLarge) ? json({ error: error.code, message: error.message }, error.status)
          : json({ error: 'mail_unavailable', message: 'Mail services are unavailable. Try again.' }, 503);
        return protectResponse(request, response, { api: true });
      }
    },
  };
}

export default createMailWorker();
