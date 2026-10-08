import { describe, expect, it } from 'vitest';
import { advanceRuleApplySnapshot, applyRules, createRuleApplySnapshot, matchesFilter, nextRuleApplyBatch, parseSearchQuery, sortEmails, validateRule, type MailRule, type RuleEmail } from '../apps/mail/src/domain/rules';
const email: RuleEmail = {
  id: 'b', mailboxIds: { inbox: true }, keywords: {}, from: [{ name: 'Alice', email: 'alice@example.com' }],
  to: [{ email: 'bob@example.com' }], subject: 'Quarterly report', receivedAt: '2026-10-05T12:00:00Z', size: 4096,
  hasAttachment: true, bodyValues: { part1: { value: 'Revenue grew ten percent' } },
};
const rule = (id: string, extra: Partial<MailRule> = {}): MailRule => ({ id, name: id, enabled: true, condition: { from: 'alice' }, actions: { keywords: { '$flagged': true } }, ...extra });
describe('Mail account rules and queries', () => {
  it('combines address, body, keyword, mailbox, attachment, size and time predicates', () => {
    expect(matchesFilter(email, { from: 'ALICE@EXAMPLE.COM', body: 'revenue grew', inMailbox: 'inbox', notKeyword: '$seen', before: '2026-10-06T00:00:00Z', after: '2026-10-05T00:00:00Z', minSize: 4096, maxSize: 4097, hasAttachment: true })).toBe(true);
    expect(matchesFilter(email, { maxSize: 4096 })).toBe(false);
    expect(matchesFilter(email, { before: email.receivedAt })).toBe(false);
    expect(matchesFilter(email, { notInMailbox: ['inbox'] })).toBe(false);
    expect(matchesFilter(email, { operator: 'NOT', conditions: [{ subject: 'report' }, { from: 'unknown' }] })).toBe(false);
    expect(matchesFilter(email, { operator: 'OR', conditions: [{ subject: 'report' }, { from: 'unknown' }] })).toBe(true);
    expect(matchesFilter(email, { operator: 'AND', conditions: [{ subject: 'report' }, { from: 'unknown' }] })).toBe(false);
  });
  it('applies ordered rules without mutating the source and honors stop and disabled rules', () => {
    const result = applyRules(email, [rule('disabled', { enabled: false, actions: { addMailboxIds: ['disabled'] } }), rule('move', { actions: { removeMailboxIds: ['inbox'], addMailboxIds: ['reports'], keywords: { '$seen': true }, snoozeUntil: '2026-10-06T12:00:00Z' } }), rule('stop', { condition: { inMailbox: 'reports' }, stop: true }), rule('later', { actions: { addMailboxIds: ['later'] } })]);
    expect(result.mailboxIds).toEqual({ reports: true, 'folder-snoozed': true });
    expect(result.keywords).toEqual({ '$seen': true, '$flagged': true });
    expect(result.snooze).toEqual({ until: '2026-10-06T12:00:00Z', mailboxIds: { reports: true } });
    expect(email.mailboxIds).toEqual({ inbox: true }); expect(email.keywords).toEqual({});
    expect(applyRules(result, [rule('clear', { actions: { keywords: { '$flagged': false }, snoozeUntil: null } })]).keywords).toEqual({ '$seen': true });
  });
  it('rejects unsupported or malformed actions and filters instead of pretending to forward', () => {
    for (const actions of [{ forward: 'someone@example.com' }, { keywords: { '$seen': 'yes' } }, { addMailboxIds: [1] }, { snoozeUntil: 'tomorrow' }, {}]) expect(() => validateRule({ ...rule('invalid'), actions })).toThrow();
    for (const condition of [{ unknown: true }, { operator: 'AND', conditions: [] }, { operator: 'X', conditions: [{}] }, { minSize: -1 }, { after: 'tomorrow' }]) expect(() => validateRule({ ...rule('invalid'), condition })).toThrow();
  });
  it('sorts using requested priority and deterministic identity ties', () => {
    const a = { ...email, id: 'a' }, c = { ...email, id: 'c', size: 1024 };
    expect(sortEmails([email, c, a], [{ property: 'size', isAscending: false }]).map(e => e.id)).toEqual(['a', 'b', 'c']);
    expect(sortEmails([email, a]).map(e => e.id)).toEqual(['a', 'b']);
    expect(() => sortEmails([email], [{ property: 'unknown' }])).toThrow('Unsupported sort');
    expect(matchesFilter(email, { inMailbox: 'constructor' })).toBe(false);
    expect(sortEmails([{ ...email, id: 'a', sortOrder: 10 }, { ...email, id: 'b', sortOrder: 2 }], [{ property: 'sortOrder' }]).map(e => e.id)).toEqual(['b', 'a']);
    expect(validateRule({ ...rule('ordered'), sortOrder: 2 }).sortOrder).toBe(2);
    expect(() => validateRule({ ...rule('ordered'), sortOrder: -1 })).toThrow('order');
  });
  it('matches named attachments and header names exactly with case-insensitive value matching', () => {
    const message = { ...email, attachments: [{ name: 'Report.PDF' }], headers: [{ name: 'delivered-to', value: 'BOB@example.com' }, { name: 'X-Delivered-To', value: 'private@example.com' }] };
    expect(matchesFilter(message, parseSearchQuery('filename:report.pdf deliveredto:bob@EXAMPLE.com'))).toBe(true);
    expect(matchesFilter(message, { header: ['Delivered-To', 'private'] })).toBe(false);
    expect(matchesFilter(message, { header: ['DELIVERED-TO'] })).toBe(true);
    for (const condition of [{ attachmentName: false }, { header: ['X\r\nBad', 'x'] }, { header: ['Delivered-To', 1] }, { header: [] }]) expect(() => validateRule({ ...rule('invalid'), condition })).toThrow();
  });
  it('sorts thread keyword aggregates using all input messages', () => {
    const messages = [{ ...email, id: 'a', threadId: 'mixed' }, { ...email, id: 'b', threadId: 'mixed', keywords: { '$flagged': true } }, { ...email, id: 'c', threadId: 'all', keywords: { '$flagged': true } }, { ...email, id: 'd', threadId: 'none' }];
    expect(sortEmails(messages, [{ property: 'someInThreadHaveKeyword', keyword: '$flagged', isAscending: false }]).map(e => e.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortEmails(messages, [{ property: 'allInThreadHaveKeyword', keyword: '$flagged', isAscending: false }]).map(e => e.id)).toEqual(['c', 'a', 'b', 'd']);
  });
  it('rule snooze hides inbox, preserves original mailbox membership, and clearing restores it', () => {
    const snoozed = applyRules(email, [rule('snooze', { actions: { snoozeUntil: '2026-10-06T12:00:00Z' } })]);
    expect(snoozed.mailboxIds).toEqual({ inbox: true, 'folder-snoozed': true });
    expect(snoozed.snooze).toEqual({ until: '2026-10-06T12:00:00Z', mailboxIds: { inbox: true } });
    const actualInbox = { ...email, mailboxIds: { 'folder-inbox': true, label: true } };
    const pending = applyRules(actualInbox, [rule('snooze', { actions: { snoozeUntil: '2026-10-06T12:00:00Z' } })]);
    expect(pending.mailboxIds).toEqual({ label: true, 'folder-snoozed': true });
    expect(matchesFilter(pending, { isSnoozed: true })).toBe(true);
    expect(matchesFilter(pending, { isSnoozed: false })).toBe(false);
    const restored = applyRules(pending, [rule('clear', { actions: { snoozeUntil: null } })]);
    expect(restored.mailboxIds).toEqual(actualInbox.mailboxIds); expect(restored.snooze).toBeUndefined();
    expect(matchesFilter(restored, { isSnoozed: false })).toBe(true);
    expect(() => validateRule({ ...rule('invalid'), condition: { isSnoozed: 'yes' } })).toThrow();
    expect(matchesFilter({ ...email, followUp: { at: '2026-10-06T12:00:00Z' } }, { isFollowUp: true })).toBe(true);
    expect(matchesFilter(email, { isFollowUp: false })).toBe(true);
    expect(() => validateRule({ ...rule('invalid'), condition: { isFollowUp: 'yes' } })).toThrow();
  });
  it('collects forwarding directives only with explicit authority, matching and ordered stop semantics', () => {
    const rules = [rule('no-match', { condition: { from: 'nobody' }, actions: { forwardTo: ['ignored@example.com'] } }), rule('disabled', { enabled: false, actions: { forwardTo: ['disabled@example.com'] } }), rule('first', { actions: { forwardTo: ['reports@example.com'] } }), rule('second', { actions: { forwardTo: ['REPORTS@example.com', 'archive@example.com'] }, stop: true }), rule('later', { actions: { forwardTo: ['later@example.com'] } })];
    expect(applyRules(email, rules).ruleForwards).toBeUndefined();
    expect(applyRules(email, rules, { allowForwarding: true }).ruleForwards).toBeUndefined();
    expect(applyRules(email, rules, { allowForwarding: true, verifiedForwardingAddresses: ['reports@example.com', 'archive@example.com'] }).ruleForwards).toEqual([{ ruleId: 'first', address: 'reports@example.com' }, { ruleId: 'second', address: 'archive@example.com' }]);
    expect(applyRules({ ...email, ruleForwards: [{ ruleId: 'old', address: 'old@example.com' }] }, rules).ruleForwards).toBeUndefined();
    expect(email.ruleForwards).toBeUndefined();
    for (const forwardTo of [[], ['not-address'], Array(6).fill('x@example.com'), ['Name <x@example.com>'], ['x@example.com\r\nBcc:x@bad.com']]) expect(() => validateRule({ ...rule('invalid'), actions: { forwardTo } })).toThrow('forwarding');
  });
  it('does not forward messages classified as junk or trash, even when later rules remove that label', () => {
    const forward = rule('forward', { actions: { forwardTo: ['x@example.com'] } });
    const restore = rule('restore', { actions: { removeMailboxIds: ['folder-junk', 'folder-trash'] } });
    for (const mailbox of ['folder-junk', 'folder-trash']) expect(applyRules({ ...email, mailboxIds: { [mailbox]: true } }, [restore, forward], { allowForwarding: true, verifiedForwardingAddresses: ['x@example.com'] }).ruleForwards).toBeUndefined();
    expect(applyRules(email, [forward, rule('junk', { actions: { addMailboxIds: ['folder-junk'] } })], { allowForwarding: true, verifiedForwardingAddresses: ['x@example.com'] }).ruleForwards).toBeUndefined();
  });
  it('resumes bounded application pages with frozen rules and refuses stale cursor replay', () => {
    const configured = rule('first');
    const job = createRuleApplySnapshot('job', [configured], 100_000);
    configured.actions.keywords!['$seen'] = true;
    expect(job.rules[0].actions.keywords).toEqual({ '$flagged': true });
    expect('targetIds' in job).toBe(false);
    const batch = nextRuleApplyBatch(job, { position: 0, total: 100_000, ids: ['a', 'b'] });
    const progress = advanceRuleApplySnapshot(job, batch, { updated: 1, missing: 1 });
    expect(progress).toMatchObject({ cursor: 2, processed: 2, updated: 1, missing: 1 });
    expect(() => advanceRuleApplySnapshot(progress, batch, { updated: 1, missing: 1 })).toThrow('cursor changed');
    expect(() => nextRuleApplyBatch(progress, { position: 2, total: 100_001, ids: ['c'] })).toThrow();
    expect(() => nextRuleApplyBatch(progress, { position: 2, total: 100_000, ids: [] })).toThrow();
    expect(() => nextRuleApplyBatch(job, { position: 0, total: 100_000, ids: Array.from({ length: 101 }, (_, i) => String(i)) })).toThrow();
    const empty = createRuleApplySnapshot('empty', [], 0);
    expect(nextRuleApplyBatch(empty, { position: 0, total: 0, ids: [] }).done).toBe(true);
  });
  it('parses supported Gmail search syntax and rejects unsupported semantics', () => {
    expect(matchesFilter(email, parseSearchQuery('from:alice subject:"Quarterly report" has:attachment is:unread -label:trash larger:2k before:2026/10/06'))).toBe(true);
    expect(matchesFilter(email, parseSearchQuery('from:nobody OR body:"ten percent"'))).toBe(true);
    expect(parseSearchQuery('')).toEqual({});
    for (const query of ['has:drive', 'is:important', 'before:yesterday', 'larger:invalid', 'from:"Alice', 'OR from:alice', 'from:alice OR']) expect(() => parseSearchQuery(query)).toThrow();
  });
});
