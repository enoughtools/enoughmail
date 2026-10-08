import {cacheScope} from './offline';
import type {MailSession,Mailbox,Identity} from './jmap';
const PREFIX='enough-mail:offline-view:v1:';
export interface OfflineView {boxes:Record<string,Mailbox[]>;identities:Record<string,Identity[]>;preferences:Record<string,Record<string,unknown>>;states:[string,string][];expiresAt:number}
export function saveOfflineView(session:MailSession,view:Omit<OfflineView,'expiresAt'>){try{localStorage.setItem(PREFIX+cacheScope(session),JSON.stringify({...view,expiresAt:Date.now()+24*60*60*1000}));}catch{/* Live mail still works without local storage. */}}
export function readOfflineView(session:MailSession):OfflineView|null{try{const value=JSON.parse(localStorage.getItem(PREFIX+cacheScope(session))||'null') as OfflineView|null;if(!value||value.expiresAt<=Date.now()||value.expiresAt>Date.now()+24*60*60*1000||!value.boxes||!value.identities||!value.preferences||!Array.isArray(value.states))return null;return value;}catch{return null;}}
export function clearOfflineViews(){for(let index=localStorage.length-1;index>=0;index--){const key=localStorage.key(index);if(key?.startsWith(PREFIX))localStorage.removeItem(key);}}
