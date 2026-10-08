import {describe,it,expect} from 'vitest';
import {recipientTokens,parseRecipients,completeRecipients,recipientSuggestions,insertRecipient} from '../apps/mail/src/domain/recipients';
import {validateSubmissionEnvelope} from '../apps/mail/src/domain/submission';
import {MailViewCache} from '../apps/mail/src/ui/view-cache';

describe('Recipient entry and draft preservation',()=>{
 it('parses display names, quoted commas, multiple separators and incomplete tokens',()=>{
  const input='"Morgan, Alex" <alex@example.test>; jane@example.test, unfinished@';
  expect(recipientTokens(input)).toHaveLength(3);expect(parseRecipients(input)).toEqual([{name:'Morgan, Alex',email:'alex@example.test'},{email:'jane@example.test'},{email:'unfinished@'}]);expect(completeRecipients(input)).toHaveLength(2);
 });
 it('suggests the active token without duplicating previous recipients or replacing them',()=>{
  const contacts=[{name:'Alex Morgan',email:'alex@example.test'},{name:'Jamie Chen',email:'jamie@example.test'},{email:'jamie@example.test'}];
  expect(recipientSuggestions('alex@example.test, jam',contacts)).toEqual([contacts[1]]);expect(insertRecipient('alex@example.test, jam',contacts[1])).toBe('alex@example.test, jamie@example.test, ');expect(recipientSuggestions('alex@example.test, alex',contacts)).toEqual([]);
 });
 it('refuses sending incomplete recipient text even when the stored delivery subset is valid',()=>{
  const email={to:[{email:'recipient@example.test'}],draftRecipients:{to:'recipient@example.test, unfin',cc:'',bcc:''}};const identity={email:'sender@example.test'};
  expect(()=>validateSubmissionEnvelope({},email,identity)).toThrow('incomplete recipient');expect(validateSubmissionEnvelope({},{...email,draftRecipients:{to:'Person <recipient@example.test>'}},identity).envelope.rcptTo[0].email).toBe('recipient@example.test');
 });
});
describe('Mailbox view memory cache',()=>{
 it('isolates exact scope and view, expires entries, bounds retention and clears on access loss',()=>{
  const cache=new MailViewCache<{ids:string[]}>(100,2);cache.set('actor-a:inbox',{ids:['private']},0);expect(cache.get('actor-b:inbox',1)).toBeUndefined();const read=cache.get('actor-a:inbox',1)!;read.ids.push('changed');expect(cache.get('actor-a:inbox',1)?.ids).toEqual(['private']);cache.set('actor-a:sent',{ids:['sent']},1);cache.set('actor-a:archive',{ids:[]},2);expect(cache.get('actor-a:inbox',3)).toBeUndefined();expect(cache.get('actor-a:sent',102)).toBeUndefined();cache.clear();expect(cache.get('actor-a:archive',3)).toBeUndefined();
 });
});
