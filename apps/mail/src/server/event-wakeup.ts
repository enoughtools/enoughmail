/** Bounded in-memory wakeups carry no mail content. State is read afresh after
 * the Worker rechecks admission and grants; missed wakeups fall back to polling. */
export class MailEventWakeup {
  private readonly listeners = new Set<() => void>();

  notify() { for (const listener of [...this.listeners]) listener(); }

  wait(signal?: AbortSignal): Promise<boolean> {
    if (this.listeners.size >= 128 || signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (changed: boolean) => {
        clearTimeout(timer);
        this.listeners.delete(notify);
        signal?.removeEventListener('abort', abort);
        resolve(changed);
      };
      const notify = () => finish(true);
      const abort = () => finish(false);
      timer = setTimeout(abort, 15_000);
      this.listeners.add(notify);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
