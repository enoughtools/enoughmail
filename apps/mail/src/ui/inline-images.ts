import type {BodyPart} from './jmap';
export const INLINE_TOTAL_LIMIT=10*1024*1024;
export function contentId(value:string):string {let decoded=value.replace(/^cid:/i,'');try{decoded=decodeURIComponent(decoded);}catch{/* Invalid encoding cannot change identity. */}return decoded.replace(/^<|>$/g,'');}
export function inlineImageParts(parts:BodyPart[]|undefined):BodyPart[]{const seen=new Set<string>();let size=0;return (parts||[]).filter(part=>{if(!part.cid||!part.blobId||!/^image\/(png|jpeg|gif|webp)$/i.test(part.type)||!Number.isFinite(part.size)||part.size<0||part.size>5*1024*1024)return false;const cid=contentId(part.cid);if(!cid||seen.has(cid)||size+part.size>INLINE_TOTAL_LIMIT)return false;seen.add(cid);size+=part.size;return true;}).slice(0,20);}
export function rasterDataUrl(bytes:ArrayBuffer,type:string):string {
 const data=new Uint8Array(bytes);const starts=(values:number[])=>values.every((value,index)=>data[index]===value);
 const valid=type==='image/png'?starts([137,80,78,71,13,10,26,10]):type==='image/jpeg'?starts([255,216,255]):type==='image/gif'?starts([71,73,70,56])&&(data[4]===55||data[4]===57)&&data[5]===97:type==='image/webp'?starts([82,73,70,70])&&String.fromCharCode(...data.slice(8,12))==='WEBP':false;
 if(!valid)throw new Error('Embedded image does not match its supported image format.');
 let binary='';for(let offset=0;offset<data.length;offset+=8192)binary+=String.fromCharCode(...data.subarray(offset,offset+8192));return `data:${type};base64,${btoa(binary)}`;
}
