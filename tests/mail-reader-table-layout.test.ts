// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { safeMailHtml } from '../apps/mail/src/ui/safe-html';
const parse = (html: string) => { const template = document.createElement('template'); template.innerHTML = safeMailHtml(html); return template.content; };

describe('Email layout and data tables', () => {
  it('preserves newsletter spacer columns and nested presentation tables', () => {
    const fragment = parse('<table role="presentation" width="100%"><tr><td width="30"></td><td><table role="presentation" width="600"><tr><td width="30"></td><td><p>A newsletter paragraph that should wrap inside the reader.</p></td><td width="30"></td></tr></table></td><td width="30"></td></tr></table>');
    expect(fragment.querySelectorAll('table')).toHaveLength(2);
    expect(fragment.querySelectorAll('[data-mail-readable-table], [data-mail-table-scroll]')).toHaveLength(0);
    expect(fragment.querySelector('p')?.textContent).toContain('should wrap inside the reader');
  });
  it('does not force single-row newsletter header columns into data columns', () => {
    const fragment = parse('<table><tr><td>Logo</td><td>View online</td><td>Account</td></tr></table>');
    expect(fragment.querySelector('[data-mail-table-scroll]')).toBeNull();
  });
  it('keeps real multi-column data tables horizontally accessible', () => {
    for (const html of ['<table><tr><th>Item</th><th>Value</th></tr><tr><td>Alpha</td><td>42</td></tr></table>', '<table><tr><td>Alpha</td><td>42</td><td>Ready</td></tr><tr><td>Beta</td><td>24</td><td>Waiting</td></tr></table>']) {
      const fragment = parse(html);
      expect(fragment.querySelector('[data-mail-table-scroll]')?.getAttribute('tabindex')).toBe('0');
      expect(fragment.querySelector('[data-mail-readable-table]')).not.toBeNull();
    }
  });
  it('does not let sender attributes force layout tables into the data-table CSS', () => {
    const fragment = parse('<table role="presentation" data-mail-readable-table><tr><td>Newsletter</td></tr></table><div data-mail-table-scroll>Body</div>');
    expect(fragment.querySelector('[data-mail-readable-table], [data-mail-table-scroll]')).toBeNull();
  });
});
