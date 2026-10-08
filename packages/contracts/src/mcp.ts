import { RESOURCE_OPERATION_LIMITS } from './resource-operations';

/** Bounded, deploy-time schemas. These never execute plugin-supplied code. */
export const MCP_MAX_REQUEST_BYTES = 64 * 1024;
export const MCP_MAX_GRANT_ACTIONS = 64;
export const MCP_MAX_DELEGATION_BYTES = 32 * 1024;
export const MCP_MAX_POLICY_ENVELOPE_BYTES = 2 * MCP_MAX_REQUEST_BYTES + MCP_MAX_DELEGATION_BYTES + 16 * 1024;
export const MCP_MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const MCP_CORE_TOOL_NAMES = ['core_list_files', 'core_get_file'] as const;

/** Tool names share one central namespace, even when app prefixes overlap. */
export function hasUniqueMcpToolNames(apps: readonly { mcp?: { tools: readonly { name: string }[] } }[]): boolean {
  const names = new Set<string>(MCP_CORE_TOOL_NAMES);
  for (const app of apps) for (const tool of app.mcp?.tools ?? []) {
    if (names.has(tool.name)) return false;
    names.add(tool.name);
  }
  return true;
}
export interface McpSchema {
  type: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, McpSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: McpSchema;
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
}

/** Declared actions across file and independently authorized native resource descriptors. */
export function appMcpActions(app: { permissions?: readonly { id: string }[]; nativeResources?: readonly { actions: readonly string[] }[] }): string[] {
  return [...new Set([...(app.permissions?.map(action => action.id) ?? []), ...(app.nativeResources?.flatMap(resource => [...resource.actions]) ?? [])])];
}

export interface AppMcpRelatedResource {
  argument: string;
  actions: ['file.read'];
}

export interface AppMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: McpSchema;
  outputSchema?: McpSchema;
  /** All required actions are intersected with the user's grant and current policy. */
  actions: string[];
  resourceArgument: 'fileId' | 'resourceId';
  /** Installed product native resource type; present only for resourceId targeting. */
  resourceType?: string;
  relatedResources?: AppMcpRelatedResource[];
  handlerPath: '/internal/mcp';
  execution: 'request';
  /** Absent means read for existing v1 manifests. Authorization always uses actions. */
  effect?: 'read' | 'write';
  annotations: { readOnlyHint: boolean; destructiveHint: false; idempotentHint: true; openWorldHint: false };
}

/** Safe, bounded product command failures preserved by the central gateway. */
export interface McpToolError {
  error: string;
  message?: string;
  retryable?: boolean;
  currentSequence?: number;
}

export function isMcpToolError(value: unknown): value is McpToolError {
  return record(value) && Object.keys(value).every(key => ['error', 'message', 'retryable', 'currentSequence'].includes(key))
    && typeof value.error === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value.error)
    && (value.message === undefined || (typeof value.message === 'string' && value.message.length <= 512))
    && (value.retryable === undefined || typeof value.retryable === 'boolean')
    && (value.currentSequence === undefined || (Number.isSafeInteger(value.currentSequence) && Number(value.currentSequence) >= 0));
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function isMcpSchema(value: unknown, depth = 0): value is McpSchema {
  if (depth > 6 || !record(value) || !['object', 'string', 'integer', 'number', 'boolean', 'array'].includes(String(value.type))) return false;
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16_384
    || Object.keys(value).some((key) => !['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'maxItems'].includes(key))) return false;
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 1024)) return false;
  if (value.type === 'object') {
    if (!record(value.properties) || Object.keys(value.properties).length > 32 || value.additionalProperties !== false) return false;
    if (!Object.entries(value.properties).every(([key, schema]) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && isMcpSchema(schema, depth + 1))) return false;
    if (value.required !== undefined && (!Array.isArray(value.required) || new Set(value.required).size !== value.required.length
      || !value.required.every((key) => typeof key === 'string' && Object.hasOwn(value.properties as object, key)))) return false;
  } else if (value.type === 'array') {
    if (!isMcpSchema(value.items, depth + 1) || !Number.isSafeInteger(value.maxItems) || Number(value.maxItems) < 1 || Number(value.maxItems) > 500) return false;
  } else if (value.type === 'string') {
    if (!Number.isSafeInteger(value.maxLength) || Number(value.maxLength) < 1 || Number(value.maxLength) > 40_960) return false;
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return false;
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 100
    || !value.enum.every((entry) => ['string', 'number', 'boolean'].includes(typeof entry)))) return false;
  return true;
}

