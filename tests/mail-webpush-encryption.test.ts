import { createECDH, createDecipheriv, hkdfSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptWebPushPayload } from '../apps/mail/src/server/webpush-encryption';

const receiverPublic = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const receiverPrivate = 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94';
const senderPublic = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const auth = 'BTBZMqHH6r4Tts7J_aSIgg';
const keys = { p256dh: receiverPublic, auth };
const bytes = (value: string) => Buffer.from(value, 'base64url');

// Independent receiver implementation uses Node's OpenSSL ECDH/HKDF/AES APIs,
// rather than sharing the encryption helper's derivation or framing routines.
function decrypt(body: Uint8Array, secret = auth): Buffer {
  const framed = Buffer.from(body);
  expect(framed.readUInt32BE(16)).toBe(4096);
  expect(framed[20]).toBe(65);
  const publicKey = framed.subarray(21, 86);
  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(bytes(receiverPrivate));
  const shared = receiver.computeSecret(publicKey);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), bytes(receiverPublic), publicKey]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, bytes(secret), info, 32));
  const cek = hkdfSync('sha256', ikm, framed.subarray(0, 16), Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfSync('sha256', ikm, framed.subarray(0, 16), Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  decipher.setAuthTag(framed.subarray(-16));
  const clear = Buffer.concat([decipher.update(framed.subarray(86, -16)), decipher.final()]);
  expect(clear.at(-1)).toBe(2);
  return clear.subarray(0, -1);
}

afterEach(() => vi.restoreAllMocks());
describe('Web Push RFC 8291 encryption', () => {
  it('matches the RFC 8291 section 5 known ciphertext exactly', async () => {
    const publicBytes = bytes(senderPublic);
    const privateKey = await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', x: publicBytes.subarray(1, 33).toString('base64url'),
      y: publicBytes.subarray(33).toString('base64url'), d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = await crypto.subtle.importKey('raw', publicBytes, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    vi.spyOn(crypto.subtle, 'generateKey').mockResolvedValue({ privateKey, publicKey });
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array: any) => {
      array.set(bytes('DGv6ra1nlYgDCS1FRnbzlw')); return array;
    });
    const clear = Buffer.from('When I grow up, I want to be a watermelon');
    const result = await encryptWebPushPayload(clear, keys);
    expect(Buffer.from(result).toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
      'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
      'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
    expect(decrypt(result)).toEqual(clear);
  });
  it('round-trips binary and maximum payloads with fresh salts and ephemeral keys', async () => {
    const clear = new Uint8Array(3993).map((_, index) => index % 256);
    const first = await encryptWebPushPayload(clear, keys);
    const second = await encryptWebPushPayload(clear, keys);
    expect(first.length).toBe(4096);
    expect(decrypt(first)).toEqual(Buffer.from(clear));
    expect(decrypt(second)).toEqual(Buffer.from(clear));
    expect(first.subarray(0, 16)).not.toEqual(second.subarray(0, 16));
    expect(first.subarray(21, 86)).not.toEqual(second.subarray(21, 86));
    expect(decrypt(await encryptWebPushPayload(new Uint8Array(), keys))).toEqual(Buffer.alloc(0));
  });
  it('authenticates ciphertext and the subscription authentication secret', async () => {
    const body = await encryptWebPushPayload(Buffer.from('notification'), keys);
    expect(() => decrypt(body, Buffer.alloc(16).toString('base64url'))).toThrow();
    body[90] ^= 1;
    expect(() => decrypt(body)).toThrow();
  });
  it('rejects malformed encoding, short secrets, invalid curve points and oversized messages', async () => {
    const clear = new Uint8Array([1]);
    for (const p256dh of ['!', 'A', 'AAAA', Buffer.alloc(65, 4).toString('base64url')]) {
      await expect(encryptWebPushPayload(clear, { p256dh, auth })).rejects.toThrow();
    }
    await expect(encryptWebPushPayload(clear, { ...keys, auth: Buffer.alloc(15).toString('base64url') })).rejects.toThrow();
    await expect(encryptWebPushPayload(new Uint8Array(3994), keys)).rejects.toThrow('3993');
  });
});
