import { token, parseToken, stateError, type MailState, type MailContext } from '../domain/model';
import { parseMime } from '../domain/mime';
import { projectEmail, validateEmailProjectionArgs } from '../domain/jmap-email';

export interface ExtendedMethodContext {
  name: string;
  args: Record<string, any>;
  state: MailState;
  context: MailContext;
  readBlob(blobId: string): Promise<Uint8Array | null>;
  /** Must persist decoded leaf parts and replace parser-local blob IDs when supplied. */
  parseBlob?(blobId: string, bytes: Uint8Array): Promise<Record<string, any>>;
  /** Account-authorized streaming parser; null means unavailable, size is authoritative. */
  parseStoredBlob?(blobId: string): Promise<Record<string, any> | null>;
  /** Account-authorized metadata lookup, avoiding loading blob content for same-account copies. */
  blobExists?(blobId: string): Promise<boolean>;
  /** Authoritative lookup is required when the account hydrates only a partial Email page. */
  liveThreadIds?(threadIds: string[]): Promise<string[]>;
}

/** Pure dispatch seam; account owner commits returned changes and receipts. */
export async function extendedMethod(input: ExtendedMethodContext): Promise<any | undefined> {
  const { name, args, state, context, readBlob } = input;
  const accountId = state.context.accountId;
  if (args.accountId !== accountId) return stateError('accountNotFound');
  if (name === 'Email/parse') {
    if (!Array.isArray(args.blobIds) || args.blobIds.some((id: unknown) => typeof id !== 'string')) return stateError('invalidArguments');
    try { validateEmailProjectionArgs(args); } catch (error) { return stateError('invalidArguments', String(error)); }
    const parsed: Record<string, any> = {}, notFound: string[] = [], notParsable: string[] = [];
    for (const blobId of args.blobIds) {
      try {
        let email: Record<string, any> | null;
        let size: number;
        if (input.parseStoredBlob) {
          email = await input.parseStoredBlob(blobId);
          if (!email) { notFound.push(blobId); continue; }
          size = email.size;
          if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid parsed blob size');
        } else {
          const bytes = await readBlob(blobId);
          if (!bytes) { notFound.push(blobId); continue; }
          email = input.parseBlob ? await input.parseBlob(blobId, bytes) : parseMime(bytes, blobId);
          size = bytes.length;
        }
        const value: Record<string, any> = { ...email, id: null, blobId, threadId: null, mailboxIds: null, keywords: null, receivedAt: null, size, hasAttachment: (email.attachments?.length ?? 0) > 0 };
        // Binary buffers are internal parsing artifacts, never JSON protocol properties.
        value.attachments = (value.attachments ?? []).map(({ bytes: _bytes, ...part }: Record<string, any>) => part);
        const defaults = ['messageId', 'inReplyTo', 'references', 'sender', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'sentAt', 'hasAttachment', 'preview', 'bodyValues', 'textBody', 'htmlBody', 'attachments'];
        parsed[blobId] = projectEmail(value, { ...args, properties: args.properties ?? defaults }, undefined, false);
      } catch { notParsable.push(blobId); }
    }
    return { accountId, parsed, notParsable, notFound };
  }
  if (name === 'SearchSnippet/get') {
    if (!Array.isArray(args.emailIds) || args.emailIds.some((id: unknown) => typeof id !== 'string')) return stateError('invalidArguments');
    const terms: string[] = [];
    const gather = (filter: any): void => {
      if (!filter || typeof filter !== 'object') return;
      for (const field of ['text', 'subject', 'body']) if (typeof filter[field] === 'string') terms.push(filter[field]);
      if (filter.operator !== 'NOT' && Array.isArray(filter.conditions)) filter.conditions.forEach(gather);
    };
    gather(args.filter);
    const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
    const highlight = (value: string): string | null => {
      const matches = terms.filter(term => term && value.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
      if (!matches.length) return null;
      const pattern = matches.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const regexp = new RegExp(pattern, 'giu'); let last = 0, result = '';
      for (const match of value.matchAll(regexp)) { const start = match.index!; result += escape(value.slice(last, start)) + '<mark>' + escape(match[0]) + '</mark>'; last = start + match[0].length; }
      return result + escape(value.slice(last));
    };
    const list: any[] = [], notFound: string[] = [];
    for (const emailId of args.emailIds) {
      const email = state.objects.Email[emailId];
      if (!email) { notFound.push(emailId); continue; }
      const body = Object.values(email.bodyValues ?? {}).map((value: any) => String(value.value ?? '')).join(' ').replace(/<[^>]*>/g, ' ');
      const first = terms.map(term => body.toLocaleLowerCase().indexOf(term.toLocaleLowerCase())).filter(index => index >= 0).sort((a, b) => a - b)[0];
      const start = Math.max(0, (first ?? 0) - 60);
      list.push({ emailId, subject: highlight(String(email.subject ?? '')), preview: highlight(body.slice(start, start + 256)) });
    }
    return { accountId, list, notFound };
  }
  if (name === 'Thread/changes') {
    const since = parseToken(args.sinceState);
    if (since === null || since > state.sequence || (state.changes.length && since < state.changes[0].sequence - 1)) return stateError('cannotCalculateChanges');
    const changes = state.changes.filter(change => change.type === 'Email' && change.sequence > since);
    if (args.maxChanges !== undefined && (!Number.isInteger(args.maxChanges) || args.maxChanges < 1)) return stateError('invalidArguments');
    // Destroyed Email events must carry threadId. Missing legacy metadata forces safe full sync.
    if (changes.some(change => !(change as any).threadId && !state.objects.Email[change.id]?.threadId)) return stateError('cannotCalculateChanges');
    const maximum = args.maxChanges ?? 1000;
    const selected = changes;
    const ids = [...new Set(selected.map(change => (change as any).threadId ?? state.objects.Email[change.id]?.threadId))];
    if (ids.length > maximum) return stateError('cannotCalculateChanges');
    const live = new Set(input.liveThreadIds ? await input.liveThreadIds(ids) : Object.values(state.objects.Email).map(email => email.threadId));
    const newlyCreated = new Set(changes.filter(change => (change as any).threadCreated === true).map(change => (change as any).threadId));
    const created = ids.filter(id => live.has(id) && newlyCreated.has(id));
    return { accountId, oldState: args.sinceState, newState: token(state.sequence), hasMoreChanges: false, created, updated: ids.filter(id => live.has(id) && !newlyCreated.has(id)), destroyed: ids.filter(id => !live.has(id) && !newlyCreated.has(id)) };
  }
  if (name === 'Blob/copy') {
    // Cross-account copies must be routed by the Worker after independent source/target authorization.
    if (args.fromAccountId !== accountId) return stateError('accountNotFound');
    if (!context.actor.actions.includes('mail.read') || !context.actor.actions.some(action => ['mail.draft', 'mail.edit'].includes(action))) return stateError('forbidden');
    if (!Array.isArray(args.blobIds) || args.blobIds.some((id: unknown) => typeof id !== 'string')) return stateError('invalidArguments');
    const copied: Record<string, string> = {}, notCopied: Record<string, any> = {};
    for (const blobId of args.blobIds) { if (input.blobExists ? await input.blobExists(blobId) : await readBlob(blobId)) copied[blobId] = blobId; else notCopied[blobId] = stateError('blobNotFound'); }
    return { fromAccountId: accountId, accountId, copied, notCopied };
  }
  return undefined;
}
