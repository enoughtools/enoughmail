import { DELEGATION_HEADER, verifyDelegation } from '@open-cloud/mcp/delegation';
import type { AssetFetcher } from '@open-cloud/worker';
import type { AuthenticationEnv } from '@open-cloud/auth';
import manifest from '../../app.manifest.json';
import { boundedBytes } from './credentials';

interface McpEnv extends AuthenticationEnv {
  MCP_SIGNING_KEY?: string;
  CORE?: AssetFetcher;
  MAIL_ACCOUNTS: { idFromName(name: string): unknown; get(id: unknown): AssetFetcher };
}
interface Authorization {
  resourceId: string; organizationId: string; workspaceId: string;
  actor: { id: string }; effectiveActions: string[]; membershipRole?: string; jobLease?: string;
}
interface Tool { method: string; actions: string[]; write: boolean; role: boolean; lease: boolean }
const methods: Record<string, Tool> = {
  "mail_list_emails": {
    "method": "Email/query",
    "actions": [
      "mail.read"
    ],
    "write": false,
    "role": false,
    "lease": false
  },
  "mail_get_email": {
    "method": "Email/get",
    "actions": [
      "mail.read"
    ],
    "write": false,
    "role": false,
    "lease": false
  },
  "mail_update_email": {
    "method": "Email/set",
    "actions": [
      "mail.organize"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_create_draft": {
    "method": "Email/set",
    "actions": [
      "mail.draft"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_send_email": {
    "method": "EmailSubmission/set",
    "actions": [
      "mail.send"
    ],
    "write": true,
    "role": false,
    "lease": true
  },
  "mail_schedule_email": {
    "method": "EmailSubmission/set",
    "actions": [
      "mail.send"
    ],
    "write": true,
    "role": false,
    "lease": true
  },
  "mail_send_shared_draft": {
    "method": "EmailSubmission/set", "actions": ["mail.read", "mail.send"], "write": true, "role": false, "lease": true
  },
  "mail_schedule_shared_draft": {
    "method": "EmailSubmission/set", "actions": ["mail.read", "mail.send"], "write": true, "role": false, "lease": true
  },
  "mail_get_submissions": {
    "method": "EmailSubmission/get",
    "actions": [
      "mail.send"
    ],
    "write": false,
    "role": false,
    "lease": false
  },
  "mail_cancel_submission": {
    "method": "EmailSubmission/set",
    "actions": [
      "mail.send"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_get_rules": {
    "method": "Rule/get",
    "actions": [
      "mail.read"
    ],
    "write": false,
    "role": false,
    "lease": false
  },
  "mail_set_rules": {
    "method": "Rule/set",
    "actions": [
      "mail.organize"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_get_mailboxes": {
    "method": "Mailbox/get",
    "actions": [
      "mail.read"
    ],
    "write": false,
    "role": false,
    "lease": false
  },
  "mail_set_mailboxes": {
    "method": "Mailbox/set",
    "actions": [
      "mail.organize"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_get_identities": {
    "method": "Identity/get",
    "actions": [
      "mail.read"
    ],
    "write": false,
    "role": false,
    "lease": false
  },
  "mail_set_identities": {
    "method": "Identity/set",
    "actions": [
      "mail.manage"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_get_domains": {
    "method": "Domain/get",
    "actions": [
      "mail.read"
    ],
    "write": false,
    "role": false,
    "lease": false
  },
  "mail_set_domains": {
    "method": "Domain/set",
    "actions": [
      "mail.manage"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_get_contacts": {
    "method": "Contact/get",
    "actions": [
      "mail.read"
    ],
    "write": false,
    "role": false,
    "lease": false
  },
  "mail_set_contacts": {
    "method": "Contact/set",
    "actions": [
      "mail.manage",
      "mail.draft"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_get_templates": {
    "method": "Template/get",
    "actions": [
      "mail.read"
    ],
    "write": false,
    "role": false,
    "lease": false
  },
  "mail_set_templates": {
    "method": "Template/set",
    "actions": [
      "mail.manage",
      "mail.draft"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_snooze_emails": {
    "method": "Snooze/set",
    "actions": [
      "mail.organize"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_unsnooze_emails": {
    "method": "Snooze/set",
    "actions": [
      "mail.organize"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_follow_up_emails": {
    "method": "FollowUp/set",
    "actions": [
      "mail.organize"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_clear_follow_up": {
    "method": "FollowUp/set",
    "actions": [
      "mail.organize"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_get_settings": {
    "method": "Settings/get",
    "actions": [
      "mail.read"
    ],
    "write": false,
    "role": false,
    "lease": false
  },
  "mail_set_settings": {
    "method": "Settings/set",
    "actions": [
      "mail.manage"
    ],
    "write": true,
    "role": false,
    "lease": false
  },
  "mail_domain_plan": {
    "method": "Domain/plan",
    "actions": [
      "mail.manage",
      "mail.read"
    ],
    "write": false,
    "role": true,
    "lease": false
  },
  "mail_domain_apply": {
    "method": "Domain/apply",
    "actions": [
      "mail.manage",
      "mail.read"
    ],
    "write": true,
    "role": true,
    "lease": false
  },
  "mail_domain_verify": {
    "method": "Domain/verify",
    "actions": [
      "mail.manage",
      "mail.read"
    ],
    "write": true,
    "role": true,
    "lease": false
  }
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function validateArgs(toolName: string, value: unknown): Record<string, unknown> {
  const descriptor = manifest.mcp.tools.find(tool => tool.name === toolName);
  if (!descriptor || !object(value)) throw new Error('Invalid tool arguments');
  const rawSchema: unknown = descriptor.inputSchema;
  if (!object(rawSchema) || !object(rawSchema.properties) || !Array.isArray(rawSchema.required) || !rawSchema.required.every(key => typeof key === 'string')) throw new Error('Invalid registered tool schema');
  const schema = rawSchema as unknown as { properties: Record<string, { type: string; minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number; maxItems?: number; items?: { type: string; minLength?: number; maxLength?: number } }>; required: string[] };
  if (Object.keys(value).length > 32 || Object.keys(value).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid tool arguments');
  for (const [key, item] of Object.entries(value)) {
    const rule = schema.properties[key];
    if (['resourceId', 'operationId'].includes(key) && (typeof item !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item))) throw new Error('Invalid command identity');
    if (rule.type === 'string' && (typeof item !== 'string' || item.length < (rule.minLength ?? 0) || item.length > (rule.maxLength ?? 16384) || rule.pattern && !new RegExp(rule.pattern).test(item))) throw new Error('Invalid bounded string');
    if (rule.type === 'integer' && (!Number.isSafeInteger(item) || Number(item) < (rule.minimum ?? 0) || Number(item) > (rule.maximum ?? Number.MAX_SAFE_INTEGER))) throw new Error('Invalid integer');
    if (rule.type === 'boolean' && typeof item !== 'boolean') throw new Error('Invalid boolean');
    if (rule.type === 'array' && (!Array.isArray(item) || item.length > (rule.maxItems ?? 100) || item.some(entry => typeof entry !== 'string' || entry.length < (rule.items?.minLength ?? 0) || entry.length > (rule.items?.maxLength ?? 255)))) throw new Error('Invalid bounded array');
  }
  return value;
}
function parseObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(value));
  if (!object(parsed)) throw new Error('JSON must contain an object');
  const check = (item: unknown, depth: number): void => {
    if (depth > 16) throw new Error('JSON nesting limit exceeded');
    if (Array.isArray(item)) { if (item.length > 100) throw new Error('JSON array limit exceeded'); item.forEach(entry => check(entry, depth + 1)); }
    else if (object(item)) { if (Object.keys(item).length > 100 || Object.keys(item).some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Invalid JSON object'); Object.values(item).forEach(entry => check(entry, depth + 1)); }
  };
  check(parsed, 0); return parsed;
}
function methodArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'mail_list_emails') return { filter: args.query ? { text: args.query } : {}, limit: args.limit ?? 50 };
  if (name === 'mail_get_email') return { ids: [args.emailId], fetchAllBodyValues: true };
  if (name === 'mail_update_email') return { update: { [String(args.emailId)]: parseObject(args.patchJson) } };
  if (name === 'mail_create_draft') return { create: { draft: parseObject(args.emailJson) } };
  if (['mail_send_email', 'mail_schedule_email', 'mail_send_shared_draft', 'mail_schedule_shared_draft'].includes(name)) return { create: { submission: { emailId: args.emailId, identityId: args.identityId, ...(args.sendAt ? { sendAt: args.sendAt } : {}), ...(args.undoSeconds !== undefined ? { undoSeconds: args.undoSeconds } : {}) } } };
  if (name === 'mail_cancel_submission') return { update: { [String(args.submissionId)]: { undoStatus: 'canceled' } } };
  if (['mail_snooze_emails', 'mail_unsnooze_emails', 'mail_follow_up_emails', 'mail_clear_follow_up'].includes(name)) return { emailIds: args.emailIds, until: args.until ?? null, ...(args.ifNoReply !== undefined ? { ifNoReply: args.ifNoReply } : {}) };
  if (name === 'mail_set_settings') {
    const settings = parseObject(args.settingsJson);
    // Scheduled automation requires a separately authorized sending lease. This tool edits preferences only.
    if (object(settings.forwarding) && settings.forwarding.enabled || object(settings.vacation) && settings.vacation.enabled) throw new Error('Enable automatic sending through the Mail settings UI so Core can issue a sending lease.');
    return { settings };
  }
  if (name.startsWith('mail_domain_')) return { domainId: args.domainId, ...(args.planJson ? { plan: parseObject(args.planJson) } : {}) };
  if (name.startsWith('mail_set_')) return { ...(args.createJson ? { create: parseObject(args.createJson) } : {}), ...(args.updateJson ? { update: parseObject(args.updateJson) } : {}), ...(args.destroy ? { destroy: args.destroy } : {}) };
  return args.ids ? { ids: args.ids } : {};
}

/** Service-bound implementation: only Core may delegate exact scoped tool requests. */
export async function handleMailMcp(request: Request, env: McpEnv): Promise<Response> {
  try {
    if (request.method !== 'POST' || !env.CORE) return Response.json({ error: 'forbidden' }, { status: 403 });
    const raw = new TextDecoder().decode(await boundedBytes(request, 1_048_576));
    const body: unknown = JSON.parse(raw);
    if (!object(body) || typeof body.tool !== 'string' || Object.keys(body).some(key => !['tool', 'arguments'].includes(key))) throw new Error('Invalid request');
    const toolName = body.tool, tool = methods[toolName];
    const registered = manifest.mcp.tools.find(descriptor => descriptor.name === toolName);
    if (!tool || !registered || JSON.stringify(tool.actions) !== JSON.stringify(registered.actions)) throw new Error('Unknown or mismatched tool authorization');
    const args = validateArgs(toolName, body.arguments);
    const claims = await verifyDelegation(request, env, { audience: 'mail', body: raw });
    if (claims.fileId !== args.resourceId || tool.actions.some(action => !claims.actions.includes(action))) throw new Error('Permission denied');
    const delegation = request.headers.get(DELEGATION_HEADER);
    const authorityExpiresAt = Date.now() + 90 * 86400000 - 60000; // Stay below the authority limit despite clock skew.
    const authorize = async (issueLease = false): Promise<Authorization> => {
      let selected: Authorization | undefined;
      for (const action of tool.actions) {
        const response = await env.CORE!.fetch(new Request('https://core.internal/internal/policy/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resourceId: args.resourceId, action, delegation, delegatedBody: raw, ...(issueLease && tool.lease && action === 'mail.send' ? { jobId: args.operationId, expiresAt: authorityExpiresAt } : {}) }) }));
        if (!response.ok) throw new Error('Permission denied');
        const value = await response.json() as { allowed: boolean; nativeResourceAuthorization?: Authorization };
        const auth = value.nativeResourceAuthorization;
        if (!value.allowed || !auth || auth.resourceId !== args.resourceId || auth.actor.id !== claims.actorId || auth.organizationId !== claims.organizationId || auth.workspaceId !== claims.workspaceId || !auth.effectiveActions.includes(action)) throw new Error('Permission denied');
        if (tool.role && !['owner', 'administrator'].includes(auth.membershipRole ?? '')) throw new Error('DNS tools require current verified workspace owner or administrator membership.');
        if (selected && (selected.membershipRole !== auth.membershipRole || tool.actions.some(required => !auth.effectiveActions.includes(required)))) throw new Error('Permission changed');
        selected = auth;
      }
      if (!selected || tool.lease && issueLease && !selected.jobLease) throw new Error('Sending lease unavailable');
      return selected;
    };
    const auth = await authorize(true);
    const methodArgs = { accountId: auth.resourceId, ...methodArguments(toolName, args), ...(tool.write ? { operationId: args.operationId, ifInState: `m${Number(args.expectedSequence).toString(36)}` } : {}) };
    const response = await env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(auth.resourceId)).fetch(new Request('https://mail-account.internal/jmap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      accountId: auth.resourceId, organizationId: auth.organizationId, workspaceId: auth.workspaceId,
      actor: { id: auth.actor.id, actions: auth.effectiveActions, workspaceRole: auth.membershipRole }, ...(auth.jobLease ? { authorityProof: { lease: auth.jobLease, jobId: args.operationId, expiresAt: authorityExpiresAt, actions: [...registered.actions] } } : {}),
      request: { using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission', 'urn:enough:params:jmap:mail'], methodCalls: [[tool.method, methodArgs, 'mcp']], ...(tool.write ? { requestId: args.operationId } : {}) },
    }) }));
    if (!response.ok) throw new Error('Mail operation failed');
    const result: unknown = await response.json();
    await authorize();
    return Response.json({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (error) { return Response.json({ error: 'forbidden', message: error instanceof Error ? error.message : 'The delegated Mail request is invalid or unavailable.' }, { status: 403 }); }
}