export function isAppMcpTool(value: unknown, appId: string, productActions: readonly string[] = []): value is AppMcpTool {
  return record(value) && Object.keys(value).every((key) => ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'actions', 'resourceArgument', 'resourceType', 'relatedResources', 'handlerPath', 'execution', 'effect', 'annotations'].includes(key))
    && typeof value.name === 'string' && value.name.startsWith(`${appId.replaceAll('-', '_')}_`)
    && !(MCP_CORE_TOOL_NAMES as readonly string[]).includes(value.name)
    && /^[a-z][a-z0-9_]{2,79}$/.test(value.name) && typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 120
    && typeof value.description === 'string' && value.description.length > 0 && value.description.length <= 2048
    && isMcpSchema(value.inputSchema) && value.inputSchema.type === 'object'
    && value.inputSchema.properties?.[String(value.resourceArgument)]?.type === 'string' && value.inputSchema.required?.includes(String(value.resourceArgument)) === true
    && (value.outputSchema === undefined || isMcpSchema(value.outputSchema))
    && Array.isArray(value.actions) && value.actions.length > 0 && value.actions.length <= 8
    && value.actions.every((action) => typeof action === 'string' && (['file.read', 'file.edit'].includes(action) || productActions.includes(action)))
    && new Set(value.actions).size === value.actions.length
    && ((value.resourceArgument === 'fileId' && value.resourceType === undefined && value.actions.includes('file.read'))
      || (value.resourceArgument === 'resourceId' && typeof value.resourceType === 'string'
        && value.resourceType.startsWith(`${appId}.`) && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(value.resourceType)
        && value.actions.every(action => productActions.includes(action)) && value.relatedResources === undefined))
    && (value.relatedResources === undefined || (
      Array.isArray(value.relatedResources) && value.relatedResources.length > 0 && value.relatedResources.length <= 4
      && value.relatedResources.every((item) => record(item) && Object.keys(item).every((key) => ['argument', 'actions'].includes(key))
        && typeof item.argument === 'string' && item.argument !== 'fileId'
        && Array.isArray(item.actions) && item.actions.length === 1 && item.actions[0] === 'file.read'
        && (value.inputSchema as McpSchema).required?.includes(item.argument) === true
        && (value.inputSchema as McpSchema).properties?.[item.argument]?.type === 'string'
        && (value.inputSchema as McpSchema).properties?.[item.argument]?.minLength === 36
        && (value.inputSchema as McpSchema).properties?.[item.argument]?.maxLength === 36)
      && new Set(value.relatedResources.map((item) => (item as { argument: string }).argument)).size === value.relatedResources.length
    ))
    && value.handlerPath === '/internal/mcp' && value.execution === 'request'
    && (value.effect === undefined || value.effect === 'read' || value.effect === 'write')
    && (value.effect === 'write'
      ? (value.resourceArgument === 'resourceId' || value.actions.includes('file.edit')) && value.inputSchema.properties?.operationId?.type === 'string'
        && value.inputSchema.required?.includes('operationId') === true
        && value.inputSchema.properties?.expectedSequence?.type === 'integer'
        && Number(value.inputSchema.properties.expectedSequence.minimum) >= 0
        && value.inputSchema.required?.includes('expectedSequence') === true
      : !value.actions.includes('file.edit'))
    && record(value.annotations) && Object.keys(value.annotations).every((key) => ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].includes(key))
    && value.annotations.readOnlyHint === (value.effect !== 'write') && value.annotations.destructiveHint === false
    && value.annotations.idempotentHint === true && value.annotations.openWorldHint === false;
}

/** V2 is descriptor grammar only; installing it does not enable gateway execution. */
export type AppMcpScopeV2 =
  | { kind: 'file'; argument: 'fileId' }
  | { kind: 'folder'; argument: 'folderId' }
  | { kind: 'workspace' };

export interface AppMcpRelatedResourceV2 {
  argument: string;
  cardinality: 'one' | 'many';
  requirement: 'required-add' | 'optional-read';
  actions: ['file.read'];
}

export interface AppMcpToolV2 {
  name: string;
  title: string;
  description: string;
  inputSchema: McpSchema;
  outputSchema?: McpSchema;
  scope: AppMcpScopeV2;
  actions: string[];
  effect: 'read' | 'write' | 'create' | 'delete';
  operationKind?: 'create-native' | 'upload' | 'delete';
  relatedResources?: AppMcpRelatedResourceV2[];
  derivedReads?: { mode: 'source-read'; maximum: 100 };
  handlerPath: '/internal/mcp';
  execution: 'request';
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: true; openWorldHint: false };
}

