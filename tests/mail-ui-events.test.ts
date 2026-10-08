import {afterEach,describe,expect,it,vi} from 'vitest';
import {mailEventEndpoint,mailStateHint} from '../apps/mail/src/ui/mail-events';
import type {MailSession} from '../apps/mail/src/ui/jmap';
describe('Mail state hints',()=>{
 afterEach(()=>vi.unstubAllGlobals());
 it('subscribes only to a same-origin advertised endpoint',()=>{vi.stubGlobal('window',{location:{origin:'https://enough.test'}});expect(mailEventEndpoint({eventSourceUrl:'/apps/mail/jmap/events?types={types}&closeafter={closeafter}&ping={ping}'} as MailSession)).toBe('/apps/mail/jmap/events?types=*&closeafter=no&ping=0');expect(()=>mailEventEndpoint({eventSourceUrl:'https://other.test/events'} as MailSession)).toThrow('untrusted');});
 it('uses arrival-specific state only after its baseline, not edits or drafts',()=>{const states=new Map<string,string>();const hint=(type:string,state:string)=>mailStateHint(JSON.stringify({'@type':'StateChange',changed:{a:{[type]:state}}}),{a:{}},states);expect(hint('EmailDelivery','d1')).toEqual({refresh:true,arrival:false});expect(hint('Email','2')).toEqual({refresh:true,arrival:false});expect(hint('EmailDelivery','d2')).toEqual({refresh:true,arrival:true});expect(hint('EmailDelivery','d2')).toEqual({refresh:false,arrival:false});});
 it('never treats hints for unknown accounts or malformed states as accessible mail',()=>{const states=new Map<string,string>();expect(mailStateHint(JSON.stringify({'@type':'StateChange',changed:{other:{EmailDelivery:'d2'},a:{Email:{subject:'private'}}}}),{a:{}},states)).toEqual({refresh:false,arrival:false});expect(states.size).toBe(0);expect(mailStateHint('not JSON',{a:{}},states)).toEqual({refresh:false,arrival:false});});
});
