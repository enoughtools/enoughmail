import { Input } from '@rebnz/enough-ui/input';
import { useState } from 'react';
import { Button } from '@rebnz/enough-ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@rebnz/enough-ui/tooltip';
import { Checkbox } from '@rebnz/enough-ui/checkbox';
import { Popover, PopoverTrigger, PopoverContent, PopoverHeader, PopoverTitle } from '@rebnz/enough-ui/popover';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@rebnz/enough-ui/select';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@rebnz/enough-ui/collapsible';
import { SlidersHorizontal, ChevronDown } from 'lucide-react';
import type { Mailbox } from './jmap';
import { parseMailSearch } from './search';

export interface MailSearchFields {
  from: string; to: string; cc: string; subject: string; body: string; mailbox: string;
  before: string; after: string; attachment: boolean; read: '' | 'read' | 'unread';
  starred: boolean; minSize: string; maxSize: string;
}
const emptyFields: MailSearchFields = { from: '', to: '', cc: '', subject: '', body: '', mailbox: '', before: '', after: '', attachment: false, read: '', starred: false, minSize: '', maxSize: '' };
/** Always quote user values so punctuation and boolean words cannot become operators. */
export function buildMailSearchQuery(fields: Partial<MailSearchFields>): string {
  const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const terms: string[] = [];
  for (const key of ['from', 'to', 'cc', 'subject', 'body'] as const) {
    const value = fields[key]?.trim(); if (value) terms.push(`${key}:${quote(value)}`);
  }
  if (fields.mailbox) terms.push(`in:${quote(fields.mailbox)}`);
  for (const key of ['before', 'after'] as const) if (fields[key]) terms.push(`${key}:${quote(fields[key])}`);
  if (fields.attachment) terms.push('has:attachment');
  if (fields.read) terms.push(`is:${fields.read}`);
  if (fields.starred) terms.push('is:starred');
  if (fields.minSize?.trim()) terms.push(`larger:${quote(fields.minSize.trim())}`);
  if (fields.maxSize?.trim()) terms.push(`smaller:${quote(fields.maxSize.trim())}`);
  return terms.join(' ');
}

export default function SearchFilters({ onSearch, mailboxes, identities = [] }: { onSearch: (query: string) => void; mailboxes: Mailbox[]; identities?: string[] }) {
  const [fields, setFields] = useState<MailSearchFields>(emptyFields);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const set = <K extends keyof MailSearchFields>(key: K, value: MailSearchFields[K]) => { setFields(previous => ({ ...previous, [key]: value })); setError(''); };
  const search = () => {
    try {
      const query = buildMailSearchQuery(fields);
      parseMailSearch(query, mailboxes);
      if (fields.after && fields.before && fields.after >= fields.before) throw new Error('The after date must come before the before date.');
      onSearch(query); setError(''); setExpanded(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check your search filters.'); }
  };
  const textField = (key: 'from' | 'to' | 'cc' | 'subject' | 'body', label: string) => <label key={key}>{label}<Input type="text" value={fields[key]} onChange={event => set(key, event.target.value)} autoComplete="off" list={key === 'to' || key === 'from' ? 'mail-known-addresses' : undefined} /></label>;
  return <Popover open={expanded} onOpenChange={setExpanded}><Tooltip><TooltipTrigger asChild><PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Search filters"><SlidersHorizontal /></Button></PopoverTrigger></TooltipTrigger><TooltipContent>Search filters</TooltipContent></Tooltip><PopoverContent align="end" className="mail-search-filter-popover"><PopoverHeader><PopoverTitle>Search filters</PopoverTitle></PopoverHeader><form onSubmit={event => {event.preventDefault();search();}}><datalist id="mail-known-addresses">{identities.map(address => <option key={address} value={address} />)}</datalist><div className="mail-search-fields">{textField('from','From')}{textField('to','To')}{textField('subject','Subject contains')}{textField('body','Body contains')}<label>Folder or label<Select value={fields.mailbox || '__all'} onValueChange={value => set('mailbox', value === '__all' ? '' : value)}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all">Anywhere</SelectItem>{mailboxes.map(box => <SelectItem key={box.id} value={box.id}>{box.name}</SelectItem>)}</SelectContent></Select></label><label>After<Input type="date" value={fields.after} onChange={event => set('after',event.target.value)} /></label><label>Before<Input type="date" value={fields.before} onChange={event => set('before',event.target.value)} /></label></div><div className="mail-search-flags"><label><Checkbox checked={fields.attachment} onCheckedChange={value => set('attachment', value === true)} />Has attachments</label><label><Checkbox checked={fields.starred} onCheckedChange={value => set('starred', value === true)} />Starred</label><label>Read status<Select value={fields.read || 'all'} onValueChange={value => set('read', value === 'all' ? '' : value as 'read' | 'unread')}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Any status</SelectItem><SelectItem value="unread">Unread</SelectItem><SelectItem value="read">Read</SelectItem></SelectContent></Select></label></div><Collapsible><CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm">More options<ChevronDown /></Button></CollapsibleTrigger><CollapsibleContent><div className="mail-search-fields">{textField('cc','Cc')}<label>Larger than<Input value={fields.minSize} placeholder="e.g. 1M" onChange={event => set('minSize',event.target.value)} /></label><label>Smaller than<Input value={fields.maxSize} placeholder="e.g. 10M" onChange={event => set('maxSize',event.target.value)} /></label></div><p className="mail-search-help">Sizes accept bytes, K, M or G. Dates use midnight UTC: after includes the date; before excludes it.</p></CollapsibleContent></Collapsible>{error && <p role="alert">{error}</p>}<div className="mail-search-filter-actions"><Button type="submit" size="sm">Search messages</Button><Button type="button" variant="outline" size="sm" onClick={() => {setFields(emptyFields);setError('');onSearch('');}}>Reset</Button></div></form></PopoverContent></Popover>;
}
