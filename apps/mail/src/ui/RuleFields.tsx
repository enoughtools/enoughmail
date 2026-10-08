import MailCheckbox from './MailCheckbox';
import { NativeSelect } from '@rebnz/enough-ui/native-select';
import { Input } from '@rebnz/enough-ui/input';
import { Button } from '@open-cloud/ui';
import type { Dispatch, SetStateAction } from 'react';
import type { Mailbox } from './jmap';
import type { EmailFilter, MailRule } from '../domain/rules';
import { validateFilter } from '../domain/rules';
import { parseMailSearch } from './search';

type Fields = Record<string, string>;
type Actions = MailRule['actions'];
const original = <T,>(value: string | undefined, fallback: T): T => value ? JSON.parse(value) as T : fallback;
const ids = (value?: string) => value ? value.split('\n').filter(Boolean) : [];
const unique = (values: string[]) => [...new Set(values)];
const filterDate = (value: string) => {
  const timestamp = `${value}T00:00:00.000Z`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new Error('Use a valid date for rule conditions.');
  return timestamp;
};
function conditionFor(fields: Fields, mailboxes: Mailbox[]): EmailFilter {
  const conditions: EmailFilter[] = [];
  if (fields.matchValue?.trim()) conditions.push({ [fields.matchField || 'from']: fields.matchValue.trim() });
  for (const key of ['cc', 'bcc', 'body', 'attachmentName', 'hasKeyword', 'notKeyword'] as const) if (fields[`rule_${key}`]?.trim()) conditions.push({ [key]: fields[`rule_${key}`].trim() });
  if (fields.rule_mailbox) conditions.push({ inMailbox: fields.rule_mailbox });
  if (fields.rule_excludeMailboxes) conditions.push({ notInMailbox: ids(fields.rule_excludeMailboxes) });
  if (fields.rule_deliveredTo?.trim()) conditions.push({ header: ['Delivered-To', fields.rule_deliveredTo.trim()] });
  if (fields.rule_headerName?.trim()) conditions.push({ header: fields.rule_headerValue ? [fields.rule_headerName.trim(), fields.rule_headerValue] : [fields.rule_headerName.trim()] });
  else if (fields.rule_headerValue) throw new Error('Add the header name to match its value.');
  for (const key of ['before', 'after'] as const) if (fields[`rule_${key}`]) conditions.push({ [key]: filterDate(fields[`rule_${key}`]) });
  if (fields.rule_after && fields.rule_before && fields.rule_after >= fields.rule_before) throw new Error('The after date must come before the before date.');
  for (const key of ['minSize', 'maxSize'] as const) if (fields[`rule_${key}`]) {
    const value = fields[`rule_${key}`];
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Rule sizes must be whole numbers of bytes.');
    conditions.push({ [key]: Number(value) });
  }
  if (fields.rule_minSize && fields.rule_maxSize && Number(fields.rule_minSize) >= Number(fields.rule_maxSize)) throw new Error('The minimum size must be smaller than the maximum.');
  for (const key of ['hasAttachment', 'isSnoozed', 'isFollowUp'] as const) if (fields[`rule_${key}`]) conditions.push({ [key]: fields[`rule_${key}`] === 'true' });
  if (fields.rule_query?.trim()) conditions.push(parseMailSearch(fields.rule_query, mailboxes) as EmailFilter);
  if (!conditions.length) {
    if (fields.rule_allMessages !== 'true') throw new Error('Add a rule condition or explicitly choose all messages.');
    return {};
  }
  return validateFilter(conditions.length === 1 && fields.rule_operator !== 'NOT' ? conditions[0] : { operator: (fields.rule_operator || 'AND') as 'AND' | 'OR' | 'NOT', conditions });
}
export function buildRuleValue(fields: Fields, mailboxes: Mailbox[], _editing?: string | null) {
  const condition = fields.advancedCondition && fields.ruleConditionDirty !== 'true' ? original<EmailFilter>(fields.advancedCondition, {}) : conditionFor(fields, mailboxes);
  let actions = original<Actions>(fields.advancedActions, {});
  if (!fields.advancedActions || fields.ruleActionsDirty === 'true') {
    actions = { ...actions };
    const add = fields.rule_addLabels !== undefined ? ids(fields.rule_addLabels) : actions.addMailboxIds || (fields.mailbox ? [fields.mailbox] : []);
    const remove = fields.rule_removeLabels !== undefined ? ids(fields.rule_removeLabels) : actions.removeMailboxIds || [];
    const destination = fields.rule_destination || (fields.archive === 'true' ? 'archive' : '');
    if (destination) {
      const folders = ['inbox', 'archive', 'junk', 'trash'].map(role => mailboxes.find(box => box.role === role)?.id).filter((id): id is string => !!id);
      const target = mailboxes.find(box => box.role === destination)?.id;
      if (!target) throw new Error('The destination mailbox is unavailable.');
      actions.addMailboxIds = unique([...add.filter(id => !folders.includes(id)), target]);
      actions.removeMailboxIds = unique([...remove.filter(id => id !== target), ...folders.filter(id => id !== target)]);
    } else { actions.addMailboxIds = unique(add); actions.removeMailboxIds = unique(remove); }
    if (actions.addMailboxIds.some(id => actions.removeMailboxIds?.includes(id))) throw new Error('A label cannot be added and removed in the same rule.');
    const keywords = { ...actions.keywords };
    for (const [field, keyword, legacy] of [['rule_read', '$seen', 'read'], ['rule_star', '$flagged', 'flagged'], ['rule_important', '$important', '']] as const) {
      const state = fields[field] ?? (legacy && fields[legacy] === 'true' ? 'true' : undefined);
      if (state === 'keep') delete keywords[keyword];
      else if (state === 'true' || state === 'false') keywords[keyword] = state === 'true';
    }
    actions.keywords = keywords;
    if (fields.rule_snoozeMode === 'clear') actions.snoozeUntil = null;
    else if (fields.rule_snoozeMode === 'keep') delete actions.snoozeUntil;
    else if (fields.rule_snoozeMode === 'set') {
      const date = new Date(fields.rule_snoozeUntil || actions.snoozeUntil || '');
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error('Choose a future snooze time.');
      actions.snoozeUntil = date.toISOString();
    }
    if (fields.rule_forwardAddresses !== undefined) { actions.forwardTo = unique(ids(fields.rule_forwardAddresses)); if (actions.forwardTo.length > 5) throw new Error('Choose no more than five forwarding destinations.'); }
    if (!actions.forwardTo?.length && !actions.addMailboxIds?.length && !actions.removeMailboxIds?.length && !Object.keys(keywords).length && !('snoozeUntil' in actions)) throw new Error('Choose at least one rule action.');
  }
  validateFilter(condition);
  return { name: fields.name, enabled: fields.enabled !== 'false', stop: fields.stop === 'true', condition, actions };
}

