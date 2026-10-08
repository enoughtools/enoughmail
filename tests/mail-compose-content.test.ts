import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { cleanComposeHtml, composePlainText, forwardSubject, quoteMessage, replaceComposeSignature, replySubject } from '../apps/mail/src/ui/compose-content';
import type { Email } from '../apps/mail/src/ui/jmap';

describe('Compose HTML content', () => {
  let window: Window;
  beforeEach(() => { window = new Window(); vi.stubGlobal('document', window.document); });
  afterEach(async () => { await window.happyDOM.close(); vi.unstubAllGlobals(); });

  it('previews an explicitly inserted hosted Example Studio signature and preserves its outgoing image',()=>{
    const signature='<table><tr><td><b>Alex Morgan</b><br>Designer, Example Studio</td></tr><tr><td><a href="https://studio.example.test/"><img src="https://studio.example.test/logo.png" alt="Example Studio" width="112" style="width:112px;height:auto"></a></td></tr></table>';
    const html=replaceComposeSignature('<p>Hello</p>',signature);const element=window.document.createElement('div');element.innerHTML=html;expect(element.querySelector('img')?.getAttribute('src')).toBe('https://studio.example.test/logo.png');expect(element.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');expect(cleanComposeHtml(html,true)).toContain('src="https://studio.example.test/logo.png"');
    const quoted=quoteMessage({subject:'Test',receivedAt:'2026-10-07T12:00:00Z',from:[],to:[],htmlBody:[{partId:'html',type:'text/html'}],bodyValues:{html:{value:html}}} as any,'reply','Hello');const quote=window.document.createElement('div');quote.innerHTML=cleanComposeHtml(quoted.html);expect(quote.querySelector('img')?.hasAttribute('src')).toBe(false);
  });

  it('preserves the complete formatted original when replying or forwarding a long message', () => {
    const original = '<table><tbody><tr><td style="color: rgb(40, 50, 60); font-weight: bold"><a href="https://example.test/document">Original link</a></td></tr></tbody></table>' + '<p>Full original paragraph</p>'.repeat(8000) + '<p>END OF ORIGINAL</p>';
    const email: Email = { id: 'original', threadId: 'thread', blobId: 'original-blob', mailboxIds: { inbox: true }, keywords: {}, preview: '', hasAttachment: false, subject: 'Original subject', receivedAt: '2026-10-07T12:00:00Z', from: [{ name: '<Sender>', email: 'sender@example.test' }], to: [{ email: 'reader@example.test' }], htmlBody: [{ partId: 'html', blobId: 'html-blob', type: 'text/html', size: original.length }], bodyValues: { html: { value: original } } };
    for (const mode of ['reply', 'forward'] as const) {
      const result = quoteMessage(email, mode, 'Plain alternative');
      expect(result.html).toContain(original);
      const sanitized = cleanComposeHtml(result.html);
      const element = window.document.createElement('div'); element.innerHTML = sanitized;
      expect(element.querySelectorAll('blockquote p')).toHaveLength(8001);
      expect(element.querySelector('blockquote table td')?.getAttribute('style')).toContain('font-weight: bold');
      expect(element.querySelector('a')?.getAttribute('href')).toBe('https://example.test/document');
      expect(element.textContent).toContain('END OF ORIGINAL');
      expect(element.querySelector('sender')).toBeNull();
    }
  });

  it('uses standard reply and forward subject prefixes without duplicating them', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('RE: Hello')).toBe('RE: Hello');
    expect(forwardSubject('Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('Fw: Hello')).toBe('Fw: Hello');
    expect(forwardSubject('FWD: Hello')).toBe('FWD: Hello');
  });

  it('keeps safe formatting and links while removing active pasted content', () => {
    const html = cleanComposeHtml('<script>alert(1)</script><svg onload="alert(1)"></svg><form><input autofocus></form><p id="mail-app" onclick="alert(1)" style="color: red; position: fixed; background-image: url(https://track.test/pixel)">Safe <b>bold</b></p><a href="javascript:alert(1)">Unsafe link</a><a href="mailto:person@example.test" onmouseover="alert(1)">Email</a>');
    const element = window.document.createElement('div'); element.innerHTML = html;
    expect(element.querySelector('script,svg,form,input,[onclick],[onmouseover],[id]')).toBeNull();
    expect(element.querySelector('p')?.getAttribute('style')).toBe('color: red;');
    expect(element.querySelector('b')?.textContent).toBe('bold');
    expect(element.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(element.querySelectorAll('a')[1].getAttribute('href')).toBe('mailto:person@example.test');
    expect(html).not.toContain('track.test');
  });

  it('does not request quoted remote images while editing, but preserves their safe outgoing source', () => {
    const editor = cleanComposeHtml('<img src="https://images.example.test/photo.png" alt="Original photo"><img src="javascript:alert(1)"><img src="https://user:password@example.test/pixel">');
    const element = window.document.createElement('div'); element.innerHTML = editor;
    expect(element.querySelectorAll('img')).toHaveLength(1);
    expect(element.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(element.querySelector('img')?.getAttribute('data-mail-remote-src')).toBe('https://images.example.test/photo.png');
    const outgoing = cleanComposeHtml(editor, true);
    expect(outgoing).toContain('src="https://images.example.test/photo.png"');
    expect(outgoing).not.toContain('data-mail-remote-src');
    expect(cleanComposeHtml(outgoing)).toBe(editor);
  });

  it('serializes authorized inline previews back to CID references without persisting temporary blob URLs', () => {
    const html = cleanComposeHtml('<img src="blob:https://mail.example/temporary" data-mail-inline-cid="cid:original-image" alt="Inline image">');
    expect(html).toContain('src="cid:original-image"');
    expect(html).not.toContain('blob:');
    expect(cleanComposeHtml(html, true)).toContain('src="cid:original-image"');
  });

  it('replaces only the signature and leaves written text plus the complete quoted original intact', () => {
    const original = '<p>My reply</p><div data-mail-signature="true"><b>Old signature</b></div><div data-mail-quote="true"><blockquote><table><tbody><tr><td>Quoted original</td></tr></tbody></table></blockquote></div>';
    const updated = replaceComposeSignature(original, '<p><strong>New signature</strong><br><a href="https://example.test">Website</a></p>');
    expect(updated).toContain('<p>My reply</p>');
    expect(updated).toContain('<td>Quoted original</td>');
    expect(updated).not.toContain('Old signature');
    expect(updated.match(/data-mail-signature/g)).toHaveLength(1);
    expect(composePlainText(updated)).toContain('New signature\nWebsite');
    const cleared = replaceComposeSignature(updated, '');
    expect(cleared).not.toContain('New signature');
    expect(cleared).toContain('Quoted original');
  });
});
