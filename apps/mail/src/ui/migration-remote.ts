import type { MailClient } from './jmap';
export interface RemoteMigrationJob {
  id: string; actorId: string; sourceUrl: string; state: 'pending' | 'running' | 'failed' | 'completed' | 'cancelled';
  phase: 'discover' | 'mailboxes' | 'emails' | 'done'; cursor: number; imported: number; duplicates: number; total: number | null;
  createdAt: number; updatedAt: number; error?: string;
}
export function migrationProgressChanged(previous: RemoteMigrationJob, next: RemoteMigrationJob): boolean {
  return previous.phase !== next.phase || previous.cursor !== next.cursor || previous.imported !== next.imported || previous.duplicates !== next.duplicates || previous.state !== next.state;
}
/** An uncertain response retains the same operation ID; receipts are followed by an authoritative refresh. */
export async function stepRemoteMigration(client: Pick<MailClient, 'call'>, accountId: string, jobId: string, pending: Map<string, string>): Promise<RemoteMigrationJob> {
  const operationId = pending.get(jobId) || crypto.randomUUID(); pending.set(jobId, operationId);
  await client.call<{ job: RemoteMigrationJob }>('Migration/step', { jobId, operationId }, accountId);
  pending.delete(jobId);
  const refreshed = await client.call<{ list: RemoteMigrationJob[] }>('Migration/get', { ids: [jobId] }, accountId);
  const job = refreshed.list.find(value => value.id === jobId);
  if (!job) throw new Error('This source migration is no longer available. Reload the migration list.');
  return job;
}
