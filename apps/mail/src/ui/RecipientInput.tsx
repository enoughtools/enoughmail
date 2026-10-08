import {useId,useState} from 'react';
import {Input} from '@rebnz/enough-ui/input';
import {Button} from '@rebnz/enough-ui/button';
import {insertRecipient,recipientSuggestions,type RecipientAddress} from '../domain/recipients';
export default function RecipientInput({id,label,value,onChange,contacts,disabled}:{id:string;label:string;value:string;onChange:(value:string)=>void;contacts:RecipientAddress[];disabled?:boolean}){
 const listId=useId();const [focused,setFocused]=useState(false),[active,setActive]=useState(0),[dismissed,setDismissed]=useState(false);
 const suggestions=focused&&!dismissed?recipientSuggestions(value,contacts):[];
 const choose=(index:number)=>{const contact=suggestions[index];if(contact){onChange(insertRecipient(value,contact));setActive(0);setDismissed(true);}};
 return <div className="mail-recipient-input"><Input id={id} aria-label={label} value={value} disabled={disabled} placeholder="Add recipients" autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={suggestions.length>0} aria-controls={listId} aria-activedescendant={suggestions.length?`${listId}-${Math.min(active,suggestions.length-1)}`:undefined} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} onChange={event=>{setActive(0);setDismissed(false);onChange(event.target.value);}} onKeyDown={event=>{if(event.key==='Escape'){setDismissed(true);return;}if(!suggestions.length)return;if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setActive(index=>(index+(event.key==='ArrowDown'?1:suggestions.length-1))%suggestions.length);}if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();choose(Math.min(active,suggestions.length-1));}}}/>
 {suggestions.length>0&&<div role="listbox" id={listId} aria-label={`${label} suggestions`} className="mail-recipient-suggestions">{suggestions.map((contact,index)=><Button key={contact.email} id={`${listId}-${index}`} role="option" aria-selected={index===active} variant="ghost" type="button" tabIndex={-1} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(index)}><span>{contact.name||contact.email}</span>{contact.name&&<small>{contact.email}</small>}</Button>)}</div>}
 </div>;
}
