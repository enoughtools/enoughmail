/** Mail-owned reusable signature library. HTML is untrusted content, sanitized by renderers. */
export interface MailSignature { id: string; name: string; text: string; html: string }
export function validateSignatures(value: unknown): MailSignature[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Use no more than 100 signatures.');
  const ids = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['id','name','text','html'].includes(key))) throw new Error('Invalid signature fields.');
    const { id, name, text, html } = entry;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || ['__proto__','prototype','constructor'].includes(id) || ids.has(id)) throw new Error('Signature IDs must be unique.');
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || typeof text !== 'string' || text.length > 100000 || typeof html !== 'string' || html.length > 200000) throw new Error('Add a signature name and keep its content within the size limit.');
    ids.add(id); return { id, name: name.trim(), text, html };
  });
}
export function validateSignatureReference(value: unknown, library: readonly MailSignature[]): void {
  if (value !== undefined && value !== null && (typeof value !== 'string' || !library.some(signature => signature.id === value))) throw new Error('Choose a signature from this inbox or select no default signature.');
}
export function validateSignatureRemoval(library: readonly MailSignature[], identities: readonly { id?: string; signatureId?: unknown }[]): void {
  for (const identity of identities) validateSignatureReference(identity.signatureId, library);
}
