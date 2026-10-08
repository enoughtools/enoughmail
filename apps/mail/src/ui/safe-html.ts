/** Only explicit HTTPS image URLs without embedded credentials can contact a sender. */
export function remoteMailImageUrl(value: string): boolean {
 try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
/** Parse attributes so encoded schemes and whitespace get the same opt-in UI. */
export function hasRemoteMailImages(html: string): boolean {
 const template = document.createElement('template'); template.innerHTML = html;
 return [...template.content.querySelectorAll('img[src]')].some(image => remoteMailImageUrl(image.getAttribute('src') || ''));
}
/** Untrusted mail is displayed in a sandbox with no automatic network or navigation surfaces; remote images require explicit opt-in. */
export function safeMailHtml(html:string,allowRemoteImages=false,inlineImages:Record<string,string>={}):string {
 const template=document.createElement('template');
 template.innerHTML=html;
 const fragment=template.content;
 fragment.querySelectorAll('script,noscript,template,meta,link,base,style,form,input,button,select,textarea,option,dialog,iframe,frame,frameset,embed,object,svg,math,video,audio,source,track').forEach(element=>element.remove());
 for(const image of fragment.querySelectorAll('img[src]')){const source=(image.getAttribute('src')||'').trim();if(/^cid:/i.test(source)){let key=source.slice(4);try{key=decodeURIComponent(key);}catch{/* malformed CID stays unmatched */}key=key.replace(/^<|>$/g,'');const replacement=inlineImages[key];if(replacement&&/^data:image\/(png|jpeg|gif|webp);base64,/i.test(replacement))image.setAttribute('src',replacement);else image.removeAttribute('src');}}
 for(const element of fragment.querySelectorAll('*'))for(const attribute of [...element.attributes]){
  const name=attribute.name.toLowerCase();const value=attribute.value.trim();
  if(name.startsWith('on')||['id','name','autofocus','contenteditable','height'].includes(name)||['href','action','formaction','srcdoc','srcset','ping','background','poster','xlink:href'].includes(name)||name==='style'&&/url\s*\(/i.test(value)||name==='src'&&!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(value)&&!(allowRemoteImages&&element.tagName==='IMG'&&remoteMailImageUrl(value)))element.removeAttribute(attribute.name);
 }
 for(const element of fragment.querySelectorAll<HTMLElement>('[style]')){for(const property of [...element.style]){if(['position','height','min-height','max-height','overflow','overflow-x','overflow-y'].includes(property)||/url|image|expression|behavior|import/i.test(property+' '+element.style.getPropertyValue(property)))element.style.removeProperty(property);}}
 for(const image of fragment.querySelectorAll('img')){
  if(image.hasAttribute('src')){image.setAttribute('referrerpolicy','no-referrer');continue;}
  const alt=image.getAttribute('alt')?.trim();
  if(!alt||Number(image.getAttribute('width'))>0&&Number(image.getAttribute('width'))<=2){image.remove();continue;}
  const placeholder=document.createElement('span');placeholder.className='mail-hidden-image';placeholder.setAttribute('role','img');placeholder.setAttribute('aria-label',alt);placeholder.textContent=alt;image.replaceWith(placeholder);
 }
 for(const quote of [...fragment.querySelectorAll('blockquote')]){if(quote.closest('details'))continue;const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Quoted text';quote.replaceWith(details);details.append(summary,quote);}
 return `<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: ${allowRemoteImages?'https:':''};"><style>html{overflow:hidden}body{display:flow-root;margin:0;padding:8px 0;font-family:system-ui;font-size:15px;line-height:1.6;overflow-wrap:anywhere;color:#171923;background:white}body *{box-sizing:border-box;max-width:100%!important}img{height:auto!important;object-fit:contain}.mail-hidden-image{display:block;padding:12px;margin:12px 0;border:1px dashed #c6ccd6;color:#626b7a;background:#f5f6f8;font:12px/1.5 system-ui;text-align:center}table{table-layout:auto}pre{white-space:pre-wrap}blockquote{margin:12px 0;padding-left:16px;border-left:2px solid #d5d8df}summary{cursor:pointer;color:#575c68}a{color:inherit}</style>${template.innerHTML}`;
}
export function mailLinks(html:string):{label:string;url:string}[]{
 const template=document.createElement('template');template.innerHTML=html;const links=new Map<string,{label:string;url:string}>();
 for(const anchor of template.content.querySelectorAll('a[href]')){try{const url=new URL(anchor.getAttribute('href')||'');if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;links.set(url.href,{label:(anchor.textContent||url.hostname).trim().slice(0,150),url:url.href});if(links.size>=100)break;}catch{/* Invalid and non-web links stay inert. */}}
 return [...links.values()];
}
