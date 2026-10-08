import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readOfflinePreferences, saveOfflinePreferences } from '../apps/mail/src/ui/offline-preferences';
import { readOfflineSession, saveOfflineSession } from '../apps/mail/src/ui/offline-session';
import type { MailSession } from '../apps/mail/src/ui/jmap';

const session = (): MailSession => ({ username: 'Alice', actorId: 'alice', organizationId: 'org', workspaceId: 'workspace', apiUrl: '/apps/mail/jmap', uploadUrl: '', downloadUrl: '', capabilities: {}, accounts: { a: { name: 'Personal', isReadOnly: false, accountCapabilities: {} } }, primaryAccounts: {} });

describe('local offline preferences', () => {
  let values: Map<string, string>;
  beforeEach(() => {
    values = new Map();
    vi.stubGlobal('window', { location: { origin: 'https://mail.test' } });
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('defaults to bounded recent copies and returns independent preferences', () => {
    const first = readOfflinePreferences(session());
    expect(first).toEqual({ enabled: true, maxMessages: 100, maxAgeHours: 24 });
    first.enabled = false;
    expect(readOfflinePreferences(session()).enabled).toBe(true);
  });
  it('scopes choices to verified identity, organization, workspace and account admission', () => {
    const source = session();
    saveOfflinePreferences(source, { enabled: false, maxMessages: 25, maxAgeHours: 6 });
    expect(readOfflinePreferences({ ...source, username: 'Renamed' }).enabled).toBe(false);
    for (const changed of [{ ...source, actorId: 'bob' }, { ...source, organizationId: 'other' }, { ...source, workspaceId: 'other' }, { ...source, accounts: { b: source.accounts.a } }, { ...source, accounts: { a: { ...source.accounts.a, isReadOnly: true } } }]) expect(readOfflinePreferences(changed).enabled).toBe(true);
    expect(() => saveOfflinePreferences({ ...source, actorId: '' }, { enabled: true, maxMessages: 25, maxAgeHours: 6 })).toThrow('identity');
  });
  it('clamps finite limits and rejects untyped, nonfinite or invalid enablement input', () => {
    expect(saveOfflinePreferences(session(), { enabled: true, maxMessages: 1000, maxAgeHours: 50 })).toEqual({ enabled: true, maxMessages: 100, maxAgeHours: 24 });
    expect(saveOfflinePreferences(session(), { enabled: true, maxMessages: -3, maxAgeHours: -3 })).toEqual({ enabled: true, maxMessages: 10, maxAgeHours: 1 });
    expect(saveOfflinePreferences(session(), { enabled: true, maxMessages: 25.7, maxAgeHours: 6.9 })).toEqual({ enabled: true, maxMessages: 25, maxAgeHours: 6 });
    for (const invalid of [{ enabled: 'false', maxMessages: 25, maxAgeHours: 6 }, { enabled: true, maxMessages: NaN, maxAgeHours: 6 }, { enabled: true, maxMessages: 25, maxAgeHours: Infinity }, { enabled: true, maxMessages: '25', maxAgeHours: 6 }]) expect(() => saveOfflinePreferences(session(), invalid as any)).toThrow();
  });
  it('recovers malformed data and never stores extra bodies or secrets', () => {
    saveOfflinePreferences(session(), { enabled: true, maxMessages: 25, maxAgeHours: 6, token: 'secret', body: 'private' } as any);
    const key = [...values.keys()][0];
    expect(JSON.parse(values.get(key)!)).toEqual({ enabled: true, maxMessages: 25, maxAgeHours: 6 });
    for (const malformed of ['{', 'null', '[]', '{"enabled":false}']) {
      values.set(key, malformed);
      expect(readOfflinePreferences(session())).toEqual({ enabled: true, maxMessages: 100, maxAgeHours: 24 });
    }
  });
  it('cannot extend an existing offline session by changing preferences offline', () => {
    saveOfflineSession(session(), 1);
    const original = values.get('enough-mail:offline-session:v1');
    vi.advanceTimersByTime(30 * 60_000);
    saveOfflinePreferences(session(), { enabled: true, maxMessages: 100, maxAgeHours: 24 });
    expect(values.get('enough-mail:offline-session:v1')).toBe(original);
    vi.advanceTimersByTime(30 * 60_000);
    expect(readOfflineSession()).toBeNull();
  });
  it('reports storage failure instead of claiming preferences were saved', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('Storage unavailable'); } });
    expect(readOfflinePreferences(session()).maxMessages).toBe(100);
    expect(() => saveOfflinePreferences(session(), { enabled: false, maxMessages: 25, maxAgeHours: 6 })).toThrow('Storage unavailable');
  });
});
