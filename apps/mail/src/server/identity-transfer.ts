import { clone, token, type MailContext, type MailObject, type MailState } from '../domain/model';
import type { DirectoryAccount, DirectoryStorage } from './directory';

export interface IdentityTransferCommand {
  operationId: string; sourceAccountId: string; destinationAccountId: string;
  identityId: string; expectedSourceState: string; expectedDestinationState: string;
}
export interface IdentityTransferRecord {
  command: IdentityTransferCommand; source: DirectoryAccount; destination: DirectoryAccount;
  actorId: string; address: string; identity: MailObject; zoneId: string;
  signatureSnapshot?: { text: string; html: string };
  status: 'preparing' | 'committed' | 'complete' | 'aborted'; expiresAt: number;
  acknowledged?: string[];
  repairAt?: number;
}
export class IdentityTransferError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
const json = (value: unknown, status = 200) => Response.json(value, { status });
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
export function validateIdentityTransfer(value: unknown): IdentityTransferCommand {
  const body = value as IdentityTransferCommand;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.operationId) ||
      !validId(body.sourceAccountId) || !validId(body.destinationAccountId) || body.sourceAccountId === body.destinationAccountId || !validId(body.identityId) ||
      !/^m[0-9a-z]+$/.test(body.expectedSourceState) || !/^m[0-9a-z]+$/.test(body.expectedDestinationState)) {
    throw new IdentityTransferError('invalid_transfer', 'Choose two different inboxes and refresh their current versions.', 400);
  }
  return { operationId: body.operationId, sourceAccountId: body.sourceAccountId, destinationAccountId: body.destinationAccountId, identityId: body.identityId, expectedSourceState: body.expectedSourceState, expectedDestinationState: body.expectedDestinationState };
}
const sameScope = (left: DirectoryAccount, right: DirectoryAccount) => left.organizationId === right.organizationId && left.workspaceId === right.workspaceId;
const recordKey = (account: DirectoryAccount, operationId: string) => `identity-transfer:${account.organizationId}:${account.workspaceId}:${operationId}`;
const ownerKey = (address: string) => `identity-transfer-owner:${address}`;
const reservationKey = (address: string) => `identity-transfer-reservation:${address}`;

