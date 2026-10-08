// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { observeVisibleConversations } from '../apps/mail/src/ui/visible-conversations';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

it('warms only visible conversations, deduplicates threads and follows scrolling without loading drafts', () => {
    vi.useFakeTimers();
    let update!: (entries: any[]) => void;
    const disconnect = vi.fn(), observe = vi.fn();
    let observedRoot: Element | Document | null | undefined;
    vi.stubGlobal('IntersectionObserver', class {
        constructor(callback: typeof update, options: IntersectionObserverInit) { update = callback; observedRoot = options.root; }
        observe = observe;
        disconnect = disconnect;
    });
    const list = document.createElement('div');
    list.innerHTML = ['one','two','draft','same-thread'].map(id => `<div data-mail-row-key="a:${id}"></div>`).join('');
    document.body.append(list);
    const rows = ['one','two','draft','same-thread'].map(id => ({ id, accountId: 'a', threadId: id === 'same-thread' ? 'one' : id, keywords: (id === 'draft' ? { $draft: true } : {}) as Record<string, boolean> }));
    const notify = vi.fn();
    const stop = observeVisibleConversations(list, rows, notify);
    expect(observedRoot).toBe(list); expect(observe).toHaveBeenCalledTimes(4);
    update([...list.children].map((target, index) => ({ target, isIntersecting: index !== 1, intersectionRatio: index === 1 ? 0 : 1 })));
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120);
    expect(notify).toHaveBeenLastCalledWith([{ accountId: 'a', threadId: 'one' }]);
    update([...list.children].map((target, index) => ({ target, isIntersecting: index === 1, intersectionRatio: index === 1 ? 1 : 0 })));
    vi.advanceTimersByTime(120);
    expect(notify).toHaveBeenLastCalledWith([{ accountId: 'a', threadId: 'two' }]);
    update([{ target: list.children[0], isIntersecting: true, intersectionRatio: 1 }]);
    stop(); vi.advanceTimersByTime(120);
    expect(disconnect).toHaveBeenCalledOnce(); expect(notify).toHaveBeenLastCalledWith([]);
});
