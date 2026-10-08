import { describe, expect, it } from 'vitest';
import { validateSubmissionEnvelope } from '../apps/mail/src/domain/submission';
const now = Date.parse('2026-10-05T12:00:00Z');
const email = { to: [{ email: 'visible@example.test' }], bcc: [{ email: 'hidden@example.test' }] }, identity = { email: 'sender@example.test' };
describe('Standard JMAP submission envelope', () => {
  it('uses explicit envelope recipients rather than visible headers and honors HOLDFOR', () => {
    const result = validateSubmissionEnvelope({ envelope: { mailFrom: { email: identity.email, parameters: { HOLDFOR: '60' } }, rcptTo: [{ email: 'actual@example.test' }] } }, email, identity, { now });
    expect(result.envelope.rcptTo.map(value => value.email)).toEqual(['actual@example.test']); expect(result.sendAt).toBe('2026-10-05T12:01:00.000Z');
  });
  it('uses header To/Cc/Bcc only when envelope is omitted and sends standard immediate at creation', () => {
    const result = validateSubmissionEnvelope({}, email, identity, { now }); expect(result.envelope.rcptTo).toHaveLength(2); expect(result.sendAt).toBe(new Date(now).toISOString());
  });
  it('rejects spoofed senders, unsupported parameters, duplicate holds and malformed dates', () => {
    const make = (parameters: any, sender = identity.email) => ({ envelope: { mailFrom: { email: sender, parameters }, rcptTo: [{ email: 'recipient@example.test' }] } });
    expect(() => validateSubmissionEnvelope(make({}, 'other@example.test'), email, identity, { now })).toThrow('identity');
    expect(() => validateSubmissionEnvelope(make({ NOTIFY: 'SUCCESS' }), email, identity, { now })).toThrow('Unsupported');
    expect(() => validateSubmissionEnvelope(make({ HOLDFOR: '1', HOLDUNTIL: '2026-10-05T13:00:00Z' }), email, identity, { now })).toThrow('one');
    expect(() => validateSubmissionEnvelope(make({ HOLDUNTIL: '2026-02-31T13:00:00Z' }), email, identity, { now })).toThrow('limits');
  });
  it('requires negotiated capability for proprietary scheduling and bounds future release', () => {
    expect(() => validateSubmissionEnvelope({ sendAt: '2026-10-05T13:00:00Z' }, email, identity, { now })).toThrow('server set');
    expect(validateSubmissionEnvelope({ sendAt: '2026-10-05T13:00:00Z' }, email, identity, { now, allowEnoughScheduling: true }).sendAt).toBe('2026-10-05T13:00:00.000Z');
    expect(() => validateSubmissionEnvelope({ envelope: { mailFrom: { email: identity.email, parameters: { HOLDFOR: '61' } }, rcptTo: email.to } }, email, identity, { now, maxDelayedSend: 60 })).toThrow('HOLDFOR');
  });
});
