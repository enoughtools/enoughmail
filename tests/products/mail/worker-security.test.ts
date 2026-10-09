import { expect, it } from 'vitest';
import { createMailWorker, type MailEnv } from '../../../apps/mail/src/worker';
const ns={idFromName:(name:string)=>name,get:()=>({async fetch(){throw new Error('Unexpected account request');}})};
const env:MailEnv={AUTH_PROVIDER:'cloudflare-access',MAIL_ACCOUNTS:ns,MAIL_DIRECTORY:ns,MAIL_CREDENTIALS:ns,
 ASSETS:{async fetch(){return new Response('<!doctype html><title>Mail</title>',{headers:{'Content-Type':'text/html; charset=utf-8'}});}},
 CORE:{async fetch(){return Response.json({organizationId:'org',workspaceId:'workspace',actor:{id:'actor',kind:'user'},membership:{status:'active',role:'member',version:1}});}}};
const worker=createMailWorker(async()=>({id:'actor',provider:'cloudflare-access',email:'actor@example.test',displayName:'Actor'}));
it('permits opted-in HTTPS message images only on the authenticated Mail document',async()=>{
 const ui=await worker.fetch(new Request('https://mail.test/apps/mail/'),env);
 expect(ui.status).toBe(200); const policy=ui.headers.get('Content-Security-Policy')!;
 expect(policy).toContain("img-src 'self' data: blob: https:"); expect(policy).toContain("script-src 'self'"); expect(policy).toContain("object-src 'none'"); expect(ui.headers.get('Referrer-Policy')).toBe('no-referrer');
 const api=await worker.fetch(new Request('https://mail.test/apps/mail/health'),env);
 expect(api.headers.get('Content-Security-Policy')).toContain("img-src 'self' data:;");
});

it('preserves the validated OAuth callback policy through the full private worker',async()=>{
 const callback='https://chatgpt.com/connector_platform_oauth_redirect';
 const oauthEnv:MailEnv={...env,MAIL_MCP_PUBLIC_ORIGIN:'https://enoughmail.mcp.test',MAIL_MCP_WORKSPACE_ORIGIN:'https://mail.test',MAIL_MCP_REDIRECT_URIS:callback,
  CORE:{async fetch(request:Request){return new URL(request.url).pathname==='/api/native-resources'?Response.json({resources:[]}):env.CORE!.fetch(request);}}};
 const params=new URLSearchParams({response_type:'code',client_id:'enoughmail-chatgpt',redirect_uri:callback,scope:'mail.read',code_challenge:'a'.repeat(43),code_challenge_method:'S256',resource:'https://enoughmail.mcp.test/mcp',state:'test'});
 const consent=await worker.fetch(new Request('https://mail.test/apps/mail/api/mcp/authorize?'+params),oauthEnv);
 expect(consent.status).toBe(200);
 expect(consent.headers.get('Content-Security-Policy')).toBe(`default-src 'none'; form-action 'self' ${callback}; frame-ancestors 'none'; base-uri 'none'`);
 expect(consent.headers.get('Referrer-Policy')).toBe('same-origin');
 expect(consent.headers.get('X-Content-Type-Options')).toBe('nosniff');
 expect(await consent.text()).toContain('Allow connection');
 params.set('redirect_uri','https://untrusted.example/callback');
 const invalid=await worker.fetch(new Request('https://mail.test/apps/mail/api/mcp/authorize?'+params),oauthEnv);
 expect(invalid.status).not.toBe(200);
 expect(invalid.headers.get('Content-Security-Policy')).not.toContain('untrusted.example');
});

it('rejects opaque and foreign origins on OAuth approval',async()=>{
 for(const origin of ['null','https://untrusted.example']){
  const response=await worker.fetch(new Request('https://mail.test/apps/mail/api/mcp/authorize',{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin'},body:'approve=yes'}),env);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({error:'cross_origin_request'});
 }
});
