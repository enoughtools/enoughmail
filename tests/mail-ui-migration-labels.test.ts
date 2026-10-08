import { describe, expect, it } from 'vitest';
import { orderMigrationMailboxes, matchMigrationMailbox, mailboxDefinitions } from '../apps/mail/src/ui/migration-labels';
import { mboxMessage, parseImport } from '../apps/mail/src/ui/migration-format';
const source = [{ id: 'old-inbox', name: 'Old Inbox', role: 'inbox' }, { id: 'old-project', name: 'Projects', role: null }, { id: 'old-child', name: 'Client', parentId: 'old-project', role: null }];
describe('semantic mailbox migration', () => {
  it('exports selected labels and parents and restores semantic identity across account IDs', () => {
    const definitions = mailboxDefinitions({ 'old-inbox': true, 'old-child': true }, source);
    expect(definitions.map(box => box.id)).toEqual(['old-inbox', 'old-project', 'old-child']);
    const raw = new TextEncoder().encode('Subject: Labelled\r\n\r\nContent\r\n');
    const chunks = mboxMessage(raw, { receivedAt: '2026-01-01T00:00:00.123Z', mailboxIds: { 'old-inbox': true, 'old-child': true }, keywords: { '$flagged': true }, mailboxes: definitions });
    const combined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let at = 0; for (const chunk of chunks) { combined.set(chunk, at); at += chunk.length; }
    const [imported] = parseImport(combined, true);
    expect(imported.bytes).toEqual(raw); expect(imported.mailboxes).toEqual(definitions); expect(imported.mailboxIds).toEqual({ 'old-inbox': true, 'old-child': true }); expect(imported.receivedAt).toBe('2026-01-01T00:00:00.123Z');
    const destination = [{ id: 'new-inbox', name: 'Inbox', role: 'inbox' }, { id: 'new-project', name: 'Projects', role: null }, { id: 'new-child', name: 'Client', parentId: 'new-project', role: null }, { id: 'other-child', name: 'Client', role: null }];
    const mapping: Record<string, string> = {};
    for (const box of orderMigrationMailboxes(imported.mailboxes!)) mapping[box.id] = matchMigrationMailbox(box, destination, mapping)!;
    expect(mapping).toEqual({ 'old-inbox': 'new-inbox', 'old-project': 'new-project', 'old-child': 'new-child' });
  });
  it('rejects absent parents, cycles and conflicting definitions', () => {
    expect(() => orderMigrationMailboxes([{ id: 'a', name: 'A', parentId: 'b' }])).toThrow(/missing/);
    expect(() => orderMigrationMailboxes([{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }])).toThrow(/cyclic/);
    expect(() => orderMigrationMailboxes([{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }])).toThrow(/conflict/);
  });
});
