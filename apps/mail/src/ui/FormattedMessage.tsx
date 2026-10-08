import { useEffect, useRef, useState } from 'react';
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
  const [remoteImageError, setRemoteImageError] = useState(false);
  const cleanupFrame = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanupFrame.current?.(), []);
  const sizeFrame = () => {
    cleanupFrame.current?.();
    const frame = frameRef.current;
    const body = frame?.contentDocument?.body;
    if (!frame || !body) return;
    // Only sanitized, script-free content shares origin. The parent measures it,
    // so images and expanded quotes join the page's normal scroll.
    const resize = () => { frame.style.height = `${Math.ceil(body.getBoundingClientRect().height) + 2}px`; };
    const imageStatus = () => setRemoteImageError([...body.querySelectorAll('img')].some(image => remoteMailImageUrl(image.src) && image.complete && !image.naturalWidth));
    const observer = new ResizeObserver(resize);
    observer.observe(body);
    body.addEventListener('load', resize, true);
    body.addEventListener('toggle', resize, true);
    body.addEventListener('error', imageStatus, true);
    imageStatus();
    resize();
    cleanupFrame.current = () => { observer.disconnect(); body.removeEventListener('load', resize, true); body.removeEventListener('toggle', resize, true); body.removeEventListener('error', imageStatus, true); };
  };
  const [images, setImages] = useState<Record<string, string>>({});
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
  const html = messageHtml(email);
  const hasRemoteImages = hasRemoteMailImages(html);
  return <div className="mail-formatted-message">
    {!allowRemoteImages && hasRemoteImages && <div className="mail-image-notice"><span>External images are hidden to protect your privacy. Loading them may let the sender know you opened this message.</span><Button variant="outline" size="sm" disabled={!online} onClick={onRemoteImages}>Show images</Button></div>}
    {allowRemoteImages && remoteImageError && <p role="status">Some external images could not be loaded.</p>}
    {error && <p role="status">{error}</p>}
    {loadingImages && <p role="status">Loading embedded images…</p>}
    {!online && messageInlineImageParts(email).length > 0 && <p>Reconnect to view embedded images.</p>}
    <iframe ref={frameRef} onLoad={sizeFrame} scrolling="no" title={`Message: ${email.subject || 'No subject'}`} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={safeMailHtml(html, allowRemoteImages, images)} />
  </div>;
}
