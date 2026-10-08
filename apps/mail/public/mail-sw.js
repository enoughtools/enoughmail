/* This cache contains the static application shell only. Mail and identity remain
   in the product's bounded, scoped browser storage, never in this worker cache. */
const CACHE = 'enough-mail-shell-v1';
const SHELL = '/apps/mail/';
function staticUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || url.search || url.hash || url.username || url.password) return null;
    if (url.pathname === SHELL || /^\/apps\/mail\/assets\/[^/]+\.(js|css)$/.test(url.pathname)) return url;
  } catch { /* Invalid message URL. */ }
  return null;
}
function cacheable(response, url) {
  if (!response.ok || response.status !== 200 || response.redirected || response.type === 'opaque') return false;
  if (response.url && response.url !== url.href) return false;
  const type = response.headers.get('content-type') || '';
  return url.pathname === SHELL ? type.includes('text/html') : url.pathname.endsWith('.css') ? type.includes('text/css') : /javascript/.test(type);
}
async function preload(value) {
  const url = staticUrl(value);
  if (!url) return;
  const response = await fetch(url.href, { redirect: 'error', cache: 'no-cache', credentials: 'same-origin' });
  if (cacheable(response, url)) await (await caches.open(CACHE)).put(url.href, response);
}
self.addEventListener('install', event => {
  event.waitUntil(Promise.all([preload(SHELL).catch(() => {}),self.skipWaiting()]));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('enough-mail-shell-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_MAIL_SHELL' || !Array.isArray(event.data.urls)) return;
  // Messages may only request a bounded set of static assets already on this origin.
  const urls = event.data.urls.slice(0, 100).filter(value => typeof value === 'string' && staticUrl(value));
  event.waitUntil(Promise.allSettled([preload(SHELL), ...urls.map(preload)]));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = staticUrl(request.url);
  if (!url || (url.pathname === SHELL && request.mode !== 'navigate')) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (cacheable(response, url)) {
        try { await (await caches.open(CACHE)).put(url.href, response.clone()); } catch { /* Storage is optional. */ }
      }
      // Any HTTP response, including 401/403/5xx, is returned without offline fallback.
      return response;
    } catch {
      const cached = await (await caches.open(CACHE)).match(url.href);
      if (cached) return cached;
      return new Response('Enough Mail is unavailable offline. Reconnect to load it.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});

/* Only generic notification text and opaque state cursors are stored here. */
function notificationConfig(write) {
 return new Promise((resolve,reject)=>{
  const open=indexedDB.open('enough-mail-notifications',1);
  open.onupgradeneeded=()=>open.result.createObjectStore('settings');
  open.onerror=()=>reject(open.error);
  open.onsuccess=()=>{const db=open.result,tx=db.transaction('settings',write===undefined?'readonly':'readwrite'),store=tx.objectStore('settings');const request=write===undefined?store.get('config'):store.put(write,'config');let value;request.onsuccess=()=>{value=request.result;};tx.oncomplete=()=>{db.close();resolve(value);};tx.onerror=()=>{db.close();reject(tx.error);};};
 });
}
self.addEventListener('message',event=>{
 if(event.data?.type==='MAIL_NOTIFICATIONS_STATUS'){event.waitUntil(notificationConfig().then(config=>event.ports[0]?.postMessage({lastNotificationAt:config?.lastNotificationAt??null})));return;}
 if(event.data?.type!=='MAIL_NOTIFICATIONS_CONFIG')return;
 const config=event.data.config;if(config?.enabled===true){try{const url=new URL(config.apiUrl);if(url.origin!==self.location.origin||url.pathname!=='/apps/mail/jmap/api'||!config.states||Object.keys(config.states).length>100||Object.values(config.states).some(value=>typeof value!=='string'||value.length>256))return;}catch{return;}}
 event.waitUntil(notificationConfig(config).then(()=>event.ports[0]?.postMessage({saved:true})).catch(()=>event.ports[0]?.postMessage({saved:false})));
});
const notificationOptions={icon:'/apps/mail/icons/mail-192.png',badge:'/apps/mail/icons/mail-192.png',tag:'enough-mail-arrival'};
let notificationQueue=Promise.resolve();
self.addEventListener('push',event=>{
 notificationQueue=notificationQueue.catch(()=>{}).then(async()=>{
  const config=await notificationConfig();if(!config?.enabled)return;
  let data;try{data=event.data?.json();}catch{return;}
  if(data?.['@type']==='PushVerification'){
   if(typeof data.pushSubscriptionId!=='string'||typeof data.verificationCode!=='string')return;
   const response=await fetch(config.apiUrl,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({using:['urn:ietf:params:jmap:core'],methodCalls:[['PushSubscription/set',{operationId:crypto.randomUUID(),update:{[data.pushSubscriptionId]:{verificationCode:data.verificationCode}}},'verify']]})});
   const result=await response.json();const verified=response.ok&&result.methodResponses?.some(([name,value])=>name==='PushSubscription/set'&&Object.hasOwn(value.updated||{},data.pushSubscriptionId));
   const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of windows)client.postMessage({type:'MAIL_PUSH_VERIFIED',verified});
   await self.registration.showNotification('Enough Mail', {...notificationOptions,tag:'enough-mail-setup',body:verified?'Notifications are enabled on this device.':'Open Enough Mail to finish enabling notifications.'});return;
  }
  if(data?.['@type']!=='StateChange'||!data.changed||typeof data.changed!=='object')return;
  let arrival=false;for(const [account,types] of Object.entries(data.changed)){const state=types?.EmailDelivery;if(typeof state!=='string'||state.length>256||!Object.hasOwn(config.states,account))continue;if(config.states[account]!==state){arrival=true;config.states[account]=state;}}
  if(arrival){await notificationConfig(config);await self.registration.showNotification('New mail in Enough Mail',{...notificationOptions,body:'You have new inbox mail. Open Enough Mail to read it.'});config.lastNotificationAt=Date.now();await notificationConfig(config);}
 });event.waitUntil(notificationQueue);
});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of windows){if(new URL(client.url).origin===self.location.origin&&new URL(client.url).pathname.startsWith(SHELL)){await client.focus();return;}}await self.clients.openWindow(SHELL);})());});
