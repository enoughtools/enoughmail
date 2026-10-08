import { afterEach, expect, it, vi } from 'vitest';
import { MailEventWakeup } from '../apps/mail/src/server/event-wakeup';
afterEach(() => vi.useRealTimers());
it('wakes all subscribers once on a committed change and releases timers', async () => {
 vi.useFakeTimers(); const events=new MailEventWakeup();
 const first=events.wait(), second=events.wait(); events.notify();
 expect(await first).toBe(true); expect(await second).toBe(true); expect(vi.getTimerCount()).toBe(0);
 events.notify(); expect(vi.getTimerCount()).toBe(0);
});
it('bounds abandoned subscriptions and supports cancellation without a change', async () => {
 vi.useFakeTimers(); const events=new MailEventWakeup(), abort=new AbortController();
 const canceled=events.wait(abort.signal); abort.abort(); expect(await canceled).toBe(false);
 const waits=Array.from({length:128},()=>events.wait()); expect(await events.wait()).toBe(false);
 await vi.advanceTimersByTimeAsync(15000); expect(await Promise.all(waits)).toEqual(Array(128).fill(false)); expect(vi.getTimerCount()).toBe(0);
});
