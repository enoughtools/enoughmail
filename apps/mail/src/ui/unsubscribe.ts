import type {Email} from './jmap';
/** Sender-provided links are shown for a deliberate visit, never fetched by the app. */
export function unsubscribeLink(email:Pick<Email,'headers'>):string|null{
 const header=email.headers?.find(value=>value.name.toLowerCase()==='list-unsubscribe')?.value;if(!header||header.length>8192)return null;
 for(const candidate of header.matchAll(/<([^<>]+)>/g))try{const url=new URL(candidate[1].trim());const host=url.hostname.toLowerCase();if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.includes(':')||/^(?:127|10|0|169\.254|192\.168)\./.test(host)||/^172\.(?:1[6-9]|2\d|3[01])\./.test(host))continue;return url.href;}catch{/* Malformed destinations are omitted. */}
 return null;
}
