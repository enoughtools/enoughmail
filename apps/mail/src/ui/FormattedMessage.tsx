import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@rebnz/enough-ui/button';
import './reader-message.css';
import type { Email, MailClient } from './jmap';
import { hasRemoteMailImages, remoteMailImageUrl, safeMailHtml } from './safe-html';
import { messageHtml, messageInlineImageParts } from './message-body';
import { contentId, rasterDataUrl, INLINE_TOTAL_LIMIT } from './inline-images';

export default function FormattedMessage({ email, client, accountId, online, allowRemoteImages, onRemoteImages }: {
  email: Email; client: MailClient; accountId: string; online: boolean; allowRemoteImages: boolean; onRemoteImages: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const html = messageHtml(email);
  const srcDoc = safeMailHtml(html, allowRemoteImages, images);
  const source = useMemo(() => ({ accountId, emailId: email.id, srcDoc }), [accountId, email.id, srcDoc]);
  const sourceRef = useRef(source); sourceRef.current = source;
  const [failedSource, setFailedSource] = useState<typeof source | null>(null);
  const cleanupFrame = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanupFrame.current?.(), []);
  useEffect(() => setFailedSource(null), [source]);
  const sizeFrame = () => {
    cleanupFrame.current?.();
    const frame = frameRef.current;
    const body = frame?.contentDocument?.body;
    if (!frame || !body) return;
    // Only sanitized, script-free content shares origin. The parent measures it,
    // so images and expanded quotes join the page's normal scroll.
    const resize = () => {
      const root = frame.contentDocument!.documentElement;
      const scrollbar = root.scrollWidth > root.clientWidth ? 24 : 0;
      frame.style.height = `${Math.ceil(Math.max(body.getBoundingClientRect().height, body.scrollHeight)) + scrollbar + 2}px`;
    };
    const fallbacks = new Map<HTMLImageElement, { placeholder: HTMLSpanElement; display: string; priority: string }>();
    const restore = (image: HTMLImageElement) => {
      const fallback = fallbacks.get(image); if (!fallback) return;
      if (fallback.display) image.style.setProperty('display', fallback.display, fallback.priority); else image.style.removeProperty('display');
      fallback.placeholder.remove(); fallbacks.delete(image);
    };
    const imageStatus = () => {
      if (sourceRef.current !== source || frameRef.current !== frame || frame.contentDocument?.body !== body) return;
      let failed = false;
      for (const image of body.querySelectorAll('img')) {
        if (!remoteMailImageUrl(image.src)) continue;
        if (!image.complete || image.naturalWidth) { restore(image); continue; }
        failed = true;
        if (fallbacks.has(image)) continue;
        const placeholder = body.ownerDocument.createElement('span');
        const alt = image.getAttribute('alt')?.trim();
        placeholder.className = 'mail-hidden-image'; placeholder.setAttribute('role', 'img');
        placeholder.textContent = alt ? `Image unavailable: ${alt}` : 'Image unavailable.';
        placeholder.setAttribute('aria-label', placeholder.textContent);
        fallbacks.set(image, { placeholder, display: image.style.getPropertyValue('display'), priority: image.style.getPropertyPriority('display') });
        image.style.setProperty('display', 'none', 'important'); image.after(placeholder);
      }
      setFailedSource(failed ? source : null); resize();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(body);
    body.addEventListener('load', imageStatus, true);
    body.addEventListener('toggle', resize, true);
    body.addEventListener('error', imageStatus, true);
    imageStatus();
    resize();
    cleanupFrame.current = () => { observer.disconnect(); body.removeEventListener('load', imageStatus, true); body.removeEventListener('toggle', resize, true); body.removeEventListener('error', imageStatus, true); for (const image of fallbacks.keys()) restore(image); };
  };
  const [error, setError] = useState('');
  const [loadingImages, setLoadingImages] = useState(false);
  useEffect(() => {
    setImages({}); setError(''); setLoadingImages(false);
    if (!online || !messageInlineImageParts(email).length) return;
    const abort = new AbortController(); let disposed = false;
    setLoadingImages(true);
    void (async () => {
      const map: Record<string, string> = {}; let size = 0;
      try {
        for (const part of messageInlineImageParts(email)) {
          const bytes = await client.readBlob(accountId, part, abort.signal);
          size += bytes.byteLength;
          if (size > INLINE_TOTAL_LIMIT) throw new Error('Embedded images exceed the display limit.');
          map[contentId(part.cid!)] = rasterDataUrl(bytes, part.type.toLowerCase());
        }
        if (!disposed) setImages(map);
      } catch (problem) { if (!disposed) setError(problem instanceof Error ? problem.message : 'Embedded images unavailable.'); }
      finally { if (!disposed) setLoadingImages(false); }
    })();
    return () => { disposed = true; abort.abort(); };
  }, [email, client, accountId, online]);
  const hasRemoteImages = hasRemoteMailImages(html);
  return <div className="mail-formatted-message">
    {!allowRemoteImages && hasRemoteImages && <div className="mail-image-notice"><span>External images are hidden to protect your privacy. Loading them may let the sender know you opened this message.</span><Button variant="outline" size="sm" disabled={!online} onClick={onRemoteImages}>Show images</Button></div>}
    {allowRemoteImages && failedSource === source && <p role="status">Some external images could not be loaded.</p>}
    {error && <p role="status">{error}</p>}
    {loadingImages && <p role="status">Loading embedded images…</p>}
    {!online && messageInlineImageParts(email).length > 0 && <p>Reconnect to view embedded images.</p>}
    <iframe key={`${accountId}\0${email.id}\0${srcDoc}`} ref={frameRef} onLoad={sizeFrame} scrolling="auto" title={`Message: ${email.subject || 'No subject'}`} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={srcDoc} />
  </div>;
}
