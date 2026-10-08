import type { MailContext } from '../domain/model';

export type JmapTuple = [string, Record<string, any>, string];
export interface JmapRequest { using: string[]; methodCalls: JmapTuple[]; createdIds?: Record<string, string>; requestId?: string }
export interface JmapResponse { methodResponses: JmapTuple[]; createdIds?: Record<string, string>; sessionState: string }
export interface AuthorizedJmapOptions {
  request: JmapRequest;
  workspace: { organizationId: string; workspaceId: string; actorId: string };
  authorizeAccount(accountId: string, requiredActions?: string[]): Promise<MailContext | null>;
  callAccount(context: MailContext, request: JmapRequest): Promise<JmapResponse>;
  callGlobal?(name: string, args: Record<string, any>, callId: string, request: JmapRequest): Promise<JmapResponse | undefined>;
  sessionState(): string | Promise<string>;
  transferEmail?(input: { source: MailContext; destination: MailContext; args: Record<string, any>; request: JmapRequest }): Promise<JmapResponse>;
}
const mutation = (name: string) => /\/(set|import|apply|verify|requestVerification|copy|start|cancel|renew|recover|prepare|route|setup)$/.test(name);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class MethodError extends Error { constructor(readonly type: string, message: string) { super(message); } }
function fail(type: string, message: string): never { throw new MethodError(type, message); }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

function references(args: Record<string, any>, responses: JmapTuple[]): Record<string, any> {
  const result = structuredClone(args);
  for (const [key, ref] of Object.entries(result)) {
    if (!key.startsWith('#')) continue;
    if (!object(ref) || typeof ref.resultOf !== 'string' || typeof ref.name !== 'string' || typeof ref.path !== 'string' || !ref.path.startsWith('/')) fail('invalidResultReference', 'Malformed result reference');
    if (Object.hasOwn(result, key.slice(1))) fail('invalidArguments', 'Argument and result reference both supplied');
    const response = responses.find(tuple => tuple[2] === ref.resultOf && tuple[0] === ref.name);
    if (!response) fail('invalidResultReference', 'Referenced response does not exist');
    let values: any[] = [response[1]];
    let wildcard = false;
    for (const encoded of ref.path.slice(1).split('/')) {
      if (/~(?![01])/u.test(encoded)) fail('invalidResultReference', 'Invalid JSON pointer escape');
      const part = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
      if (part === '*') {
        wildcard = true;
        values = values.flatMap(value => Array.isArray(value) ? value : object(value) ? Object.values(value) : fail('invalidResultReference', 'Wildcard requires an array or object'));
      } else values = values.map(value => {
        if ((!object(value) && !Array.isArray(value)) || !Object.hasOwn(value, part)) fail('invalidResultReference', 'Referenced path does not exist');
        return (value as Record<string, any>)[part];
      });
    }
    Object.defineProperty(result, key.slice(1), { value: wildcard ? values : values[0], writable: true, enumerable: true, configurable: true });
    delete result[key];
  }
  return result;
}

