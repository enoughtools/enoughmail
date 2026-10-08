import type { Email } from './jmap';
import { inlineImageParts } from './inline-images';

type MessageBody = Pick<Email, 'textBody' | 'htmlBody' | 'bodyValues' | 'attachments'>;

/** Body lists can contain related MIME media; binary body values are never prose. */
export function messageHtml(email: MessageBody): string {
  return (email.htmlBody || []).filter(part => part.type.toLowerCase() === 'text/html')
    .map(part => email.bodyValues?.[part.partId || '']?.value || '').join('\n');
}
export function messagePlainText(email: MessageBody): string {
  return (email.textBody || []).filter(part => part.type.toLowerCase() === 'text/plain')
    .map(part => email.bodyValues?.[part.partId || '']?.value || '').join('\n\n');
}
export function messageInlineImageParts(email: MessageBody) {
  return inlineImageParts([...(email.attachments || []), ...(email.htmlBody || []), ...(email.textBody || [])]);
}
