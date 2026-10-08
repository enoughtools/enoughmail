import {safeEndpoint,type MailSession} from './jmap';
export function mailEventEndpoint(session:MailSession):string|null{return session.eventSourceUrl?safeEndpoint(session.eventSourceUrl.replace('{types}','*').replace('{closeafter}','no').replace('{ping}','0')):null;}
/** State hints carry no message authority. Unknown accounts and content are ignored. */
export function mailStateHint(raw:string,accounts:Record<string,unknown>,previous:Map<string,string>):{refresh:boolean;arrival:boolean}{
 const result={refresh:false,arrival:false};let event:any;try{event=JSON.parse(raw);}catch{return result;}if(event?.['@type']!=='StateChange'||!event.changed||typeof event.changed!=='object')return result;
 for(const [account,types] of Object.entries(event.changed)){if(!Object.hasOwn(accounts,account)||!types||typeof types!=='object')continue;for(const [type,state] of Object.entries(types)){if(!['Email','EmailDelivery','Mailbox','Thread'].includes(type)||typeof state!=='string'||state.length>256)continue;const key=`${account}:${type}`;const prior=previous.get(key);previous.set(key,state);if(prior!==state){result.refresh=true;if(type==='EmailDelivery'&&prior!==undefined)result.arrival=true;}}}return result;
}
