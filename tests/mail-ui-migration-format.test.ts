import { describe, expect, it } from 'vitest';
import { parseImport, mboxMessage, MAX_MESSAGE_BYTES } from '../apps/mail/src/ui/migration-format';
const encoder = new TextEncoder();
describe('mail portability byte format', () => {
  it('preserves binary MIME bytes and unquotes precisely one mboxrd level', () => {
    const prefix = encoder.encode('From sender@example.test Mon Jan 01 00:00:00 2024\nSubject: Binary\nStatus: RO\nX-Status: FA\n\n>From text\n>>From quoted\n');
    const bytes = new Uint8Array(prefix.length + 3); bytes.set(prefix); bytes.set([255, 128, 10], prefix.length);
    const [message] = parseImport(bytes, true);
    expect(message.keywords).toEqual({ '$seen': true, '$flagged': true, '$answered': true });
    expect(message.receivedAt).toBe('2024-01-01T00:00:00.000Z');
    expect([...message.bytes.slice(-3)]).toEqual([255, 128, 10]);
    expect(new TextDecoder().decode(message.bytes)).toContain('\nFrom text\n>From quoted\n');
  });
  it('exports complete message bodies and preserves flags through mbox roundtrip', () => {
    const source = encoder.encode('Subject: Test\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\nAP8=\r\n--x--\r\nFrom body\r\n');
    const parts = mboxMessage(source, { receivedAt: '2024-02-01T00:00:00Z', keywords: { '$seen': true, custom: true }, mailboxIds: { inbox: true, label: true } });
    const combined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { combined.set(part, at); at += part.length; }
    const [message] = parseImport(combined, true);
    expect(message.keywords).toEqual({ '$seen': true, custom: true });
    expect(message.bytes).toEqual(source);
    expect(message.receivedAt).toBe('2024-02-01T00:00:00.000Z');
  });
  it('splits messages and refuses malformed or oversized messages', () => {
    expect(parseImport(encoder.encode('From a@test Thu Jan 1 00:00:00 2026\nSubject: A\n\nBody\nFrom b@test Thu Jan 1 00:00:00 2026\nSubject: B\n\nBody\n'), true)).toHaveLength(2);
    expect(() => parseImport(encoder.encode('not mail'), false)).toThrow(/headers/);
    expect(() => parseImport(encoder.encode('Subject: message\n\nBody'), true)).toThrow(/separator/);
    expect(() => parseImport(new Uint8Array(MAX_MESSAGE_BYTES + 1), false)).toThrow(/25 MB/);
  });
});
