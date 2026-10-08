/** RFC 8292 keys are private to one actor's durable push registry. */
export interface VapidKeys { publicKey: string; privateKey: JsonWebKey }
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export async function createVapidKeys(): Promise<VapidKeys> {
 const keys = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 return {publicKey:base64(new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey))),privateKey:await crypto.subtle.exportKey('jwk',keys.privateKey)};
}
export async function vapidAuthorization(keys:VapidKeys, endpoint:string,subject?:string):Promise<string> {
 const encode=(value:unknown)=>base64(new TextEncoder().encode(JSON.stringify(value)));
 const token=encode({typ:'JWT',alg:'ES256'})+'.'+encode({aud:new URL(endpoint).origin,exp:Math.floor(Date.now()/1000)+3600,...(subject?{sub:subject}:{})});
 const key=await crypto.subtle.importKey('jwk',keys.privateKey,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(token));
 return `vapid t=${token}.${base64(new Uint8Array(signature))}, k=${keys.publicKey}`;
}
