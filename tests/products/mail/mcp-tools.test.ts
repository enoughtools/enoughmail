import { describe, expect, it } from 'vitest';
import { isAppManifest } from '@open-cloud/contracts';
import { DELEGATION_HEADER, signDelegation } from '@open-cloud/mcp/delegation';
import { handleMailMcp } from '../../../apps/mail/src/server/mcp';
import manifest from '../../../apps/mail/app.manifest.json';

const accountId = '00000000-0000-4000-8000-000000000001';
const operationId = '00000000-0000-4000-8000-000000000002';
const signing = { MCP_SIGNING_KEY: 'mail-mcp-test-signing-key-at-least-thirty-two-characters', AUTH_PROVIDER: 'cloudflare-access' as const };
async function invoke(tool: string, args: Record<string, unknown>, options: { role?: string; actions?: string[]; revokedAfter?: number; lease?: boolean } = {}) {
  const descriptor = manifest.mcp.tools.find(item => item.name === tool)!;
  const actions = options.actions ?? descriptor.actions;
  const raw = JSON.stringify({ tool, arguments: { resourceId: accountId, ...args } });
  const request = new Request('https://mail.internal/internal/mcp', { method: 'POST', body: raw });
  request.headers.set(DELEGATION_HEADER, await signDelegation(request, signing, { audience: 'mail', requestId: crypto.randomUUID(), organizationId: 'org', workspaceId: 'workspace', actorId: 'actor', principal: { id: 'access', provider: 'cloudflare-access', email: 'person@example.test', displayName: 'Person' }, clientId: 'client', grantId: 'grant', grantVersion: 1, actions, resourceIds: [accountId], fileId: accountId, action: actions[0] }, raw));
  let authCalls = 0;
  const policies: any[] = [], backend: any[] = [];
  const response = await handleMailMcp(request, { ...signing, CORE: { async fetch(req: Request) {
    const body = await req.json(); policies.push(body); authCalls++;
    return Response.json({ allowed: !(options.revokedAfter && authCalls > options.revokedAfter), nativeResourceAuthorization: { resourceId: accountId, organizationId: 'org', workspaceId: 'workspace', actor: { id: 'actor' }, effectiveActions: actions, membershipRole: options.role, ...(options.lease !== false && body.jobId ? { jobLease: 'core-signed-lease' } : {}) } });
  } }, MAIL_ACCOUNTS: { idFromName: (id: string) => id, get: () => ({ async fetch(req: Request) { backend.push(await req.json()); return Response.json({ methodResponses: [['result', { accountId }, 'mcp']] }); } }) } });
  return { response, backend, policies };
}

describe('Mail central MCP service implementation', () => {
  it('publishes a manifest accepted by the public platform contract',()=>{expect(isAppManifest(manifest)).toBe(true);});

  it('binds shared-draft sending to reading and sending for the entire delayed authority',async()=>{
    for(const tool of ['mail_send_shared_draft','mail_schedule_shared_draft']){
      const result=await invoke(tool,{operationId,expectedSequence:0,emailId:'email',identityId:'identity',...(tool.includes('schedule')?{sendAt:'2027-01-01T10:00:00Z'}:{})});
      expect(result.response.status).toBe(200);expect(result.backend[0].actor.actions).toEqual(['mail.read','mail.send']);
      expect(result.backend[0].authorityProof).toEqual({lease:'core-signed-lease',jobId:operationId,expiresAt:result.policies[1].expiresAt,actions:['mail.read','mail.send']});
      expect(result.policies.map(policy=>policy.action)).toEqual(['mail.read','mail.send','mail.read','mail.send']);
      const denied=await invoke(tool,{operationId,expectedSequence:0,emailId:'email',identityId:'identity',...(tool.includes('schedule')?{sendAt:'2027-01-01T10:00:00Z'}:{})},{actions:['mail.send']});
      expect(denied.response.status).toBe(403);expect(denied.backend).toHaveLength(0);
    }
  });

  it('passes the stable operation receipt, revision and signed sending lease to scheduled submissions', async () => {
    const result = await invoke('mail_schedule_email', { operationId, expectedSequence: 35, emailId: 'email', identityId: 'identity', sendAt: '2027-01-01T10:00:00Z' });
    expect(result.response.status).toBe(200);
    expect(result.backend[0].request.methodCalls[0]).toEqual(['EmailSubmission/set', { accountId, create: { submission: { emailId: 'email', identityId: 'identity', sendAt: '2027-01-01T10:00:00Z' } }, operationId, ifInState: 'mz' }, 'mcp']);
    expect(result.backend[0].authorityProof).toEqual({ lease: 'core-signed-lease', jobId: operationId, expiresAt: result.policies[0].expiresAt, actions: ['mail.send'] });
    expect(result.policies).toHaveLength(2);
    expect(result.policies[1].jobId).toBeUndefined();
  });
  it('fails closed when Core cannot issue sending authority', async () => {
    const result = await invoke('mail_send_email', { operationId, expectedSequence: 0, emailId: 'email', identityId: 'identity' }, { lease: false });
    expect(result.response.status).toBe(403); expect(result.backend).toHaveLength(0);
  });
  it('does not infer DNS administration from a mail.manage grant', async () => {
    const result = await invoke('mail_domain_plan', { domainId: 'domain' });
    expect(result.response.status).toBe(403); expect(result.backend).toHaveLength(0);
  });
  it('forwards only current verified DNS administration and separately checks both current actions', async () => {
    const result = await invoke('mail_domain_plan', { domainId: 'domain' }, { role: 'administrator' });
    expect(result.response.status).toBe(200);
    expect(result.backend[0].actor.workspaceRole).toBe('administrator');
    expect(result.policies.map(item => item.action)).toEqual(['mail.manage', 'mail.read', 'mail.manage', 'mail.read']);
  });
  it('does not release a response after the current grant is revoked', async () => {
    const result = await invoke('mail_get_submissions', { ids: ['submission'] }, { revokedAfter: 1 });
    expect(result.backend).toHaveLength(1); expect(result.response.status).toBe(403);
  });
  it('rejects caller-supplied actor fields before invoking account storage', async () => {
    const result = await invoke('mail_get_email', { emailId: 'email', actor: { id: 'other' } });
    expect(result.response.status).toBe(403); expect(result.backend).toHaveLength(0);
  });
  it('cannot turn settings management into automatic sending without a separately authorized lease', async () => {
    const result = await invoke('mail_set_settings', { operationId, expectedSequence: 0, settingsJson: JSON.stringify({ forwarding: { enabled: true, address: 'other@example.test' } }) });
    expect(result.response.status).toBe(403); expect(result.backend).toHaveLength(0);
  });
  it('requires bounded schemas and explicit revisions on every write descriptor', () => {
    for (const tool of manifest.mcp.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(tool.inputSchema.properties).length).toBeLessThanOrEqual(32);
      expect(Object.hasOwn(tool.inputSchema, 'maxProperties')).toBe(false);
      if (tool.effect === 'write') expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['operationId', 'expectedSequence']));
    }
  });
});
