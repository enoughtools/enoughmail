import { describe, expect, it, vi } from 'vitest';
import { migrationProgressChanged, stepRemoteMigration, type RemoteMigrationJob } from '../apps/mail/src/ui/migration-remote';
const job: RemoteMigrationJob = { id: 'job', actorId: 'actor', sourceUrl: 'https://source.test/jmap', state: 'running', phase: 'emails', cursor: 25, imported: 24, duplicates: 1, total: 100, createdAt: 1, updatedAt: 2 };
describe('remote JMAP migration orchestration', () => {
  it('retains the exact operation after uncertain response and refreshes authoritative server progress', async () => {
    const pending = new Map<string, string>(); const requests: [string, Record<string, unknown>, string | undefined][] = []; let fail = true;
    const call = vi.fn(async (method: string, args: Record<string, unknown>, accountId?: string) => { requests.push([method, args, accountId]); if (method === 'Migration/step') { if (fail) { fail = false; throw new Error('Connection interrupted'); } return { job: { ...job, cursor: 0 } }; } return { list: [job] }; });
    const client = { call } as unknown as Parameters<typeof stepRemoteMigration>[0];
    await expect(stepRemoteMigration(client, 'account', job.id, pending)).rejects.toThrow(/interrupted/);
    const operationId = pending.get(job.id); expect(operationId).toBeTruthy();
    expect(await stepRemoteMigration(client, 'account', job.id, pending)).toEqual(job);
    expect(requests[1]).toEqual(['Migration/step', { jobId: job.id, operationId }, 'account']);
    expect(requests[2]).toEqual(['Migration/get', { ids: [job.id] }, 'account']); expect(pending.has(job.id)).toBe(false);
  });
  it('uses a fresh operation for a new bounded step and reports missing jobs', async () => {
    const pending = new Map<string, string>(); const ids: string[] = [];
    const call = vi.fn(async (method: string, args: Record<string, unknown>) => { if (method === 'Migration/step') { ids.push(String(args.operationId)); return { job }; } return { list: ids.length < 3 ? [job] : [] }; });
    const client = { call } as unknown as Parameters<typeof stepRemoteMigration>[0];
    await stepRemoteMigration(client, 'account', job.id, pending); await stepRemoteMigration(client, 'account', job.id, pending);
    expect(ids[0]).not.toBe(ids[1]); await expect(stepRemoteMigration(client, 'account', job.id, pending)).rejects.toThrow(/no longer available/);
  });
  it('stops unproductive loops while recognizing successful phase, cursor and state changes', () => {
    expect(migrationProgressChanged(job, { ...job, updatedAt: 10 })).toBe(false);
    expect(migrationProgressChanged(job, { ...job, cursor: 50 })).toBe(true);
    expect(migrationProgressChanged(job, { ...job, state: 'failed' })).toBe(true);
    expect(migrationProgressChanged({ ...job, phase: 'discover' }, job)).toBe(true);
  });
});
