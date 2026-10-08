import {describe,expect,it} from 'vitest';
import {unsubscribeLink} from '../apps/mail/src/ui/unsubscribe';
describe('Deliberate unsubscribe link',()=>{
 it('selects a supplied HTTPS address without making a network request',()=>{expect(unsubscribeLink({headers:[{name:'List-Unsubscribe',value:'<mailto:list@example.com>, <https://lists.example.com/unsubscribe?token=abc>'}]})).toBe('https://lists.example.com/unsubscribe?token=abc');});
 it.each(['javascript:alert(1)','http://lists.example.com/unsubscribe','https://localhost/u','https://127.0.0.1/u','https://169.254.169.254/u','https://10.1.2.3/u','https://172.16.0.1/u','https://192.168.1.1/u','https://[::1]/u','https://user:secret@example.com/u','https://example.com:8443/u'])('omits unsafe destination %s',(value)=>{expect(unsubscribeLink({headers:[{name:'list-unsubscribe',value:`<${value}>`}]})).toBeNull();});
 it('omits mail without a usable supplied header',()=>{expect(unsubscribeLink({headers:[]})).toBeNull();expect(unsubscribeLink({headers:[{name:'List-Unsubscribe',value:'invalid'}]})).toBeNull();});
});
