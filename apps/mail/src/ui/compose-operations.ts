/** An uncertain mutation must replay its exact request, including its revision fence. */
export interface PendingComposeOperation {
  operationId: string;
  args: Record<string, unknown>;
  fingerprint: string;
}
export function createComposeOperation(args: Record<string, unknown>, fingerprint: string, state: string | undefined, operationId = crypto.randomUUID()): PendingComposeOperation {
  return { operationId, fingerprint, args: { ...structuredClone(args), operationId, ifInState: state ?? null } };
}
/** Transport failures do not prove that a mutation failed to commit. */
export function isConfirmedRejection(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'confirmed' in error && error.confirmed === true;
}
/** A replay's earlier attempt may have committed even if this attempt never dispatched. */
export function isConfirmedSubmissionRejection(error: unknown, firstAttempt: boolean): boolean {
  return isConfirmedRejection(error) || firstAttempt && !!error && typeof error === 'object' && 'submissionNotDispatched' in error && error.submissionNotDispatched === true;
}
export function isConfirmedDraftConflict(error: unknown): boolean {
  return isConfirmedRejection(error) && ((error as { errorType?: unknown }).errorType === 'stateMismatch' || error instanceof Error && error.message === 'stateMismatch');
}

interface DraftOperationClient {
  call<T>(name: string, args: Record<string, unknown>, accountId: string): Promise<T>;
}
export interface DraftBaseline {
  id: string;
  blobId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
}
/** Older clients marked unrelated account revision races as draft conflicts. */
export function recoverNewDraftConflict<T extends {
  conflicted?: boolean;
  emailId?: string;
  sourceEmailId?: string;
  sourceBlobId?: string;
  draftBaseline?: DraftBaseline;
  pendingDraft?: PendingComposeOperation;
  pendingSubmission?: PendingComposeOperation;
  pendingDiscard?: PendingComposeOperation;
}>(recovery: T, serverDraftId?: string): T {
  if (!recovery.conflicted || serverDraftId || recovery.emailId || recovery.sourceEmailId || recovery.sourceBlobId || recovery.draftBaseline || recovery.pendingDraft || recovery.pendingSubmission || recovery.pendingDiscard) return recovery;
  // No server message or uncertain command exists to overwrite or replay. Keep
  // the local content and backups intact; the next save is an independent create.
  return { ...recovery, conflicted: false };
}
const sameFlags = (left: Record<string, boolean>, right: Record<string, boolean>) =>
  JSON.stringify(Object.entries(left).sort(([a], [b]) => a.localeCompare(b))) === JSON.stringify(Object.entries(right).sort(([a], [b]) => a.localeCompare(b)));

/** Discard must never remove another editor's newer content or forget an uncertain delete. */
export async function discardComposeDraft(
  client: DraftOperationClient,
  accountId: string,
  baseline: DraftBaseline | undefined,
  persist: (operation: PendingComposeOperation) => void,
  pending?: PendingComposeOperation,
): Promise<void> {
  let operation = pending;
  if (!operation) {
    if (!baseline) throw Object.assign(new Error('Reload this draft before discarding it. Your local edits are preserved.'), { confirmed: true, errorType: 'stateMismatch' });
    const observed = await client.call<{ state: string; list: DraftBaseline[] }>('Email/get', { ids: [baseline.id] }, accountId);
    const current = observed.list?.find(email => email.id === baseline.id);
    if (!current || !current.keywords?.$draft || current.blobId !== baseline.blobId || !sameFlags(current.mailboxIds || {}, baseline.mailboxIds) || !sameFlags(current.keywords || {}, baseline.keywords)) throw Object.assign(new Error('This draft changed in another window. Your edits are preserved.'), { confirmed: true, errorType: 'stateMismatch' });
    if (typeof observed.state !== 'string' || !observed.state) throw new Error('The mail server did not provide a revision for discarding this draft.');
    operation = createComposeOperation({ destroy: [baseline.id] }, 'discard:' + baseline.id, observed.state);
  }
  persist(operation);
  const result = await client.call<{ destroyed?: string[] }>('Email/set', operation.args, accountId);
  const ids = operation.args.destroy;
  if (!Array.isArray(ids) || ids.length !== 1 || !result.destroyed?.includes(ids[0])) throw new Error('Discarding is unconfirmed. Check the same request again before editing this draft.');
}
/**
 * New drafts do not overwrite an existing message. Read a current account fence
 * before creating one, since even a contact change advances the account revision.
 * Existing drafts may refresh their fence only after verifying the saved blob
 * and metadata still match the editor's baseline. This avoids confusing an
 * unrelated incoming message with another editor changing the draft.
 * Only a confirmed rejection permits a new request; an uncertain request must
 * retain its operation ID and original fence for receipt recovery.
 */
