/** Enough logical connections are independent of MCP transport sessions.
 * Modern MCP is stateless; do not mint or interpret Mcp-Session-Id here.
 */
export const MCP_CONNECTION_CONTEXT_HEADER = 'x-open-cloud-mcp-connection-context';
export const DEFAULT_MCP_CONNECTION_TTL_MS = 15 * 60 * 1000;
export const MAX_MCP_CONNECTION_TTL_MS = 60 * 60 * 1000;
export const MAX_MCP_CONNECTION_INFLIGHT = 64;
export const MAX_MCP_CONNECTION_INVOCATIONS = 2048;

/** Core supplies this only after verifying current identity, grant and membership.
 * A connection ID is a routing/correlation identifier, never a bearer credential.
 */
export interface McpConnectionIdentity {
  connectionId: string;
  organizationId: string;
  workspaceId: string;
  actorId: string;
  clientId: string;
  grantId: string;
  grantVersion: number;
}
export type McpConnectionStatus = 'initializing' | 'ready' | 'closed' | 'expired' | 'revoked';
export interface McpConnectionRecord extends McpConnectionIdentity {
  version: 1;
  status: McpConnectionStatus;
  createdAt: number;
  expiresAt: number;
}
export type McpInvocationOutcome = 'completed' | 'failed' | 'cancelled';
export type McpInvocationStatus = 'running' | 'cancel_requested' | McpInvocationOutcome | 'interrupted';
export interface McpInvocationRecord {
  invocationId: string;
  status: McpInvocationStatus;
  startedAt: number;
  finishedAt: number | null;
  cancelRequestedAt: number | null;
  interruptionReason: 'closed' | 'expired' | 'revoked' | null;
}
interface SqlCursor<T> { toArray(): T[] }
export interface McpConnectionState {
  storage: {
    sql: { exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T> };
    transactionSync<T>(callback: () => T): T;
    setAlarm(time: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
}
interface InvocationRow {
  invocation_id: string; status: McpInvocationStatus; started_at: number;
  finished_at: number | null; cancel_requested_at: number | null;
  interruption_reason: McpInvocationRecord['interruptionReason'];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTITY_FIELDS = ['connectionId', 'organizationId', 'workspaceId', 'actorId', 'clientId', 'grantId', 'grantVersion'] as const;
const ACTIVE = new Set<McpConnectionStatus>(['initializing', 'ready']);
const OUTCOMES = new Set<McpInvocationStatus>(['completed', 'failed', 'cancelled']);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
class ConnectionError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const boundedString = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\u0000-\u001f\u007f]/.test(value);
export const isMcpConnectionId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export const createMcpConnectionId = (): string => crypto.randomUUID();
export const createMcpInvocationId = (): string => crypto.randomUUID();

function context(request: Request): McpConnectionIdentity {
  let value: unknown;
  try { value = JSON.parse(request.headers.get(MCP_CONNECTION_CONTEXT_HEADER) ?? 'null'); } catch { throw new ConnectionError('connection_authorization_required', 403); }
  if (!record(value) || !isMcpConnectionId(value.connectionId)
    || !['organizationId', 'workspaceId', 'actorId', 'clientId', 'grantId'].every((field) => boundedString(value[field]))
    || !Number.isSafeInteger(value.grantVersion) || Number(value.grantVersion) < 1) throw new ConnectionError('connection_authorization_required', 403);
  // Select fields explicitly: no credential, action grant, document state or tool payload is persisted.
  return { connectionId: value.connectionId, organizationId: value.organizationId as string, workspaceId: value.workspaceId as string,
    actorId: value.actorId as string, clientId: value.clientId as string, grantId: value.grantId as string, grantVersion: Number(value.grantVersion) };
}
async function body(request: Request, allowed: string[]): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    if (reader) while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 4096) { void reader.cancel().catch(() => {}); throw new ConnectionError('connection_request_too_large', 413); }
      chunks.push(value);
    }
  } finally { reader?.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new ConnectionError('invalid_connection_request', 400); }
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new ConnectionError('invalid_connection_request', 400);
  return value;
}
function invocation(row: InvocationRow): McpInvocationRecord {
  return { invocationId: row.invocation_id, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at,
    cancelRequestedAt: row.cancel_requested_at, interruptionReason: row.interruption_reason };
}