/** A transfer decision and the exact incoming route change share one directory transaction. */
export async function directoryIdentityTransfer(storage: DirectoryStorage, account: DirectoryAccount, body: Record<string, any>): Promise<Response> {
  try {
    if (body.action === 'owner') {
      if (typeof body.address !== 'string') throw new IdentityTransferError('invalid_address', 'Invalid address.', 400);
      const owner = await storage.get<DirectoryAccount>(ownerKey(body.address.trim().toLowerCase()));
      return json({ owner: owner && sameScope(owner, account) ? owner.accountId : owner ? 'outside-workspace' : null });
    }
    const command = validateIdentityTransfer(body.command);
    return await storage.transaction(async transaction => {
      const key = recordKey(account, command.operationId);
      let record = await transaction.get<IdentityTransferRecord>(key);
      if (record && JSON.stringify(record.command) !== JSON.stringify(command)) throw new IdentityTransferError('operation_conflict', 'This move request was already used with different details.');
      if (record && ![record.source.accountId, record.destination.accountId].includes(account.accountId)) throw new IdentityTransferError('forbidden', 'This move does not belong to this inbox.', 403);
      if (record?.status === 'preparing' && record.expiresAt <= Date.now()) {
        record = { ...record, status: 'aborted' }; await transaction.put(key, record); if(await transaction.get<string>(reservationKey(record.address))===key)await transaction.delete(reservationKey(record.address));
      }
      if (body.action === 'read') return json({ record: record || null });
      if (body.action === 'begin') {
        if (record) return json({ record });
        const source = body.source as DirectoryAccount, destination = body.destination as DirectoryAccount;
        if (!source || !destination || !sameScope(source, account) || !sameScope(destination, account) || source.accountId !== command.sourceAccountId || destination.accountId !== command.destinationAccountId || account.accountId !== source.accountId || !validId(source.ownerActorId) || !validId(destination.ownerActorId) || !validId(body.actorId)) throw new IdentityTransferError('forbidden', 'Both inboxes must belong to this workspace.', 403);
        const identity = body.identity as MailObject;
        if (!identity || identity.id !== command.identityId || identity.verified !== true || identity.enabled === false || identity.transferredTo || typeof identity.email !== 'string' || !/^[^\s@<>]+@[^\s@<>]+$/.test(identity.email) || typeof body.zoneId !== 'string' || !/^[a-f0-9]{32}$/i.test(body.zoneId)) throw new IdentityTransferError('identity_not_ready', 'Only a verified sending address can be moved.');
        const address = identity.email.trim().toLowerCase();
        const route = await transaction.get<any>('address:' + address);
        if (!route || route.catchAll || !route.enabled || route.accountId !== source.accountId || !sameScope(route, source)) throw new IdentityTransferError('route_changed', 'This address no longer routes to the source inbox.');
        const reservation = await transaction.get<string>(reservationKey(address));
        if (reservation && reservation !== key) {
          const previous = await transaction.get<IdentityTransferRecord>(reservation);
          if (previous?.status === 'preparing' && previous.expiresAt <= Date.now()) { await transaction.put(reservation, { ...previous, status: 'aborted' }); await transaction.delete(reservationKey(address)); }
          else throw new IdentityTransferError('transfer_in_progress', 'Another move is already in progress for this address.');
        }
        const signatureSnapshot = body.signatureSnapshot;
        if (identity.signatureId && (!signatureSnapshot || typeof signatureSnapshot.text !== 'string' || typeof signatureSnapshot.html !== 'string' || signatureSnapshot.text.length > 100000 || signatureSnapshot.html.length > 200000)) throw new IdentityTransferError('signature_unavailable', 'The default signature could not be copied from the source inbox.');
        record = { command, source, destination, actorId: body.actorId, address, identity: clone(identity), zoneId: body.zoneId, ...(identity.signatureId ? { signatureSnapshot: clone(signatureSnapshot) } : {}), status: 'preparing', expiresAt: Date.now() + 5 * 60_000 };
        await transaction.put(key, record); await transaction.put(reservationKey(address), key);
      } else {
        if (!record) throw new IdentityTransferError('transfer_not_found', 'This move request is unavailable.', 404);
        if (body.action === 'abort') {
          if (record.status === 'committed' || record.status === 'complete') throw new IdentityTransferError('already_committed', 'This move has committed and must finish.');
          record = { ...record, status: 'aborted' }; if(await transaction.get<string>(reservationKey(record.address))===key)await transaction.delete(reservationKey(record.address));
        } else if (body.action === 'commit') {
          if (record.status === 'aborted') throw new IdentityTransferError('transfer_expired', 'This move expired before it changed delivery. Refresh both inboxes and try again.');
          if (record.status === 'preparing') {
            const route = await transaction.get<any>('address:' + record.address);
            if (!route || route.accountId !== record.source.accountId || !sameScope(route, record.source) || !route.enabled) throw new IdentityTransferError('route_changed', 'The delivery route changed before the move.');
            await transaction.put('address:' + record.address, { ...route, ...record.destination });
            await transaction.put(ownerKey(record.address), record.destination);
            record = { ...record, status: 'committed' };
          }
        } else if (body.action === 'acknowledge') {
          if (!['committed', 'complete'].includes(record.status)) throw new IdentityTransferError('not_committed', 'The move has not committed.');
          const acknowledged = [...new Set([...(record.acknowledged || []), account.accountId])];
          const complete = [record.source.accountId, record.destination.accountId].every(id => acknowledged.includes(id));
          record = { ...record, acknowledged, status: complete ? 'complete' : 'committed' };
          if (complete) if(await transaction.get<string>(reservationKey(record.address))===key)await transaction.delete(reservationKey(record.address));
        } else if (body.action === 'complete') {
          if (!['committed', 'complete'].includes(record.status)) throw new IdentityTransferError('not_committed', 'The move has not committed.');
          if (![record.source.accountId, record.destination.accountId].every(id => record!.acknowledged?.includes(id))) throw new IdentityTransferError('completion_pending', 'Both inboxes must acknowledge their saved move before completion.');
          record = { ...record, status: 'complete' }; if(await transaction.get<string>(reservationKey(record.address))===key)await transaction.delete(reservationKey(record.address));
        } else throw new IdentityTransferError('invalid_transfer_action', 'Invalid move operation.', 400);
      }
      await transaction.put(key, record);
      return json({ record });
    });
  } catch (error) {
    if (error instanceof IdentityTransferError) return json({ error: error.code, message: error.message }, error.status);
    throw error;
  }
}

