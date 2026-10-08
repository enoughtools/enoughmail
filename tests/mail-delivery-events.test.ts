import { describe, expect, it } from 'vitest';
import { initialRecipientDelivery, mergeRecipientDelivery, parseProviderDeliveryEvent } from '../apps/mail/src/server/provider-events';
const env = { CF_ACCOUNT_ID: 'cloudflare-account', MAIL_DELIVERY_EVENT_SUBSCRIPTION_IDS: 'subscription' };
const fixture = (status = 'delivered', timestamp = '2026-10-05T12:00:00Z') => ({ type: `cf.email.sending.message.${status}`,
  source: { type: 'email.sending', zoneId: 'zone', domain: 'example.com' },
  payload: { eventId: status + timestamp, messageId: 'provider', sender: 'me@example.com', recipient: 'you@example.net', terminal: status !== 'deferred', delivery: { status, smtpStatusCode: status === 'delivered' ? '250' : '550' } },
  metadata: { accountId: env.CF_ACCOUNT_ID, eventSubscriptionId: 'subscription', eventSchemaVersion: 1, eventTimestamp: timestamp } });
describe('Cloudflare Email Sending events', () => {
  it('supports every official lifecycle event and rejects foreign accounts/subscriptions/senders or schema', () => {
    for (const status of ['delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained']) expect(parseProviderDeliveryEvent(fixture(status), env).status).toBe(status);
    expect(() => parseProviderDeliveryEvent(fixture(), { ...env, CF_ACCOUNT_ID: 'foreign' })).toThrow('ScopeMismatch');
    expect(() => parseProviderDeliveryEvent(fixture(), { ...env, MAIL_DELIVERY_EVENT_SUBSCRIPTION_IDS: 'foreign' })).toThrow('ScopeMismatch');
    const invalid = fixture(); invalid.payload.sender = 'foreign@other.net'; expect(() => parseProviderDeliveryEvent(invalid, env)).toThrow('ScopeMismatch');
    const schema = fixture(); schema.metadata.eventSchemaVersion = 2; expect(() => parseProviderDeliveryEvent(schema, env)).toThrow('ScopeMismatch');
  });
  it('retains terminal state across delayed deferrals and makes complaint state sticky', () => {
    const delivered = mergeRecipientDelivery(undefined, parseProviderDeliveryEvent(fixture(), env));
    expect(mergeRecipientDelivery(delivered, parseProviderDeliveryEvent(fixture('deferred', '2026-10-05T13:00:00Z'), env))).toEqual(delivered);
    const complained = mergeRecipientDelivery(delivered, parseProviderDeliveryEvent(fixture('complained', '2026-10-05T14:00:00Z'), env));
    expect(mergeRecipientDelivery(complained, parseProviderDeliveryEvent(fixture('delivered', '2026-10-05T15:00:00Z'), env))).toEqual(complained);
  });
  it('ignores duplicate events and older conflicting terminal events', () => {
    const event = parseProviderDeliveryEvent(fixture('bounced', '2026-10-05T14:00:00Z'), env);
    const previous = mergeRecipientDelivery(undefined, event);
    expect(mergeRecipientDelivery(previous, event)).toBe(previous);
    expect(mergeRecipientDelivery(previous, parseProviderDeliveryEvent(fixture(), env))).toBe(previous);
  });
  it('stores recipient keyed initial outcomes, preserving partial failure and unknown recipients', () => {
    const result = initialRecipientDelivery(['a@example.net', 'b@example.net', 'c@example.net'], { status: 'accepted', providerId: 'provider', delivered: ['a@example.net'], permanentBounces: ['b@example.net'] });
    expect(result['a@example.net'].status).toBe('delivered'); expect(result['b@example.net'].status).toBe('bounced'); expect(result['c@example.net'].status).toBe('unknown');
  });
});
