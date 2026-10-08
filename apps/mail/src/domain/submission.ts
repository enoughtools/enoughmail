import { parseRecipients, validRecipient, validateDraftRecipients } from './recipients';
export const MAX_DELAYED_SEND_SECONDS = 89 * 86400;
interface Address { email: string; parameters?: Record<string, string | null> | null }
export interface SubmissionEnvelope { mailFrom: Address; rcptTo: Address[] }
export interface SubmissionPolicy { now?: number; maxDelayedSend?: number; allowEnoughScheduling?: boolean; defaultUndoSeconds?: number }
function address(input: unknown): string {
  if (typeof input !== 'string' || input.length > 254 || !/^[^\s<>@,;"\\\x00-\x1f\x7f]+@[^\s<>@,;"\\\x00-\x1f\x7f]+$/.test(input)) throw new Error('Invalid envelope address');
  return input;
}
function parameters(input: unknown): Record<string, string | null> {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid envelope parameters');
  const result: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = key.toUpperCase();
    if (!/^[A-Z][A-Z0-9-]*$/.test(normalized) || Object.hasOwn(result, normalized) || (value !== null && typeof value !== 'string')) throw new Error('Invalid envelope parameter');
    result[normalized] = value as string | null;
  }
  return result;
}

/** Validate standard submission envelope; legacy scheduling fields require negotiated Enough capability. */
export function validateSubmissionEnvelope(input: Record<string, any>, email: Record<string, any>, identity: Record<string, any>, policy: SubmissionPolicy = {}): { envelope: SubmissionEnvelope; sendAt: string } {
  validateDraftRecipients(email.draftRecipients);
  if(email.draftRecipients && Object.values(email.draftRecipients).some(value=>parseRecipients(value as string).some(address=>!validRecipient(address.email))))throw new Error('Finish or remove incomplete recipient addresses before sending.');
  const now = policy.now ?? Date.now(), maximum = policy.maxDelayedSend ?? MAX_DELAYED_SEND_SECONDS;
  if (('sendAt' in input || 'undoSeconds' in input) && !policy.allowEnoughScheduling) throw new Error('sendAt is server set; use negotiated future release parameters');
  const raw = input.envelope;
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error('Invalid submission envelope');
  if (raw && (!raw.mailFrom || typeof raw.mailFrom !== 'object' || Array.isArray(raw.mailFrom) || !Array.isArray(raw.rcptTo))) throw new Error('Envelope requires mailFrom and rcptTo');
  const sender = address(raw?.mailFrom?.email ?? identity.email);
  if (sender.toLowerCase() !== String(identity.email).toLowerCase()) throw new Error('Envelope sender does not match authorized identity');
  const mailParameters = parameters(raw?.mailFrom?.parameters);
  for (const name of Object.keys(mailParameters)) if (!['HOLDFOR', 'HOLDUNTIL'].includes(name)) throw new Error(`Unsupported submission extension: ${name}`);
  if (Object.hasOwn(mailParameters, 'HOLDFOR') && Object.hasOwn(mailParameters, 'HOLDUNTIL')) throw new Error('Use one future release parameter');
  const recipients = raw?.rcptTo ?? [...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])];
  if (!Array.isArray(recipients) || !recipients.length || recipients.length > 50) throw new Error('Submission requires 1 to 50 recipients');
  const rcptTo = recipients.map((recipient: any): Address => {
    if (!recipient || typeof recipient !== 'object') throw new Error('Invalid envelope recipient');
    if (Object.keys(parameters(recipient.parameters)).length) throw new Error('Unsupported recipient submission extension');
    return { email: address(recipient.email), parameters: null };
  });
  let scheduled = now;
  if (Object.hasOwn(mailParameters, 'HOLDFOR')) {
    const interval = mailParameters.HOLDFOR;
    if (typeof interval !== 'string' || !/^[1-9][0-9]{0,8}$/.test(interval) || Number(interval) > maximum) throw new Error('Invalid HOLDFOR interval');
    scheduled = now + Number(interval) * 1000;
  } else if (Object.hasOwn(mailParameters, 'HOLDUNTIL')) {
    const date = mailParameters.HOLDUNTIL;
    if (typeof date !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(date)) throw new Error('Invalid HOLDUNTIL UTC timestamp');
    scheduled = Date.parse(date);
    if (!Number.isFinite(scheduled) || new Date(scheduled).toISOString().replace('.000Z', 'Z') !== date || scheduled < now || scheduled - now > maximum * 1000) throw new Error('HOLDUNTIL exceeds release limits');
  } else if (policy.allowEnoughScheduling) {
    const undo = input.undoSeconds ?? policy.defaultUndoSeconds ?? 10;
    if (!Number.isInteger(undo) || undo < 0 || undo > 60) throw new Error('Invalid undo interval');
    scheduled = input.sendAt !== undefined ? Date.parse(input.sendAt) : now + undo * 1000;
    if (!Number.isFinite(scheduled) || scheduled < now || scheduled - now > maximum * 1000) throw new Error('Invalid scheduled time');
  }
  return { envelope: { mailFrom: { email: sender, parameters: Object.keys(mailParameters).length ? mailParameters : null }, rcptTo }, sendAt: new Date(scheduled).toISOString() };
}
