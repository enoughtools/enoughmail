/** Private service protocol for identity admission, accounts, grants and bounded job leases.
 * Core and standalone Mail implement the same interface. Never expose it as an HTTP route.
 */
export interface MailAuthority { fetch(request: Request): Promise<Response> }
export interface MailAuthorityNamespace { idFromName(name: string): unknown; get(id: unknown): MailAuthority }
export interface MailAuthorityEnvironment {
  /** Request-scoped service adapter supplied by the composition root. */
  MAIL_AUTHORITY_SERVICE?: MailAuthority;
  /** Compatibility adapter for integrated installations. */
  CORE?: MailAuthority;
  MAIL_AUTHORITY?: MailAuthorityNamespace;
}
export function mailAuthority(env: MailAuthorityEnvironment): MailAuthority | undefined {
  return env.MAIL_AUTHORITY_SERVICE ?? (env.MAIL_AUTHORITY ? env.MAIL_AUTHORITY.get(env.MAIL_AUTHORITY.idFromName('authority-v1')) : env.CORE);
}
