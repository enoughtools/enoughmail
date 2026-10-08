import { describe, expect, it } from 'vitest';
import { projectEmail } from '../apps/mail/src/domain/jmap-email';
const email = { id: 'e', blobId: 'b', threadId: 't', mailboxIds: { inbox: true }, keywords: {}, size: 42, receivedAt: '2026-10-05T12:00:00Z', subject: 'Hello', headers: [{ name: 'Subject', value: '=?UTF-8?B?SGVsbG8=?=' }, { name: 'X-Repeat', value: 'one' }, { name: 'X-Repeat', value: 'two' }, { name: 'To', value: 'First <first@example.test>, Friends: second@example.test, Third <third@example.test>;' }], textBody: [{ partId: 'p', blobId: 'bp', size: 9, type: 'text/plain', charset: 'utf-8' }], htmlBody: [{ partId: 'h', blobId: 'bh', size: 11, type: 'text/html', charset: 'utf-8' }], bodyValues: { p: { value: '😀😀x', isEncodingProblem: false, isTruncated: false }, h: { value: '<p>HTML</p>' } } };
describe('Standard Email projection', () => {
  it('omits cleared optional extensions while preserving existing extension values', () => {
    const properties = ['snooze', 'followUp', 'quarantine'];
    expect(projectEmail(email, { properties })).toEqual({ id: 'e' });
    const snooze = { wakeAt: '2026-10-06T12:00:00Z' };
    expect(projectEmail({ ...email, snooze, followUp: null }, { properties })).toEqual({ id: 'e', snooze, followUp: null });
    expect(() => projectEmail(email, { properties: ['unknownExtension'] })).toThrow('Unknown Email property');
  });
  it('returns required default nullable fields without leaking internal fields or unrequested headers', () => {
    const value = projectEmail({ ...email, internalSecret: 'private' }, {});
    expect(value.sender).toBeNull(); expect(value.from).toBeNull(); expect(value.bodyValues).toEqual({}); expect(value).not.toHaveProperty('internalSecret'); expect(value).not.toHaveProperty('headers');
  });
  it('selects text versus HTML body values and truncates by valid UTF-8 octets', () => {
    const value = projectEmail(email, { properties: ['bodyValues', 'textBody'], fetchTextBodyValues: true, maxBodyValueBytes: 5, bodyProperties: ['partId', 'blobId', 'size'] });
    expect(value.bodyValues).toEqual({ p: { value: '😀', isEncodingProblem: false, isTruncated: true } }); expect(value.textBody).toEqual([{ partId: 'p', blobId: 'bp', size: 9 }]);
    expect(projectEmail(email, { fetchTextBodyValues: true, maxBodyValueBytes: 0 }).bodyValues.p.value).toBe('😀😀x');
  });
  it('supports raw/text/all header forms with exact requested capitalization and grouped addresses', () => {
    const value = projectEmail(email, { properties: ['header:Subject:asText', 'header:X-Repeat:all', 'header:Missing', 'header:To:asGroupedAddresses'] });
    expect(value['header:Subject:asText']).toBe('Hello'); expect(value['header:X-Repeat:all']).toEqual(['one', 'two']); expect(value['header:Missing']).toBeNull(); expect(value['header:To:asGroupedAddresses']).toEqual([{ name: null, addresses: [{ name: 'First', email: 'first@example.test' }] }, { name: 'Friends', addresses: [{ name: null, email: 'second@example.test' }, { name: 'Third', email: 'third@example.test' }] }]);
  });
  it('rejects forbidden parsed header forms and invalid byte limits', () => {
    expect(() => projectEmail(email, { properties: ['header:From:asDate'] })).toThrow('Forbidden'); expect(() => projectEmail(email, { maxBodyValueBytes: -1 })).toThrow('maxBodyValueBytes');
  });
});