/** One SQLite Durable Object per server-issued logical connection.
 * Core alone routes to this internal object; never forward a browser's context header.
 * Admission/finish are short independent transactions. Tool execution happens outside
 * them, so parallel agents do not queue behind another invocation's remote work.
 * This is coordination, not an exactly-once executor or document authority store.
 */
export class McpConnection {
  constructor(private readonly ctx: McpConnectionState, _env?: unknown) {
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mcp_connection (singleton INTEGER PRIMARY KEY CHECK(singleton=1), record_json TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mcp_invocations (invocation_id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, cancel_requested_at INTEGER, interruption_reason TEXT)');
  }
  private load(): McpConnectionRecord | null {
    const row = this.ctx.storage.sql.exec<{ record_json: string }>('SELECT record_json FROM mcp_connection WHERE singleton=1').toArray()[0];
    if (!row) return null;
    const value = JSON.parse(row.record_json) as McpConnectionRecord;
    if (value.version !== 1) throw new ConnectionError('unsupported_connection_version', 503);
    return value;
  }
  private save(value: McpConnectionRecord): void {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO mcp_connection (singleton,record_json) VALUES (1,?)', JSON.stringify(value));
  }
  private end(value: McpConnectionRecord, status: 'closed' | 'expired' | 'revoked'): McpConnectionRecord {
    const ended = { ...value, status };
    this.ctx.storage.transactionSync(() => {
      this.save(ended);
      this.ctx.storage.sql.exec("UPDATE mcp_invocations SET status='interrupted',finished_at=?,interruption_reason=? WHERE status IN ('running','cancel_requested')", Date.now(), status);
    });
    return ended;
  }
  private expire(value: McpConnectionRecord): McpConnectionRecord {
    return ACTIVE.has(value.status) && value.expiresAt <= Date.now() ? this.end(value, 'expired') : value;
  }
  private authorized(identity: McpConnectionIdentity): McpConnectionRecord {
    const existing = this.load();
    if (!existing) throw new ConnectionError('connection_not_found', 404);
    if (IDENTITY_FIELDS.some((field) => identity[field] !== existing[field])) throw new ConnectionError('connection_identity_mismatch', 403);
    return this.expire(existing);
  }
  private requireActive(value: McpConnectionRecord, ready = false): void {
    if (!ACTIVE.has(value.status)) throw new ConnectionError(`connection_${value.status}`);
    if (ready && value.status !== 'ready') throw new ConnectionError('connection_not_ready');
  }
  private getInvocation(id: unknown): McpInvocationRecord {
    if (!isMcpConnectionId(id)) throw new ConnectionError('invalid_invocation_id', 400);
    const row = this.ctx.storage.sql.exec<InvocationRow>('SELECT * FROM mcp_invocations WHERE invocation_id=?', id).toArray()[0];
    if (!row) throw new ConnectionError('invocation_not_found', 404);
    return invocation(row);
  }
  private counts(): { total: number; inFlight: number } {
    return this.ctx.storage.sql.exec<{ total: number; inFlight: number }>("SELECT COUNT(*) AS total,COALESCE(SUM(status IN ('running','cancel_requested')),0) AS inFlight FROM mcp_invocations").toArray()[0];
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const identity = context(request), path = new URL(request.url).pathname;
      if (path === '/initialize' && request.method === 'POST') {
        const input = await body(request, ['ttlMs']);
        const ttlMs = input.ttlMs ?? DEFAULT_MCP_CONNECTION_TTL_MS;
        if (!Number.isSafeInteger(ttlMs) || Number(ttlMs) < 1000 || Number(ttlMs) > MAX_MCP_CONNECTION_TTL_MS) throw new ConnectionError('invalid_connection_lifetime', 400);
        let connection = this.load();
        if (connection) { connection = this.authorized(identity); this.requireActive(connection); }
        else { connection = { ...identity, version: 1, status: 'initializing', createdAt: Date.now(), expiresAt: Date.now() + Number(ttlMs) }; this.save(connection); }
        // Also repairs an alarm failure after a durable initialization. Retry never extends expiry.
        await this.ctx.storage.setAlarm(connection.expiresAt);
        return json({ connection });
      }
      // Reject unknown routes before exposing any existing connection's state.
      const lookup = /^\/invocations\/([0-9a-f-]+)$/.exec(path);
      if (!['/ready', '/status', '/close', '/revoke', '/invocations/begin', '/invocations/cancel', '/invocations/finish'].includes(path) && !lookup) return json({ error: 'connection_route_not_found' }, 404);
      const expectedMethod = path === '/status' || lookup ? 'GET' : 'POST';
      if (request.method !== expectedMethod) return json({ error: 'method_not_allowed' }, 405);
      let connection = this.authorized(identity);
      if (path === '/status') return json({ connection, invocations: this.counts() });
      if (lookup) return json({ invocation: this.getInvocation(lookup[1]) });
      if (path === '/ready') {
        await body(request, []); connection = this.authorized(identity); this.requireActive(connection);
        connection = { ...connection, status: 'ready' }; this.save(connection);
        return json({ connection });
      }
      if (path === '/close' || path === '/revoke') {
        await body(request, []);
        connection = this.authorized(identity);
        if (ACTIVE.has(connection.status) || path === '/revoke') connection = this.end(connection, path === '/revoke' ? 'revoked' : 'closed');
        await this.ctx.storage.deleteAlarm();
        return json({ connection });
      }
      const input = await body(request, path === '/invocations/finish' ? ['invocationId', 'outcome'] : ['invocationId']);
      // Request body reads may yield while another call closes/revokes this object.
      connection = this.authorized(identity);
      if (!isMcpConnectionId(input.invocationId)) throw new ConnectionError('invalid_invocation_id', 400);
      const id = input.invocationId;
      if (path === '/invocations/begin') {
        this.requireActive(connection, true);
        const admitted = this.ctx.storage.transactionSync(() => {
          if (this.ctx.storage.sql.exec('SELECT invocation_id FROM mcp_invocations WHERE invocation_id=?', id).toArray().length) return false;
          const counts = this.counts();
          if (counts.inFlight >= MAX_MCP_CONNECTION_INFLIGHT) throw new ConnectionError('connection_inflight_limit', 429);
          // Retain all IDs for this bounded lifetime; evicting receipts would enable ambiguous replay.
          if (counts.total >= MAX_MCP_CONNECTION_INVOCATIONS) throw new ConnectionError('connection_invocation_limit', 429);
          this.ctx.storage.sql.exec("INSERT INTO mcp_invocations (invocation_id,status,started_at) VALUES (?,'running',?)", id, Date.now());
          return true;
        });
        return json({ admitted, invocation: this.getInvocation(id) });
      }
      let current = this.getInvocation(id);
      if (path === '/invocations/cancel') {
        // Explicit cancellation is advisory; it never rolls back accepted product mutations.
        if (current.status === 'running') this.ctx.storage.sql.exec("UPDATE mcp_invocations SET status='cancel_requested',cancel_requested_at=? WHERE invocation_id=?", Date.now(), id);
        return json({ invocation: this.getInvocation(id) });
      }
      if (!OUTCOMES.has(input.outcome as McpInvocationStatus)) throw new ConnectionError('invalid_invocation_outcome', 400);
      if (OUTCOMES.has(current.status)) {
        if (current.status !== input.outcome) throw new ConnectionError('invocation_outcome_conflict');
      } else {
        // A late completion can resolve interrupted work; connection termination did not undo it.
        this.ctx.storage.sql.exec('UPDATE mcp_invocations SET status=?,finished_at=? WHERE invocation_id=?', input.outcome, Date.now(), id);
        current = this.getInvocation(id);
      }
      return json({ invocation: current });
    } catch (error) {
      if (error instanceof ConnectionError) return json({ error: error.code }, error.status);
      return json({ error: 'connection_unavailable' }, 503);
    }
  }
  async alarm(): Promise<void> {
    const value = this.load();
    if (!value || !ACTIVE.has(value.status)) { await this.ctx.storage.deleteAlarm(); return; }
    if (value.expiresAt > Date.now()) { await this.ctx.storage.setAlarm(value.expiresAt); return; }
    this.end(value, 'expired');
    await this.ctx.storage.deleteAlarm();
  }
}