export interface IdentityTransferParticipant {
  state: MailState;
  readLock(): IdentityTransferRecord | null;
  writeLock(record: IdentityTransferRecord | null): void;
  readReceipt(operationId: string): unknown;
  writeReceipt(operationId: string, receipt: unknown): void;
  directory(action: string, command: IdentityTransferCommand): Promise<IdentityTransferRecord | null>;
  authorizeZone(domain: MailObject, context: MailContext): Promise<boolean>;
  storeIdentity(identity: MailObject): void;
  save(): void;
}
function assertParticipant(context: MailContext, record: IdentityTransferRecord) {
  if (!context.actor.actions.includes('mail.manage') || context.organizationId !== record.source.organizationId || context.workspaceId !== record.source.workspaceId || ![record.source.accountId, record.destination.accountId].includes(context.accountId)) throw new IdentityTransferError('forbidden', 'Current management permission is required on both inboxes.', 403);
}
export async function transferParticipant(adapter: IdentityTransferParticipant, context: MailContext, body: Record<string, any>): Promise<unknown> {
  if (!context.actor.actions.includes('mail.manage')) throw new IdentityTransferError('forbidden', 'Inbox management permission is required.', 403);
  if (body.action === 'pending') {
    const lock = adapter.readLock();
    if (!lock) return { pending: null };
    const record = await adapter.directory('read', lock.command);
    if (!record || record.status === 'aborted' || record.status === 'complete') { adapter.writeLock(null); return { pending: null }; }
    return { pending: record.command, status: record.status };
  }
  if (body.action === 'inspect') {
    if (body.expectedState !== token(adapter.state.sequence)) throw new IdentityTransferError('state_mismatch', 'The source inbox changed. Refresh before moving the address.');
    const identity = adapter.state.objects.Identity[body.identityId];
    if (!identity || identity.transferredTo || identity.verified !== true || identity.enabled === false) throw new IdentityTransferError('identity_not_ready', 'Only a verified sending address can be moved.');
    const domain = Object.values(adapter.state.objects.Domain).find(value => value.sendingVerified && value.enabled !== false && value.name.toLowerCase() === identity.email.split('@')[1].toLowerCase());
    if (!domain || !await adapter.authorizeZone(domain, context)) throw new IdentityTransferError('domain_not_ready', 'The sending domain is not authorized for this inbox.');
    const signature = identity.signatureId ? (adapter.state.objects.Settings?.singleton?.signatures || []).find((value: any) => value.id === identity.signatureId) : null;
    if (identity.signatureId && !signature) throw new IdentityTransferError('signature_unavailable', 'The default signature is no longer available in the source inbox.');
    return { identity: clone(identity), zoneId: domain.zoneId, ...(signature ? { signatureSnapshot: { text: signature.text, html: signature.html } } : {}) };
  }
  const command = validateIdentityTransfer(body.command);
  const record = await adapter.directory('read', command);
  if (!record) throw new IdentityTransferError('transfer_not_found', 'This move request is unavailable.', 404);
  assertParticipant(context, record);
  const source = context.accountId === command.sourceAccountId;
  const existingLock = adapter.readLock();
  if (existingLock && existingLock.command.operationId !== command.operationId) throw new IdentityTransferError('transfer_in_progress', 'Finish the existing address move before starting another.');
  const receipt = adapter.readReceipt(command.operationId);
  if (body.action === 'prepare') {
    if (receipt) return receipt;
    if (existingLock) return { prepared: true };
    if (record.status !== 'preparing') throw new IdentityTransferError('transfer_not_preparing', 'This move can no longer be prepared.');
    if (token(adapter.state.sequence) !== (source ? command.expectedSourceState : command.expectedDestinationState)) throw new IdentityTransferError('state_mismatch', 'An inbox changed. Refresh both inboxes before moving the address.');
    const identities = Object.values(adapter.state.objects.Identity);
    if (source) {
      if (JSON.stringify(adapter.state.objects.Identity[command.identityId]) !== JSON.stringify(record.identity)) throw new IdentityTransferError('identity_changed', 'The sending address changed before the move.');
      if (record.identity.signatureId) {
        const signature = (adapter.state.objects.Settings?.singleton?.signatures || []).find((value: any) => value.id === record.identity.signatureId);
        if (!signature || !record.signatureSnapshot || signature.text !== record.signatureSnapshot.text || signature.html !== record.signatureSnapshot.html) throw new IdentityTransferError('signature_changed', 'The default signature changed before the move. Refresh and try again.');
      }
      if (Object.values(adapter.state.objects.EmailSubmission).some(value => value.identityId === command.identityId && ['pending','scheduled','sending','uncertain'].includes(value.status))) throw new IdentityTransferError('active_sends', 'Finish or cancel pending sends from this address before moving it.');
    } else {
      if (identities.some(value => (value.id === record.identity.id || value.email.toLowerCase() === record.address) && !(value.transferredTo === command.sourceAccountId && value.id === record.identity.id && value.email.toLowerCase() === record.address))) throw new IdentityTransferError('identity_collision', 'The destination already has this address or identity.');
    }
    const domain = Object.values(adapter.state.objects.Domain).find(value => value.sendingVerified && value.enabled !== false && value.zoneId === record.zoneId && value.name.toLowerCase() === record.address.split('@')[1]);
    if (!domain || !await adapter.authorizeZone(domain, context)) throw new IdentityTransferError('destination_domain_not_ready', 'Set up and verify the same domain in the destination inbox before moving this address.');
    adapter.writeLock(record);
    return { prepared: true };
  }
  if (body.action === 'finish') {
    if (receipt) { await adapter.directory('acknowledge', command); adapter.writeLock(null); return receipt; }
    if (!existingLock) throw new IdentityTransferError('not_prepared', 'The inbox has not prepared this move.');
    if (record.status === 'aborted') { adapter.writeLock(null); return { aborted: true }; }
    if (!['committed', 'complete'].includes(record.status)) throw new IdentityTransferError('not_committed', 'The move has not committed.');
    // Retain the source identity as a server-owned tombstone for historical references.
    const destinationIdentity: MailObject = { ...record.identity, id: command.identityId };
    if (record.signatureSnapshot) { delete destinationIdentity.signatureId; destinationIdentity.textSignature = record.signatureSnapshot.text; destinationIdentity.htmlSignature = record.signatureSnapshot.html; }
    adapter.storeIdentity(source ? { ...destinationIdentity, verified: false, enabled: false, transferredTo: command.destinationAccountId, transferOperationId: command.operationId } : destinationIdentity);
    const result = { moved: true, accountId: context.accountId, state: token(adapter.state.sequence), operationId: command.operationId };
    adapter.writeReceipt(command.operationId, result);
    adapter.save();
    await adapter.directory('acknowledge', command);
    adapter.writeLock(null);
    return result;
  }
  throw new IdentityTransferError('invalid_transfer_action', 'Invalid move operation.', 400);
}

