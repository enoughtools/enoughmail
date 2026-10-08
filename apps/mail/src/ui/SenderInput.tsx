import { useId, useState } from 'react';
import { Input } from '@rebnz/enough-ui/input';
import { Button } from '@rebnz/enough-ui/button';
import { validRecipient } from '../domain/recipients';

interface Sender { name?: string; email: string; }
export function senderSuggestions(value: string, identities: Sender[], domains: string[]): Sender[] {
  const query = value.trim().toLowerCase();
  const options = identities.filter(identity => !query || `${identity.name || ''} ${identity.email}`.toLowerCase().includes(query));
  if (query && !query.includes('@') && validRecipient(`${query}@example.test`)) {
    options.push(...domains.map(domain => ({ email: `${query}@${domain}` })));
  }
  const seen = new Set<string>();
  return options.filter(option => {
    const email = option.email.toLowerCase();
    if (seen.has(email)) return false;
    seen.add(email); return true;
  }).slice(0, 8);
}

/** Choosing a suggestion edits the draft; ownership is checked only on Send. */
export default function SenderInput({ id, value, onChange, identities, domains, disabled }: {
  id: string; value: string; onChange: (value: string) => void; identities: Sender[]; domains: string[]; disabled?: boolean;
}) {
  const listId = useId();
  const [focused, setFocused] = useState(false), [active, setActive] = useState(-1), [dismissed, setDismissed] = useState(false);
  const suggestions = focused && !dismissed ? senderSuggestions(value, identities, domains) : [];
  const activeIndex = Math.min(active, suggestions.length - 1);
  const choose = (index: number) => {
    const suggestion = suggestions[index];
    if (suggestion) { onChange(suggestion.email); setActive(-1); setDismissed(true); }
  };
  return <div className="mail-recipient-input">
    <Input id={id} aria-label="From" value={value} disabled={disabled} placeholder="Choose or enter a sending address" autoComplete="off" spellCheck={false}
      role="combobox" aria-autocomplete="list" aria-expanded={suggestions.length > 0} aria-controls={suggestions.length ? listId : undefined}
      aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
      onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); setActive(-1); }}
      onChange={event => { setActive(-1); setDismissed(false); onChange(event.target.value); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { setDismissed(true); setActive(-1); return; }
        if (!suggestions.length) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setActive(index => index < 0 ? event.key === 'ArrowDown' ? 0 : suggestions.length - 1 : (Math.min(index, suggestions.length - 1) + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
        }
        if (event.key === 'Enter' && activeIndex >= 0) { event.preventDefault(); choose(activeIndex); }
      }} />
    {suggestions.length > 0 && <div role="listbox" id={listId} aria-label="Sending addresses" className="mail-recipient-suggestions">
      {suggestions.map((sender, index) => <Button key={sender.email} id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex} variant="ghost" type="button" tabIndex={-1}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}><span>{sender.name || sender.email}</span>{sender.name && <small>{sender.email}</small>}</Button>)}
    </div>}
  </div>;
}
