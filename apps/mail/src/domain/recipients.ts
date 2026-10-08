export interface RecipientAddress { name?: string; email: string }
/** Split addresses without breaking quoted names such as "Bloxwich, Russell". */
export function recipientTokens(value: string): string[] {
  const tokens:string[]=[];let start=0,quoted=false,escaped=false,angle=0;
  for(let i=0;i<value.length;i++){const c=value[i];if(escaped){escaped=false;continue;}if(c==='\\'&&quoted){escaped=true;continue;}if(c==='"')quoted=!quoted;if(!quoted){if(c==='<')angle++;if(c==='>')angle=Math.max(0,angle-1);if(!angle&&/[,;\n]/.test(c)){tokens.push(value.slice(start,i));start=i+1;}}}
  tokens.push(value.slice(start));return tokens;
}
export function parseRecipient(value:string):RecipientAddress {
  const token=value.trim();const match=/^(.*?)<([^<>]+)>$/.exec(token);
  return match?{...(match[1].trim()?{name:match[1].trim().replace(/^"|"$/g,'').replace(/\\"/g,'"')}:{}),email:match[2].trim()}:{email:token};
}
export function validRecipient(value:string):boolean{return /^[^\s<>@,;"\x00-\x1f]+@[^\s<>@,;"\x00-\x1f]+\.[^\s<>@,;"\x00-\x1f]+$/.test(value);}
export function parseRecipients(value:string):RecipientAddress[]{return recipientTokens(value).filter(token=>token.trim()).map(parseRecipient);}
export function completeRecipients(value:string):RecipientAddress[]{return parseRecipients(value).filter(address=>validRecipient(address.email));}
export function recipientSuggestions(value:string,contacts:RecipientAddress[]):RecipientAddress[]{
  const tokens=recipientTokens(value),query=tokens.at(-1)?.trim().toLowerCase()||'';if(!query)return [];
  const existing=new Set(tokens.slice(0,-1).map(token=>parseRecipient(token).email.toLowerCase()));
  const seen=new Set<string>();return contacts.filter(contact=>{const email=contact.email.toLowerCase();if(!validRecipient(email)||existing.has(email)||seen.has(email))return false;seen.add(email);return `${contact.name||''} ${email}`.toLowerCase().includes(query);}).slice(0,8);
}
export function insertRecipient(value:string,address:RecipientAddress):string {const tokens=recipientTokens(value);tokens[tokens.length-1]=address.email;return tokens.map(token=>token.trim()).filter(Boolean).join(', ')+', ';}
export function validateDraftRecipients(value:unknown):void {
  if(value===undefined||value===null)return;
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['to','cc','bcc'].includes(key))||Object.values(value).some(text=>typeof text!=='string'||text.length>10000||/[\x00\r]/.test(text)))throw new Error('Invalid draft recipient text');
}
