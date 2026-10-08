import { importJWK, jwtVerify } from 'jose';
import {
  assertFreshness,
  checkOwnPlainData,
  decodeCanonicalBase64Url,
  readConfigurationFields,
  computeCallbackRequestHash,
  computeOrderedContextHash,
  computeSha256Hex,
  deepFreeze,
  failAdmission,
  hasLoneSurrogate,
  isSafePositiveInt,
  NATIVE_SEED_ADMISSION_ALG,
  NATIVE_SEED_ADMISSION_HEADER,
  NATIVE_SEED_ADMISSION_ISS,
  NATIVE_SEED_ADMISSION_LIFETIME_SECONDS,
  NATIVE_SEED_ADMISSION_LIMITS,
  NATIVE_SEED_ADMISSION_METHOD,
  NATIVE_SEED_ADMISSION_PATH,
  NATIVE_SEED_ADMISSION_PURPOSE,
  NATIVE_SEED_ADMISSION_TYP,
  NativeSeedAdmissionClaims,
  NativeSeedAdmissionEnvelope,
  NativeSeedAdmissionInstallationContext,
  parseStrictClaims,
  parseStrictCompactJson,
  parseStrictEnvelope,
  parseStrictInstallationContext,
  parseStrictPublicRing,
} from './native-seed-admission-codec';

export {
  assertFreshness,
  parseStrictInstallationContext,
  type NativeSeedAdmissionClaims,
  type NativeSeedAdmissionEnvelope,
  type NativeSeedAdmissionInstallationContext,
};

export interface NativeSeedAdmissionVerificationEnv {
  NATIVE_SEED_ADMISSION_PUBLIC_JWKS: string;
  NATIVE_SEED_ADMISSION_INSTALLATION_ID: string;
  [key: string]: unknown;
}

export interface VerifyNativeSeedAdmissionOptions {
  audience: string;
  expectedInstallation: NativeSeedAdmissionInstallationContext;
  rawBody: Uint8Array;
}

export interface VerifiedNativeSeedAdmission {
  claims: Readonly<NativeSeedAdmissionClaims>;
  envelope: Readonly<NativeSeedAdmissionEnvelope>;
}

/** Parse trusted verification configuration using the verifier's exact public-ring grammar. */
export function parseNativeSeedAdmissionPublicKeyRing(rawPublicJwks: string) {
  if (typeof rawPublicJwks !== 'string') failAdmission('invalid_key');
  if (rawPublicJwks.length > NATIVE_SEED_ADMISSION_LIMITS.maxRingBytes) failAdmission('invalid_key');
  const publicRingBytes = new TextEncoder().encode(rawPublicJwks);
  if (publicRingBytes.byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxRingBytes) {
    failAdmission('invalid_key', 'Public ring exceeds size limit');
  }

  const { parsed: parsedRing } = parseStrictCompactJson(
    publicRingBytes,
    NATIVE_SEED_ADMISSION_LIMITS.maxRingBytes,
    'invalid_key',
  );
  const publicRing = parseStrictPublicRing(parsedRing, 'invalid_key');

  return publicRing;
}

/** Check every configured public key using the same import as signature verification. */
export async function validateNativeSeedAdmissionPublicKeyRing(rawPublicJwks: string) {
  const ring = parseNativeSeedAdmissionPublicKeyRing(rawPublicJwks);
  for (const key of ring.keys) await importNativeSeedAdmissionPublicKey(key);
  return ring;
}

async function importNativeSeedAdmissionPublicKey(
  matchingKey: ReturnType<typeof parseNativeSeedAdmissionPublicKeyRing>['keys'][number],
): Promise<CryptoKey> {
  const keyToImport = {
    kty: matchingKey.kty,
    crv: matchingKey.crv,
    x: matchingKey.x,
    y: matchingKey.y,
  };

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = (await importJWK(keyToImport, NATIVE_SEED_ADMISSION_ALG, {
      extractable: false,
    })) as CryptoKey;
  } catch {
    failAdmission('invalid_key', 'Failed to import public key');
  }

  return cryptoKey;
}

/**
 * Verifies a native seed admission JWT assertion and body.
 * Returns detached, deeply frozen { claims, envelope } only.
 * NEVER returns an allow / permission / control token.
 */
