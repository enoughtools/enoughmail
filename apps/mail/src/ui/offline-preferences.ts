import type { MailSession } from './jmap';
import { cacheScope } from './offline';

const PREFIX = 'enough-mail:offline-preferences:v1:';
export interface OfflinePreferences { enabled: boolean; maxMessages: number; maxAgeHours: number }
export const DEFAULT_OFFLINE_PREFERENCES: Readonly<OfflinePreferences> = Object.freeze({ enabled: true, maxMessages: 100, maxAgeHours: 24 });

function bounded(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Offline limits must be finite numbers.');
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
function validate(value: unknown): OfflinePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid offline preferences.');
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== 'boolean') throw new Error('Offline access must be enabled or disabled.');
  return { enabled: input.enabled, maxMessages: bounded(input.maxMessages, 10, 100), maxAgeHours: bounded(input.maxAgeHours, 1, 24) };
}
export function readOfflinePreferences(session: MailSession): OfflinePreferences {
  const key = PREFIX + cacheScope(session);
  try {
    const encoded = localStorage.getItem(key);
    return encoded ? validate(JSON.parse(encoded)) : { ...DEFAULT_OFFLINE_PREFERENCES };
  } catch { return { ...DEFAULT_OFFLINE_PREFERENCES }; }
}
// These settings never persist message bodies, discovery metadata, or credentials.
// Saving them does not renew an offline session or extend an existing copy's TTL.
export function saveOfflinePreferences(session: MailSession, value: OfflinePreferences): OfflinePreferences {
  const key = PREFIX + cacheScope(session);
  const preferences = validate(value);
  localStorage.setItem(key, JSON.stringify(preferences));
  return preferences;
}
