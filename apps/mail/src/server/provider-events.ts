/** Official Cloudflare Email Sending queue schema, version 1. No public webhook accepts these events. */
import { validAddress, type DeliveryResult } from './delivery';
export type RecipientDeliveryStatus = 'queued' | 'delivered' | 'deferred' | 'bounced' | 'failed' | 'rejected' | 'complained' | 'suppressed' | 'unknown';
export interface RecipientDelivery {
  status: RecipientDeliveryStatus; terminal: boolean; updatedAt: string;
  providerId?: string; eventId?: string; smtpStatusCode?: string; smtpEnhancedStatusCode?: string; reason?: string;
}
export interface ProviderDeliveryEvent {
  eventId: string; providerId: string; sender: string; recipient: string; domain: string; zoneId: string;
  status: Exclude<RecipientDeliveryStatus, 'queued' | 'suppressed' | 'unknown'>; terminal: boolean;
  timestamp: string; subscriptionId: string; smtpStatusCode?: string; smtpEnhancedStatusCode?: string; reason?: string;
}
export interface ProviderEventEnvironment { CF_ACCOUNT_ID?: string; MAIL_DELIVERY_EVENT_SUBSCRIPTION_IDS?: string }
const statuses = ['delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained'] as const;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalidProviderEvent'); return value as Record<string, unknown>;
};
const bounded = (value: unknown, max = 1024): string => {
  if (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error('invalidProviderEvent'); return value;
};
/** Must only be invoked for the configured Cloudflare event Queue; JSON fields alone are not origin authentication. */
export function parseProviderDeliveryEvent(body: unknown, env: ProviderEventEnvironment): ProviderDeliveryEvent {
  if (!env.CF_ACCOUNT_ID || !env.MAIL_DELIVERY_EVENT_SUBSCRIPTION_IDS) throw new Error('providerEventsNotConfigured');
  if (JSON.stringify(body).length > 128 * 1024) throw new Error('providerEventTooLarge');
  const event = object(body); const source = object(event.source); const payload = object(event.payload); const metadata = object(event.metadata);
  if (source.type !== 'email.sending' || metadata.accountId !== env.CF_ACCOUNT_ID || metadata.eventSchemaVersion !== 1) throw new Error('providerEventScopeMismatch');
  const subscriptionId = bounded(metadata.eventSubscriptionId, 128);
  if (!env.MAIL_DELIVERY_EVENT_SUBSCRIPTION_IDS.split(',').map(v => v.trim()).filter(Boolean).includes(subscriptionId)) throw new Error('providerEventScopeMismatch');
  const type = bounded(event.type, 128); const status = type.replace(/^cf\.email\.sending\.message\./, '');
  if (!type.startsWith('cf.email.sending.message.') || !statuses.includes(status as typeof statuses[number])) throw new Error('unsupportedProviderEvent');
  const delivery = object(payload.delivery);
  if (delivery.status !== status || payload.terminal !== (status !== 'deferred')) throw new Error('invalidProviderEvent');
  const sender = bounded(payload.sender, 254).toLowerCase(); const recipient = bounded(payload.recipient, 254).toLowerCase();
  const domain = bounded(source.domain, 253).toLowerCase().replace(/\.$/, '');
  if (!validAddress(sender) || !validAddress(recipient) || sender.slice(sender.lastIndexOf('@') + 1) !== domain) throw new Error('providerEventScopeMismatch');
  const timestamp = bounded(metadata.eventTimestamp, 64);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('invalidProviderEvent');
  const reasonGroup = payload.bounce ?? payload.failure ?? payload.rejection ?? payload.complaint;
  const reasonObject = reasonGroup ? object(reasonGroup) : {};
  return { eventId: bounded(payload.eventId, 128), providerId: bounded(payload.messageId, 1024), sender, recipient, domain,
    zoneId: bounded(source.zoneId, 128), status: status as ProviderDeliveryEvent['status'], terminal: payload.terminal as boolean,
    timestamp, subscriptionId,
    ...(typeof delivery.smtpStatusCode === 'string' ? { smtpStatusCode: bounded(delivery.smtpStatusCode, 16) } : {}),
    ...(typeof delivery.smtpEnhancedStatusCode === 'string' ? { smtpEnhancedStatusCode: bounded(delivery.smtpEnhancedStatusCode, 32) } : {}),
    ...(typeof reasonObject.reason === 'string' ? { reason: bounded(reasonObject.reason, 1024) } : typeof reasonObject.type === 'string' ? { reason: bounded(reasonObject.type, 128) } : {}),
  };
}
/** Durable account transaction separately deduplicates eventId and checks providerId/envelope recipient membership. */
export function mergeRecipientDelivery(previous: RecipientDelivery | undefined, event: ProviderDeliveryEvent): RecipientDelivery {
  if (previous?.eventId === event.eventId) return previous;
  if (previous?.status === 'complained') return previous;
  if (previous?.terminal && !event.terminal) return previous;
  if (previous && Date.parse(previous.updatedAt) > Date.parse(event.timestamp) && event.status !== 'complained') return previous;
  return { status: event.status, terminal: event.terminal, updatedAt: event.timestamp, providerId: event.providerId, eventId: event.eventId,
    ...(event.smtpStatusCode ? { smtpStatusCode: event.smtpStatusCode } : {}),
    ...(event.smtpEnhancedStatusCode ? { smtpEnhancedStatusCode: event.smtpEnhancedStatusCode } : {}), ...(event.reason ? { reason: event.reason } : {}) };
}
export function initialRecipientDelivery(recipients: string[], result: DeliveryResult, timestamp = new Date().toISOString()): Record<string, RecipientDelivery> {
  return Object.fromEntries(recipients.map(address => {
    const recipient = address.toLowerCase(); const contains = (values?: string[]) => values?.some(v => v.toLowerCase() === recipient);
    const status: RecipientDeliveryStatus = contains(result.permanentBounces) ? 'bounced' : contains(result.suppressed) ? 'suppressed'
      : contains(result.delivered) ? 'delivered' : contains(result.queued) ? 'queued' : result.status === 'rejected' ? 'rejected' : 'unknown';
    return [recipient, { status, terminal: ['bounced', 'suppressed', 'delivered', 'rejected'].includes(status), updatedAt: timestamp,
      ...(result.providerId ? { providerId: result.providerId } : {}), ...(result.error ? { reason: result.error } : {}) }];
  }));
}
