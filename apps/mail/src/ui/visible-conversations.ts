import type { Email } from './jmap';

type Row = Pick<Email, 'id' | 'threadId' | 'keywords'> & { accountId: string };
export interface VisibleConversation { accountId: string; threadId: string }

/** Observe the scroll viewport, rather than downloading every row in a page. */
export function observeVisibleConversations(list: HTMLElement, rows: Row[], notify: (targets: VisibleConversation[]) => void): () => void {
    const byKey = new Map(rows.map(row => [`${row.accountId}:${row.id}`, row]));
    const elements = [...list.querySelectorAll<HTMLElement>('[data-mail-row-key]')];
    const visible = new Set<HTMLElement>();
    let timer: ReturnType<typeof setTimeout>;
    const publish = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            const targets = new Map<string, VisibleConversation>();
            for (const element of elements) {
                if (!visible.has(element)) continue;
                const row = byKey.get(element.dataset.mailRowKey || '');
                if (!row || row.keywords.$draft) continue;
                targets.set(JSON.stringify([row.accountId, row.threadId]), { accountId: row.accountId, threadId: row.threadId });
            }
            notify([...targets.values()]);
        }, 120);
    };
    if (typeof IntersectionObserver !== 'undefined') {
        const observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (entry.isIntersecting && entry.intersectionRatio > 0) visible.add(entry.target as HTMLElement);
                else visible.delete(entry.target as HTMLElement);
            }
            publish();
        }, { root: list, threshold: 0 });
        elements.forEach(element => observer.observe(element));
        return () => { clearTimeout(timer); observer.disconnect(); notify([]); };
    }
    const measure = () => {
        const bounds = list.getBoundingClientRect();
        visible.clear();
        if (bounds.width && bounds.height) for (const element of elements) {
            const rect = element.getBoundingClientRect();
            if (rect.height && rect.width && rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right) visible.add(element);
        }
        publish();
    };
    measure();
    list.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => { clearTimeout(timer); list.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); notify([]); };
}
