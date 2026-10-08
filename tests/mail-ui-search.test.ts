import { describe, expect, it } from 'vitest';
import { parseMailSearch, sortMailRows } from '../apps/mail/src/ui/search';
import type { Email, Mailbox } from '../apps/mail/src/ui/jmap';
const boxes: Mailbox[] = [
  { id: 'in', name: 'Inbox', role: 'inbox', totalEmails: 0, unreadEmails: 0 },
  { id: 'work', name: 'Work Projects', role: null, totalEmails: 0, unreadEmails: 0 },
  { id: 'spam', name: 'Spam', role: 'junk', totalEmails: 0, unreadEmails: 0 },
];
describe('mail UI search', () => {
  it('resolves mailbox roles and quoted labels and combines clauses', () => {
    expect(parseMailSearch('in:inbox label:"Work Projects" from:alice subject:"budget meeting"', boxes)).toEqual({operator:'AND',conditions:[{inMailbox:'in'},{inMailbox:'work'},{from:'alice'},{subject:'budget meeting'}]});
    expect(parseMailSearch('in:spam', boxes)).toEqual({inMailbox:'spam'});
  });
  it('uses AND precedence and parenthesized alternatives with negation', () => {
    expect(parseMailSearch('(from:a OR from:b) AND -is:read', boxes)).toEqual({operator:'AND',conditions:[{operator:'OR',conditions:[{from:'a'},{from:'b'}]},{operator:'NOT',conditions:[{hasKeyword:'$seen'}]}]});
    expect(parseMailSearch('a b OR c', boxes)).toEqual({operator:'OR',conditions:[{operator:'AND',conditions:[{text:'a'},{text:'b'}]},{text:'c'}]});
  });
  it('supports dates sizes flags and attachments without losing strict size semantics', () => {
    expect(parseMailSearch('older:2026/2/28 newer:2025-01-01 larger:1M smaller:2K is:important has:attachment filename:pdf deliveredto:alias@example.com', boxes)).toEqual({operator:'AND',conditions:[{before:'2026-02-28T00:00:00.000Z'},{after:'2025-01-01T00:00:00.000Z'},{minSize:1048577},{maxSize:2048},{hasKeyword:'$important'},{hasAttachment:true},{attachmentName:'pdf'},{header:['Delivered-To','alias@example.com']}]});
    expect(parseMailSearch('is:unread', boxes)).toEqual({notKeyword:'$seen'});
    expect(parseMailSearch('is:starred', boxes)).toEqual({hasKeyword:'$flagged'});
  });
  it('keeps quoted boolean words literal and escaped quotes intact', () => {
    expect(parseMailSearch('"AND" "hello \\"world\\""', boxes)).toEqual({operator:'AND',conditions:[{text:'AND'},{text:'hello "world"'}]});
  });
  it.each(['from:', 'unknown:value', 'before:2026-02-30', 'larger:no', 'OR a', 'a OR', 'a AND', '()', '(a', 'a)', '"open', '-', 'is:magic'])('rejects invalid search %s', query => {
    expect(() => parseMailSearch(query, boxes)).toThrow();
  });
  it('keeps a colon inside a fully quoted phrase as text', () => expect(parseMailSearch('"status: ready"', boxes)).toEqual({text:'status: ready'}));
  it('rejects missing or ambiguous mailboxes', () => {
    expect(() => parseMailSearch('label:missing', boxes)).toThrow('not found');
    expect(() => parseMailSearch('label:Inbox', [...boxes, {...boxes[0],id:'another'}])).toThrow('ambiguous');
  });
  it('empty search matches all', () => expect(parseMailSearch('  ', boxes)).toEqual({}));
});
const row = (accountId: string, id: string, overrides: Partial<Email> = {}): Email & {accountId:string} => ({accountId,id,threadId:id,blobId:id,mailboxIds:{},keywords:{},from:[{email:'sender@example.com'}],to:[],subject:'same',receivedAt:'2026-01-01T00:00:00Z',preview:'',hasAttachment:false,...overrides});
describe('unified mail sorting', () => {
  it('stabilizes ties by account then ID regardless of sort direction, without mutation', () => {
    const rows = [row('b','1'),row('a','2'),row('a','1')];
    expect(sortMailRows(rows,'receivedAt',false).map(v=>`${v.accountId}/${v.id}`)).toEqual(['a/1','a/2','b/1']);
    expect(rows[0].accountId).toBe('b');
  });
  it('sorts dates subjects senders and flags', () => {
    const rows = [row('a','1',{subject:'Z',from:[{name:'Zoe',email:'z@e.com'}],keywords:{$seen:true}}),row('a','2',{subject:'A',from:[{email:'a@e.com'}],receivedAt:'2026-02-01T00:00:00Z',keywords:{$flagged:true}})];
    for (const [sort,ascending] of [['subject',true],['from',true],['receivedAt',false],['unread',false],['starred',false]] as const) expect(sortMailRows(rows,sort,ascending)[0].id).toBe('2');
  });
  it('rejects unsupported sort fields', () => expect(()=>sortMailRows([], 'random',true)).toThrow('Unsupported'));
});