export async function saveComposeDraft<T>(
  client: DraftOperationClient,
  accountId: string,
  operation: PendingComposeOperation,
  persist: (operation: PendingComposeOperation) => void,
  replay = false,
  baseline?: DraftBaseline,
): Promise<{ operation: PendingComposeOperation; result: T }> {
  const independentCreate = !!operation.args.create && !operation.args.update && !operation.args.destroy;
  const destroys = operation.args.destroy;
  const checkedReplacement = !!baseline && !!operation.args.create && !operation.args.update && Array.isArray(destroys) && destroys.length === 1 && destroys[0] === baseline.id;
  const refresh = async () => {
    const observed = await client.call<{ state: string; list?: DraftBaseline[] }>('Email/get', { ids: checkedReplacement ? [baseline!.id] : [] }, accountId);
    if (typeof observed.state !== 'string' || !observed.state) throw new Error('The mail server did not provide a revision for saving this draft.');
    if (checkedReplacement) {
      const current = observed.list?.find(email => email.id === baseline!.id);
      if (!current || !current.keywords?.$draft || current.blobId !== baseline!.blobId || !sameFlags(current.mailboxIds || {}, baseline!.mailboxIds) || !sameFlags(current.keywords || {}, baseline!.keywords)) {
        throw Object.assign(new Error('This draft changed in another window. Your edits are preserved.'), { confirmed: true, errorType: 'stateMismatch' });
      }
    }
    const { operationId: _id, ifInState: _state, ...args } = operation.args;
    operation = createComposeOperation(args, operation.fingerprint, observed.state);
  };
  if ((independentCreate || checkedReplacement) && !replay) await refresh();
  persist(operation);
  try {
    return { operation, result: await client.call<T>('Email/set', operation.args, accountId) };
  } catch (error) {
    if (!(independentCreate || checkedReplacement) || !isConfirmedDraftConflict(error)) throw error;
    // A concurrent incoming message can advance the fence between the read and
    // mutation. Recheck the baseline before one bounded, confirmed-only retry.
    await refresh();
    persist(operation);
    return { operation, result: await client.call<T>('Email/set', operation.args, accountId) };
  }
}

interface SendingIdentity { id: string; email: string; }
interface ReplyRecipients { to: { email: string }[]|null; cc?: { email: string }[]|null; headers?: { name: string; value: string }[]; }
/** Only select an identity present in the account's authorized identity list. */
export function chooseSendingIdentity<T extends SendingIdentity>(identities: T[], draft?: { from: { email: string }[]|null }, reply?: ReplyRecipients): T | undefined {
  const unique = (addresses: string[]) => identities.filter(identity => addresses.includes(identity.email.toLowerCase()));
  if (draft) {
    const matches = unique((draft.from||[]).map(address => address.email.toLowerCase()));
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (reply) {
    const delivered = (reply.headers || []).filter(header => ['delivered-to', 'x-original-to'].includes(header.name.toLowerCase())).flatMap(header => header.value.match(/[^\s<>;,]+@[^\s<>;,]+/g) || []).map(value => value.toLowerCase());
    const envelopeMatches = unique(delivered);
    if (envelopeMatches.length) return envelopeMatches.length === 1 ? envelopeMatches[0] : undefined;
    const recipientMatches = unique([...(reply.to||[]), ...(reply.cc || [])].map(address => address.email.toLowerCase()));
    return recipientMatches.length === 1 ? recipientMatches[0] : undefined;
  }
  return identities.length === 1 ? identities[0] : undefined;
}
/** Revisions replace immutable Email objects, fenced and committed as one command. */
export function draftReplacementArgs(content: Record<string, unknown>, previousEmailId?: string): Record<string, unknown> {
  return { create: { compose: structuredClone(content) }, ...(previousEmailId ? { destroy: [previousEmailId] } : {}) };
}
