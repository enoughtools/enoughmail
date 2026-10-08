// @vitest-environment happy-dom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,test,vi} from 'vitest';
import {useMailConfirm} from '../apps/mail/src/ui/use-mail-confirm';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let dispose=()=>{};
afterEach(()=>{dispose();document.body.innerHTML='';vi.restoreAllMocks();vi.unstubAllGlobals();});
test('canceling an EnoughUI confirmation resolves false; accepting resolves true without a browser prompt',async()=>{
 const native=vi.fn();vi.stubGlobal('confirm',native);let ask!:ReturnType<typeof useMailConfirm>['confirm'];
 function Harness(){const value=useMailConfirm();ask=value.confirm;return value.dialog;}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);dispose=()=>act(()=>root.unmount());
 await act(async()=>root.render(<Harness/>));
 let result!:Promise<boolean>;await act(async()=>{result=ask('Selected mail moves to Trash.','Move to Trash?','Move');});
 expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Move to Trash?');
 await act(async()=>{(document.querySelector('[data-slot="alert-dialog-cancel"]') as HTMLElement).click();});
 expect(await result).toBe(false);
 await act(async()=>{result=ask('Delete selected mail?','Delete mail?','Delete');});
 await act(async()=>{(document.querySelector('[data-slot="alert-dialog-action"]') as HTMLElement).click();});
 expect(await result).toBe(true);expect(native).not.toHaveBeenCalled();
});
test('closing the owning screen cancels an unresolved confirmation',async()=>{
 let ask!:ReturnType<typeof useMailConfirm>['confirm'];function Harness(){const value=useMailConfirm();ask=value.confirm;return value.dialog;}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Harness/>));
 let result!:Promise<boolean>;await act(async()=>{result=ask('Apply changes?');});
 await act(async()=>root.unmount());expect(await result).toBe(false);
});
