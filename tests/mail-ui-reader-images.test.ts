import { describe, expect, it } from 'vitest';
import { remoteMailImageUrl } from '../apps/mail/src/ui/safe-html';

describe('Reader remote image policy', () => {
  it('permits explicit HTTPS image URLs for the opted-in reader', () => {
    expect(remoteMailImageUrl('https://images.example.test/newsletter.png')).toBe(true);
    expect(remoteMailImageUrl('HTTPS://images.example.test/image?a=1&b=2')).toBe(true);
  });
  it('rejects active, insecure, relative, credentialed and malformed sources', () => {
    for (const value of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'http://example.test/a', '//example.test/a', '/a', 'https://user:password@example.test/a', 'not a URL']) {
      expect(remoteMailImageUrl(value), value).toBe(false);
    }
  });
});

it('shows a quiet placeholder rather than a broken image before opt-in',async()=>{
 const {Window}=await import('happy-dom');const {safeMailHtml}=await import('../apps/mail/src/ui/safe-html');const {vi}=await import('vitest');const window=new Window();vi.stubGlobal('document',window.document);
 try{const source='<img alt="Newsletter cover" src="https://images.example.test/cover.jpg"><img width="1" src="https://images.example.test/pixel">';const hidden=window.document.createElement('template');hidden.innerHTML=safeMailHtml(source);expect(hidden.content.querySelectorAll('img')).toHaveLength(0);expect(hidden.content.querySelector('[role="img"]')?.textContent).toBe('Newsletter cover');const visible=window.document.createElement('template');visible.innerHTML=safeMailHtml(source,true);expect(visible.content.querySelector('img')?.getAttribute('src')).toBe('https://images.example.test/cover.jpg');expect(visible.content.querySelector('[role="img"]')).toBeNull();}finally{vi.unstubAllGlobals();await window.happyDOM.close();}
});
