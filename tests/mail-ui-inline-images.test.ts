import {describe,expect,it} from 'vitest';
import {contentId,inlineImageParts,rasterDataUrl} from '../apps/mail/src/ui/inline-images';
describe('Embedded image safety',()=>{
 it('resolves RFC Content-ID without treating it as a web URL',()=>{expect(contentId('cid:logo%40example.test')).toBe('logo@example.test');expect(contentId('<logo@example.test>')).toBe('logo@example.test');});
 it('bounds images and excludes active SVG content, missing IDs and duplicate IDs',()=>{const part={blobId:'b',cid:'logo',type:'image/png',size:10};expect(inlineImageParts([part,{...part,blobId:'duplicate'},{...part,cid:'svg',type:'image/svg+xml'},{...part,cid:null},{...part,cid:'large',size:6*1024*1024}])).toEqual([part]);});
 it('validates decoded MIME bytes before putting them in the opaque reader',()=>{expect(rasterDataUrl(Uint8Array.from([137,80,78,71,13,10,26,10]).buffer,'image/png')).toMatch(/^data:image\/png;base64,/);expect(()=>rasterDataUrl(new TextEncoder().encode('<svg onload="alert(1)">').buffer,'image/png')).toThrow('does not match');});
});
