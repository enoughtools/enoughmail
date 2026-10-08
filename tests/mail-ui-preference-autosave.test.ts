import { describe, expect, it, vi } from 'vitest';
import { PreferenceAutosave } from '../apps/mail/src/ui/preference-autosave';
describe('preference autosave', () => {
  it('does not save loaded defaults and flushes changed preferences before leaving', async () => {
    const save = vi.fn(async (_args: Record<string, unknown>) => ({})), status = vi.fn();
    const auto = new PreferenceAutosave(save, () => 'm1', status, 10000);
    auto.reset({ density: 'compact' }); auto.update({ density: 'compact' }); await auto.flush(); expect(save).not.toHaveBeenCalled();
    auto.update({ density: 'comfortable' }); expect(await auto.flush()).toBe(true);
    expect(save.mock.calls[0][0]).toMatchObject({ settings: { density: 'comfortable' }, ifInState: 'm1' }); auto.dispose();
  });
  it('queues later edits and reads the revision again only for the next confirmed command', async () => {
    let finish!: () => void, revision = 'm1';
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = () => { revision = 'm2'; resolve(); }; })).mockResolvedValue({});
    const auto = new PreferenceAutosave(save, () => revision, () => {}, 10000); auto.reset({ pageSize: 25 }); auto.update({ pageSize: 50 });
    const flush = auto.flush(); auto.update({ pageSize: 100 }); finish(); await flush;
    expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[1][0]).toMatchObject({ settings: { pageSize: 100 }, ifInState: 'm2' }); auto.dispose();
  });
  it('retains the exact command after uncertain failure and does not discard later edits', async () => {
    const save = vi.fn().mockRejectedValueOnce(new TypeError('Network unavailable')).mockResolvedValue({});
    const auto = new PreferenceAutosave(save, () => 'm2', () => {}, 10000); auto.reset({ density: 'compact' }); auto.update({ density: 'comfortable' });
    expect(await auto.flush()).toBe(false); const pending = structuredClone(save.mock.calls[0][0]); auto.update({ density: 'compact', pageSize: 100 });
    expect(await auto.flush()).toBe(false); expect(await auto.retry()).toBe(true);
    expect(save.mock.calls[1][0]).toEqual(pending); expect(save.mock.calls[2][0].settings).toEqual({ density: 'compact', pageSize: 100 }); auto.dispose();
  });
});

describe('preference autosave lifecycle', () => {
  it('does not write defaults during StrictMode cleanup before loading', async () => {
    const save = vi.fn(async () => ({})); const auto = new PreferenceAutosave(save, () => 'm1', () => {});
    auto.dispose(); auto.activate(); await auto.flush(); expect(save).not.toHaveBeenCalled();
    auto.reset({ density: 'compact' }); auto.dispose(); await Promise.resolve(); expect(save).not.toHaveBeenCalled();
  });
  it('flushes user edits when the settings view unmounts', async () => {
    const save = vi.fn(async () => ({})); const auto = new PreferenceAutosave(save, () => 'm1', () => {}, 10000);
    auto.reset({ density: 'compact' }); auto.update({ density: 'comfortable' }); auto.dispose(); await Promise.resolve(); expect(save).toHaveBeenCalledTimes(1);
  });
  it('requires reload after a confirmed rejection rather than retrying stale state', async () => {
    const save = vi.fn().mockRejectedValue(Object.assign(new Error('stateMismatch'), { confirmed: true })); const auto = new PreferenceAutosave(save, () => 'm1', () => {}, 10000);
    auto.reset({ pageSize: 25 }); auto.update({ pageSize: 50 }); expect(await auto.flush()).toBe(false); expect(auto.retryable).toBe(false); expect(await auto.retry()).toBe(false); expect(save).toHaveBeenCalledTimes(1); auto.dispose();
  });
});

import { validateSettings } from '../apps/mail/src/domain/workflows';
it('allows clearing an inactive forwarding destination without blocking unrelated preferences', () => {
  expect(() => validateSettings({ forwarding: { enabled: false, address: '', keepCopy: true } })).not.toThrow();
  expect(() => validateSettings({ forwarding: { enabled: true, address: '', keepCopy: true } })).toThrow();
  expect(() => validateSettings({ forwarding: { enabled: false, address: 'invalid', keepCopy: true } })).toThrow();
});
