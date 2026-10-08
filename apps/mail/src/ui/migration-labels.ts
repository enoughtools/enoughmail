import type { MigrationMailbox } from './migration-format';
/** Resolve ancestry before labels, without treating account-local IDs as portable identity. */
export function orderMigrationMailboxes(source: MigrationMailbox[]): MigrationMailbox[] {
  const byId = new Map<string, MigrationMailbox>();
  for (const box of source) { const previous = byId.get(box.id); if (previous && (previous.name !== box.name || previous.parentId !== box.parentId || previous.role !== box.role)) throw new Error('Archive mailbox definitions conflict.'); byId.set(box.id, box); }
  if (byId.size > 1000) throw new Error('This archive contains too many mailbox definitions.');
  const ordered: MigrationMailbox[] = []; const done = new Set<string>(); const visiting = new Set<string>();
  function visit(box: MigrationMailbox, depth: number): void {
    if (done.has(box.id)) return;
    if (depth > 20 || visiting.has(box.id)) throw new Error('The archive contains cyclic or overly deep mailbox nesting.');
    visiting.add(box.id);
    if (box.parentId) { const parent = byId.get(box.parentId); if (!parent) throw new Error(`Archive is missing the parent of ${box.name}.`); visit(parent, depth + 1); }
    visiting.delete(box.id); done.add(box.id); ordered.push(box);
  }
  for (const box of byId.values()) visit(box, 0); return ordered;
}
export function matchMigrationMailbox(box: MigrationMailbox, existing: MigrationMailbox[], mapping: Record<string, string>): string | undefined {
  if (box.role) return existing.find(value => value.role === box.role)?.id;
  const parentId = box.parentId ? mapping[box.parentId] : null;
  if (box.parentId && !parentId) throw new Error('Restore the parent mailbox before its child.');
  return existing.find(value => !value.role && value.name === box.name && (value.parentId || null) === parentId)?.id;
}
/** Export only selected labels and their ancestors, keeping per-message headers bounded. */
export function mailboxDefinitions(mailboxIds: Record<string, boolean>, all: MigrationMailbox[]): MigrationMailbox[] {
  const byId = new Map(all.map(box => [box.id, box])); const selected = new Map<string, MigrationMailbox>();
  function include(id: string, depth: number): void { if (depth > 20) throw new Error('Cannot export deeply nested labels.'); if (selected.has(id)) return; const box = byId.get(id); if (!box) throw new Error('Export snapshot is missing mailbox metadata.'); selected.set(id, { id: box.id, name: box.name, parentId: box.parentId || null, role: box.role || null, ...(box.color ? { color: box.color } : {}) }); if (box.parentId) include(box.parentId, depth + 1); }
  for (const [id, value] of Object.entries(mailboxIds)) if (value) include(id, 0); return orderMigrationMailboxes([...selected.values()]);
}