interface TransferTransport {
  authorizeBoth(): Promise<void>;
  account(accountId: string, body: unknown): Promise<any>;
  directory(body: unknown): Promise<{ record: IdentityTransferRecord | null }>;
  source: DirectoryAccount; destination: DirectoryAccount; actorId: string;
}
/** Retry the same command after any uncertain transport outcome; never delete/create an address. */
export async function runIdentityTransfer(command: IdentityTransferCommand, transport: TransferTransport): Promise<unknown> {
  await transport.authorizeBoth();
  let record = (await transport.directory({ action: 'read', command })).record;
  if (!record) {
    const inspected = await transport.account(command.sourceAccountId, { action: 'inspect', identityId: command.identityId, expectedState: command.expectedSourceState });
    record = (await transport.directory({ action: 'begin', command, ...inspected, source: transport.source, destination: transport.destination, actorId: transport.actorId })).record;
  }
  if (!record) throw new IdentityTransferError('transfer_not_found', 'The move request could not be created.', 503);
  if (record.status === 'aborted') {
    for (const id of [command.sourceAccountId, command.destinationAccountId]) await transport.account(id, { action: 'finish', command }).catch(() => undefined);
    throw new IdentityTransferError('transfer_aborted', 'The move did not change delivery. Refresh both inboxes before trying again.');
  }
  if (record.status === 'complete') return { moved: true, operationId: command.operationId, sourceAccountId: command.sourceAccountId, destinationAccountId: command.destinationAccountId, replayed: true };
  if (record.status === 'preparing') {
    try {
      for (const id of [command.sourceAccountId, command.destinationAccountId].sort()) await transport.account(id, { action: 'prepare', command });
      await transport.authorizeBoth();
      record = (await transport.directory({ action: 'commit', command })).record!;
    } catch (error) {
      // Only a definite rejection permits abort. A lost response may have committed.
      if (error instanceof IdentityTransferError && error.status >= 400 && error.status < 500) {
        const latest = (await transport.directory({ action: 'read', command })).record;
        if (latest?.status === 'preparing') {
          await transport.directory({ action: 'abort', command });
          for (const id of [command.sourceAccountId, command.destinationAccountId]) await transport.account(id, { action: 'finish', command }).catch(() => undefined);
        }
      }
      throw error;
    }
  }
  try {
    for (const id of [command.destinationAccountId, command.sourceAccountId]) await transport.account(id, { action: 'finish', command });
    await transport.directory({ action: 'complete', command });
  } catch {
    throw new IdentityTransferError('transfer_completion_pending', 'Delivery has moved. Retry this same move to finish updating both inboxes; message history is preserved.', 503);
  }
  return { moved: true, operationId: command.operationId, sourceAccountId: command.sourceAccountId, destinationAccountId: command.destinationAccountId };
}
