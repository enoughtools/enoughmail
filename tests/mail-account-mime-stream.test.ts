import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { parseMime } from '../apps/mail/src/domain/mime';
import { buildMimeStream, prepareMimeStream, parseMimeStream, decodedMimePart, type MimeStreamSource } from '../apps/mail/src/domain/mime-stream';
const encode = (s: string) => new TextEncoder().encode(s);
function virtualSource(segments: { data: Uint8Array; repeat?: number }[], chunkSize = 65536): MimeStreamSource {
  const sizes = segments.map(s => s.data.length * (s.repeat || 1));
  const size = sizes.reduce((a, b) => a + b, 0);
  return { size, async read(range) {
    let position = range?.offset || 0, end = position + (range?.length ?? size);
    return new ReadableStream({ pull(c) {
      if (position >= end) { c.close(); return; }
      const result = new Uint8Array(Math.min(chunkSize, end - position));
      for (let i = 0; i < result.length;) {
        let index = 0, start = 0; while (position + i >= start + sizes[index]) start += sizes[index++];
        const data = segments[index].data, offset = (position + i - start) % data.length;
        const length = Math.min(data.length - offset, result.length - i, start + sizes[index] - position - i);
        result.set(data.subarray(offset, offset + length), i); i += length;
      }
      position += result.length; c.enqueue(result);
    } });
  } };
}
async function digest(stream: ReadableStream<Uint8Array>) {
  const hash = createHash('sha256'), reader = stream.getReader(); let count = 0, largest = 0;
  while (true) { const item = await reader.read(); if (item.done) break; count += item.value.length; largest = Math.max(largest, item.value.length); hash.update(item.value); }
  return { hash: hash.digest('hex'), count, largest };
}
const zeroHash = (size: number) => { const hash = createHash('sha256'), zero = new Uint8Array(65536); for (let i = 0; i < size; i += zero.length) hash.update(zero.subarray(0, Math.min(zero.length, size - i))); return hash.digest('hex'); };
describe('bounded MIME streams', () => {
  it('parses split UTF8 headers, boundaries, QP escapes and preserves exact decoded bytes', async () => {
    const raw = encode('From: José <jose@example.test>\r\nSubject: Hello 📨\r\nContent-Type: multipart/mixed; boundary="outer"\r\n\r\n--outer\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=E9=\r\n here\r\n--outer\r\nContent-Type: image/png\r\nContent-Disposition: attachment\r\nContent-ID: <picture>\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECA/8=\r\n--outer--\r\n');
    for (const chunkSize of [1, 2, 7, 101, 65536]) {
      const source = virtualSource([{ data: raw }], chunkSize);
      const mail = await parseMimeStream(source, 'raw');
      expect(mail.subject).toBe('Hello 📨'); expect(mail.from[0].name).toBe('José');
      expect(mail.bodyValues[mail.textBody[0].partId!].value).toBe('café here');
      expect(mail.textBody[0].size).toBe(9);
      const picture = mail.attachments.find(p => p.cid === 'picture')!;
      expect(picture.size).toBe(5);
      const result = await digest(await decodedMimePart(source, picture));
      expect(result.hash).toBe(createHash('sha256').update(new Uint8Array([0, 1, 2, 3, 255])).digest('hex'));
      expect(mail.bodyStructure.subParts![0]).toBe(mail.textBody[0]);
    }
  });
  it('streams a25MiB attachment in a34MiB raw message with exact hash and bounded decoder chunks', async () => {
    const length = 25 * 1024 * 1024;
    const quartets = Math.floor(length / 3);
    const source = virtualSource([
      { data: encode('Content-Type: multipart/mixed; boundary="big"\r\n\r\n--big\r\nContent-Type: text/plain\r\n\r\nHello\r\n--big\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="big.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n') },
      { data: encode('AAAA'), repeat: quartets }, { data: encode(length % 3 === 1 ? 'AA==' : 'AAA=') },
      { data: encode('\r\n--big--\r\n') },
    ]);
    let checked = false;
    const mail = await parseMimeStream(source, 'raw', { onLeaf: async (part, stream) => {
      const result = await digest(stream);
      if (part.name === 'big.bin') { expect(result.count).toBe(length); expect(result.hash).toBe(zeroHash(length)); expect(result.largest).toBeLessThanOrEqual(65536); checked = true; }
      return { blobId: `saved-${part.partId}` };
    } });
    expect(checked).toBe(true); expect(source.size).toBeGreaterThan(33 * 1024 * 1024);
    expect(mail.attachments[0].size).toBe(length); expect(mail.attachments[0].bytes).toBeUndefined();
    expect(mail.attachments[0].blobId).toBe(`saved-${mail.attachments[0].partId}`);
  }, 30000);
  it('parses50MiB raw binary without any message-sized allocation', async () => {
    const head = encode('Content-Type: application/octet-stream\r\n\r\n');
    const size = 50 * 1024 * 1024, payload = size - head.length;
    const source = virtualSource([{ data: head }, { data: new Uint8Array(1), repeat: payload }]);
    const mail = await parseMimeStream(source, 'binary');
    expect(mail.attachments[0].size).toBe(payload);
    const result = await digest(await decodedMimePart(source, mail.attachments[0]));
    expect(result.count).toBe(payload); expect(result.hash).toBe(zeroHash(payload));
  }, 30000);
  it('caps retained text bytes and keeps full leaf stream accessible', async () => {
    const source = virtualSource([{ data: encode('Content-Type: text/plain; charset=utf-8\r\n\r\n') }, { data: encode('héllo\r\n'), repeat: 10000 }], 53);
    const mail = await parseMimeStream(source, 'text', { maxBodyValueBytes: 1024 });
    expect(new TextEncoder().encode(mail.bodyValues['1'].value).length).toBeLessThanOrEqual(1024);
    expect(mail.bodyValues['1'].isTruncated).toBe(true);
    expect((await digest(await decodedMimePart(source, mail.bodyStructure))).count).toBe(80000);
  });
  it('composes streamed attachments and never exposes Bcc', async () => {
    const attachment = new Uint8Array([0, 1, 2, 254, 255]);
    const stream = buildMimeStream({ from: [{ email: 'sender@example.test' }], to: [{ email: 'reader@example.test' }], bcc: [{ email: 'secret@example.test' }], subject: 'Hello', text: 'Body', attachments: [{ type: 'application/octet-stream', name: 'five.bin' }] }, async () => (await virtualSource([{ data: attachment }], 1).read()));
    const raw = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(new TextDecoder().decode(raw)).not.toContain('secret@example.test');
    const mail = parseMime(raw, 'composed'); expect(mail.attachments[0].bytes).toEqual(attachment);
    expect(mail.bodyValues[mail.textBody[0].partId!].value).toBe('Body');
  });
});