async function operationId(requestId: string, name: string, callId: string, index: number): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([requestId.toLowerCase(), name, callId, index]))));
  hash[6] = (hash[6] & 15) | 80; hash[8] = (hash[8] & 63) | 128;
  const hex = Array.from(hash.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Route each method with freshly verified account authority, retaining batch response order. */
export async function executeAuthorizedJmap(options: AuthorizedJmapOptions): Promise<JmapResponse> {
  const { request, workspace } = options;
  if (!Array.isArray(request.using) || !request.using.every(value => typeof value === 'string') || !Array.isArray(request.methodCalls) || request.methodCalls.length > 100 || request.methodCalls.some(tuple => !Array.isArray(tuple) || tuple.length !== 3 || typeof tuple[0] !== 'string' || !object(tuple[1]) || typeof tuple[2] !== 'string')) throw new Error('Invalid JMAP request');
  if (request.requestId !== undefined && !uuid.test(request.requestId)) throw new Error('Invalid request ID');
  if (request.createdIds !== undefined && (!object(request.createdIds) || !Object.values(request.createdIds).every(value => typeof value === 'string'))) throw new Error('Invalid created IDs');
  const responses: JmapTuple[] = [], createdIds = { ...request.createdIds };
  const owners = new Map<string, string>();
  async function authorize(id: unknown, actions: string[]): Promise<MailContext> {
    if (typeof id !== 'string' || !id) fail('invalidArguments', 'accountId is required');
    let context: MailContext | null;
    try { context = await options.authorizeAccount(id, actions); } catch { fail('accountNotFound', 'Account is unavailable'); }
    if (!context || context.accountId !== id || context.organizationId !== workspace.organizationId || context.workspaceId !== workspace.workspaceId || context.actor.id !== workspace.actorId) fail('accountNotFound', 'Account is unavailable');
    return context;
  }
  function resolve(value: any, accountId: string): any {
    if (typeof value === 'string' && value.startsWith('#') && Object.hasOwn(createdIds, value.slice(1))) {
      const key = value.slice(1), owner = owners.get(key);
      if (owner && owner !== accountId) fail('invalidArguments', 'Creation ID belongs to a different account');
      return createdIds[key];
    }
    if (Array.isArray(value)) return value.map(item => resolve(item, accountId));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [resolve(key, accountId), resolve(item, accountId)]));
    return value;
  }
  for (const [index, tuple] of request.methodCalls.entries()) {
    const [name, original, callId] = tuple;
    try {
      if (name === 'Core/echo') { responses.push([name, structuredClone(original), callId]); continue; }
      let args = references(original, responses);
      if (name === 'PushSubscription/get' || name === 'PushSubscription/set') {
        args = resolve(args, 'push-subscriptions');
        if (name === 'PushSubscription/set' && request.requestId && !args.operationId) args.operationId = await operationId(request.requestId, name, callId, index);
        const response = await options.callGlobal?.(name, args, callId, { ...request, methodCalls: [[name, args, callId]], createdIds: { ...createdIds } });
        if (!response) fail('unknownMethod', 'Push subscriptions are unavailable');
        if (!Array.isArray(response.methodResponses)) fail('serverFail', 'Invalid global response');
        responses.push(...response.methodResponses);
        for (const [key, id] of Object.entries(response.createdIds ?? {})) if (!Object.hasOwn(createdIds, key)) createdIds[key] = id;
        for (const [, result] of response.methodResponses) for (const [key, entry] of Object.entries(result.created ?? {}) as Array<[string, any]>) if (typeof entry?.id === 'string') createdIds[key] = entry.id;
        continue;
      }
      const required = name === 'EmailSubmission/recover' ? 'mail.draft' : !mutation(name) ? (['EmailSubmission', 'Identity'].includes(name.split('/')[0]) ? 'mail.send' : 'mail.read') : name.startsWith('EmailSubmission/') ? 'mail.send' : name.startsWith('Email/') ? 'mail.draft' : name.startsWith('Export/') ? 'mail.read' : ['Snooze', 'FollowUp', 'Mailbox', 'Rule'].includes(name.split('/')[0]) ? 'mail.organize' : 'mail.manage';
      const destination = await authorize(args.accountId, name === 'EmailSubmission/recover' ? ['mail.read','mail.draft'] : [required]);
      const allows = (context: MailContext, action: string) => context.actor.actions.includes(action) || action !== 'mail.send' && context.actor.actions.includes('mail.edit');
      if (!allows(destination, required) && !(!mutation(name) && ['Identity','EmailSubmission'].includes(name.split('/')[0]) && allows(destination, 'mail.read')) && !(name === 'Email/set' && allows(destination, 'mail.organize'))) fail('forbidden', 'Account permission does not allow this method');
      if (name === 'EmailSubmission/recover' && !['mail.read','mail.draft'].every(action => destination.actor.actions.includes(action))) fail('forbidden', 'Recovery requires current reading and draft authority');
      let source: MailContext | undefined;
      if (name === 'Email/copy') {
        source = await authorize(args.fromAccountId, ['mail.read', ...(args.onSuccessDestroyOriginal ? ['mail.organize'] : [])]);
        if (!allows(source, 'mail.read') || args.onSuccessDestroyOriginal && !allows(source, 'mail.organize')) fail('forbidden', 'Source account permission does not allow this copy');
        if (source.accountId !== destination.accountId && !options.transferEmail) fail('cannotDo', 'Cross-account email copy is unavailable');
      }
      if (object(args.create)) for (const key of Object.keys(args.create)) if (Object.hasOwn(createdIds, key)) fail('invalidArguments', 'Creation ID is already in use');
      if (source && source.accountId !== destination.accountId) {
        const sourceId = source.accountId;
        // The copied email ID belongs to the source; mailbox IDs and other copy
        // properties belong to the destination and may reference its prior creates.
        const create = object(args.create) ? Object.fromEntries(Object.entries(args.create).map(([key, item]) => [key, object(item) ? { ...resolve({ ...item, id: undefined }, destination.accountId), id: resolve(item.id, sourceId) } : item])) : args.create;
        args = { ...resolve({ ...args, create: undefined }, destination.accountId), create };
      }
      else args = resolve(args, destination.accountId);
      // A retried product command keeps its own receipt identity even when the
      // transport envelope is new. Derive IDs only for standard JMAP callers
      // that supplied a request ID without an explicit command ID.
      if (mutation(name) && args.operationId !== undefined && (typeof args.operationId !== 'string' || !uuid.test(args.operationId))) fail('invalidArguments', 'Invalid operation ID');
      if (request.requestId && mutation(name) && args.operationId === undefined) args.operationId = await operationId(request.requestId, name, callId, index);
      const scopedCreatedIds = Object.fromEntries(Object.entries(createdIds).filter(([key]) => !owners.has(key) || owners.get(key) === destination.accountId));
      const single: JmapRequest = { using: request.using, methodCalls: [[name, args, callId]], createdIds: scopedCreatedIds, ...(request.requestId ? { requestId: request.requestId } : {}) };
      const response = source && source.accountId !== destination.accountId ? await options.transferEmail!({ source, destination, args, request: single }) : await options.callAccount(destination, single);
      if (!Array.isArray(response.methodResponses)) fail('serverFail', 'Invalid account response');
      responses.push(...response.methodResponses);
      for (const [key, id] of Object.entries(response.createdIds ?? {})) {
        if (scopedCreatedIds[key] === id) continue;
        createdIds[key] = id; owners.set(key, destination.accountId);
      }
      for (const [, result] of response.methodResponses) for (const [key, entry] of Object.entries(result.created ?? {}) as Array<[string, any]>) if (typeof entry?.id === 'string') { createdIds[key] = entry.id; owners.set(key, destination.accountId); }
    } catch (error) {
      responses.push(['error', { type: error instanceof MethodError ? error.type : 'serverFail', description: error instanceof MethodError ? error.message : 'Unable to execute account method' }, callId]);
    }
  }
  return { methodResponses: responses, createdIds, sessionState: await options.sessionState() };
}
