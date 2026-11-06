/** Only explicit HTTPS image URLs without embedded credentials can contact a sender. */
export function remoteMailImageUrl(value: string): boolean {
 try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
/** Inspect sender dimensions before layout sanitization removes heights. */
function nonContentMailImage(image: HTMLImageElement): boolean {
 for(const dimension of ['width','height']){
  const value=(image.style.getPropertyValue(dimension)||image.getAttribute(dimension)||'').trim();
  if(/^(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/i.test(value)&&Number(value.replace(/px$/i,''))<=2)return true;
 }
 for(let element:HTMLElement|null=image;element;element=element.parentElement){
  if(element.hasAttribute('hidden')||element.style.display==='none'||['hidden','collapse'].includes(element.style.visibility))return true;
 }
 return false;
}
/** Parse attributes so encoded schemes and whitespace get the same opt-in UI. */
export function hasRemoteMailImages(html: string): boolean {
 const template = document.createElement('template'); template.innerHTML = html;
 return [...template.content.querySelectorAll<HTMLImageElement>('img[src]')].some(image => remoteMailImageUrl(image.getAttribute('src') || '')&&!nonContentMailImage(image));
}
/** Untrusted mail is displayed in a sandbox with no automatic network or navigation surfaces; remote images require explicit opt-in. */
export function safeMailHtml(html:string,allowRemoteImages=false,inlineImages:Record<string,string>={}):string {
 const template=document.createElement('template');
 template.innerHTML=html;
 const fragment=template.content;
 fragment.querySelectorAll('script,noscript,template,meta,link,base,style,form,input,button,select,textarea,option,dialog,iframe,frame,frameset,embed,object,svg,math,video,audio,source,track').forEach(element=>element.remove());
 for(const image of fragment.querySelectorAll<HTMLImageElement>('img[src]'))if(remoteMailImageUrl(image.getAttribute('src')||'')&&nonContentMailImage(image))image.remove();
 for(const image of fragment.querySelectorAll('img[src]')){const source=(image.getAttribute('src')||'').trim();if(/^cid:/i.test(source)){let key=source.slice(4);try{key=decodeURIComponent(key);}catch{/* malformed CID stays unmatched */}key=key.replace(/^<|>$/g,'');const replacement=inlineImages[key];if(replacement&&/^data:image\/(png|jpeg|gif|webp);base64,/i.test(replacement))image.setAttribute('src',replacement);else image.removeAttribute('src');}}
 for(const element of fragment.querySelectorAll('*'))for(const attribute of [...element.attributes]){
  const name=attribute.name.toLowerCase();const value=attribute.value.trim();
  if(name.startsWith('on')||['id','name','autofocus','contenteditable','height','data-mail-table-scroll','data-mail-readable-table'].includes(name)||['href','action','formaction','srcdoc','srcset','ping','background','poster','xlink:href'].includes(name)||name==='style'&&/url\s*\(/i.test(value)||name==='src'&&!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(value)&&!(allowRemoteImages&&element.tagName==='IMG'&&remoteMailImageUrl(value)))element.removeAttribute(attribute.name);
 }
 for(const element of fragment.querySelectorAll<HTMLElement>('[style]')){for(const property of Array.from(element.style)){if(['position','height','min-height','max-height','overflow','overflow-x','overflow-y'].includes(property)||/url|image|expression|behavior|import/i.test(property+' '+element.style.getPropertyValue(property)))element.style.removeProperty(property);}}
 for(const image of fragment.querySelectorAll('img')){
  if(image.hasAttribute('src')){image.setAttribute('referrerpolicy','no-referrer');continue;}
  const alt=image.getAttribute('alt')?.trim();
  if(!alt||Number(image.getAttribute('width'))>0&&Number(image.getAttribute('width'))<=2){image.remove();continue;}
  const placeholder=document.createElement('span');placeholder.className='mail-hidden-image';placeholder.setAttribute('role','img');placeholder.setAttribute('aria-label',alt);placeholder.textContent=alt;image.replaceWith(placeholder);
 }
 for(const quote of [...fragment.querySelectorAll('blockquote')]){if(quote.closest('details'))continue;const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Quoted text';quote.replaceWith(details);details.append(summary,quote);}
 for(const table of [...fragment.querySelectorAll('table')]){
  // Newsletter tables arrange artwork, spacer cells and nested blocks. Giving
  // those cells a data-column minimum expands the whole newsletter sideways.
  if(['presentation','none'].includes(table.getAttribute('role')||'')||table.querySelector('table'))continue;
  const rows=[...table.querySelectorAll('tr')].filter(row=>row.closest('table')===table);
  const columns=Math.max(0,...rows.map(row=>[...row.children].filter(cell=>['TD','TH'].includes(cell.tagName)).reduce((sum,cell)=>sum+Math.max(1,Number(cell.getAttribute('colspan'))||1),0)));
  const headers=rows.some(row=>[...row.children].some(cell=>cell.tagName==='TH'));
  const dataRows=rows.filter(row=>[...row.children].filter(cell=>['TD','TH'].includes(cell.tagName)&&!!cell.textContent?.trim()).length>=3);
  if(!(columns>=2&&headers)&&!(columns>=3&&dataRows.length>=2))continue;
  const wrapper=document.createElement('div');wrapper.setAttribute('data-mail-table-scroll','');wrapper.setAttribute('role','region');wrapper.setAttribute('aria-label','Message table, scroll horizontally');wrapper.tabIndex=0;
  table.setAttribute('data-mail-readable-table','');table.replaceWith(wrapper);wrapper.append(table);
 }
 return `<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: ${allowRemoteImages?'https:':''};"><style>html{overflow-x:auto;overflow-y:hidden}body{display:flow-root;margin:0;padding:8px 0;font-family:system-ui;font-size:15px;line-height:1.6;overflow-wrap:anywhere;color:#171923;background:white}body *{box-sizing:border-box;max-width:100%!important}img{height:auto!important;object-fit:contain}.mail-hidden-image{display:block;padding:12px;margin:12px 0;border:1px dashed #c6ccd6;color:#626b7a;background:#f5f6f8;font:12px/1.5 system-ui;text-align:center}table{table-layout:auto}[data-mail-table-scroll]{display:block;width:100%;overflow-x:auto;overscroll-behavior-x:contain}[data-mail-readable-table],[data-mail-readable-table] *{max-width:none!important}[data-mail-readable-table]{width:max-content!important;min-width:100%;table-layout:auto!important}[data-mail-readable-table] :is(th,td){min-width:8rem!important;overflow-wrap:normal!important;word-break:normal!important}[data-mail-readable-table] img{max-width:100%!important}[data-mail-table-scroll]:focus-visible{outline:2px solid #575c68;outline-offset:-2px}pre{white-space:pre-wrap}blockquote{margin:12px 0;padding-left:16px;border-left:2px solid #d5d8df}summary{cursor:pointer;color:#575c68}a{color:inherit}</style>${template.innerHTML}`;
}
export function mailLinks(html:string):{label:string;url:string}[]{
 const template=document.createElement('template');template.innerHTML=html;const links=new Map<string,{label:string;url:string}>();
 for(const anchor of template.content.querySelectorAll('a[href]')){try{const url=new URL(anchor.getAttribute('href')||'');if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;links.set(url.href,{label:(anchor.textContent||url.hostname).trim().slice(0,150),url:url.href});if(links.size>=100)break;}catch{/* Invalid and non-web links stay inert. */}}
 return [...links.values()];
}