const v2AuthorityArguments = ['actor', 'actorId', 'audience', 'grant', 'grantId', 'scope', 'scopeId',
  'organizationId', 'workspaceId', 'parentId', 'principal', 'currentPrincipal', 'resourceType', 'resourceArgument'];
const v2TargetReservedArguments = [...v2AuthorityArguments, 'fileId', 'folderId', 'resourceId', 'operationId',
  'expectedSequence', 'expectedMetadataVersion', 'content', 'byteLength', 'contentSha256'];
const uuidSchemaV2 = (schema: McpSchema | undefined): boolean =>
  schema?.type === 'string' && schema.minLength === 36 && schema.maxLength === 36;

/** supplementaryActions must come from installed permissions, never native entity actions. */
export function isAppMcpToolV2(value: unknown, appId: string, supplementaryActions: readonly string[] = []): value is AppMcpToolV2 {
  if (!record(value) || Object.keys(value).some(key => !['name', 'title', 'description', 'inputSchema', 'outputSchema',
    'scope', 'actions', 'effect', 'operationKind', 'relatedResources', 'derivedReads', 'handlerPath', 'execution', 'annotations'].includes(key))
    || typeof value.name !== 'string' || !value.name.startsWith(`${appId.replaceAll('-', '_')}_`)
    || !/^[a-z][a-z0-9_]{2,79}$/.test(value.name) || (MCP_CORE_TOOL_NAMES as readonly string[]).includes(value.name)
    || typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 120
    || typeof value.description !== 'string' || value.description.length < 1 || value.description.length > 2048
    || !isMcpSchema(value.inputSchema) || value.inputSchema.type !== 'object'
    || (value.outputSchema !== undefined && !isMcpSchema(value.outputSchema))
    || !record(value.scope) || !['read', 'write', 'create', 'delete'].includes(String(value.effect))
    || value.handlerPath !== '/internal/mcp' || value.execution !== 'request') return false;
  const scope = value.scope;
  const input = value.inputSchema;
  const properties = input.properties!;
  const required = input.required ?? [];
  const has = (key: string) => Object.hasOwn(properties, key);
  const needs = (key: string) => has(key) && required.includes(key);
  if (v2AuthorityArguments.some(has)) return false;
  if (has('phase')) {
    const phase = properties.phase;
    if (!((value.effect === 'create' && value.operationKind === 'create-native') || (value.effect === 'delete' && value.operationKind === 'delete'))
      || required.includes('phase') || Object.keys(phase).some(key => !['type', 'enum', 'maxLength', 'minLength', 'description'].includes(key))
      || (Object.hasOwn(phase, 'minLength') && (!Number.isInteger(phase.minLength) || Number(phase.minLength) < 0 || Number(phase.minLength) > 6))
      || phase.type !== 'string' || phase.maxLength !== 7 || !Array.isArray(phase.enum) || phase.enum.length !== 3
      || new Set(phase.enum).size !== 3 || !phase.enum.every(entry => typeof entry === 'string' && ['prepare', 'execute', 'lookup'].includes(entry))) return false;
  }
  if (scope.kind === 'workspace') {
    if (Object.keys(scope).some(key => key !== 'kind') || ['fileId', 'folderId'].some(has)) return false;
  } else if (scope.kind === 'file' || scope.kind === 'folder') {
    const argument = scope.kind === 'file' ? 'fileId' : 'folderId';
    if (Object.keys(scope).some(key => !['kind', 'argument'].includes(key)) || scope.argument !== argument
      || !needs(argument) || !uuidSchemaV2(properties[argument]) || has(argument === 'fileId' ? 'folderId' : 'fileId')) return false;
  } else return false;
  let coreActions: string[];
  if (value.effect === 'read') {
    coreActions = ['file.read'];
    if (value.operationKind !== undefined || ['expectedSequence', 'expectedMetadataVersion', 'resourceId'].some(has)) return false;
    // Existing-file command receipts are source-only reads. Actual command ID syntax is product-owned.
    if (has('operationId') && (scope.kind !== 'file' || !needs('operationId') || properties.operationId.type !== 'string'
      || properties.operationId.minLength !== 1 || properties.operationId.maxLength !== 128)) return false;
  } else {
    if (!needs('operationId') || properties.operationId.type !== 'string'
      || properties.operationId.minLength !== 1 || properties.operationId.maxLength !== 128) return false;
    if (value.effect === 'write') {
      coreActions = ['file.read', 'file.edit'];
      if (scope.kind !== 'file' || value.operationKind !== undefined || has('resourceId') || has('expectedMetadataVersion')
        || !needs('expectedSequence') || properties.expectedSequence.type !== 'integer'
        || properties.expectedSequence.minimum !== 0 || properties.expectedSequence.maximum !== Number.MAX_SAFE_INTEGER) return false;
    } else if (value.effect === 'create') {
      coreActions = scope.kind === 'folder' ? ['file.read', 'file.create'] : ['file.create'];
      if (scope.kind === 'file' || !['create-native', 'upload'].includes(String(value.operationKind))
        || ['expectedSequence', 'expectedMetadataVersion', 'fileId'].some(has)
        || !needs('resourceId') || !uuidSchemaV2(properties.resourceId)) return false;
      if (value.operationKind === 'create-native') {
        if (!needs('content') || properties.content.type !== 'string' || properties.content.maxLength !== RESOURCE_OPERATION_LIMITS.nativeContentMaxBytes
          || has('byteLength') || has('contentSha256')) return false;
      } else if (has('content') || !needs('byteLength') || properties.byteLength.type !== 'integer'
        || properties.byteLength.minimum !== 0 || properties.byteLength.maximum !== RESOURCE_OPERATION_LIMITS.uploadMaxBytes
        || !needs('contentSha256') || properties.contentSha256.type !== 'string'
        || properties.contentSha256.minLength !== 64 || properties.contentSha256.maxLength !== 64) return false;
    } else {
      coreActions = ['file.read', 'file.delete'];
      if (scope.kind !== 'file' || value.operationKind !== 'delete' || value.relatedResources !== undefined || value.derivedReads !== undefined
        || ['expectedSequence', 'resourceId', 'content', 'byteLength', 'contentSha256'].some(has)
        || !needs('expectedMetadataVersion') || properties.expectedMetadataVersion.type !== 'integer'
        || properties.expectedMetadataVersion.minimum !== 1 || properties.expectedMetadataVersion.maximum !== Number.MAX_SAFE_INTEGER) return false;
    }
  }
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 8
    || new Set(value.actions).size !== value.actions.length || !coreActions.every(action => value.actions instanceof Array && value.actions.includes(action))
    || !value.actions.every(action => typeof action === 'string' && (coreActions.includes(action)
      || (action.startsWith(`${appId}.`) && action.length <= 96
        && /^(?!core\.|file\.|workspace\.)[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(action) && supplementaryActions.includes(action))))) return false;
  if (value.derivedReads !== undefined && (value.effect !== 'read' || !record(value.derivedReads)
    || Object.keys(value.derivedReads).some(key => !['mode', 'maximum'].includes(key))
    || value.derivedReads.mode !== 'source-read' || value.derivedReads.maximum !== 100)) return false;
  if (value.relatedResources !== undefined) {
    if (!Array.isArray(value.relatedResources) || value.relatedResources.length < 1 || value.relatedResources.length > 4) return false;
    let maximum = 0;
    const names = new Set<string>();
    for (const target of value.relatedResources) {
      if (!record(target) || Object.keys(target).some(key => !['argument', 'cardinality', 'requirement', 'actions'].includes(key))
        || typeof target.argument !== 'string' || v2TargetReservedArguments.includes(target.argument)
        || names.has(target.argument) || !needs(target.argument)
        || !Array.isArray(target.actions) || target.actions.length !== 1 || target.actions[0] !== 'file.read') return false;
      names.add(target.argument);
      const schema = properties[target.argument];
      if (target.cardinality === 'one') {
        if (!uuidSchemaV2(schema)) return false;
        maximum++;
      } else if (target.cardinality === 'many') {
        if (schema.type !== 'array' || !uuidSchemaV2(schema.items)) return false;
        maximum += schema.maxItems!;
      } else return false;
      if (target.requirement === 'required-add') {
        if (!['write', 'create'].includes(String(value.effect)) || value.derivedReads !== undefined) return false;
      } else if (target.requirement !== 'optional-read' || !['read', 'write'].includes(String(value.effect))) return false;
    }
    // Actual explicit + derived candidate union is capped by the later target resolver.
    if (maximum > 100) return false;
  }
  return record(value.annotations) && Object.keys(value.annotations).every(key => ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].includes(key))
    && value.annotations.readOnlyHint === (value.effect === 'read') && value.annotations.destructiveHint === (value.effect === 'delete')
    && value.annotations.idempotentHint === true && value.annotations.openWorldHint === false;
}
