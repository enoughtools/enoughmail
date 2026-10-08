import type { BodyPart, Email } from './jmap';
import { messageHtml } from './message-body';

export const replySubject = (subject: string) => /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
export const forwardSubject = (subject: string) => /^fwd?\s*:/i.test(subject) ? subject : `Fwd: ${subject}`;
export const escapeComposeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const composeTextHtml = (value: string) => escapeComposeText(value).replace(/\n/g, '<br>');

/** JMAP can include inline media in both body lists rather than attachments. */
export function composeSourceAttachments(email: Email): BodyPart[] {
  const parts = [...(email.attachments || []), ...[...(email.textBody || []), ...(email.htmlBody || [])].filter(part => part.cid && part.blobId && !part.type.startsWith('text/'))];
  return parts.filter((part, index) => parts.findIndex(candidate => candidate.blobId === part.blobId && candidate.cid === part.cid) === index);
}

/** Full body values are hydrated by loadComposeEmail before this is called. */
export function quoteMessage(email: Email, mode: 'reply' | 'forward', plain: string): { html: string; body: string } {
  const source = document.createElement('template'); source.innerHTML = messageHtml(email) || composeTextHtml(plain);
  source.content.querySelectorAll('[data-mail-authored-image]').forEach(image=>image.removeAttribute('data-mail-authored-image'));
  const html = source.innerHTML;
  const from = (email.from || []).map(address => address.name ? `${address.name} <${address.email}>` : address.email).join(', ');
  const date = new Date(email.receivedAt).toLocaleString();
  const heading = mode === 'reply' ? `On ${date}, ${from} wrote:` : `---------- Forwarded message ----------\nFrom: ${from}\nDate: ${date}\nSubject: ${email.subject}\nTo: ${(email.to || []).map(address => address.email).join(', ')}`;
  return {
    body: `${heading}\n${mode === 'reply' ? plain.split('\n').map(line => `> ${line}`).join('\n') : plain}`,
    html: `<div data-mail-quote="true"><p>${composeTextHtml(heading)}</p><blockquote>${html}</blockquote></div>`,
  };
}

const allowedTags = new Set('A B I U STRONG EM S P DIV BR UL OL LI BLOCKQUOTE SPAN PRE CODE IMG TABLE THEAD TBODY TFOOT TR TD TH COL COLGROUP CAPTION HR H1 H2 H3 H4 H5 H6 DL DT DD SUP SUB'.split(' '));
const safeStyles = new Set('color background-color font-family font-size font-weight font-style text-decoration text-align line-height white-space border border-color border-width border-style border-collapse border-spacing padding padding-top padding-bottom padding-left padding-right margin margin-top margin-bottom margin-left margin-right width min-width max-width height vertical-align'.split(' '));
function safeImageSource(value: string): boolean { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }

/** Preserve mail formatting while keeping pasted/quoted HTML inert in our app. */
export function cleanComposeHtml(html: string, outgoing = false, authoredImages = false): string {
  const template = document.createElement('template'); template.innerHTML = html;
  template.content.querySelectorAll('script,noscript,style,iframe,object,embed,svg,math,form,input,button,textarea,select,meta,link,base,video,audio,template').forEach(element => element.remove());
  for (const element of Array.from(template.content.querySelectorAll('*'))) {
    if (!allowedTags.has(element.tagName)) { element.replaceWith(...Array.from(element.childNodes)); continue; }
    const attributes = [...element.attributes].map(attribute => [attribute.name.toLowerCase(), attribute.value]);
    const authoredImage = authoredImages || element.getAttribute('data-mail-authored-image') === 'true';
    const imageSource = element.tagName === 'IMG' ? element.getAttribute('data-mail-inline-cid') || element.getAttribute('data-mail-remote-src') || element.getAttribute('src') || '' : '';
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    for (const [name, value] of attributes) {
      if (name === 'style') {
        const styles = document.createElement('span'); styles.setAttribute('style', value);
        for (const property of Array.from(styles.style)) {
          const candidate = styles.style.getPropertyValue(property);
          if (safeStyles.has(property) && !/url\s*\(|expression\s*\(|@|[<>]|\\/i.test(candidate)) (element as HTMLElement).style.setProperty(property, candidate);
        }
      } else if (['title', 'alt', 'colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'dir', 'lang'].includes(name)) element.setAttribute(name, value);
      else if (name === 'href' && element.tagName === 'A' && /^(https?:|mailto:)/i.test(value.trim())) { element.setAttribute('href', value); element.setAttribute('rel', 'noopener noreferrer'); }
      else if (['data-mail-signature', 'data-mail-quote'].includes(name) && value === 'true') element.setAttribute(name, value);
    }
    if (element.tagName === 'IMG') {
      if (/^cid:[^\s<>]+$/i.test(imageSource)) element.setAttribute('src', imageSource);
      else if (safeImageSource(imageSource)) { element.setAttribute(outgoing || authoredImage ? 'src' : 'data-mail-remote-src', imageSource); if(authoredImage)element.setAttribute('data-mail-authored-image','true'); if(!outgoing)element.setAttribute('referrerpolicy','no-referrer'); }
      else if (!element.getAttribute('alt')) element.remove();
    }
  }
  return template.innerHTML;
}

export function composePlainText(html: string): string {
  const template = document.createElement('template'); template.innerHTML = html;
  template.content.querySelectorAll('br').forEach(element => element.replaceWith('\n'));
  template.content.querySelectorAll('p,div,li,tr').forEach(element => element.append('\n'));
  return (template.content.textContent || '').trimEnd();
}

export function replaceComposeSignature(html: string, signatureHtml: string): string {
  const template = document.createElement('template'); template.innerHTML = cleanComposeHtml(html);
  const previous = template.content.querySelector('[data-mail-signature]');
  const signature = document.createElement('div'); signature.setAttribute('data-mail-signature', 'true');
  signature.innerHTML = cleanComposeHtml(signatureHtml, false, true);
  if (previous) previous.replaceWith(signature);
  else { const quote = template.content.querySelector('[data-mail-quote]'); if (quote) quote.before(signature); else template.content.append(signature); }
  return template.innerHTML;
}
