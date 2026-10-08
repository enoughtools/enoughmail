/** Bounded memory only. Scope includes verified actor/workspace and exact view. */
export class MailViewCache<T> {
 private entries=new Map<string,{at:number;value:T}>();
 constructor(private ttl=1800000,private limit=128){}
 get(key:string,now=Date.now()):T|undefined{const entry=this.entries.get(key);if(!entry)return;if(now-entry.at>this.ttl){this.entries.delete(key);return;}return structuredClone(entry.value);}
 set(key:string,value:T,now=Date.now()){this.entries.delete(key);this.entries.set(key,{at:now,value:structuredClone(value)});while(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value!);}
 clear(){this.entries.clear();}
}
