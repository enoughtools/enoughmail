import { importJWK, SignJWT as AdmissionJwt } from 'jose';
import {
  assertFreshness,
  computeCallbackRequestHash,
  computeOrderedContextHash,
  computeSha256Hex,
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
  parseStrictCompactJson,
  parseStrictEnvelope,
  parseStrictPrivateKeyJwk,
  readConfigurationFields,
} from './native-seed-admission-codec';

export interface NativeSeedAdmissionSigningEnv {
  NATIVE_SEED_ADMISSION_PRIVATE_JWK: string;
  NATIVE_SEED_ADMISSION_KEY_ID: string;
  NATIVE_SEED_ADMISSION_KEY_GENERATION: string;
  NATIVE_SEED_ADMISSION_INSTALLATION_ID: string;
  [key: string]: unknown;
}

export type NativeSeedAdmissionClaimsInput = NativeSeedAdmissionEnvelope;

/**
 * Signs a native seed admission JWT assertion.
 *
 * NOTE: The signer input represents trusted Core original verified context.
 * This module performs cryptographic signing, byte binding, and structural
 * serialization validation; it does NOT evaluate current policy or catalog authorization.
 */
export async function signNativeSeedAdmission(
  request: Request,
  env: NativeSeedAdmissionSigningEnv,
  input: NativeSeedAdmissionClaimsInput,
  rawBody: Uint8Array,
): Promise<string> {
  // Synchronous checks and detachment before first await

  // Check request method & URL
  if (request.method !== NATIVE_SEED_ADMISSION_METHOD) {
    failAdmission('invalid_request', `Expected method ${NATIVE_SEED_ADMISSION_METHOD}`);
  }
  const url = new URL(request.url);
  if (url.pathname !== NATIVE_SEED_ADMISSION_PATH || url.search !== '' || url.hash !== '') {
    failAdmission('invalid_request', `Expected exact path ${NATIVE_SEED_ADMISSION_PATH} with no query/fragment`);
  }

  // Detach rawBody bytes synchronously
  if (!(rawBody instanceof Uint8Array)) {
    failAdmission('invalid_request');
  }
  if (rawBody.byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxRawBodyBytes) failAdmission('invalid_request');
  const detachedBody = new Uint8Array(rawBody.byteLength);
  detachedBody.set(rawBody);

  if (detachedBody.byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxRawBodyBytes) {
    failAdmission('invalid_request', 'Raw body exceeds 112KiB limit');
  }

  // Check environment variables strictly
  if (!env || typeof env !== 'object') {
    failAdmission('invalid_configuration');
  }

  const config = readConfigurationFields(env, ['NATIVE_SEED_ADMISSION_PRIVATE_JWK', 'NATIVE_SEED_ADMISSION_KEY_ID', 'NATIVE_SEED_ADMISSION_KEY_GENERATION', 'NATIVE_SEED_ADMISSION_INSTALLATION_ID']);
  const rawPrivateJwk = config.NATIVE_SEED_ADMISSION_PRIVATE_JWK;
  const rawKeyId = config.NATIVE_SEED_ADMISSION_KEY_ID;
  const rawKeyGen = config.NATIVE_SEED_ADMISSION_KEY_GENERATION;
  const rawInstallationId = config.NATIVE_SEED_ADMISSION_INSTALLATION_ID;

  if (
    typeof rawPrivateJwk !== 'string' ||
    typeof rawKeyId !== 'string' ||
    typeof rawKeyGen !== 'string' ||
    typeof rawInstallationId !== 'string'
  ) {
    failAdmission('invalid_configuration', 'Missing required signing configuration');
  }

  const keyGenNum = Number(rawKeyGen);
  if (!Number.isSafeInteger(keyGenNum) || keyGenNum <= 0 || String(keyGenNum) !== rawKeyGen) {
    failAdmission('invalid_configuration', 'Invalid key generation');
  }

  const installationId = rawInstallationId;
  if ((!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(installationId) || installationId.length > 20)) {
    failAdmission('invalid_configuration', 'Invalid installation ID');
  }

  if (rawPrivateJwk.length > NATIVE_SEED_ADMISSION_LIMITS.maxConfigBytes) failAdmission('invalid_key');
  const privateJwkBytes = new TextEncoder().encode(rawPrivateJwk);
  if (privateJwkBytes.byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxConfigBytes) {
    failAdmission('invalid_key', 'Private JWK config exceeds size limit');
  }

  const { parsed: parsedPrivateJwk } = parseStrictCompactJson(
    privateJwkBytes,
    NATIVE_SEED_ADMISSION_LIMITS.maxConfigBytes,
    'invalid_key',
  );
  const privateJwk = parseStrictPrivateKeyJwk(parsedPrivateJwk, 'invalid_key');

  if (privateJwk.kid !== rawKeyId) {
    failAdmission('invalid_key', 'Configured key ID does not match private JWK kid');
  }

  // Parse raw body compact JSON and envelope
  const { parsed: parsedBody } = parseStrictCompactJson<Record<string, unknown>>(
    detachedBody,
    NATIVE_SEED_ADMISSION_LIMITS.maxRawBodyBytes,
    'invalid_envelope',
  );

  const parsedEnvelope = parseStrictEnvelope(parsedBody);
  const validatedInput = parseStrictEnvelope(input);

  // Signer ensures input and parsed rawBody binding match exactly
  if (JSON.stringify(parsedEnvelope) !== JSON.stringify(validatedInput)) {
    failAdmission('invalid_envelope', 'Input and rawBody envelope do not match');
  }

  // Validate expiry and iat
  const initialWallTime = Math.floor(Date.now() / 1000);
  const exp = validatedInput.expiresAt;
  const iat = exp - NATIVE_SEED_ADMISSION_LIFETIME_SECONDS;

  if (!isSafePositiveInt(exp)) {
    failAdmission('invalid_claims', 'Invalid expiresAt');
  }

  // Check freshness and reasonable future skew against current wall time
  if (initialWallTime >= exp) {
    failAdmission('token_expired', 'Token is already expired at signing time');
  }
  if (iat > initialWallTime + 5) {
    failAdmission('invalid_claims', 'Issued-at is too far in the future');
  }

  // Content validation
  if (hasLoneSurrogate(validatedInput.content)) {
    failAdmission('invalid_envelope', 'Lone surrogate in content');
  }
  const contentEncoded = new TextEncoder().encode(validatedInput.content);
  if (contentEncoded.byteLength !== validatedInput.contentBytes) {
    failAdmission('invalid_envelope', 'contentBytes mismatch');
  }

  // Asynchronous hashing and signing
  const computedContentHash = await computeSha256Hex(contentEncoded);
  if (computedContentHash !== validatedInput.contentHash) {
    failAdmission('invalid_envelope', 'contentHash mismatch');
  }

  const { contextHash: computedContextHash } = await computeOrderedContextHash(validatedInput);
  if (computedContextHash !== validatedInput.contextHash) {
    failAdmission('invalid_context', 'contextHash mismatch');
  }

  const computedCallbackRequestHash = await computeCallbackRequestHash(detachedBody);

  // Build audience derived strictly from trusted config and envelope
  const aud = `${installationId}:${validatedInput.ownerAppId}:native-seed-admission`;

  // Build exact claims object
  const claims: NativeSeedAdmissionClaims = {
    version: 1,
    purpose: NATIVE_SEED_ADMISSION_PURPOSE,
    iss: NATIVE_SEED_ADMISSION_ISS,
    aud,
    installationId,
    kidGeneration: keyGenNum,
    iat,
    exp,
    invocationId: validatedInput.invocationId,
    requestHash: computedCallbackRequestHash,
    contextHash: computedContextHash,
    contentHash: computedContentHash,
    contentBytes: validatedInput.contentBytes,
    organizationId: validatedInput.organizationId,
    workspaceId: validatedInput.workspaceId,
    actorId: validatedInput.actorId,
    principalBindingHash: validatedInput.principalBindingHash,
    resourceId: validatedInput.resourceId,
    parentId: validatedInput.parentId,
    mode: validatedInput.mode,
    action: validatedInput.action,
    ownerAppId: validatedInput.ownerAppId,
    installationFingerprint: validatedInput.installationFingerprint,
    admissionRevision: validatedInput.admissionRevision,
    admissionGeneration: validatedInput.admissionGeneration,
    provenanceContextId: validatedInput.provenanceContextId,
  };

  if (validatedInput.operation !== undefined) {
    claims.operation = {
      operationId: validatedInput.operation.operationId,
      attemptId: validatedInput.operation.attemptId,
      requestHash: validatedInput.operation.requestHash,
    };
  }

  const serializedClaims = JSON.stringify(claims);
  if (new TextEncoder().encode(serializedClaims).byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxPayloadBytes) failAdmission('invalid_claims');
  const claimsPayload = JSON.parse(serializedClaims);

  // Import key into jose (sanitized standard JWK fields only)
  const keyToImport = {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
    y: privateJwk.y,
    d: privateJwk.d,
  };

  let signingKey: CryptoKey;
  try {
    signingKey = (await importJWK(keyToImport, NATIVE_SEED_ADMISSION_ALG, {
      extractable: false,
    })) as CryptoKey;
  } catch {
    failAdmission('invalid_key', 'Failed to import private key');
  }

  const signer = new AdmissionJwt(claimsPayload)
    .setProtectedHeader({
      alg: NATIVE_SEED_ADMISSION_ALG,
      typ: NATIVE_SEED_ADMISSION_TYP,
      kid: privateJwk.kid,
    });

  let token: string;
  try {
    token = await signer.sign(signingKey);
  } catch {
    failAdmission('invalid_signature', 'JWT assertion could not be created');
  }

  if (new TextEncoder().encode(token).byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxAssertionBytes) {
    failAdmission('invalid_assertion', 'Assertion exceeds 8192 bytes');
  }

  // Final fresh wall time check immediately before return
  assertFreshness(exp);

  return token;
}

export { computeOrderedContextHash, NativeSeedAdmissionError } from './native-seed-admission-codec';
