import { describe, expect, it } from 'vitest';
import { buildMime, parseMime } from '../apps/mail/src/domain/mime';
const bytes = (text: string) => new TextEncoder().encode(text);
describe('Enough Mail MIME conversion', () => {
  it('reads encoded and folded headers, quoted printable bodies and threading', () => {
    const mail = parseMime(bytes('From: =?UTF-8?B?Sm9zw6k=?= <jose@example.test>\r\nTo: "Doe, Jane" <jane@example.test>\r\nSubject: =?UTF-8?Q?Ol=C3=A1?=\r\n =?UTF-8?Q?_mundo?=\r\nMessage-ID: <first@example.test>\r\nReferences: <before@example.test>\r\nDate: Mon, 05 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nOl=C3=A1=\r\n mundo'), 'raw');
    expect(mail.subject).toBe('Olá mundo');
    expect(mail.from).toEqual([{ name: 'José', email: 'jose@example.test' }]);
    expect(mail.to).toEqual([{ name: 'Doe, Jane', email: 'jane@example.test' }]);
    expect(mail.preview).toBe('Olá mundo');
    expect(mail.messageId).toEqual(['first@example.test']);
    expect(mail.references).toEqual(['before@example.test']);
    expect(mail.sentAt).toBe('2026-10-05T10:00:00.000Z');
  });
  it('round trips Unicode, alternative bodies and exact binary attachments without leaking Bcc', () => {
    const raw = buildMime({ from: [{ email: 'sender@example.test', name: 'José' }], to: [{ email: 'reader@example.test' }], bcc: [{ email: 'hidden@example.test' }], subject: 'Hello 📨', text: 'Plain résumé', html: '<p>Rich résumé</p>', messageId: ['message@example.test'], attachments: [{ type: 'application/octet-stream', name: 'résumé.bin', bytes: new Uint8Array([0, 127, 128, 255]) }] });
    expect(new TextDecoder().decode(raw)).not.toContain('hidden@example.test');
    const mail = parseMime(raw, 'raw');
    expect(mail.subject).toBe('Hello 📨');
    const textPartId = mail.textBody[0].partId, htmlPartId = mail.htmlBody[0].partId;
    if (textPartId === null || htmlPartId === null) throw new Error('Display body parts must have leaf IDs');
    expect(mail.bodyValues[textPartId].value).toBe('Plain résumé');
    expect(mail.bodyValues[htmlPartId].value).toBe('<p>Rich résumé</p>');
    expect(mail.attachments[0].name).toBe('résumé.bin');
    expect(mail.attachments[0].bytes).toEqual(new Uint8Array([0, 127, 128, 255]));
  });
  it('rejects header injection and missing attachment data', () => {
    for (const input of [{ subject: 'Hi\r\nBcc: attacker@example.test' }, { from: [{ email: 's@example.test\r\nX: bad' }] }, { bcc: [{ email: 'bad-address' }] }, { messageId: ['one\r\nInjected: two'] }]) expect(() => buildMime(input)).toThrow();
    expect(() => buildMime({ attachments: [{ blobId: 'missing' }] })).toThrow('resolved');
  });
  it('rejects malformed encodings and bounds hostile multipart nesting', () => {
    expect(() => parseMime(bytes('Content-Transfer-Encoding: base64\r\n\r\n%%%'), 'blob')).toThrow('base64');
    expect(() => parseMime(bytes('Content-Type: multipart/mixed\r\n\r\nbody'), 'blob')).toThrow('boundary');
    let nested = 'Content-Type: text/plain\r\n\r\nhello';
    for (let i = 0; i < 22; i++) nested = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${nested}\r\n--b${i}--`;
    expect(() => parseMime(bytes(nested), 'blob')).toThrow('nesting');
  });
  it('preserves HTML as untrusted data and makes a plain text preview', () => {
    const mail = parseMime(bytes('Content-Type: text/html\r\n\r\n<p>Hello</p><script>bad()</script>'), 'blob');
    expect(mail.bodyValues['1'].value).toContain('<script>');
    expect(mail.preview).toBe('Hello bad()');
    expect(mail.preview).not.toContain('<');
  });
});

describe('JMAP MIME tree and leaf blobs', () => {
  it('preserves transfer decoded ISO-8859-1 bytes and shares leaf objects with the MIME tree', () => {
    const mail = parseMime(bytes('Sender: delegate@example.test\r\nContent-Type: multipart/alternative; boundary="alt"\r\n\r\n--alt\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Language: fr, en\r\nContent-Location: https://example.test/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=E9\r\n--alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>HTML</p>\r\n--alt--'), 'raw');
    expect(mail.bodyStructure).toMatchObject({ partId: null, blobId: null, type: 'multipart/alternative', charset: null });
    const plain = mail.bodyStructure.subParts![0];
    expect(mail.textBody[0]).toBe(plain);
    expect(mail.htmlBody[0]).toBe(mail.bodyStructure.subParts![1]);
    expect(plain.bytes).toEqual(new Uint8Array([99, 97, 102, 233]));
    expect(mail.bodyValues[plain.partId!].value).toBe('café');
    expect(plain).toMatchObject({ language: ['fr', 'en'], location: 'https://example.test/plain', charset: 'iso-8859-1' });
    expect(plain.headers!.find(h => h.name === 'Content-Language')?.value).toBe(' fr, en');
    plain.blobId = 'persisted';
    expect(mail.bodyStructure.subParts![0].blobId).toBe('persisted');
    expect(mail.sender).toEqual([{ name: null, email: 'delegate@example.test' }]);
  });
  it('defaults charset to us-ascii and supplies the sole representation to both display lists', () => {
    const mail = parseMime(bytes('Subject: Hello\r\n\r\nfirst\r\nsecond'), 'raw');
    expect(mail.sender).toBeNull();
    expect(mail.textBody[0]).toBe(mail.bodyStructure);
    expect(mail.htmlBody[0]).toBe(mail.bodyStructure);
    expect(mail.bodyStructure.charset).toBe('us-ascii');
    expect(mail.bodyValues['1'].value).toBe('first\nsecond');
    expect(mail.bodyStructure.bytes).toEqual(bytes('first\r\nsecond'));
  });
  it('keeps related embedded images as attachments and selects its first body part', () => {
    const mail = parseMime(bytes('Content-Type: multipart/related; boundary="r"\r\n\r\n--r\r\nContent-Type: text/html\r\n\r\n<p>Hello</p>\r\n--r\r\nContent-Type: image/png\r\nContent-ID: <picture>\r\nContent-Transfer-Encoding: base64\r\n\r\nAAE=\r\n--r--'), 'raw');
    expect(mail.textBody).toEqual(mail.htmlBody);
    expect(mail.textBody[0]).toBe(mail.bodyStructure.subParts![0]);
    expect(mail.attachments[0]).toBe(mail.bodyStructure.subParts![1]);
    expect(mail.attachments[0].bytes).toEqual(new Uint8Array([0, 1]));
    expect(mail.attachments[0].cid).toBe('picture');
  });
});


it('retains raw header whitespace and folding while parsed fields are normalized', () => {
  const mail = parseMime(bytes('Subject:  hello\r\n\tworld\r\nX-Info: first\r\n second\r\nX-Info: last\r\n\r\nbody'), 'raw');
  expect(mail.headers.filter(h => h.name === 'X-Info').map(h => h.value)).toEqual([' first\r\n second', ' last']);
  expect(mail.headers.find(h => h.name === 'Subject')?.value).toBe('  hello\r\n\tworld');
  expect(mail.subject).toBe('hello world');
});