it('streams outgoing25MiB attachments back through the bounded parser with exact content', async () => {
  const length = 25 * 1024 * 1024;
  const input = virtualSource([{ data: new Uint8Array(65536), repeat: length / 65536 }]);
  const chunks: Uint8Array[] = [];
  // A spool stands in for R2 in this test. The producer itself emits bounded chunks.
  const composed = buildMimeStream({ subject: 'Large attachment', text: 'hello', attachments: [{ type: 'application/octet-stream', name: 'large.bin' }] }, async () => input.read());
  const reader = composed.getReader(); let size = 0;
  while (true) { const item = await reader.read(); if (item.done) break; expect(item.value.length).toBeLessThanOrEqual(100000); chunks.push(item.value); size += item.value.length; }
  const source = virtualSource(chunks.map(data => ({ data })));
  expect(source.size).toBe(size);
  const mail = await parseMimeStream(source, 'large-outgoing');
  expect(mail.attachments[0].size).toBe(length);
  const decoded = await digest(await decodedMimePart(source, mail.attachments[0]));
  expect(decoded.hash).toBe(zeroHash(length));
}, 30000);

it('rejects invalid transfer content, source length mismatch and deeply nested MIME', async () => {
  await expect(parseMimeStream(virtualSource([{ data: encode('Content-Transfer-Encoding: base64\r\n\r\n%%%') }]), 'bad')).rejects.toThrow('base64');
  const mismatch = virtualSource([{ data: encode('Subject: A\r\n\r\nbody') }]); mismatch.size++;
  await expect(parseMimeStream(mismatch, 'bad')).rejects.toThrow('size mismatch');
  let nested = 'Content-Type: text/plain\r\n\r\nhello';
  for (let i = 0; i < 22; i++) nested = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${nested}\r\n--b${i}--`;
  await expect(parseMimeStream(virtualSource([{ data: encode(nested) }], 31), 'deep')).rejects.toThrow('nesting');
});


it('rejects aggregate multipart headers exceeding256KiB before producing canonical metadata', async () => {
  const header = 'X-Oversized: ' + 'x'.repeat(100000) + '\r\nContent-Type: text/plain\r\n\r\nbody';
  const raw = 'Content-Type: multipart/mixed; boundary="aggregate"\r\n\r\n' +
    [header, header, header].map(value => '--aggregate\r\n' + value + '\r\n').join('') + '--aggregate--\r\n';
  await expect(parseMimeStream(virtualSource([{ data: encode(raw) }], 4096), 'headers')).rejects.toThrow('Aggregate MIME headers');
});

it('freezes composition headers and boundaries for identical count and persistence passes', async () => {
  const input = { subject: 'Frozen', text: '🙂 body', html: '<b>🙂 body</b>', attachments: [{ type: 'application/octet-stream', name: 'tiny.bin' }] };
  const prepared = prepareMimeStream(input, async () => virtualSource([{ data: new Uint8Array([1, 2, 3]) }]).read());
  const first = await digest(prepared.stream());
  input.subject = 'Changed'; input.text = 'Changed'; input.attachments[0].name = 'changed.bin';
  const second = await digest(prepared.stream());
  expect(second).toEqual(first);
});

it('streams a25MiB plain body with bounded UTF8 encoding and exact decoded content', async () => {
  const text = 'x'.repeat(25 * 1024 * 1024 - 2) + '🙂';
  const prepared = prepareMimeStream({ subject: 'Large plain body', text }, async () => { throw new Error('No attachment expected'); });
  const chunks: Uint8Array[] = [], reader = prepared.stream().getReader();
  while (true) { const next = await reader.read(); if (next.done) break; expect(next.value.length).toBeLessThanOrEqual(100000); chunks.push(next.value); }
  const source = virtualSource(chunks.map(data => ({ data })));
  const mail = await parseMimeStream(source, 'plain');
  expect(mail.bodyValues['1'].isTruncated).toBe(true);
  const decoded = await digest(await decodedMimePart(source, mail.bodyStructure));
  const expected = createHash('sha256').update(text).digest('hex');
  expect(decoded.hash).toBe(expected);
}, 30000);
