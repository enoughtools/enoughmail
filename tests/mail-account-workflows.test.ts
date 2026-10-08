import { describe, expect, it } from 'vitest';
import { applyFollowUp, applyMailPreferences, buildAutoResponses, dueFollowUps, reconcileFollowUps, validateSettings, type WorkflowEmail } from '../apps/mail/src/domain/workflows';
const now = '2026-10-05T12:00:00Z';
const email: WorkflowEmail = { id: 'mail-1', threadId: 'thread-1', from: [{ email: 'Alice@Example.com' }], mailboxIds: { 'folder-inbox': true }, keywords: {}, receivedAt: '2026-10-04T12:00:00Z', subject: 'Newsletter' };
const vacation = { enabled: true, subject: 'Away', textBody: 'Back next week.' };
describe('Persistent account workflows', () => {
  it('blocks exact normalized senders and categorizes only explicit matching rules without mutating mail', () => {
    const settings = validateSettings({ blockedSenders: ['alice@example.com'], categories: [{ id: 'updates', name: 'Updates', mailboxId: 'label-updates', enabled: true, condition: { subject: 'Newsletter' } }] });
    expect(applyMailPreferences(email, settings).mailboxIds).toEqual({ 'folder-junk': true });
    expect(applyMailPreferences(email, { categories: settings.categories }).mailboxIds).toEqual({ 'folder-inbox': true, 'label-updates': true });
    expect(applyMailPreferences(email, { blockedSenders: ['lice@example.com'] }).mailboxIds).toEqual(email.mailboxIds);
    expect(applyMailPreferences(email, { mutedThreads: ['thread-1'] }).mailboxIds).toEqual({ 'folder-archive': true });
    expect(email.mailboxIds).toEqual({ 'folder-inbox': true });
    expect(applyMailPreferences({ ...email, mailboxIds: { 'folder-trash': true } }, { categories: settings.categories }).mailboxIds).toEqual({ 'folder-trash': true });
  });
  it('validates workflow preferences and rejects unsupported fake capabilities', () => {
    const settings = { pageSize: 50, savedSearches: [{ name: 'Unread', query: 'is:unread' }], forwarding: { enabled: true, address: 'other@example.com', keepCopy: true }, vacation, followUp: { defaultDelayHours: 48, defaultIfNoReply: true } };
    expect(validateSettings(settings)).toEqual(settings); expect(validateSettings(settings)).not.toBe(settings);
    for (const invalid of [{ blockedSenders: ['alice'] }, { mutedThreads: ['__proto__'] }, { pageSize: 1000 }, { forwarding: { enabled: true, address: 'bob@example.com\r\nBcc: x@y.com', keepCopy: true } }, { vacation: { ...vacation, subject: 'bad\r\nheader' } }, { vacation: { ...vacation, fromDate: now, toDate: '2026-10-04T12:00:00Z' } }, { vacation: { ...vacation, responseIntervalDays: 0 } }, { followUp: { defaultDelayHours: 0, defaultIfNoReply: true } }, { savedSearches: [{ name: 'Unsupported', query: 'has:drive' }] }, { categories: [{ id: 'x', name: 'X', mailboxId: 'folder-trash', enabled: true, condition: {} }] }, { imaginaryAutoSend: true }]) expect(() => validateSettings(invalid)).toThrow();
  });
  it('restores due follow-ups once while preserving sent and label membership', () => {
    const followed = applyFollowUp({ ...email, mailboxIds: { 'folder-sent': true, label: true } }, { until: now, ifNoReply: true, now: '2026-10-04T13:00:00Z' });
    expect(dueFollowUps([followed], now)).toEqual([followed]);
    const [restored] = reconcileFollowUps([followed], now); expect(restored.mailboxIds).toEqual({ 'folder-sent': true, label: true, 'folder-inbox': true }); expect(restored.followUp).toBeUndefined();
    expect(reconcileFollowUps([restored], now)).toEqual([restored]); expect(followed.followUp).toBeDefined();
    expect(() => applyFollowUp(email, { until: now, ifNoReply: true, now })).toThrow();
  });
  it('cancels no-reply reminders on later inbound messages but ignores drafts, sent messages and older inbound mail', () => {
    const followed = applyFollowUp(email, { until: now, ifNoReply: true, now: '2026-10-04T13:00:00Z' });
    const reply = { ...email, id: 'reply', receivedAt: '2026-10-05T10:00:00Z' };
    expect(dueFollowUps([followed, reply], now)).toEqual([]); expect(reconcileFollowUps([followed, reply], now)[0].followUp).toBeUndefined();
    expect(dueFollowUps([followed, { ...reply, keywords: { '$draft': true } }], now)).toEqual([followed]);
    expect(dueFollowUps([followed, { ...reply, mailboxIds: { 'folder-sent': true } }], now)).toEqual([followed]);
    expect(dueFollowUps([followed, { ...reply, receivedAt: email.receivedAt }], now)).toEqual([followed]);
    const unconditional = applyFollowUp(email, { until: now, ifNoReply: false, now: '2026-10-04T13:00:00Z' }); expect(dueFollowUps([unconditional, reply], now)).toEqual([unconditional]);
  });
  it('cancels overdue replied reminders without restoring an archived message to Inbox', () => {
    const archived = applyFollowUp({ ...email, mailboxIds: { 'folder-archive': true, label: true } }, { until: now, ifNoReply: true, now: '2026-10-04T13:00:00Z' });
    const reply = { ...email, id: 'reply', receivedAt: '2026-10-05T10:00:00Z' };
    const [cancelled] = reconcileFollowUps([archived, reply], '2026-10-06T12:00:00Z');
    expect(cancelled.followUp).toBeUndefined();
    expect(cancelled.mailboxIds).toEqual({ 'folder-archive': true, label: true });
    expect(archived.followUp).toBeDefined();
  });
  it('never resurrects trash, spam, drafts or an actively snoozed reminder', () => {
    const followed = applyFollowUp(email, { until: now, ifNoReply: false, now: '2026-10-04T13:00:00Z' });
    const protectedMail: WorkflowEmail[] = [{ ...followed, mailboxIds: { 'folder-trash': true } }, { ...followed, mailboxIds: { 'folder-junk': true } }, { ...followed, keywords: { '$draft': true } }, { ...followed, snooze: { until: '2026-10-06T12:00:00Z', mailboxIds: email.mailboxIds } }];
    for (const mail of protectedMail) { expect(dueFollowUps([mail], now)).toEqual([]); expect(reconcileFollowUps([mail], now)).toEqual([mail]); }
  });
  it('describes deterministic forwarding and vacation outbox jobs with loop-prevention headers', () => {
    const jobs = buildAutoResponses(email, { forwarding: { enabled: true, address: 'forward@example.com', keepCopy: false }, vacation }, { now, recipientAddress: 'me@example.com' });
    expect(jobs.map(job => [job.id, job.type, job.to])).toEqual([['forward:mail-1', 'forward', 'forward@example.com'], ['vacation:mail-1', 'vacation', 'alice@example.com']]);
    expect(jobs[1].headers).toEqual([{ name: 'Auto-Submitted', value: 'auto-replied' }]);
    expect(buildAutoResponses(email, { vacation }, { now, lastVacationResponses: { 'alice@example.com': '2026-10-04T00:00:00Z' } })).toEqual([]);
    expect(buildAutoResponses(email, { vacation }, { now, lastVacationResponses: { 'alice@example.com': '2026-10-01T12:00:00Z' } })).toHaveLength(1);
    expect(buildAutoResponses(email, { vacation: { ...vacation, toDate: now } }, { now })).toEqual([]);
  });
  it('suppresses automated, list, bounce, self, blocked and forwarded traffic', () => {
    const headers = [{ name: 'Auto-Submitted', value: 'auto-replied' }, { name: 'List-ID', value: 'list.example.com' }, { name: 'List-Unsubscribe', value: '<mailto:list@example.com>' }, { name: 'Precedence', value: 'bulk' }, { name: 'X-Enough-Mail-Forwarded', value: 'yes' }, { name: 'X-Auto-Response-Suppress', value: 'All' }, { name: 'Return-Path', value: '<>' }];
    for (const header of headers) expect(buildAutoResponses({ ...email, headers: [header] }, { vacation }, { now })).toEqual([]);
    expect(buildAutoResponses(email, { vacation }, { now, recipientAddress: 'alice@example.com' })).toEqual([]);
    expect(buildAutoResponses(email, { vacation, blockedSenders: ['alice@example.com'] }, { now })).toEqual([]);
    expect(buildAutoResponses({ ...email, headers: [{ name: 'Auto-Submitted', value: 'no' }] }, { vacation }, { now })).toHaveLength(1);
  });
});