export async function verifyNativeSeedAdmission(
  request: Request,
  env: NativeSeedAdmissionVerificationEnv,
  options: VerifyNativeSeedAdmissionOptions,
): Promise<VerifiedNativeSeedAdmission> {
  // Synchronous checks and detachment before first await

  // Check request method & URL
  if (request.method !== NATIVE_SEED_ADMISSION_METHOD) {
    failAdmission('invalid_request', `Expected method ${NATIVE_SEED_ADMISSION_METHOD}`);
  }
  const url = new URL(request.url);
  if (url.pathname !== NATIVE_SEED_ADMISSION_PATH || url.search !== '' || url.hash !== '') {
    failAdmission('invalid_request', `Expected exact path ${NATIVE_SEED_ADMISSION_PATH} with no query/fragment`);
  }

  const detachedOptions = checkOwnPlainData(options, ['audience', 'expectedInstallation', 'rawBody'], ['audience', 'expectedInstallation', 'rawBody'], 'invalid_configuration');
  // Detach rawBody bytes synchronously
  if (!options || typeof options !== 'object' || !(detachedOptions.rawBody instanceof Uint8Array)) {
    failAdmission('invalid_request');
  }
  if (detachedOptions.rawBody.byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxRawBodyBytes) failAdmission('invalid_request');
  const detachedBody = new Uint8Array(detachedOptions.rawBody.byteLength);
  detachedBody.set(detachedOptions.rawBody);

  if (detachedBody.byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxRawBodyBytes) {
    failAdmission('invalid_request', 'Raw body exceeds 112KiB limit');
  }

  // Validate environment strictly: MUST reject any private key or signer material
  if (!env || typeof env !== 'object') {
    failAdmission('configuration_unavailable');
  }

  if (
    'NATIVE_SEED_ADMISSION_PRIVATE_JWK' in env ||
    'NATIVE_SEED_ADMISSION_KEY_ID' in env ||
    'NATIVE_SEED_ADMISSION_KEY_GENERATION' in env
  ) {
    // Fail closed without logging values
    failAdmission('invalid_configuration', 'Verification environment must not contain private key or signer parameters');
  }

  const config = readConfigurationFields(env, ['NATIVE_SEED_ADMISSION_PUBLIC_JWKS', 'NATIVE_SEED_ADMISSION_INSTALLATION_ID'], ['NATIVE_SEED_ADMISSION_PRIVATE_JWK', 'NATIVE_SEED_ADMISSION_KEY_ID', 'NATIVE_SEED_ADMISSION_KEY_GENERATION']);
  const rawPublicJwks = config.NATIVE_SEED_ADMISSION_PUBLIC_JWKS;
  const rawInstallationId = config.NATIVE_SEED_ADMISSION_INSTALLATION_ID;

  if (typeof rawPublicJwks !== 'string' || typeof rawInstallationId !== 'string') {
    failAdmission('configuration_unavailable', 'Missing public JWKS or installation ID configuration');
  }

  const expectedInstallationId = rawInstallationId;
  if ((!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(expectedInstallationId) || expectedInstallationId.length > 20)) {
    failAdmission('invalid_configuration', 'Invalid installation ID format in env');
  }

  const publicRing = parseNativeSeedAdmissionPublicKeyRing(rawPublicJwks);

  // Validate expected installation options
  if (!detachedOptions.expectedInstallation || typeof detachedOptions.expectedInstallation !== 'object') {
    failAdmission('invalid_configuration', 'Missing expectedInstallation');
  }
  const expectedInstall = parseStrictInstallationContext(
    detachedOptions.expectedInstallation,
    'invalid_configuration',
  );

  if (expectedInstall.installationId !== expectedInstallationId) {
    failAdmission('invalid_configuration', 'Config installation ID does not match expected installation ID');
  }

  // Validate expected audience
  if (typeof detachedOptions.audience !== 'string' || !detachedOptions.audience) {
    failAdmission('invalid_configuration', 'Missing expected audience');
  }
  const expectedAudience = detachedOptions.audience;
  if (expectedAudience !== `${expectedInstall.installationId}:${expectedInstall.ownerAppId}:native-seed-admission`) failAdmission('invalid_configuration');

  // Extract assertion from exact header
  const token = request.headers.get(NATIVE_SEED_ADMISSION_HEADER);
  if (!token) {
    failAdmission('invalid_assertion', 'Missing seed admission header');
  }

  const tokenBytes = new TextEncoder().encode(token);
  if (tokenBytes.byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxAssertionBytes) {
    failAdmission('invalid_assertion', 'Assertion exceeds 8192 bytes');
  }

  // Exact 3 unpadded canonical base64url segments
  const segments = token.split('.');
  if (segments.length !== 3) {
    failAdmission('invalid_assertion', 'Token must have exactly 3 segments');
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (!headerSegment || !payloadSegment || !signatureSegment) {
    failAdmission('invalid_assertion', 'Empty segment in token');
  }

  decodeCanonicalBase64Url(signatureSegment, 'invalid_assertion', 64);
  // Decode header segment
  const headerBytes = decodeCanonicalBase64Url(headerSegment, 'invalid_assertion');
  const { parsed: headerParsed } = parseStrictCompactJson<Record<string, unknown>>(
    headerBytes,
    1024,
    'invalid_assertion',
  );

  // Exact protected header fields: alg, typ, kid
  if (
    typeof headerParsed !== 'object' ||
    headerParsed === null ||
    Array.isArray(headerParsed) ||
    Object.keys(headerParsed).length !== 3 ||
    headerParsed.alg !== NATIVE_SEED_ADMISSION_ALG ||
    headerParsed.typ !== NATIVE_SEED_ADMISSION_TYP ||
    typeof headerParsed.kid !== 'string'
  ) {
    failAdmission('invalid_assertion', 'Invalid protected header');
  }

  const kid = headerParsed.kid;

  // Match kid in public ring
  const matchingKey = publicRing.keys.find((k) => k.kid === kid);
  if (!matchingKey) {
    failAdmission('invalid_key', 'Unknown key ID');
  }

  // Decode payload segment
  const payloadBytes = decodeCanonicalBase64Url(payloadSegment, 'invalid_assertion');
  if (payloadBytes.byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxPayloadBytes) {
    failAdmission('invalid_claims', 'Payload exceeds 6144 bytes limit');
  }

  const { parsed: payloadParsed } = parseStrictCompactJson<Record<string, unknown>>(
    payloadBytes,
    NATIVE_SEED_ADMISSION_LIMITS.maxPayloadBytes,
    'invalid_claims',
  );

  const claims = parseStrictClaims(payloadParsed);

  // Check matching kid generation
  if (claims.kidGeneration !== matchingKey.generation) {
    failAdmission('invalid_claims', 'Key generation mismatch');
  }

  // Check audience and installationId
  if (claims.aud !== expectedAudience) {
    failAdmission('invalid_claims', 'Audience mismatch');
  }
  if (claims.installationId !== expectedInstallationId) {
    failAdmission('invalid_claims', 'Installation ID mismatch');
  }

  // Check time bounds
  const wallNow = Math.floor(Date.now() / 1000);
  if (wallNow >= claims.exp) {
    failAdmission('token_expired', 'Assertion is expired');
  }
  if (claims.iat > wallNow + 5) {
    failAdmission('invalid_claims', 'Assertion issued in future');
  }

  // Parse raw body compact JSON
  const { parsed: parsedBody } = parseStrictCompactJson<Record<string, unknown>>(
    detachedBody,
    NATIVE_SEED_ADMISSION_LIMITS.maxRawBodyBytes,
    'invalid_envelope',
  );

  const envelope = parseStrictEnvelope(parsedBody);

  // Cross-compare envelope and expected installation
  if (envelope.organizationId !== expectedInstall.organizationId) {
    failAdmission('invalid_envelope', 'Organization ID mismatch');
  }
  if (envelope.workspaceId !== expectedInstall.workspaceId) {
    failAdmission('invalid_envelope', 'Workspace ID mismatch');
  }
  if (envelope.ownerAppId !== expectedInstall.ownerAppId) {
    failAdmission('invalid_envelope', 'Owner app ID mismatch');
  }
  if (envelope.installationFingerprint !== expectedInstall.installationFingerprint) {
    failAdmission('invalid_envelope', 'Installation fingerprint mismatch');
  }
  if (envelope.schemaId !== expectedInstall.schemaId) {
    failAdmission('invalid_envelope', 'Schema ID mismatch');
  }
  if (envelope.schemaVersion !== expectedInstall.schemaVersion) {
    failAdmission('invalid_envelope', 'Schema version mismatch');
  }
  if (envelope.admissionRevision !== expectedInstall.admissionRevision) {
    failAdmission('invalid_envelope', 'Admission revision mismatch');
  }
  if (envelope.admissionGeneration !== expectedInstall.admissionGeneration) {
    failAdmission('invalid_envelope', 'Admission generation mismatch');
  }
  if (!expectedInstall.mimeTypes.includes(envelope.mimeType)) {
    failAdmission('invalid_envelope', 'MIME type not allowed by expected installation');
  }

  // Cross-compare claims and envelope
  if (claims.invocationId !== envelope.invocationId) failAdmission('invalid_envelope');
  if (claims.exp !== envelope.expiresAt) failAdmission('invalid_envelope');
  if (claims.organizationId !== envelope.organizationId) failAdmission('invalid_envelope');
  if (claims.workspaceId !== envelope.workspaceId) failAdmission('invalid_envelope');
  if (claims.actorId !== envelope.actorId) failAdmission('invalid_envelope');
  if (claims.principalBindingHash !== envelope.principalBindingHash) failAdmission('invalid_envelope');
  if (claims.resourceId !== envelope.resourceId) failAdmission('invalid_envelope');
  if (claims.parentId !== envelope.parentId) failAdmission('invalid_envelope');
  if (claims.mode !== envelope.mode) failAdmission('invalid_envelope');
  if (claims.action !== envelope.action) failAdmission('invalid_envelope');
  if (claims.ownerAppId !== envelope.ownerAppId) failAdmission('invalid_envelope');
  if (claims.installationFingerprint !== envelope.installationFingerprint) failAdmission('invalid_envelope');
  if (claims.admissionRevision !== envelope.admissionRevision) failAdmission('invalid_envelope');
  if (claims.admissionGeneration !== envelope.admissionGeneration) failAdmission('invalid_envelope');
  if (claims.provenanceContextId !== envelope.provenanceContextId) failAdmission('invalid_envelope');
  if (claims.contextHash !== envelope.contextHash) failAdmission('invalid_envelope');
  if (claims.contentHash !== envelope.contentHash) failAdmission('invalid_envelope');
  if (claims.contentBytes !== envelope.contentBytes) failAdmission('invalid_envelope');

  // Compare operation if present
  if (envelope.operation !== undefined) {
    if (claims.operation === undefined) failAdmission('invalid_envelope');
    if (claims.operation.operationId !== envelope.operation.operationId) failAdmission('invalid_envelope');
    if (claims.operation.attemptId !== envelope.operation.attemptId) failAdmission('invalid_envelope');
    if (claims.operation.requestHash !== envelope.operation.requestHash) failAdmission('invalid_envelope');
    // Nested operation requestHash MUST equal original envelope.requestHash
    if (envelope.operation.requestHash !== envelope.requestHash) failAdmission('invalid_envelope');
  } else {
    if (claims.operation !== undefined) failAdmission('invalid_envelope');
  }

  // Async hash recomputations and verification

  // 1. Content recomputation
  if (hasLoneSurrogate(envelope.content)) {
    failAdmission('invalid_envelope', 'Lone surrogate in content');
  }
  const contentEncoded = new TextEncoder().encode(envelope.content);
  if (contentEncoded.byteLength !== envelope.contentBytes) {
    failAdmission('invalid_envelope', 'contentBytes mismatch');
  }
  const recomputedContentHash = await computeSha256Hex(contentEncoded);
  if (recomputedContentHash !== envelope.contentHash) {
    failAdmission('invalid_envelope', 'contentHash mismatch');
  }

  // 2. Context recomputation
  const { contextHash: recomputedContextHash } = await computeOrderedContextHash(envelope);
  if (recomputedContextHash !== envelope.contextHash) {
    failAdmission('invalid_context', 'contextHash mismatch');
  }

  // 3. Callback requestHash recomputation
  const recomputedCallbackHash = await computeCallbackRequestHash(detachedBody);
  if (recomputedCallbackHash !== claims.requestHash) {
    failAdmission('invalid_claims', 'Callback requestHash mismatch');
  }

  // 4. Crypto verification using jose jwtVerify with dedicated public key
  const cryptoKey = await importNativeSeedAdmissionPublicKey(matchingKey);

  try {
    await jwtVerify(token, cryptoKey, {
      algorithms: [NATIVE_SEED_ADMISSION_ALG],
      issuer: NATIVE_SEED_ADMISSION_ISS,
      audience: expectedAudience,
      typ: NATIVE_SEED_ADMISSION_TYP,
    });
  } catch {
    failAdmission('invalid_signature', 'Cryptographic signature verification failed');
  }

  // Fresh wall time check after crypto await and immediately before return
  assertFreshness(claims.exp);

  // Return detached deeply frozen { claims, envelope } only
  const claimsClone: NativeSeedAdmissionClaims = JSON.parse(JSON.stringify(claims));
  const envelopeClone: NativeSeedAdmissionEnvelope = JSON.parse(JSON.stringify(envelope));

  return deepFreeze({
    claims: claimsClone,
    envelope: envelopeClone,
  });
}

export { NativeSeedAdmissionError } from './native-seed-admission-codec';
