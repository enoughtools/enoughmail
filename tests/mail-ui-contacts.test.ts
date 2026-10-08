import { describe, expect, it } from 'vitest';
import { parseContacts, exportContacts, contactDuplicates, contactImportPlan, MAX_CONTACT_BYTES, MAX_CONTACTS } from '../apps/mail/src/ui/contact-format';

describe('contact portability', () => {
  it('roundtrips quoted CSV, Unicode and CRLF details', () => {
    const contacts = [{ name: '山田, "Renée"', email: 'renee@example.test', notes: 'First line\r\nSecond, line', company: 'A;B', favorite: false }];
    expect(parseContacts(exportContacts(contacts, 'csv'), 'csv')).toEqual(contacts);
  });
  it('roundtrips escaped vCards with multiline notes and Unicode', () => {
    const contacts = [{ name: 'Renée; 山田', email: 'renee@example.test', notes: 'Line one\ncomma, semi; slash\\', company: 'A,B', favorite: true }];
    expect(parseContacts(exportContacts(contacts, 'vcf'), 'vcf')).toEqual(contacts);
  });
  it('unfolds vCard lines and preserves each email as a portable contact', () => {
    expect(parseContacts('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Long \r\n name\r\nEMAIL;TYPE=WORK:a@example.test\r\nEMAIL:b@example.test\r\nEND:VCARD\r\n', 'vcf')).toEqual([{ name: 'Long name', email: 'a@example.test' }, { name: 'Long name', email: 'b@example.test' }]);
  });
  it('discards imported account, authority and identifier fields', () => {
    expect(parseContacts('[{"name":"A","email":"a@example.test","id":"foreign","accountId":"other","actorId":"admin","__proto__":{"role":"owner"}}]', 'json')).toEqual([{ name: 'A', email: 'a@example.test' }]);
    expect(() => parseContacts('[{"name":{},"email":"a@example.test"}]', 'json')).toThrow(/names/);
    expect(() => parseContacts('name,email\nA,invalid\n', 'csv')).toThrow(/email/);
  });
  it('rejects broken quoting, malformed cards and duplicate CSV headers', () => {
    expect(() => parseContacts('name,email\n"A,a@example.test', 'csv')).toThrow(/Unclosed/);
    expect(() => parseContacts('name,email\n"A"oops,a@example.test', 'csv')).toThrow(/quoting/);
    expect(() => parseContacts('email,email\na@example.test,b@example.test', 'csv')).toThrow(/unique/);
    expect(() => parseContacts('BEGIN:VCARD\nEMAIL:a@example.test', 'vcf')).toThrow(/Unclosed/);
    expect(() => parseContacts('BEGIN:VCARD\nFN:A\nEND:VCARD', 'vcf')).toThrow(/email/);
    expect(() => parseContacts('BEGIN:VCARD\nEMAIL:a@example.test\nFN;ENCODING=QUOTED-PRINTABLE:A\nEND:VCARD', 'vcf')).toThrow(/legacy/);
  });
  it('bounds file bytes and contact counts before import', () => {
    expect(() => parseContacts('x'.repeat(MAX_CONTACT_BYTES + 1), 'csv')).toThrow(/5 MB/);
    expect(() => parseContacts('email\n' + 'a@example.test\n'.repeat(MAX_CONTACTS + 1), 'csv')).toThrow(/10,000/);
  });
  const existing = [{ id: 'local', name: 'Original', email: 'A@example.test', notes: 'Keep me', favorite: true }];
  it('identifies existing and intra-file duplicate email addresses case insensitively', () => {
    expect(contactDuplicates([{ name: 'A', email: 'a@example.test' }, { name: 'B', email: 'b@example.test' }, { name: 'Second B', email: 'B@example.test' }], existing)).toEqual(['Original', undefined, 'B']);
  });
  it('requires explicit choices and retains ownership during merge', () => {
    expect(() => contactImportPlan([{ name: 'Changed', email: 'a@example.test' }], existing, {})).toThrow(/Choose/);
    const plan = contactImportPlan([{ name: '', email: 'a@example.test', notes: '', company: 'New company' }], existing, { 0: 'merge' });
    expect(plan).toEqual({ create: {}, update: { local: { email: 'a@example.test', company: 'New company' } } });
    expect(existing[0]).toEqual({ id: 'local', name: 'Original', email: 'A@example.test', notes: 'Keep me', favorite: true });
  });
  it('skips or keeps a separate duplicate without deleting existing contacts', () => {
    const incoming = [{ name: 'Skip', email: 'a@example.test' }, { name: 'Keep', email: 'a@example.test' }];
    expect(contactImportPlan(incoming, existing, { 0: 'skip', 1: 'keep' })).toEqual({ create: { 'contact-1': incoming[1] }, update: {} });
  });
  it('merges duplicates in the selected file into their staged creation', () => {
    expect(contactImportPlan([{ name: 'First', email: 'a@example.test' }, { name: '', email: 'a@example.test', company: 'Added' }], [], { 1: 'merge' })).toEqual({ create: { 'contact-0': { name: 'First', email: 'a@example.test', company: 'Added' } }, update: {} });
    expect(() => contactImportPlan([{ name: 'First', email: 'a@example.test' }, { name: 'Next', email: 'a@example.test' }], [], { 0: 'skip', 1: 'merge' })).toThrow(/retained/);
  });
});
