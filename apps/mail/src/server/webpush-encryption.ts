/** RFC 8291 Web Push encryption, using only the Workers Web Crypto API. */
export async function encryptWebPushPayload(
  payload: Uint8Array,
  keys: { p256dh: string; auth: string },
): Promise<Uint8Array> {
  // RFC 8030's universally supported 4096-byte body includes 86 header bytes
  // and 17 bytes for the final-record delimiter and authentication tag.
  if (payload.byteLength > 3993) throw new Error('Web Push payload exceeds 3993 bytes');
  const receiverPublic = decodeKey(keys.p256dh);
  const auth = decodeKey(keys.auth);
  if (receiverPublic.length !== 65 || receiverPublic[0] !== 4) throw new Error('Invalid Web Push P-256 public key');
  if (auth.length < 16) throw new Error('Invalid Web Push authentication secret');
  // importKey verifies that the supplied uncompressed point is on P-256.
  const receiverKey = await crypto.subtle.importKey('raw', buffer(receiverPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sender = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverKey }, sender.privateKey, 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(shared, auth, concat(encode('WebPush: info\0'), receiverPublic, senderPublic), 32);
  const [cek, nonce] = await Promise.all([
    hkdf(ikm, salt, encode('Content-Encoding: aes128gcm\0'), 16),
    hkdf(ikm, salt, encode('Content-Encoding: nonce\0'), 12),
  ]);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, buffer(concat(payload, new Uint8Array([2])))));
  const header = new Uint8Array(86);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = 65;
  header.set(senderPublic, 21);
  return concat(header, ciphertext);
}

function decodeKey(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error('Invalid Web Push base64url key');
  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1 || (value.includes('=') && value.length % 4 !== 0)) throw new Error('Invalid Web Push base64url key');
  let decoded: string;
  try { decoded = atob(unpadded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - unpadded.length % 4) % 4)); }
  catch { throw new Error('Invalid Web Push base64url key'); }
  // Reject noncanonical encodings (nonzero unused bits).
  if (btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== unpadded) throw new Error('Invalid Web Push base64url key');
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

function encode(value: string): Uint8Array { return new TextEncoder().encode(value); }
function buffer(value: Uint8Array): ArrayBuffer { return new Uint8Array(value).buffer; }
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
async function hkdf(ikm: ArrayBuffer, salt: Uint8Array, info: Uint8Array, length: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buffer(salt), info: buffer(info) }, key, length * 8);
}
