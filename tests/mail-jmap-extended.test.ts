import { describe, expect, it } from 'vitest';
import { extendedMethod } from '../apps/mail/src/server/jmap-extended';
import { initialMailState, token } from '../apps/mail/src/domain/model';

const context = { accountId: 'a', organizationId: 'o', workspaceId: 'w', actor: { id: 'u', actions: ['mail.read', 'mail.edit'] } };
function fixture() { return { context, state: initialMailState(context), readBlob: async (_id: string): Promise<Uint8Array | null> => null }; }
describe('JMAP extended method boundaries', () => {
  it('uses authorized streaming and metadata callbacks without reading raw blob content', async () => {
    const readBlob = async (): Promise<Uint8Array | null> => { throw new Error('Raw blob must not be buffered'); };
    const parsed = await extendedMethod({ ...fixture(), readBlob, name: 'Email/parse', args: { accountId: 'a', blobIds: ['large', 'missing', 'bad'], properties: ['subject', 'size'] }, parseStoredBlob: async id => id === 'missing' ? null : id === 'bad' ? { size: -1 } : { size: 64 * 1024 * 1024, subject: 'Streamed MIME' } });
    expect(parsed.parsed.large).toEqual({ subject: 'Streamed MIME', size: 64 * 1024 * 1024 }); expect(parsed.notFound).toEqual(['missing']); expect(parsed.notParsable).toEqual(['bad']);
    const copied = await extendedMethod({ ...fixture(), readBlob, name: 'Blob/copy', args: { accountId: 'a', fromAccountId: 'a', blobIds: ['large', 'missing'] }, blobExists: async id => id === 'large' });
    expect(copied.copied).toEqual({ large: 'large' }); expect(copied.notCopied).toEqual({ missing: { type: 'blobNotFound' } });
  });
  it('parses raw MIME and separates missing and malformed blobs', async () => {
    const result = await extendedMethod({ ...fixture(), name: 'Email/parse', args: { accountId: 'a', blobIds: ['raw', 'missing'], fetchAllBodyValues: true }, readBlob: async id => id === 'raw' ? new TextEncoder().encode('Subject: Hello\r\nContent-Type: text/plain\r\n\r\nWorld') : null });
    expect(result.notFound).toEqual(['missing']); expect(result.parsed.raw.subject).toBe('Hello'); expect(result.parsed.raw).not.toHaveProperty('id'); expect(result.parsed.raw.bodyValues['1'].value).toBe('World');
  });
  it('escapes active markup while highlighting matched snippets', async () => {
    const input = fixture(); input.state.objects.Email.e = { id: 'e', subject: '<script>Hello</script>', bodyValues: { p: { value: '<img src=x>hello & world' } } };
    const result = await extendedMethod({ ...input, name: 'SearchSnippet/get', args: { accountId: 'a', emailIds: ['e', 'missing'], filter: { text: 'hello' } } });
    expect(result.list[0].subject).toBe('&lt;script&gt;<mark>Hello</mark>&lt;/script&gt;'); expect(result.list[0].preview).not.toContain('<img'); expect(result.list[0].preview).toContain('&amp;'); expect(result.notFound).toEqual(['missing']);
  });
  it('requires both copy scopes and rejects cross-account authority guesses', async () => {
    const input = fixture();
    expect(await extendedMethod({ ...input, name: 'Blob/copy', args: { accountId: 'a', fromAccountId: 'other', blobIds: ['b'] } })).toEqual({ type: 'accountNotFound' });
    expect(await extendedMethod({ ...input, context: { ...context, actor: { id: 'u', actions: ['mail.read'] } }, name: 'Blob/copy', args: { accountId: 'a', fromAccountId: 'a', blobIds: ['b'] } })).toEqual({ type: 'forbidden' });
  });
  it('uses retained thread birth/death evidence and forces safe resync for missing tombstones', async () => {
    const input = fixture(); input.state.sequence = 2; input.state.objects.Email.e = { id: 'e', threadId: 't' };
    input.state.changes = [{ sequence: 1, type: 'Email', id: 'e', destroyed: false, threadId: 't', threadCreated: true } as any];
    const result = await extendedMethod({ ...input, name: 'Thread/changes', args: { accountId: 'a', sinceState: token(0) } }); expect(result.created).toEqual(['t']); expect(result.updated).toEqual([]);
    input.state.changes.push({ sequence: 2, type: 'Email', id: 'deleted', destroyed: true });
    expect(await extendedMethod({ ...input, name: 'Thread/changes', args: { accountId: 'a', sinceState: token(1) } })).toEqual({ type: 'cannotCalculateChanges' });
  });
});
