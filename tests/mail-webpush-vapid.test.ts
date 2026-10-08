import {it,expect} from 'vitest';
import {createVapidKeys,vapidAuthorization} from '../apps/mail/src/server/webpush-vapid';
it('signs a bounded ES256 VAPID token for the endpoint origin with its advertised public key',async()=>{
 const keys=await createVapidKeys(),header=await vapidAuthorization(keys,'https://fcm.googleapis.com/send/private','https://mail.example.com/');
 const token=/t=([^,]+)/.exec(header)![1],parts=token.split('.');const decode=(part:string)=>Uint8Array.from(atob(part.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));
 expect(header).toContain('k='+keys.publicKey);const claims=JSON.parse(new TextDecoder().decode(decode(parts[1])));expect(claims).toMatchObject({aud:'https://fcm.googleapis.com',sub:'https://mail.example.com/'});expect(claims.exp).toBeGreaterThan(Date.now()/1000);expect(claims.exp).toBeLessThan(Date.now()/1000+86400);
 const publicKey=await crypto.subtle.importKey('raw',decode(keys.publicKey),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);expect(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,decode(parts[2]),new TextEncoder().encode(parts.slice(0,2).join('.')))).toBe(true);
});
