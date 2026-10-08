export type PreferenceSaveStatus = 'saved' | 'waiting' | 'saving' | 'error';
interface Pending { value: Record<string, unknown>; args: Record<string, unknown> }
/** Serializes edits, freezes uncertain commands, and flushes before leaving preferences. */
export class PreferenceAutosave {
  private initialized = false;
  private baseline = '';
  private latest: Record<string, unknown> = {};
  private pending: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<boolean> | null = null;
  private stopped = false;
  private failed = false;
  private retryAllowed = true;
  get retryable() { return this.retryAllowed; }
  constructor(private save: (args: Record<string, unknown>) => Promise<unknown>, private revision: () => string | undefined, private changed: (status: PreferenceSaveStatus, error?: string) => void, private delay = 500) {}
  activate() { this.stopped = false; }
  reset(value: Record<string, unknown>) { this.initialized = true; this.baseline = JSON.stringify(value); this.latest = structuredClone(value); this.pending = null; this.failed = false; this.retryAllowed = true; this.changed('saved'); }
  update(value: Record<string, unknown>) {
    this.latest = structuredClone(value);
    if (!this.initialized || this.stopped || this.failed || JSON.stringify(this.latest) === this.baseline) return;
    clearTimeout(this.timer); this.changed('waiting'); this.timer = setTimeout(() => { void this.flush(); }, this.delay);
  }
  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (!this.initialized) return true;
    if (this.running) return this.running;
    if (this.failed || this.stopped) return false;
    this.running = this.drain();
    try { return await this.running; } finally { this.running = null; }
  }
  async retry(): Promise<boolean> { if (!this.retryAllowed) return false; this.failed = false; return this.flush(); }
  private async drain(): Promise<boolean> {
    while (this.pending || JSON.stringify(this.latest) !== this.baseline) {
      if (!this.pending) { const value = structuredClone(this.latest), state = this.revision(); this.pending = { value, args: { settings: value, operationId: crypto.randomUUID(), ...(state ? { ifInState: state } : {}) } }; }
      if (!this.stopped) this.changed('saving');
      try { await this.save(this.pending.args); this.baseline = JSON.stringify(this.pending.value); this.pending = null; }
      catch (e) { this.failed = true; this.retryAllowed = !(e as { confirmed?: boolean })?.confirmed; if (!this.stopped) this.changed('error', e instanceof Error ? e.message : 'Changes could not be saved.'); return false; }
    }
    if (!this.stopped) this.changed('saved'); return true;
  }
  dispose() { clearTimeout(this.timer); if (!this.failed) void this.flush(); this.stopped = true; }
}
