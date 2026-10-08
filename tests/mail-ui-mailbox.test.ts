import { describe, expect, it, vi } from 'vitest';
vi.mock('../apps/mail/src/ui/Settings', () => ({default: () => null}));
vi.mock('../apps/mail/src/ui/Compose', () => ({default: () => null}));
import { mailboxViewFilter, addressSummary, sortMailConversation } from '../apps/mail/src/ui/MailApp';
import { matchesCached } from '../apps/mail/src/ui/offline';
import type { Email, Mailbox } from '../apps/mail/src/ui/jmap';

const boxes: Mailbox[] = ['inbox','drafts','sent','archive','junk','trash'].map(role => ({id:`box-${role}`,name:role,role,totalEmails:0,unreadEmails:0}));
boxes.push({id:'projects',name:'Projects',role:null,totalEmails:0,unreadEmails:0});
const email = (id: string, mailbox: string, keywords: Record<string,boolean> = {}): Email => ({id,blobId:id,threadId:id,mailboxIds:{[mailbox]:true},keywords,from:[{name:'Alice',email:'alice@example.com'}],to:[{email:'work@example.com'}],subject:id,preview:id,receivedAt:'2026-10-07T12:00:00Z',hasAttachment:false});

describe('mailbox view isolation', () => {
  it.each(['inbox','drafts','sent','archive','junk','trash'])('maps %s to its own account mailbox, never Inbox fallback', role => {
    const filter = mailboxViewFilter(role, boxes);
    expect(filter).toEqual({inMailbox:`box-${role}`});
    expect(matchesCached(email('match',`box-${role}`),filter)).toBe(true);
    if(role !== 'inbox') expect(matchesCached(email('inbox','box-inbox'),filter)).toBe(false);
  });
  it('shows labels by ID and missing folders as empty', () => {
    expect(mailboxViewFilter('projects',boxes)).toEqual({inMailbox:'projects'});
    expect(mailboxViewFilter('drafts',[])).toEqual({inMailbox:'__missing_mailbox__'});
    expect(mailboxViewFilter('missing-label',boxes)).toEqual({inMailbox:'__missing_mailbox__'});
  });
  it.each([['starred','$flagged'],['important','$important']])('filters %s by keyword while excluding spam and trash', (view,flag) => {
    const filter=mailboxViewFilter(view,boxes);
    expect(matchesCached(email('match','box-inbox',{[flag]:true}),filter)).toBe(true);
    expect(matchesCached(email('plain','box-inbox'),filter)).toBe(false);
    expect(matchesCached(email('trash','box-trash',{[flag]:true}),filter)).toBe(false);
    expect(matchesCached(email('spam','box-junk',{[flag]:true}),filter)).toBe(false);
  });
  it('keeps unread and all-mail views distinct from Inbox', () => {
    expect(matchesCached(email('read','box-inbox',{$seen:true}),mailboxViewFilter('unread',boxes))).toBe(false);
    expect(matchesCached(email('archive','box-archive'),mailboxViewFilter('all',boxes))).toBe(true);
    expect(matchesCached(email('trash','box-trash'),mailboxViewFilter('all',boxes))).toBe(false);
  });
  it('matches Snoozed only when actual snooze state exists', () => {
    const filter=mailboxViewFilter('snoozed',boxes);
    expect(matchesCached({...email('snoozed','box-archive'),snooze:{until:'2027-01-01T00:00:00Z',mailboxIds:{'box-archive':true}}},filter)).toBe(true);
    expect(matchesCached(email('plain','box-inbox'),filter)).toBe(false);
  });
  it('lets an explicit search span folders instead of inheriting the current folder', () => {
    expect(mailboxViewFilter('inbox',boxes,'subject:report')).toEqual({subject:'report'});
  });
  it('narrows received mail by address and sent mail by sender, within its selected folder', () => {
    const received=mailboxViewFilter('inbox',boxes,'',false,'work@example.com');
    expect(matchesCached(email('received','box-inbox'),received)).toBe(true);
    expect(matchesCached({...email('other','box-inbox'),to:[{email:'elsewhere@example.com'}]},received)).toBe(false);
    const sent=mailboxViewFilter('sent',boxes,'',false,'alice@example.com');
    expect(matchesCached(email('sent','box-sent'),sent)).toBe(true);
    expect(matchesCached(email('wrong-folder','box-inbox'),sent)).toBe(false);
  });
});

describe('mailbox presentation data', () => {
  it('keeps both display names and complete addresses for row labels and hover details', () => {
    expect(addressSummary([{name:'Alice',email:'alice@example.com'},{email:'bob@example.com'}])).toBe('Alice <alice@example.com>, bob@example.com');
    expect(addressSummary(null)).toBe('');
  });
  it('sorts conversations chronologically without mutating source so newest is last', () => {
    const old={...email('old','box-inbox'),receivedAt:'2026-10-06T00:00:00Z'};
    const recent=email('recent','box-inbox');
    const source=[recent,old];
    expect(sortMailConversation(source).map(message => message.id)).toEqual(['old','recent']);
    expect(source.map(message => message.id)).toEqual(['recent','old']);
  });
});
