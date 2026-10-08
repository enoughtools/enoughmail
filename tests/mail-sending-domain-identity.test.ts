import { describe, expect, it, vi } from 'vitest';
import { prepareSendingDomain } from '../apps/mail/src/server/domains';

const zoneId = 'a'.repeat(32), sendingId = 'b'.repeat(32);
const response = (result: unknown) => Response.json({ success: true, result });

describe('Sending domain identity on adoption retries', () => {
  it('re-enables the existing disabled identity once and then reuses it', async () => {
    const identity = { name: 'example.com', tag: sendingId, enabled: false };
    const fetcher = vi.fn(async (_input: any, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ name: 'example.com' });
        identity.enabled = true;
        return response(identity);
      }
      return response([identity]);
    });
    expect(await prepareSendingDomain({ CF_API_TOKEN: 'test' }, 'example.com', zoneId, fetcher)).toBe(sendingId);
    expect(await prepareSendingDomain({ CF_API_TOKEN: 'test' }, 'example.com', zoneId, fetcher)).toBe(sendingId);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('rejects a replacement identity rather than using a different key after re-enabling', async () => {
    const fetcher = vi.fn(async (_input: any, init?: RequestInit) => response(init?.method === 'POST'
      ? { name: 'example.com', tag: 'c'.repeat(32), enabled: true }
      : [{ name: 'example.com', tag: sendingId, enabled: false }]));
    await expect(prepareSendingDomain({ CF_API_TOKEN: 'test' }, 'example.com', zoneId, fetcher)).rejects.toThrow('invalidProviderResponse');
  });

  it('keeps an enabled identity without a provider write even when other domains are disabled', async () => {
    const fetcher = vi.fn(async (_input: any, _init?: RequestInit) => response([
      { name: 'other.example.com', tag: 'c'.repeat(32), enabled: false },
      { name: 'EXAMPLE.COM.', tag: sendingId, enabled: true },
    ]));
    expect(await prepareSendingDomain({ CF_API_TOKEN: 'test' }, 'example.com', zoneId, fetcher)).toBe(sendingId);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });
});
