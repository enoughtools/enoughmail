import { describe, expect, it } from 'vitest';
import { messageHtml, messageInlineImageParts, messagePlainText } from '../apps/mail/src/ui/message-body';

describe('Real MIME reader body lists', () => {
  const image = { partId: 'related-1', blobId: 'image-blob', cid: '<logo@example.test>', type: 'image/png', size: 68 };
  const email = {
    textBody: [{ partId: 'plain', blobId: 'plain-blob', type: 'text/plain', size: 10 }, image],
    htmlBody: [{ partId: 'html', blobId: 'html-blob', type: 'text/html', size: 40 }, image],
    attachments: [],
    bodyValues: { plain: { value: 'Hello' }, html: { value: '<p>Hello</p><img src="cid:logo@example.test">' }, 'related-1': { value: 'binary image data is not prose' } },
  };
  it('keeps related images out of both displayed body formats', () => {
    expect(messagePlainText(email)).toBe('Hello');
    expect(messageHtml(email)).toBe('<p>Hello</p><img src="cid:logo@example.test">');
  });
  it('loads a related image once even when it appears in both MIME body lists', () => {
    expect(messageInlineImageParts(email)).toEqual([image]);
    expect(messageInlineImageParts({ ...email, attachments: [image] })).toEqual([image]);
  });
});
