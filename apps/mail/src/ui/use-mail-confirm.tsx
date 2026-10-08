import {useCallback,useEffect,useRef,useState} from 'react';
import {AlertDialog,AlertDialogContent,AlertDialogHeader,AlertDialogTitle,AlertDialogDescription,AlertDialogFooter,AlertDialogCancel,AlertDialogAction} from '@rebnz/enough-ui/alert-dialog';

/** Product-owned confirmation: keyboard accessible, cancellable and never a native browser prompt. */
export function useMailConfirm(){
 const [request,setRequest]=useState<{description:string;title:string;action:string}|null>(null);
 const resolve=useRef<((value:boolean)=>void)|null>(null);
 const finish=useCallback((value:boolean)=>{const pending=resolve.current;resolve.current=null;setRequest(null);pending?.(value);},[]);
 useEffect(()=>()=>{resolve.current?.(false);resolve.current=null;},[]);
 const confirm=useCallback((description:string,title='Confirm change',action='Confirm')=>new Promise<boolean>(accept=>{resolve.current?.(false);resolve.current=accept;setRequest({description,title,action});}),[]);
 const dialog=<AlertDialog open={!!request} onOpenChange={open=>{if(!open)finish(false);}}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{request?.title}</AlertDialogTitle><AlertDialogDescription>{request?.description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel onClick={()=>finish(false)}>Cancel</AlertDialogCancel><AlertDialogAction onClick={()=>finish(true)}>{request?.action}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
 return {confirm,dialog};
}