export default function RuleFields({ fields, setFields, mailboxes, verifiedForwardingAddresses = [] }: { fields: Fields; setFields: Dispatch<SetStateAction<Fields>>; mailboxes: Mailbox[]; verifiedForwardingAddresses?: string[] }) {
  const actions = original<Actions>(fields.advancedActions, {});
  const set = (key: string, value: string, action = false) => setFields(previous => ({ ...previous, [key]: value, [action ? 'ruleActionsDirty' : 'ruleConditionDirty']: 'true' }));
  const text = (key: string, label: string, type = 'text') => <label className="mail-settings-field" key={key}>{label}<Input type={type} value={fields[key] || ''} onChange={event => set(key, event.target.value)} /></label>;
  const select = (key: string, label: string, options: [string, string][], action = false, fallback = '') => <label className="mail-settings-field">{label}<NativeSelect value={fields[key] ?? fallback} onChange={event => set(key, event.target.value, action)}>{options.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</NativeSelect></label>;
  const boxes = (key: string, label: string, action: boolean, fallback: string[] = []) => {
    const chosen = ids(fields[key] ?? fallback.join('\n'));
    return <fieldset><legend>{label}</legend>{mailboxes.map(box => <label key={box.id} className="mail-settings-check"><MailCheckbox checked={chosen.includes(box.id)} onChange={event => set(key, (event.target.checked ? unique([...chosen, box.id]) : chosen.filter(id => id !== box.id)).join('\n'), action)} />{box.name}</label>)}</fieldset>;
  };
  return <div className="mail-rule-fields">
    <label className="mail-settings-check"><MailCheckbox checked={fields.enabled !== 'false'} onChange={event => setFields(previous => ({ ...previous, enabled: String(event.target.checked) }))} />Enable rule</label>
    <label className="mail-settings-check"><MailCheckbox checked={fields.stop === 'true'} onChange={event => setFields(previous => ({ ...previous, stop: String(event.target.checked) }))} />Stop processing later rules when this matches</label>
    <fieldset><legend>1. When a message arrives</legend>{fields.rule_query && <div className="mail-rule-current-search"><strong>Based on your search</strong><p>{fields.rule_query}</p><p>You can adjust this expression under More conditions. Choose what should happen to matching messages below.</p></div>}
      {fields.advancedCondition && fields.ruleConditionDirty !== 'true' && <p>The saved conditions are preserved. Changing a condition below replaces them with these selections.</p>}
      {select('rule_operator', 'Match conditions', [['AND', 'All conditions'], ['OR', 'Any condition'], ['NOT', 'None of these conditions']], false, 'AND')}
      {select('matchField', 'Match field', [['from', 'Sender'], ['to', 'Recipient'], ['subject', 'Subject'], ['text', 'Message text'], ['body', 'Body']], false, 'from')}{text('matchValue', 'Contains')}
      <details className="mail-secondary-tools"><summary>More conditions</summary>{text('rule_cc', 'Cc contains')}{text('rule_bcc', 'Bcc contains')}{text('rule_body', 'Body contains')}{text('rule_deliveredTo', 'Delivered to')}
      {select('rule_mailbox', 'In mailbox or label', [['', 'Any mailbox'], ...mailboxes.map(box => [box.id, box.name] as [string, string])])}
      {boxes('rule_excludeMailboxes', 'Exclude mailboxes or labels', false)}
      {text('rule_before', 'Before date (exclusive, UTC)', 'date')}{text('rule_after', 'After date (inclusive, UTC)', 'date')}
      {text('rule_minSize', 'Minimum size in bytes', 'number')}{text('rule_maxSize', 'Maximum size in bytes (exclusive)', 'number')}
      {select('rule_hasAttachment', 'Attachments', [['', 'Any'], ['true', 'Has attachments'], ['false', 'No attachments']])}{text('rule_attachmentName', 'Attachment filename contains')}
      {text('rule_headerName', 'Header name')}{text('rule_headerValue', 'Header value contains (optional)')}
      {text('rule_hasKeyword', 'Has keyword')}{text('rule_notKeyword', 'Does not have keyword')}
      {select('rule_isSnoozed', 'Snooze state', [['', 'Any'], ['true', 'Snoozed'], ['false', 'Not snoozed']])}
      {select('rule_isFollowUp', 'Follow-up state', [['', 'Any'], ['true', 'Has follow-up'], ['false', 'No follow-up']])}
      {text('rule_query', 'Advanced search expression')}
      <p>Use Gmail-style terms and AND, OR, NOT or parentheses, for example: (from:alice@example.com OR from:bob@example.com) -has:attachment.</p>
      <label className="mail-settings-check"><MailCheckbox checked={fields.rule_allMessages === 'true'} onChange={event => set('rule_allMessages', String(event.target.checked))} />Match all messages when no conditions are selected</label></details>
    </fieldset>
    <fieldset><legend>2. Do this</legend>
      {select('rule_destination', 'Move message', [['', 'Keep current location'], ['inbox', 'Inbox'], ['archive', 'Archive'], ['junk', 'Spam'], ['trash', 'Trash']], true, fields.archive === 'true' ? 'archive' : '')}
      {select('rule_read', 'Read state', [['keep', 'Keep current state'], ['true', 'Mark read'], ['false', 'Mark unread']], true, '$seen' in (actions.keywords || {}) ? String(actions.keywords!.$seen) : fields.read === 'true' ? 'true' : 'keep')}
      {select('rule_star', 'Star state', [['keep', 'Keep current state'], ['true', 'Star'], ['false', 'Remove star']], true, '$flagged' in (actions.keywords || {}) ? String(actions.keywords!.$flagged) : fields.flagged === 'true' ? 'true' : 'keep')}
      {select('rule_important', 'Importance', [['keep', 'Keep current state'], ['true', 'Mark important'], ['false', 'Mark not important']], true, '$important' in (actions.keywords || {}) ? String(actions.keywords!.$important) : 'keep')}
      <details className="mail-secondary-tools"><summary>Labels, forwarding & snoozing</summary>
      <fieldset><legend>Forward to verified addresses</legend><p>Verify forwarding destinations in Preferences before selecting them here. Forwarding requires permission to manage this account and send mail.</p>{verifiedForwardingAddresses.length ? verifiedForwardingAddresses.map(address => { const chosen = ids(fields.rule_forwardAddresses ?? actions.forwardTo?.join('\n')); return <label className="mail-settings-check" key={address}><MailCheckbox checked={chosen.includes(address)} onChange={event => set('rule_forwardAddresses', (event.target.checked ? unique([...chosen, address]) : chosen.filter(value => value !== address)).join('\n'), true)} />{address}</label>; }) : <p>No verified forwarding destinations are available.</p>}{(actions.forwardTo || []).some(address => !verifiedForwardingAddresses.includes(address)) && <p>A saved forwarding destination is no longer verified. Reverify it in Preferences or remove all forwarding destinations below.</p>}{(actions.forwardTo?.length || fields.rule_forwardAddresses) && <Button variant="outline" type="button" onClick={() => set('rule_forwardAddresses', '', true)}>Remove forwarding action</Button>}</fieldset>
      {boxes('rule_addLabels', 'Add labels or mailboxes', true, actions.addMailboxIds || (fields.mailbox ? [fields.mailbox] : []))}
      {boxes('rule_removeLabels', 'Remove labels or mailboxes', true, actions.removeMailboxIds || [])}
      {select('rule_snoozeMode', 'Snooze action', [['keep', 'Keep current snooze state'], ['set', 'Snooze until'], ['clear', 'Wake message']], true, 'snoozeUntil' in actions ? actions.snoozeUntil ? 'set' : 'clear' : 'keep')}
      {(fields.rule_snoozeMode === 'set' || (fields.rule_snoozeMode === undefined && actions.snoozeUntil)) && <label className="mail-settings-field">Snooze until (local time)<Input type="datetime-local" value={fields.rule_snoozeUntil ?? (actions.snoozeUntil ? new Date(Date.parse(actions.snoozeUntil) - new Date(actions.snoozeUntil).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')} onChange={event => { setFields(previous => ({ ...previous, rule_snoozeMode: 'set', rule_snoozeUntil: event.target.value, ruleActionsDirty: 'true' })); }} /></label>}
      </details>
    </fieldset>
  </div>;
}
