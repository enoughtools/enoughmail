import {useMailConfirm} from './use-mail-confirm';
import { MailViewCache } from './view-cache';
import { MailConversationCache } from './conversation-cache';
import { observeVisibleConversations } from './visible-conversations';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppControls, useModuleContext } from '@open-cloud/ui';
import { Button } from '@rebnz/enough-ui/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@rebnz/enough-ui/collapsible';
import { Checkbox } from '@rebnz/enough-ui/checkbox';
import { Badge } from '@rebnz/enough-ui/badge';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from '@rebnz/enough-ui/empty';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@rebnz/enough-ui/dropdown-menu';
import { Popover, PopoverTrigger, PopoverContent, PopoverHeader, PopoverTitle } from '@rebnz/enough-ui/popover';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@rebnz/enough-ui/select';
import { Tooltip, TooltipTrigger, TooltipContent } from '@rebnz/enough-ui/tooltip';
import { toast } from '@rebnz/enough-ui/sonner';
import { Archive, Inbox, FilePenLine, Send, Star, Mail, MailOpen, Clock, Tag, Trash2, CircleAlert, MoreHorizontal, Search, RefreshCw, Settings as SettingsIcon, Settings2, ChevronDown, ChevronLeft, Plus, X, Reply, ReplyAll, Forward, Bell, Keyboard, Folder, LogOut, Menu, ArrowDownWideNarrow, ShieldAlert, Paperclip, Download, FileCode2, Link2 } from 'lucide-react';
import { Item } from '@rebnz/enough-ui/item';
import { Input } from '@rebnz/enough-ui/input';
import { Spinner } from '@rebnz/enough-ui/spinner';
import './mailbox.css';
import { MailClient,canUseOfflineCopy, MAIL_CAP, type Email, type Mailbox, type Identity, type GetResult, type MailSession, type SetResult } from './jmap';
import Compose from './Compose';
import Settings from './Settings';
import MailFrame from './MailFrame';
import MailBrand from './MailBrand';
import {registerMailOfflineShell,saveOfflineSession,readOfflineSession,clearOfflineSession} from './offline-session';
import {saveOfflineView,readOfflineView,clearOfflineViews} from './offline-view';
import {listDraftRecoveries} from './compose-recovery';
import {loadComposeEmail} from './load-compose';
import {readOfflinePreferences} from './offline-preferences';
import OfflineQueue from './OfflineQueue';
import {unsubscribeLink} from './unsubscribe';
import SearchFilters from './SearchFilters';
import {NotificationRenewalPrompt} from './BrowserNotifications';
import MessageText from './MessageText';
import Outbox from './Outbox';
import { parseMailSearch, sortMailRows } from './search';
import { cacheScope, saveMailCache, readMailCache, clearMailCaches, replayMutations, queueMutation, matchesCached } from './offline';
import {mailLinks} from './safe-html';
import FormattedMessage from './FormattedMessage';
import { messageHtml, messagePlainText } from './message-body';
import SenderAuthentication from './SenderAuthentication';
import {mailEventEndpoint,mailStateHint} from './mail-events';
export type Row = Email & {
    accountId: string;
};
const applyUiPatch=(row:Row,patch:Record<string,unknown>):Row=>{const next={...row,keywords:{...row.keywords},mailboxIds:{...row.mailboxIds}};for(const [path,value] of Object.entries(patch)){const [root,key]=path.split('/');if(key&&(root==='keywords'||root==='mailboxIds')){if(value===null)delete next[root][key];else next[root][key]=value===true;}else Object.assign(next,{[path]:value});}return next;};
const reverseUiPatch=(row:Row,patch:Record<string,unknown>)=>Object.fromEntries(Object.keys(patch).map(path=>{const [root,key]=path.split('/');const value=key&&(root==='keywords'||root==='mailboxIds')?row[root][key]:(row as unknown as Record<string,unknown>)[path];return [path,value??null];}));
const settingsValue=(value:Record<string,unknown>|undefined)=>{const {id:ignored,...rest}=value||{};return rest;};
const folderNames: Record<string, string> = { inbox: 'Inbox', drafts: 'Drafts', sent: 'Sent', starred: 'Starred', unread: 'Unread', important: 'Important', snoozed: 'Snoozed', all: 'All mail', archive: 'Archive', junk: 'Spam', trash: 'Trash' };
const formatListDate = (value: string) => { const date = new Date(value); return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}) }); };
const localDateTime = (offset: number) => { const date = new Date(Date.now() + offset); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const formatDate = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function mailboxViewFilter(view: string, mailboxes: Mailbox[], search = '', missingMailboxAsEmpty = false, address = ''): Record<string, unknown> {
    const filter = parseMailSearch(search, mailboxes, missingMailboxAsEmpty);
    if (!search) {
        const excluded = mailboxes.filter(box => box.role === 'junk' || box.role === 'trash').map(box => box.id);
        if (view === 'all') filter.notInMailbox = excluded;
        else if (['starred', 'unread', 'important'].includes(view)) {
            filter.notInMailbox = excluded;
            if (view === 'unread') filter.notKeyword = '$seen';
            else filter.hasKeyword = view === 'starred' ? '$flagged' : '$important';
        } else if (view === 'snoozed') filter.isSnoozed = true;
        else {
            const mailbox = folderNames[view] ? mailboxes.find(box => box.role === view) : mailboxes.find(box => box.id === view);
            filter.inMailbox = mailbox?.id || '__missing_mailbox__';
        }
    }
    if (!address) return filter;
    const addressFilter = ['sent', 'drafts'].includes(view) ? { from: address } : { operator: 'OR', conditions: [{ to: address }, { header: ['Delivered-To', address] }] };
    return { operator: 'AND', conditions: [filter, addressFilter] };
}
export function sortMailConversation(messages: Email[]): Email[] { return [...messages].sort((a,b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt)); }
export function addressSummary(addresses: Email['from']): string { return addresses?.map(address => address.name ? `${address.name} <${address.email}>` : address.email).join(', ') || ''; }
function MailIconAction({ label, icon: Icon, onClick, disabled = false, pressed }: { label: string; icon: typeof Mail; onClick: () => void; disabled?: boolean; pressed?: boolean }) {
    return <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Icon aria-hidden="true" /></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}
const folderIcons: Record<string, typeof Mail> = { inbox: Inbox, drafts: FilePenLine, sent: Send, starred: Star, unread: Mail, important: CircleAlert, snoozed: Clock, all: Mail, archive: Archive, junk: ShieldAlert, trash: Trash2 };
export default function MailApp() {
    const standalone = import.meta.env.MODE === 'standalone';
 const {confirm,dialog:confirmationDialog}=useMailConfirm();
    const context = useModuleContext('mail');
    const client = useMemo(() => new MailClient(), []);
    const conversations = useMemo(() => new MailConversationCache(client), [client]);
    const [session, setSession] = useState<MailSession | null>(null);
    const [accountName, setAccountName] = useState('Personal');
    const [creatingAccount, setCreatingAccount] = useState(false);
    const [account, setAccount] = useState('');
    const [addressScope, setAddressScope] = useState('');
    const [pageSizeOverride, setPageSizeOverride] = useState<number | null>(null);
    const [snoozeOpen, setSnoozeOpen] = useState(false);
    const [snoozeValue, setSnoozeValue] = useState(localDateTime(86400000));
    const [snoozeError, setSnoozeError] = useState('');
    const [snoozeBusy, setSnoozeBusy] = useState(false);
    const [messageHeaders, setMessageHeaders] = useState<Set<string>>(new Set());
    const [messageLinks, setMessageLinks] = useState<Set<string>>(new Set());
    const [messageDisplay, setMessageDisplay] = useState<Record<string, 'formatted' | 'plain'>>({});
    const [boxes, setBoxes] = useState<Record<string, Mailbox[]>>({});
    const [identities, setIdentities] = useState<Record<string, Identity[]>>({});
    const [rows, setRows] = useState<Row[]>([]);
    const [mobileNavOpen,setMobileNavOpen]=useState(false);
    const [moreFoldersOpen,setMoreFoldersOpen]=useState(false);
    const [actionScope,setActionScope]=useState<'message'|'conversation'>('conversation');
    const [view, setView] = useState('inbox');
    const [query, setQuery] = useState('');
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState('receivedAt');
    const [ascending, setAscending] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [active, setActive] = useState<Row | null>(null);
    const [remoteImages,setRemoteImages]=useState<Set<string>>(new Set());
    const [thread, setThread] = useState<Email[]>([]);
    const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
    const readerElement = useRef<HTMLElement>(null);
    const listElement = useRef<HTMLDivElement>(null);
    const [ruleQuery, setRuleQuery] = useState('');
    const [threadLoading, setThreadLoading] = useState(false);
    const [threadError, setThreadError] = useState('');
    const readerRequest = useRef(0);
    const [compose, setCompose] = useState<{
        accountId?:string;
        reply?: Email;
        draft?: Email;
        recoveryId?:string;
        mode?: 'reply' | 'replyAll' | 'forward';
    } | null>(null);
    const [settings, setSettings] = useState(false);
    const [settingsSection, setSettingsSection] = useState<'Accounts' | 'Domains' | 'Preferences' | 'Mailboxes' | 'Templates' | 'Signatures' | 'Rules' | 'Notifications'>('Domains');
    const [offlineQueue,setOfflineQueue]=useState(false);
    const [recoveryPicker,setRecoveryPicker]=useState(false);
    const [outbox, setOutbox] = useState(false);
    const [preferences, setPreferences] = useState<Record<string, Record<string, unknown>>>({});
    const [palette, setPalette] = useState(false);
    const [command, setCommand] = useState<null | { title: string; description: string; label: string; type?: string; value: string; submitLabel: string; submit: (value: string) => Promise<void> }>(null);
    const [commandBusy, setCommandBusy] = useState(false);
    const [commandError, setCommandError] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [loading, setLoading] = useState(true);
    const [online, setOnline] = useState(navigator.onLine);
    const [position, setPosition] = useState(0);
    const [more, setMore] = useState(false);
    const [undo, setUndo] = useState<null | (() => Promise<void>)>(null);
    const request = useRef(0);
    const loadScope = useRef('');
    const cacheGeneration=useRef(0);
    const viewCache=useRef(new MailViewCache<{rows:Row[];more:boolean;position:number}>());
    const conversationStates=useRef(new Map<string,string>());
    const acknowledgedConversationStates=useRef(new Map<string,string>());
    const searchInput = useRef<HTMLInputElement>(null);
    useEffect(()=>{client.onAuthorizationLost=()=>{setRows([]);setThread([]);setActive(null);setSelected(new Set());setCompose(null);setSettings(false);setOutbox(false);setSession(null);setRemoteImages(new Set());clearMailCaches();++readerRequest.current;conversations.clear();conversationStates.current.clear();acknowledgedConversationStates.current.clear();cacheGeneration.current++;viewCache.current.clear();clearOfflineSession();clearOfflineViews();};return()=>{client.onAuthorizationLost=undefined;};},[client]);
    useEffect(()=>{void registerMailOfflineShell().catch(()=>setNotice('Offline startup is unavailable in this browser; local draft recovery still works.'));},[]);
    function closePanels() { setMobileNavOpen(false); setSettings(false); setOutbox(false); setOfflineQueue(false); setRecoveryPicker(false); setPalette(false); setCommand(null); setCommandError(''); }
    function openSettings(section: 'Accounts' | 'Domains' | 'Preferences' | 'Mailboxes' | 'Templates' | 'Signatures' | 'Rules' | 'Notifications' = 'Domains') { closePanels(); setSettingsSection(section); setSettings(true); }
    const panelOpen = settings || outbox || offlineQueue || recoveryPicker || palette || !!command;
    const conversationScope = session ? cacheScope(session) : '';
    useEffect(() => () => conversations.clear(), [conversations]);
    useEffect(() => { ++readerRequest.current; conversations.clear(); conversationStates.current.clear(); acknowledgedConversationStates.current.clear(); }, [conversations, conversationScope]);
    useEffect(() => {
        if (!session || !online || loading || compose || panelOpen || !listElement.current) { conversations.prefetch(conversationScope, []); return; }
        return observeVisibleConversations(listElement.current, rows, targets => conversations.prefetch(conversationScope, targets));
    }, [conversations, conversationScope, session, online, loading, compose, panelOpen, rows]);
    const accountIds = session ? Object.keys(session.accounts) : [];
    const currentAccount = account || accountIds[0] || '';
    const currentBoxes = boxes[currentAccount] || [];
    const composeAccount=compose?.accountId||currentAccount;
    function openComposer(){if(compose){document.querySelector<HTMLElement>('.mail-compose')?.focus();return;}closePanels();setCompose({accountId:currentAccount});}
    const pageSize = pageSizeOverride || Number(preferences[currentAccount]?.pageSize) || 50;
    const knownAddresses = [...new Set((account ? identities[account] || [] : Object.values(identities).flat()).map(identity => identity.email))];
    const favoriteIds=(preferences[currentAccount]?.favoriteMailboxIds||[]) as string[];
    const splits = (preferences[currentAccount]?.savedSearches || []) as {
        name: string;
        query: string;
    }[];
    const perform = async (work: () => Promise<void>) => { setError(''); try {
        await work();
    }
    catch (e) {
        if((e as {authorizationLost?:boolean}).authorizationLost){setRows([]);setThread([]);setActive(null);setSelected(new Set());setCompose(null);setSettings(false);setOutbox(false);setSession(null);setRemoteImages(new Set());clearMailCaches();++readerRequest.current;conversations.clear();conversationStates.current.clear();acknowledgedConversationStates.current.clear();cacheGeneration.current++;viewCache.current.clear();clearOfflineSession();clearOfflineViews();}
        setError(e instanceof Error ? e.message : String(e));
    } };
    const fetchView = useCallback(async(accountId:string,targetView:string,targetSearch:string,scopeAccount:string,offset=0)=>{ const filter = mailboxViewFilter(targetView, boxes[accountId] || [], targetSearch, !scopeAccount, addressScope); const results = await client.readBatch([
            ['Email/query', { filter, sort: [...(['unread', 'starred', 'important'].includes(sort) ? [{ property: 'hasKeyword', keyword: sort === 'unread' ? '$seen' : sort === 'starred' ? '$flagged' : '$important', isAscending: sort === 'unread' ? !ascending : ascending }] : [{ property: sort, isAscending: ascending }]), { property: 'id', isAscending: true }], position: offset, limit: pageSize, calculateTotal: true }, 'query'],
            ['Email/get', { '#ids': { resultOf: 'query', name: 'Email/query', path: '/ids' }, properties: ['id','threadId','blobId','mailboxIds','keywords','from','to','cc','subject','receivedAt','preview','hasAttachment','size'] }, 'emails'],
            ['Mailbox/get', {}, 'mailboxes'],
        ], accountId);
       return {accountId,emailState:results.emails.state as string,mailboxes:results.mailboxes.list as Mailbox[],emails:(results.emails.list as Email[]).map(email=>({...email,accountId})),more:results.query.total > offset + results.query.ids.length}; },[client,boxes,addressScope,pageSize,sort,ascending]);
    const load = useCallback(async (offset = 0) => { if (!session || !Object.keys(session.accounts).length)
        return; const generation = ++request.current; const scope = JSON.stringify([account,view,search,addressScope,pageSize,sort,ascending]); const viewKey=cacheScope(session)+':'+scope;if(!offset && loadScope.current !== scope){loadScope.current=scope;const cached=viewCache.current.get(viewKey);setRows(cached?.rows||[]);setMore(cached?.more||false);setPosition(cached?.position||0);setSelected(new Set());setError('');} setLoading(true); try {
        const all = await Promise.all((account ? [account] : Object.keys(session.accounts)).map(async (accountId) => { return fetchView(accountId,view,search,account,offset); }));
        if (generation !== request.current)
            return;
        for (const result of all) {
            if (conversationStates.current.get(result.accountId) !== result.emailState && acknowledgedConversationStates.current.get(result.accountId) !== result.emailState) conversations.invalidate(result.accountId);
            conversationStates.current.set(result.accountId, result.emailState);
        }
        setBoxes(previous=>{const next={...previous};let changed=false;for(const result of all){if(JSON.stringify(previous[result.accountId])!==JSON.stringify(result.mailboxes)){next[result.accountId]=result.mailboxes;changed=true;}}return changed?next:previous;});
        setRows(previous => { const next = sortMailRows(offset ? [...previous, ...all.flatMap(a => a.emails)] : all.flatMap(a => a.emails), sort, ascending); const offlinePrefs=readOfflinePreferences(session);if(offlinePrefs.enabled)saveMailCache(cacheScope(session), next.slice(0,offlinePrefs.maxMessages));if(navigator.onLine&&offlinePrefs.enabled){saveOfflineSession(session,offlinePrefs.maxAgeHours);saveOfflineView(session,{boxes:Object.fromEntries(all.map(result=>[result.accountId,result.mailboxes])),identities,preferences,states:[...client.states]});}return next; });
        if(!offset)viewCache.current.set(viewKey,{rows:sortMailRows(all.flatMap(a=>a.emails),sort,ascending),more:all.some(a=>a.more),position:offset});
        setMore(all.some(a => a.more));
        setPosition(offset);
        setSelected(previous => offset?previous:new Set([...previous].filter(key => all.some(a => a.emails.some(row => rowKey(row) === key)))));
    }
    catch (e) {
        if (canUseOfflineCopy(e) && generation === request.current) {
            setOnline(false);const cached = readMailCache(cacheScope(session)) as Row[];
            const filtered = cached.filter(row => { if (account && row.accountId !== account)
                return false; const filter = mailboxViewFilter(view, boxes[row.accountId] || [], search, !account, addressScope); return matchesCached(row, filter); });
            setRows(sortMailRows(filtered, sort, ascending));
            setNotice('Showing recent cached mail. Reconnect to synchronize.');
        }
        if((e as {authorizationLost?:boolean}).authorizationLost){setRows([]);setThread([]);setActive(null);setSelected(new Set());setCompose(null);setSettings(false);setOutbox(false);setSession(null);setRemoteImages(new Set());clearMailCaches();++readerRequest.current;conversations.clear();conversationStates.current.clear();acknowledgedConversationStates.current.clear();cacheGeneration.current++;viewCache.current.clear();clearOfflineSession();clearOfflineViews();}
        if (generation === request.current)
            setError(e instanceof Error ? e.message : String(e));
    }
    finally {
        if (generation === request.current)
            setLoading(false);
    } }, [session, account, boxes, view, search, sort, ascending, client, preferences, addressScope, pageSize,fetchView,conversations]);
    useEffect(() => { let mounted = true; void client.discover().then(async (value) => { if (!Object.keys(value.accounts).length) { if (mounted) { clearOfflineSession(); clearOfflineViews(); clearMailCaches();++readerRequest.current;conversations.clear();conversationStates.current.clear();acknowledgedConversationStates.current.clear();cacheGeneration.current++;viewCache.current.clear(); setSession(value); setLoading(false); } return; } const entries = await Promise.all(Object.keys(value.accounts).map(async (id) => { const results = await client.readBatch([['Mailbox/get',{},'mailboxes'],['Identity/get',{},'identities'],['Settings/get',{},'preferences']],id); const mailboxes=results.mailboxes as GetResult<Mailbox>, ids=results.identities as GetResult<Identity>, prefs=results.preferences as {settings:Record<string,unknown>}; return { id, mailboxes: mailboxes.list, ids: ids.list, prefs: prefs.settings || {} }; })); if (!mounted)
        return; setBoxes(Object.fromEntries(entries.map(e => [e.id, e.mailboxes]))); setIdentities(Object.fromEntries(entries.map(e => [e.id, e.ids]))); setPreferences(Object.fromEntries(entries.map(e => [e.id, e.prefs])));const offlinePrefs=readOfflinePreferences(value);if(offlinePrefs.enabled)saveOfflineSession(value,offlinePrefs.maxAgeHours);if(offlinePrefs.enabled)saveOfflineView(value,{boxes:Object.fromEntries(entries.map(e=>[e.id,e.mailboxes])),identities:Object.fromEntries(entries.map(e=>[e.id,e.ids])),preferences:Object.fromEntries(entries.map(e=>[e.id,e.prefs])),states:[...client.states]});setSession(value); }).catch(e => { if (mounted) {
        if(canUseOfflineCopy(e)){setOnline(false);const cached=readOfflineSession();if(cached&&readOfflinePreferences(cached).enabled&&readOfflineSession(readOfflinePreferences(cached).maxAgeHours)){const metadata=readOfflineView(cached);client.session=cached;if(metadata){setBoxes(metadata.boxes);setIdentities(metadata.identities);setPreferences(metadata.preferences);client.states=new Map(metadata.states);}setRows(readMailCache(cacheScope(cached)) as Row[]);setSession(cached);setNotice(`Offline copy for ${cached.username}. This local copy expires within 24 hours of the last verified connection.`);setLoading(false);return;}setError('Your offline copy expired or is unavailable. Reconnect to verify access.');}else setError(e.message);
        setLoading(false);
    } }); return () => { mounted = false; request.current++; }; }, [client]);
    useEffect(() => { void load(); }, [load]);
    useEffect(()=>{
      if(!session||loading||!online||compose||panelOpen||active)return;
      let cancelled=false;const epoch=cacheGeneration.current;const ids=Object.keys(session.accounts);
      const scopes=[...new Set([account,'',...ids])];
      const custom=[...new Set(Object.values(boxes).flat().filter(box=>!['inbox','drafts','sent'].includes(box.role||'')).map(box=>box.role||box.id))];
      const views=['drafts','sent','inbox','all',...custom];
      const timer=window.setTimeout(()=>{void (async()=>{
        for(const targetView of views)for(const scopeAccount of scopes){
          if(cancelled||epoch!==cacheGeneration.current||!navigator.onLine)return;
          const viewKey=cacheScope(session)+':'+JSON.stringify([scopeAccount,targetView,'',addressScope,pageSize,sort,ascending]);
          if(viewCache.current.get(viewKey))continue;
          const all=[];
          for(const id of scopeAccount?[scopeAccount]:ids){
            if(cancelled||epoch!==cacheGeneration.current)return;
            const key=cacheScope(session)+':'+JSON.stringify([id,targetView,'',addressScope,pageSize,sort,ascending]);
            const cached=viewCache.current.get(key);
            if(cached){all.push(cached);continue;}
            // Visible message bodies and explicit opens take priority over other folders.
            while(conversations.isBusy()) { await new Promise(resolve=>window.setTimeout(resolve,150)); if(cancelled||epoch!==cacheGeneration.current||!navigator.onLine)return; }
            const value=await fetchView(id,targetView,'',scopeAccount);
            if(cancelled||epoch!==cacheGeneration.current)return;
            const result={rows:sortMailRows(value.emails,sort,ascending),more:value.more,position:0};
            viewCache.current.set(key,result);all.push(result);
          }
          if(!cancelled&&epoch===cacheGeneration.current)viewCache.current.set(viewKey,{rows:sortMailRows(all.flatMap(value=>value.rows),sort,ascending),more:all.some(value=>value.more),position:0});
        }
      })().catch(()=>{/* Foreground loads report failures; speculative reads stay quiet. */});},250);
      return()=>{cancelled=true;window.clearTimeout(timer);};
    },[session,loading,online,compose,panelOpen,active,boxes,account,addressScope,pageSize,sort,ascending,fetchView,conversations]);
    useEffect(() => { const update = () => { setOnline(navigator.onLine); if (navigator.onLine && session)
        void client.discover().then(value=>{if(cacheScope(value)!==cacheScope(session))throw new Error('Mail admission changed. Refresh to load the current authorized accounts.');setSession(value);if(!offlineQueue)return replayMutations(cacheScope(value),client);}).then(() => load()).catch(e => setError(e.message)); }; window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); }; }, [session, client, load,offlineQueue]);
    useEffect(() => { if (!session || session.eventSourceUrl && typeof EventSource !== 'undefined')
        return; const interval = window.setInterval(() => { if (navigator.onLine && !compose && !settings&&!selected.size)
        void load(); }, 60000); return () => window.clearInterval(interval); }, [session, compose, settings, load,selected]);
    const hintRefresh=useRef(load);hintRefresh.current=load;
    const hintPaused=useRef(false);hintPaused.current=!!compose||settings||selected.size>0;
    const [pendingMailHint,setPendingMailHint]=useState(false);
    useEffect(()=>{if(!session||!Object.keys(session.accounts).length||!online||typeof EventSource==='undefined')return;let endpoint:string|null;try{endpoint=mailEventEndpoint(session);}catch(problem){setError(problem instanceof Error?problem.message:'Mail update stream unavailable.');return;}if(!endpoint)return;const stream=new EventSource(endpoint,{withCredentials:true});const states=new Map<string,string>();
      const state=(event:Event)=>{const previous=new Map(states);const hint=mailStateHint((event as MessageEvent).data,session.accounts,states);if(hint.arrival)setNotice('New mail arrived.');if(hint.refresh){for(const id of Object.keys(session.accounts)){const known=acknowledgedConversationStates.current.get(id);if(['Email','Thread'].some(type=>{const key=`${id}:${type}`,value=states.get(key);return value!==undefined&&value!==previous.get(key)&&value!==known;}))conversations.invalidate(id);}cacheGeneration.current++;viewCache.current.clear();if(hintPaused.current)setPendingMailHint(true);else void hintRefresh.current();}};
      stream.addEventListener('state',state);return()=>{stream.removeEventListener('state',state);stream.close();};
    },[session,online,conversations]);
    useEffect(()=>{if(pendingMailHint&&!compose&&!settings&&!selected.size){setPendingMailHint(false);void load();}},[pendingMailHint,compose,settings,selected.size,load]);
    useEffect(()=>{const timer=window.setInterval(()=>{if(!navigator.onLine&&session&&!readOfflineSession(readOfflinePreferences(session).maxAgeHours)){setRows([]);setThread([]);setActive(null);setSession(null);setCompose(null);setSettings(false);setOutbox(false);clearMailCaches();++readerRequest.current;conversations.clear();conversationStates.current.clear();acknowledgedConversationStates.current.clear();cacheGeneration.current++;viewCache.current.clear();clearOfflineViews();setError('Your offline copy expired. Reconnect to verify current access.');}},30000);return()=>window.clearInterval(timer);},[session]);
    useEffect(() => {
        if (!notice) return;
        const notification = toast(notice, { duration: undo ? 10000 : 5000, ...(undo ? { action: { label: 'Undo', onClick: () => { void perform(async () => { await undo(); setUndo(null); setNotice('Change undone'); }); } } } : {}) });
        return () => { toast.dismiss(notification); };
    }, [notice, undo]);
    const rowKey = (row: Row) => `${row.accountId}:${row.id}`;
    const targets = selected.size ? rows.filter(row => selected.has(rowKey(row))) : active ? actionScope==='conversation'&&thread.length?thread.map(email=>({...email,accountId:active.accountId})):[active] : [];
    const updateRows = async (patch: (email: Row) => Record<string, unknown>, affected: Row[] = targets) => { const originals = affected.map(row => ({ ...row })); const updates=new Map(affected.map(row=>[rowKey(row),patch(row)])); const appliedStates = new Map<string, string>(); for (const id of [...new Set(affected.map(row => row.accountId))]) {
        const args = { update: Object.fromEntries(affected.filter(row => row.accountId === id).map(row => [row.id, updates.get(rowKey(row))])) };
        if (!navigator.onLine && session) {
            const expectedState = client.states.get(`${id}:Email`);
            if (!expectedState)
                throw new Error('Reconnect before changing uncached mail.');
            queueMutation(cacheScope(session), id, args, expectedState);
            setNotice('Change queued for synchronization');
            continue;
        }
        const result = await client.call<SetResult>('Email/set', args, id);
        appliedStates.set(id, result.newState);
        acknowledgedConversationStates.current.set(id, result.newState);
        conversations.patch(conversationScope, id, Object.fromEntries(affected.filter(row=>row.accountId===id).map(row=>{const next=applyUiPatch(row,updates.get(rowKey(row))!);return [row.id,{keywords:next.keywords,mailboxIds:next.mailboxIds}];})));
    }
    setRows(previous => previous.map(row => updates.has(rowKey(row)) ? applyUiPatch(row, updates.get(rowKey(row))!) : row));
    // Keep the open conversation in sync with row actions as well as the list.
    setActive(previous => previous && updates.has(rowKey(previous)) ? applyUiPatch(previous, updates.get(rowKey(previous))!) : previous);
    if (active) setThread(previous => previous.map(email => { const key = `${active.accountId}:${email.id}`; return updates.has(key) ? applyUiPatch({ ...email, accountId: active.accountId }, updates.get(key)!) : email; }));
    if(!navigator.onLine&&session){const next=rows.map(row=>updates.has(rowKey(row))?applyUiPatch(row,updates.get(rowKey(row))!):row);setRows(next);saveMailCache(cacheScope(session),next);setUndo(null);setNotice('Changes queued. Reconnect to synchronize; conflicts will require review.');return;} setUndo(() => async () => { for (const id of [...new Set(originals.map(row => row.accountId))])
        await client.call('Email/set', { ifInState: appliedStates.get(id), update: Object.fromEntries(originals.filter(row => row.accountId === id).map(row => [row.id,reverseUiPatch(row,updates.get(rowKey(row))!)])) }, id); await load(); }); setNotice(`${affected.length} message${affected.length === 1 ? '' : 's'} updated`); await load(); };
    const keyword = (key: string, value: boolean) => perform(async () => {await updateRows(() => ({[`keywords/${key}`]:value ? true : null}));setNotice(key === '$important' ? value ? 'Marked important' : 'Marked not important' : key === '$seen' ? value ? 'Marked read' : 'Marked unread' : value ? 'Messages starred' : 'Stars removed');});
    const move = async (role: string) => { if (!targets.length) return Promise.resolve(); if (role === 'trash' && preferences[currentAccount]?.confirmDelete !== false && !await confirm('Selected messages will move to Trash. You can restore them from there.', 'Move messages to Trash?', 'Move to Trash'))
        return Promise.resolve(); return perform(() => updateRows(row => { const mailbox = boxes[row.accountId]?.find(b => b.role === role); if (!mailbox)
        throw new Error(`No ${role} mailbox available.`); if(role==='archive'){const inbox=boxes[row.accountId]?.find(box=>box.role==='inbox');return {[`mailboxIds/${mailbox.id}`]:true,...(inbox?{[`mailboxIds/${inbox.id}`]:null}:{})};}return Object.fromEntries((boxes[row.accountId]||[]).filter(box=>box.role).map(box=>[`mailboxIds/${box.id}`,box.id===mailbox.id?true:null])); })); };
    const open = async (row: Row) => {
        const generation = ++readerRequest.current;
        setThreadError('');
        if (row.keywords.$draft && navigator.onLine) {
            if(compose){setNotice('Save and close the current draft before opening another.');return;}
            await perform(async () => { const draft = await loadComposeEmail(client, row.accountId, row.id, true); if (generation !== readerRequest.current) return; setAccount(row.accountId); setCompose({ draft, accountId:row.accountId }); });
            return;
        }
        const cached = navigator.onLine ? conversations.get(conversationScope, row.accountId, row.threadId) : undefined;
        const showConversation = (messages: Email[]) => { const conversation=sortMailConversation(messages);setThread(conversation);setExpandedMessages(new Set(conversation.length?[conversation[conversation.length-1].id]:[]));setThreadLoading(false); };
        setActive(row); setThread(cached ? sortMailConversation(cached) : []); setThreadLoading(!cached);
        if(cached)setExpandedMessages(new Set(cached.length?[sortMailConversation(cached).at(-1)!.id]:[]));
        if (!navigator.onLine) {
            const related = sortMailConversation(rows.filter(value => value.accountId === row.accountId && value.threadId === row.threadId)); setThread(related); setExpandedMessages(new Set(related.length ? [related[related.length - 1].id] : []));
            setThreadLoading(false);
            setNotice('Offline copy. Formatting, attachments and editing existing drafts require a connection.');
            return;
        }
        try {
            let conversation=cached;
            if(!conversation){
                try { conversation=await conversations.load(conversationScope,row.accountId,row.threadId); }
                catch(cause){
                    if(generation!==readerRequest.current)return;
                    if(!(cause as {conversationInvalidated?:boolean}).conversationInvalidated&&(cause as {errorType?:string}).errorType!=='tooManyObjects')throw cause;
                    conversation=await conversations.load(conversationScope,row.accountId,row.threadId);
                }
            }
            if (generation !== readerRequest.current) return;
            showConversation(conversation);
            if (!row.keywords.$seen) {
                try { const result=await client.call<SetResult>('Email/set', { update: { [row.id]: { 'keywords/$seen': true } } }, row.accountId);acknowledgedConversationStates.current.set(row.accountId,result.newState);conversations.patch(conversationScope,row.accountId,{[row.id]:{keywords:{...(conversation.find(email=>email.id===row.id)?.keywords||row.keywords),$seen:true}}}); }
                catch (cause) { if (generation === readerRequest.current && !(cause as {authorizationLost?:boolean}).authorizationLost) setNotice('Message opened, but its read status could not be saved. Refresh to try again.'); return; }
                if (generation !== readerRequest.current) return;
                setRows(previous => previous.map(value => rowKey(value) === rowKey(row) ? { ...value, keywords: { ...value.keywords, $seen: true } } : value));
                setActive(previous => previous && rowKey(previous) === rowKey(row) ? { ...previous, keywords: { ...previous.keywords, $seen: true } } : previous);
            }
        } catch (cause) {
            if (generation === readerRequest.current) setThreadError(cause instanceof Error ? cause.message : 'This conversation could not be loaded.');
        } finally { if (generation === readerRequest.current) setThreadLoading(false); }
    };
    useEffect(() => {
        if (!active || threadLoading) return;
        const frame = window.requestAnimationFrame(() => { const reader = readerElement.current; const newest = reader?.querySelector<HTMLElement>('[data-mail-newest=true]'); if (reader && newest && newest.getBoundingClientRect().top > reader.getBoundingClientRect().bottom - 100) reader.scrollTop += newest.getBoundingClientRect().top - reader.getBoundingClientRect().top - 60; });
        return () => window.cancelAnimationFrame(frame);
    }, [active?.id, threadLoading]);
    const replyTo = (email: Email, mode: 'reply' | 'replyAll' | 'forward') => {
        if (!active) return;
        if(compose){setNotice('Save and close the current draft before starting another reply.');return;}
        void perform(async () => { const reply = await loadComposeEmail(client, active.accountId, email.id); setAccount(active.accountId); closePanels(); setCompose({ reply, mode, accountId:active.accountId }); });
    };
    const askCommand = (value: NonNullable<typeof command>) => { closePanels(); setCommand(value); };
    useEffect(() => { const handler = (event: KeyboardEvent) => { if(event.defaultPrevented || event.isComposing)return; if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        if(compose)return;
        closePanels(); setPalette(!palette);
        return;
    } if(panelOpen){if(event.key==='Escape' && !compose)closePanels();return;} if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable],[role=textbox]'))
        return; if (event.key === 'Escape') {
        setPalette(false);
        setActive(null);
    } if (event.key === '/') {
        event.preventDefault();
        searchInput.current?.focus();
    } if (event.key.toLowerCase() === 'c') { event.preventDefault(); openComposer(); } if (event.key.toLowerCase() === 'e')
        void move('archive'); if (event.key === 'j' || event.key === 'k') {
        const index = rows.findIndex(row => active && rowKey(row) === rowKey(active));
        const next = rows[index + (event.key === 'j' ? 1 : -1)];
        if (next)
            void open(next);
    } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); });
    const saveSearch = () => { if (!search.trim()) return; askCommand({ title: 'Save this search', description: 'Keep this search in the sidebar to find these messages again.', label: 'Search name', value: '', submitLabel: 'Save search', submit: async (name) => { const settings = { ...settingsValue(preferences[currentAccount]), savedSearches: [...splits, { id: crypto.randomUUID(), name: name.trim(), query: search }] }; await client.call('Settings/set', { settings }, currentAccount); setPreferences(prev => ({ ...prev, [currentAccount]: settings })); setNotice('Search saved'); } }); };
    const pinFolder=async()=>{const box=currentBoxes.find(box=>box.id===view||box.role===view);if(!box)return;await perform(async()=>{const settings={...settingsValue(preferences[currentAccount]),favoriteMailboxIds:favoriteIds.includes(box.id)?favoriteIds.filter(id=>id!==box.id):[...favoriteIds,box.id]};await client.call('Settings/set',{settings},currentAccount);setPreferences(previous=>({...previous,[currentAccount]:settings}));});};
    const addLabel = () => { askCommand({ title: 'Create a label', description: selected.size ? 'The label will also be applied to your selected messages.' : 'Organize messages without moving them out of their folders.', label: 'Label name', value: '', submitLabel: 'Create label', submit: async (name) => { const result = await client.call<SetResult>('Mailbox/set', { create: { label: { name: name.trim(), role: null } } }, currentAccount); const box = await client.call<GetResult<Mailbox>>('Mailbox/get', {}, currentAccount); setBoxes(prev => ({ ...prev, [currentAccount]: box.list })); const id = result.created?.label.id; if (id && targets.length)
        await updateRows(row => {if(row.accountId!==currentAccount)throw new Error('Choose one account before applying a newly created label.');return {[`mailboxIds/${id}`]:true};}); } }); };
    const removeLabel=()=>{askCommand({title:'Remove a label',description:'Remove a label from the selected messages. Your messages stay in their other folders.',label:'Label name',value:'',submitLabel:'Remove label',submit:async(name)=>updateRows(row=>{const box=boxes[row.accountId]?.find(box=>!box.role&&box.name.toLocaleLowerCase()===name.toLocaleLowerCase());if(!box)throw new Error('Label missing in a selected account.');const mailboxIds={...row.mailboxIds};delete mailboxIds[box.id];if(!Object.values(mailboxIds).some(Boolean))throw new Error('Keep at least one folder or label on every message.');return {[`mailboxIds/${box.id}`]:null};})});};
    const deleteForever = async () => { if (!targets.length || !await confirm('These messages will be permanently deleted. This cannot be undone.', 'Delete messages permanently?', 'Delete permanently'))
        return; await perform(async () => { for (const id of [...new Set(targets.map(row => row.accountId))])
        await client.call('Email/set', { destroy: targets.filter(row => row.accountId === id).map(row => row.id) }, id); setActive(null); setUndo(null); await load(); setNotice('Messages permanently deleted'); }); };
    const applySnooze = async (value: string) => {
        setSnoozeError(''); setSnoozeBusy(true);
        try {
            const date = new Date(value); if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error('Choose a time in the future.');
            for (const id of [...new Set(targets.map(row => row.accountId))]) await client.call('Snooze/set', { ifInState: client.states.get(`${id}:Email`), emailIds: targets.filter(row => row.accountId === id).map(row => row.id), until: date.toISOString() }, id);
            await load(); setSnoozeOpen(false); setActive(null); toast.success('Messages snoozed');
        } catch (cause) { setSnoozeError(cause instanceof Error ? cause.message : 'Snooze could not be saved.'); }
        finally { setSnoozeBusy(false); }
    };
    const navigate = (next: string) => {
      ++request.current;++readerRequest.current;closePanels();setView(next);setSearch('');setQuery('');setActive(null);setThread([]);setSelected(new Set());setError('');
      const key=session?cacheScope(session)+':'+JSON.stringify([account,next,'',addressScope,pageSize,sort,ascending]):'';
      const cached=viewCache.current.get(key);setRows(cached?.rows||[]);setMore(cached?.more||false);setPosition(cached?.position||0);setLoading(true);
      // React does not rerun the view effect when the user clicks the current folder.
      if(next===view&&!search)void load();
    };
    const setPageSize = (value: string) => { const size = Number(value); setPageSizeOverride(size); void perform(async () => { const next = { ...settingsValue(preferences[currentAccount]), pageSize: size }; await client.call('Settings/set', { settings: next }, currentAccount); setPreferences(previous => ({ ...previous, [currentAccount]: next })); toast.success('Page size saved'); }); };
    const mute = async () => { if (!active)
        return; await perform(async () => { const settings = { ...settingsValue(preferences[active.accountId]), mutedThreads: ((preferences[active.accountId]?.mutedThreads||[]) as string[]).includes(active.threadId)?((preferences[active.accountId]?.mutedThreads||[]) as string[]).filter(id=>id!==active.threadId):[...((preferences[active.accountId]?.mutedThreads||[]) as string[]),active.threadId] }; await client.call('Settings/set', { settings }, active.accountId); setPreferences(prev => ({ ...prev, [active.accountId]: settings })); setNotice(settings.mutedThreads.includes(active.threadId)?'Conversation muted. Future replies will skip the inbox.':'Conversation unmuted.'); }); };
    const block = async () => { if (!active)
        return; const email = active.from?.[0]?.email; if (!email)
        return; await perform(async () => { const settings = { ...settingsValue(preferences[active.accountId]), blockedSenders:((preferences[active.accountId]?.blockedSenders||[]) as string[]).includes(email)?((preferences[active.accountId]?.blockedSenders||[]) as string[]).filter(id=>id!==email):[...((preferences[active.accountId]?.blockedSenders||[]) as string[]),email] }; await client.call('Settings/set', { settings }, active.accountId); setPreferences(prev => ({ ...prev, [active.accountId]: settings })); setNotice(`${email} ${settings.blockedSenders.includes(email)?'blocked':'unblocked'}`); }); };
    const followUp = () => { if (!active) return; askCommand({ title: 'Remind me to follow up', description: 'Get a reminder if no one replies to this message by the time you choose.', label: 'Remind me on', type: 'datetime-local', value: localDateTime(172800000), submitLabel: 'Set reminder', submit: async (value) => {
        const until = new Date(value); if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now()) throw new Error('Choose a time in the future.');
        await client.call('FollowUp/set', { ifInState: client.states.get(`${active.accountId}:Email`), emailIds: [active.id], until: until.toISOString(), ifNoReply: true }, active.accountId); setNotice('Follow-up reminder set');
    } }); };
    const submissions = async () => { await perform(async () => { const result = await client.call<GetResult<{
        id: string;
        sendAt?: string;
        undoStatus?: string;
        deliveryStatus?: unknown;
    }>>('EmailSubmission/get', {}, currentAccount); setNotice(result.list.length ? result.list.map(v => `${v.id}: ${v.undoStatus || 'queued'} ${v.sendAt || ''}`).join('\n') : 'No outgoing submissions.'); }); };
    if (!session || !accountIds.length) return <MailFrame currentApp={{ id: 'mail', name: 'Mail' }} user={context.user} apps={context.apps} layout="workspace">
      <div className="mail-start" id={standalone ? 'main' : undefined} role={standalone ? 'main' : undefined} tabIndex={-1}>{confirmationDialog}
        <div className="mail-start-identity"><AppControls currentApp={{id:'mail',name:'Mail'}} user={context.user} apps={context.apps} showApps={!standalone} accountDescription={null} accountMenuItems={<DropdownMenuItem asChild><a href="/cdn-cgi/access/logout"><LogOut />Sign out</a></DropdownMenuItem>} /></div>
        <section className="mail-start-card" aria-labelledby="mail-start-title">
          <div className="mail-wordmark"><MailBrand /></div>
          <h2 id="mail-start-title">{loading ? 'Opening your mail…' : session ? 'Your mail starts here.' : 'We couldn’t open your mail.'}</h2>
          {loading && <Spinner label="Opening your mail" />}
          {error && <p className="mail-start-error" role="alert">{error}</p>}
          {session ? <><p>Create a mailbox to keep your messages together. Then connect your domains and choose your email addresses.</p>
            <form onSubmit={event => { event.preventDefault(); if (creatingAccount) return; setCreatingAccount(true); void perform(async () => {
              const response = await fetch('/apps/mail/api/accounts', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: accountName.trim(), operationId: crypto.randomUUID() }) });
              if (!response.ok) { const result = await response.json(); throw new Error(result.error?.message || result.message || 'Could not create your mailbox. Please try again.'); }
              window.location.reload();
            }).finally(() => setCreatingAccount(false)); }}>
              <label>Mailbox name<Input autoFocus required maxLength={100} value={accountName} onChange={event => setAccountName(event.target.value)} /></label>
              <Button size="sm" type="submit" disabled={creatingAccount || !accountName.trim()}>{creatingAccount ? 'Creating mailbox…' : 'Create mailbox'}</Button>
            </form><p className="mail-start-note">You can add more mailboxes and domains later.</p></> : !loading && <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>Try again</Button>}
        </section>
      </div>
    </MailFrame>;
    return <MailFrame currentApp={{ id: 'mail', name: 'Mail' }} user={context.user} apps={context.apps} layout="workspace"><div className="mail-app" role={standalone ? 'main' : undefined} tabIndex={-1} data-density={preferences[currentAccount]?.density||'comfortable'} id={standalone ? 'main' : undefined}>{confirmationDialog}
 <aside className={`mail-sidebar ${mobileNavOpen ? 'mobile-nav-open' : ''}`}>
   <div className="mail-sidebar-brand"><a className="mail-wordmark" href="/apps/mail/" onClick={event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate('inbox');}}><MailBrand /></a><Button className="mail-mobile-menu-toggle" variant="ghost" size="icon-sm" aria-label="Mail navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(value => !value)}><Menu /></Button></div>
   <Button size="sm" className="mail-compose-button" onClick={() => { openComposer(); }}><FilePenLine /> Compose</Button>
   {!Object.values(identities).flat().some(identity => identity.verified === true) && <Button variant="outline" size="sm" onClick={() => openSettings('Domains')}>Set up inboxes</Button>}
   <nav aria-label="Mail folders">{['inbox','drafts','sent'].map(role => { const Icon = folderIcons[role]; return <Button key={role} variant={!panelOpen && view === role ? 'secondary' : 'ghost'} size="sm" aria-current={!panelOpen && view === role ? 'page' : undefined} onClick={() => navigate(role)}><Icon /><span>{folderNames[role]}</span>{role === 'inbox' && <small>{Object.values(boxes).flat().filter(box => box.role === 'inbox').reduce((total, box) => total + box.unreadEmails, 0) || ''}</small>}</Button>; })}</nav>
   <Collapsible open={moreFoldersOpen} onOpenChange={setMoreFoldersOpen} className="mail-more-folders"><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="mail-more-folders-trigger"><Folder />{moreFoldersOpen ? 'Fewer folders' : 'More folders'}<ChevronDown /></Button></CollapsibleTrigger><CollapsibleContent><nav aria-label="More mail folders">{['starred','unread','important','snoozed','all','archive','junk','trash'].map(role => { const Icon=folderIcons[role];return <Button key={role} variant={!panelOpen&&view===role?'secondary':'ghost'} size="sm" aria-current={!panelOpen&&view===role?'page':undefined} onClick={()=>navigate(role)}><Icon /><span>{folderNames[role]}</span></Button>;})}{currentBoxes.filter(box=>!box.role&&!['folder-snoozed','folder-quarantine'].includes(box.id)).map(box=><Button key={box.id} variant={!panelOpen&&view===box.id?'secondary':'ghost'} size="sm" aria-current={!panelOpen&&view===box.id?'page':undefined} onClick={()=>navigate(box.id)}><Tag />{box.name}</Button>)}{currentBoxes.some(box=>box.id==='folder-quarantine')&&<Button variant="ghost" size="sm" onClick={()=>navigate('folder-quarantine')}><ShieldAlert />Quarantine</Button>}<Button variant="ghost" size="sm" onClick={()=>addLabel()}><Plus />Create label</Button></nav></CollapsibleContent></Collapsible>
   {favoriteIds.length > 0 && <nav aria-label="Favorite folders">{currentBoxes.filter(box => favoriteIds.includes(box.id)).map(box => <Button key={box.id} variant={view === box.id && !panelOpen ? 'secondary' : 'ghost'} size="sm" onClick={() => navigate(box.id)}><Tag />{box.name}</Button>)}</nav>}
   {splits.length > 0 && <nav aria-label="Saved searches">{splits.map((split,index) => <Button key={index} variant="ghost" size="sm" onClick={() => {closePanels();setQuery(split.query);setSearch(split.query);setActive(null);}}><Search />{split.name}</Button>)}</nav>}
 </aside>
   <header className="mail-search">
     <form role="search" onSubmit={event => {event.preventDefault();closePanels();setSearch(query);setActive(null);}}><Input ref={searchInput} aria-label="Search mail" placeholder="Search mail" value={query} onChange={event => setQuery(event.target.value)} />{query && <MailIconAction label="Clear search" icon={X} onClick={() => {closePanels();setQuery('');setSearch('');setActive(null);searchInput.current?.focus();}} />}<Button type="submit" size="sm" className="mail-search-submit" aria-label="Search"><Search /><span>Search</span></Button></form>
     <div className="mail-search-tools" aria-label="Mailbox tools"><SearchFilters mailboxes={currentBoxes} identities={knownAddresses} onSearch={value => {closePanels();setQuery(value);setSearch(value);setActive(null);}} />
     <DropdownMenu><Tooltip><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Sort messages"><ArrowDownWideNarrow /></Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent>Sort messages</TooltipContent></Tooltip><DropdownMenuContent className="mail-menu" align="end"><DropdownMenuLabel>Sort messages</DropdownMenuLabel><DropdownMenuRadioGroup value={sort} onValueChange={setSort}>{[['receivedAt','Date'],['from','Sender'],['subject','Subject'],['to','Recipient'],['size','Size'],['unread','Read status'],['starred','Starred']].map(([value,label]) => <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup><DropdownMenuSeparator /><DropdownMenuCheckboxItem checked={ascending} onCheckedChange={value => setAscending(value === true)}>Ascending</DropdownMenuCheckboxItem>{currentBoxes.some(box => box.id === view || box.role === view) && <DropdownMenuItem onSelect={() => void pinFolder()}>{favoriteIds.includes(currentBoxes.find(box => box.id === view || box.role === view)!.id) ? 'Unpin from sidebar' : 'Pin to sidebar'}</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>
     <MailIconAction label={loading ? 'Refreshing mail' : 'Refresh mail'} icon={RefreshCw} disabled={loading} onClick={() => void load()} />
     </div>
     <div className="mail-header-actions">
       <DropdownMenu><Tooltip><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Settings and tools"><SettingsIcon /></Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent>Settings and tools</TooltipContent></Tooltip><DropdownMenuContent className="mail-menu" align="end"><DropdownMenuLabel>Mail settings & tools</DropdownMenuLabel><DropdownMenuItem onSelect={() => openSettings('Preferences')}><Settings2 />Mail settings</DropdownMenuItem><DropdownMenuItem onSelect={() => openSettings('Domains')}><Inbox />Inboxes & domains</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => {closePanels();setOutbox(true);}}><Send />Outbox & delivery</DropdownMenuItem><DropdownMenuItem onSelect={() => {closePanels();setOfflineQueue(true);}}><RefreshCw />Offline changes</DropdownMenuItem><DropdownMenuItem onSelect={() => {closePanels();setRecoveryPicker(true);}}><FilePenLine />Recover drafts</DropdownMenuItem><DropdownMenuItem onSelect={() => {closePanels();setPalette(true);}}><Keyboard />Keyboard shortcuts</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
       <AppControls currentApp={{id:'mail',name:'Mail'}} user={context.user} apps={context.apps} showApps={!standalone} accountDescription={null} accountMenuItems={<DropdownMenuItem asChild><a href="/cdn-cgi/access/logout"><LogOut />Sign out</a></DropdownMenuItem>} />
     </div>
   </header>
 {!panelOpen && <section className={`mail-content ${active ? 'mail-content-reading' : ''}`} aria-label="Mailbox">
 <NotificationRenewalPrompt client={client} onRenew={()=>openSettings('Notifications')} />
   <div className="mail-inbox-scope">
     <label>Inbox<Select value={account || 'all'} onValueChange={value => {closePanels();setAccount(value === 'all' ? '' : value);setAddressScope('');setPageSizeOverride(null);setActive(null);setSelected(new Set());}}><SelectTrigger size="sm" aria-label="Choose inbox"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All inboxes</SelectItem>{accountIds.map(id => <SelectItem key={id} value={id}>{session.accounts[id].name}</SelectItem>)}</SelectContent></Select></label>
     {knownAddresses.length > 0 && <label>Address<Select value={addressScope || 'all'} onValueChange={value => {setAddressScope(value === 'all' ? '' : value);setActive(null);setSelected(new Set());}}><SelectTrigger size="sm" aria-label="Filter by email address"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All addresses</SelectItem>{knownAddresses.map(address => <SelectItem key={address} value={address}>{address}</SelectItem>)}</SelectContent></Select></label>}
     <h1 className="mail-scope-view">{search ? 'Search results' : folderNames[view] || currentBoxes.find(box => box.id === view)?.name || view}{!online && ' · Offline'}</h1>
   </div>
   {search && <div className="mail-applied-search"><span>Matching <strong>{search}</strong></span><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm">Search actions<ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent className="mail-menu" align="end"><DropdownMenuItem onSelect={() => saveSearch()}>Save search</DropdownMenuItem><DropdownMenuItem onSelect={() => {openSettings('Rules');setRuleQuery(search);}}>Create rule from this search</DropdownMenuItem></DropdownMenuContent></DropdownMenu><MailIconAction label="Clear search" icon={X} onClick={() => {setSearch('');setQuery('');}} /></div>}
   {error && <div className="mail-alert" role="alert"><span>{error}</span><Button variant="outline" size="sm" onClick={() => {setError('');void load();}}>Try again</Button><MailIconAction label="Dismiss error" icon={X} onClick={() => setError('')} /></div>}
   {rows.length > 0 && <div className="mail-toolbar" aria-label="Message actions"><Checkbox aria-label="Select all messages" checked={selected.size === rows.length ? true : selected.size ? 'indeterminate' : false} onCheckedChange={value => setSelected(value === true ? new Set(rows.map(rowKey)) : new Set())} />
     <MailIconAction label="Archive" icon={Archive} disabled={!targets.length} onClick={() => void move('archive')} />
     <MailIconAction label="Move to trash" icon={Trash2} disabled={!targets.length} onClick={() => void move('trash')} />
     <MailIconAction label={targets.every(row => row.keywords.$seen) ? 'Mark unread' : 'Mark read'} icon={targets.every(row => row.keywords.$seen) ? Mail : MailOpen} disabled={!targets.length} onClick={() => void keyword('$seen', !targets.every(row => row.keywords.$seen))} />
     <Popover open={snoozeOpen} onOpenChange={value => {setSnoozeOpen(value);setSnoozeError('');}}><Tooltip><TooltipTrigger asChild><PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Snooze messages" title="Snooze messages" disabled={!targets.length}><Clock /></Button></PopoverTrigger></TooltipTrigger><TooltipContent>Snooze messages</TooltipContent></Tooltip><PopoverContent align="start"><PopoverHeader><PopoverTitle>Snooze until</PopoverTitle></PopoverHeader><div className="mail-snooze-presets"><Button variant="ghost" size="sm" disabled={snoozeBusy} onClick={() => void applySnooze(localDateTime(3*3600000))}>Later today</Button><Button variant="ghost" size="sm" disabled={snoozeBusy} onClick={() => void applySnooze(localDateTime(86400000))}>Tomorrow</Button><Button variant="ghost" size="sm" disabled={snoozeBusy} onClick={() => void applySnooze(localDateTime(7*86400000))}>Next week</Button></div><form className="mail-snooze-custom" onSubmit={event => {event.preventDefault();void applySnooze(snoozeValue);}}><label>Choose date and time<Input type="datetime-local" required value={snoozeValue} onChange={event => setSnoozeValue(event.target.value)} /></label>{snoozeError && <p role="alert">{snoozeError}</p>}<Button type="submit" size="sm" disabled={snoozeBusy}>{snoozeBusy ? 'Saving…' : 'Snooze'}</Button></form></PopoverContent></Popover>
     <DropdownMenu><Tooltip><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Labels" title="Labels" disabled={!targets.length}><Tag /></Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent>Labels</TooltipContent></Tooltip><DropdownMenuContent className="mail-menu" align="start"><DropdownMenuLabel>Labels</DropdownMenuLabel>{currentBoxes.filter(box => !box.role && !['folder-snoozed','folder-quarantine'].includes(box.id)).map(box => <DropdownMenuCheckboxItem key={box.id} checked={targets.length > 0 && targets.every(row => !!(boxes[row.accountId]?.find(candidate => candidate.id === box.id || !candidate.role && candidate.name === box.name)?.id && row.mailboxIds[boxes[row.accountId]!.find(candidate => candidate.id === box.id || !candidate.role && candidate.name === box.name)!.id]))} onCheckedChange={checked => void perform(() => updateRows(row => {const label = boxes[row.accountId]?.find(candidate => candidate.id === box.id || !candidate.role && candidate.name === box.name);if(!label)throw new Error('Create this label in each selected inbox before applying it.');if(!checked && Object.keys(row.mailboxIds).filter(id => row.mailboxIds[id] && id !== label.id).length === 0)throw new Error('Keep a folder or label on each message.');return {[`mailboxIds/${label.id}`]: checked ? true : null};}))}>{box.name}</DropdownMenuCheckboxItem>)}<DropdownMenuSeparator /><DropdownMenuItem onSelect={() => addLabel()}><Plus />Create label</DropdownMenuItem><DropdownMenuItem onSelect={() => {closePanels();setSettingsSection('Mailboxes');setSettings(true);}}><Settings2 />Manage labels</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
     <DropdownMenu><Tooltip><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="More message actions" title="More message actions" disabled={!targets.length}><MoreHorizontal /></Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent>More message actions</TooltipContent></Tooltip><DropdownMenuContent className="mail-menu" align="start">{active && !selected.size && <><DropdownMenuLabel>Apply actions to</DropdownMenuLabel><DropdownMenuRadioGroup value={actionScope} onValueChange={value => setActionScope(value as 'message' | 'conversation')}><DropdownMenuRadioItem value="conversation">Conversation</DropdownMenuRadioItem><DropdownMenuRadioItem value="message">This message</DropdownMenuRadioItem></DropdownMenuRadioGroup><DropdownMenuSeparator /></>}<DropdownMenuItem onSelect={() => void keyword('$flagged', !targets.every(row => row.keywords.$flagged))}><Star />{targets.every(row => row.keywords.$flagged) ? 'Remove star' : 'Star messages'}</DropdownMenuItem><DropdownMenuItem onSelect={() => void keyword('$important', !targets.every(row => row.keywords.$important))}><CircleAlert />{targets.every(row => row.keywords.$important) ? 'Mark not important' : 'Mark important'}</DropdownMenuItem><DropdownMenuItem onSelect={() => void move('junk')}><ShieldAlert />Mark as spam</DropdownMenuItem>{['trash','junk'].includes(view) && <DropdownMenuItem onSelect={() => void move('inbox')}><Inbox />{view === 'junk' ? 'Not spam' : 'Restore to inbox'}</DropdownMenuItem>}{view === 'trash' && <DropdownMenuItem onSelect={() => void deleteForever()}><Trash2 />Delete forever</DropdownMenuItem>}{view === 'snoozed' && <DropdownMenuItem onSelect={() => void perform(async () => {for(const id of [...new Set(targets.map(row => row.accountId))])await client.call('Snooze/set',{emailIds:targets.filter(row => row.accountId === id).map(row => row.id),until:null,ifInState:client.states.get(`${id}:Email`)},id);await load();})}><Inbox />Return to inbox now</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>
     <span className="mail-selection-count">{selected.size ? `${selected.size} selected` : ''}</span>
   </div>}
   <div className={`mail-panes ${active ? 'has-reader' : ''}`}>
     <div ref={listElement} className="mail-list" aria-label="Messages" aria-busy={loading}>
       {loading && !rows.length ? <Empty role="status"><EmptyHeader><EmptyMedia><Spinner label="Loading messages" /></EmptyMedia><EmptyTitle>Loading your mail</EmptyTitle><EmptyDescription>Your messages will appear here in a moment.</EmptyDescription></EmptyHeader></Empty> : !rows.length ? <Empty><EmptyHeader><EmptyMedia variant="icon"><Inbox /></EmptyMedia><EmptyTitle>{error ? 'Mail couldn’t be loaded' : search ? 'No matching messages' : view === 'drafts' ? 'No drafts yet' : view === 'sent' ? 'No sent messages yet' : view === 'inbox' ? 'You’re all caught up' : `No ${folderNames[view]?.toLowerCase() || 'messages'} here`}</EmptyTitle><EmptyDescription>{error ? 'Try refreshing this view.' : search ? 'Try another name, address or phrase.' : view === 'drafts' ? 'Messages you start writing are saved here automatically.' : view === 'sent' ? 'Messages you send will appear here.' : view === 'inbox' ? 'New messages will appear here when they arrive.' : 'Messages matching this folder will appear here.'}</EmptyDescription></EmptyHeader><EmptyContent>{search ? <Button variant="outline" size="sm" onClick={() => {setSearch('');setQuery('');}}>Clear search</Button> : error ? <Button variant="outline" size="sm" onClick={() => void load()}>Refresh mail</Button> : ['drafts','sent'].includes(view) ? <Button variant="ghost" size="sm" onClick={openComposer}><FilePenLine />Write a message</Button> : null}</EmptyContent></Empty> : rows.map(row => <div className={`mail-row ${!row.keywords.$seen ? 'unread' : ''} ${selected.has(rowKey(row)) ? 'selected' : ''} ${active && rowKey(active) === rowKey(row) ? 'active' : ''}`} key={rowKey(row)} data-mail-row-key={rowKey(row)}>
         <Checkbox aria-label={`Select ${row.subject || 'untitled message'}`} checked={selected.has(rowKey(row))} onCheckedChange={value => setSelected(previous => {const next = new Set(previous);value === true ? next.add(rowKey(row)) : next.delete(rowKey(row));return next;})} />
         <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={row.keywords.$flagged ? 'Remove star' : 'Star message'} aria-pressed={!!row.keywords.$flagged} onClick={() => void perform(() => updateRows(() => ({'keywords/$flagged': row.keywords.$flagged ? null : true}),[row]))}><Star fill={row.keywords.$flagged ? 'currentColor' : 'none'} /></Button></TooltipTrigger><TooltipContent>{row.keywords.$flagged ? 'Remove star' : 'Star message'}</TooltipContent></Tooltip>
         <span className="mail-row-unread" aria-label={row.keywords.$seen ? 'Read' : 'Unread'}>{!row.keywords.$seen && <span />}</span>
         <Item asChild variant="plain" size="sm" className="mail-row-open"><button type="button" aria-current={active && rowKey(active) === rowKey(row) ? 'true' : undefined} aria-label={`${addressSummary(row.from)}, ${row.subject || 'No subject'}, ${formatDate(row.receivedAt)}`} onClick={() => void open(row)}>
           <span className="mail-row-correspondents" title={addressSummary(row.from)}><strong>{addressSummary(row.from) || (row.keywords.$draft ? 'Draft' : 'Unknown sender')}</strong></span>
           <span className="mail-row-content"><span className="mail-row-labels" aria-label="Labels">{(boxes[row.accountId] || []).filter(box => !box.role && !['folder-snoozed','folder-quarantine'].includes(box.id) && row.mailboxIds[box.id]).map(box => <Badge variant="secondary" key={box.id} title={box.name}>{box.name}</Badge>)}</span><span className="mail-row-summary"><strong className="mail-row-subject">{row.keywords.$draft && <Badge variant="outline">Draft</Badge>}{row.subject || '(No subject)'}{row.keywords.$important && <CircleAlert className="mail-row-important" aria-label="Important" />}</strong>{preferences[row.accountId]?.showPreview !== false && <span className="mail-row-preview"> — {row.preview}</span>}</span></span>
           <span className="mail-row-end">{row.hasAttachment && <Paperclip aria-label="Has attachments" />}<time dateTime={row.receivedAt} title={formatDate(row.receivedAt)}>{formatListDate(row.receivedAt)}</time></span>
         </button></Item>
       </div>)}
       {(!loading || rows.length > 0) && <footer className="mail-pagination"><label>Messages per page<Select value={String(pageSize)} onValueChange={setPageSize}><SelectTrigger size="sm" aria-label="Messages per page"><SelectValue /></SelectTrigger><SelectContent>{[25,50,100].map(size => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}</SelectContent></Select></label><span>{rows.length}{more ? '+' : ''} message{rows.length === 1 ? '' : 's'}</span>{more && <Button variant="outline" size="sm" onClick={() => void load(position + pageSize)} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</Button>}</footer>}
     </div>
     {active && <article ref={readerElement} className="mail-reader" aria-label="Conversation" aria-busy={threadLoading}>
       <div className="mail-reader-navigation"><Button variant="ghost" size="sm" onClick={() => {++readerRequest.current;setActive(null);setThread([]);}}><ChevronLeft />Back to messages</Button><span>{thread.length ? `${thread.length} message${thread.length === 1 ? '' : 's'}` : ''}</span></div>
       <div className="mail-reader-heading"><h2>{active.subject || '(No subject)'}</h2></div>
       <div className="mail-reader-mobile-actions"><MailIconAction label="Archive" icon={Archive} onClick={() => void move('archive')} /><MailIconAction label="Move to trash" icon={Trash2} onClick={() => void move('trash')} /><MailIconAction label={targets.every(row => row.keywords.$seen) ? 'Mark unread' : 'Mark read'} icon={Mail} onClick={() => void keyword('$seen', !targets.every(row => row.keywords.$seen))} /></div>

       {threadLoading && <div className="mail-reader-status" role="status"><Spinner label="Loading conversation" /><p>Opening conversation…</p></div>}
       {threadError && <div className="mail-reader-status" role="alert"><h3>Couldn’t open this conversation</h3><p>{threadError}</p><Button size="sm" variant="outline" onClick={() => void open(active)}>Try again</Button></div>}
       {!threadLoading && !threadError && !thread.length && <div className="mail-reader-status"><p>This message is not available in your offline copy.</p></div>}
       {thread.map(email => <Collapsible className="mail-message" data-mail-newest={email.id === thread[thread.length - 1]?.id ? 'true' : undefined} key={email.id} open={expandedMessages.has(email.id)} onOpenChange={open => setExpandedMessages(previous => {const next=new Set(previous);open ? next.add(email.id) : next.delete(email.id);return next;})}>
         <div className="mail-message-foldline"><CollapsibleTrigger asChild><Button variant="ghost" size="ghost" className="mail-message-fold-trigger"><span className="mail-sender-avatar" aria-hidden="true">{(email.from?.[0]?.name || email.from?.[0]?.email || '?').slice(0,1).toUpperCase()}</span><span className="mail-message-fold-sender"><strong>{email.from?.map(address => address.name || address.email).join(', ') || 'Unknown sender'}</strong>{expandedMessages.has(email.id) ? <small>{email.from?.map(address => address.email).join(', ')}</small> : <span className="mail-message-fold-preview">{email.preview}</span>}</span><time dateTime={email.receivedAt}>{formatDate(email.receivedAt)}</time><ChevronDown aria-hidden="true" /></Button></CollapsibleTrigger><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`More options for ${email.subject || 'message'}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent className="mail-menu" align="end"><DropdownMenuLabel>Message options</DropdownMenuLabel>{!!messageHtml(email) && <><DropdownMenuRadioGroup value={messageDisplay[email.id] || 'formatted'} onValueChange={value => setMessageDisplay(previous => ({...previous,[email.id]:value as 'plain' | 'formatted'}))}><DropdownMenuRadioItem value="formatted">Formatted message</DropdownMenuRadioItem><DropdownMenuRadioItem value="plain">Plain text</DropdownMenuRadioItem></DropdownMenuRadioGroup><DropdownMenuSeparator /></>}<DropdownMenuCheckboxItem checked={messageHeaders.has(email.id)} onCheckedChange={value => setMessageHeaders(previous => {const next = new Set(previous);value ? next.add(email.id) : next.delete(email.id);return next;})}>Show original headers</DropdownMenuCheckboxItem>{!!email.htmlBody?.length && mailLinks(messageHtml(email)).length > 0 && <DropdownMenuCheckboxItem checked={messageLinks.has(email.id)} onCheckedChange={value => setMessageLinks(previous => {const next = new Set(previous);value ? next.add(email.id) : next.delete(email.id);return next;})}>Show message links</DropdownMenuCheckboxItem>}<DropdownMenuItem asChild><a href={client.download(active.accountId,email.blobId,`${email.subject || 'message'}.eml`,'message/rfc822')} download><Download />Download original message</a></DropdownMenuItem>{unsubscribeLink(email) && <DropdownMenuItem asChild><a href={unsubscribeLink(email)!} target="_blank" rel="noopener noreferrer">Unsubscribe from this sender</a></DropdownMenuItem>}</DropdownMenuContent></DropdownMenu></div>
         <CollapsibleContent>

         <div className="mail-message-recipient"><Popover><PopoverTrigger asChild><Button variant="ghost" size="ghost">To {email.to?.map(value => value.name || value.email).join(', ') || '(No recipients)'}<ChevronDown /></Button></PopoverTrigger><PopoverContent align="start" className="mail-message-metadata"><dl><dt>From</dt><dd>{addressSummary(email.from)}</dd><dt>To</dt><dd>{addressSummary(email.to)}</dd>{!!email.cc?.length && <><dt>Cc</dt><dd>{addressSummary(email.cc)}</dd></>}<dt>Inbox</dt><dd>{session.accounts[active.accountId].name}</dd><dt>Received</dt><dd>{formatDate(email.receivedAt)}</dd></dl><SenderAuthentication /></PopoverContent></Popover></div>
         {messageHeaders.has(email.id) && <pre className="mail-message-headers">{email.headers?.map(header => `${header.name}: ${header.value}`).join('\n') || 'Original headers are not available in this copy.'}</pre>}
         {messageDisplay[email.id] !== 'plain' && messageHtml(email) ? <FormattedMessage email={email} client={client} accountId={active.accountId} online={online} allowRemoteImages={remoteImages.has(`${active.accountId}:${email.id}`) || preferences[active.accountId]?.remoteImages === true} onRemoteImages={() => setRemoteImages(previous => new Set([...previous,`${active.accountId}:${email.id}`]))} /> : <MessageText text={messagePlainText(email) || email.preview} />}
         {messageLinks.has(email.id) && !!email.htmlBody?.length && <div className="mail-message-links">{mailLinks(messageHtml(email)).map(link => <p key={link.url}><a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a><small className="mail-link-address">{link.url}</small></p>)}</div>}
         {!!email.attachments?.length && <div className="mail-attachments"><h4>Attachments <span>{email.attachments.length}</span></h4>{email.attachments.map(part => <Button asChild variant="outline" size="sm" key={part.blobId}><a className="mail-attachment" href={client.download(active.accountId, part.blobId, part.name || 'attachment', part.type)} download><Download /><span><strong>{part.name || 'Attachment'}</strong><small>{Math.ceil(part.size / 1024)} KB · Download</small></span></a></Button>)}</div>}

         </CollapsibleContent>
       </Collapsible>)}
       <div className="mail-reader-actions"><Button variant="outline" size="sm" disabled={!online || threadLoading || !thread.length} onClick={() => replyTo(thread[thread.length - 1] || active,'reply')}><Reply />Reply</Button><Button variant="ghost" size="sm" disabled={!online || threadLoading || !thread.length} onClick={() => replyTo(thread[thread.length - 1] || active,'replyAll')}><ReplyAll />Reply all</Button><Button variant="ghost" size="sm" disabled={!online || threadLoading || !thread.length} onClick={() => replyTo(thread[thread.length - 1] || active,'forward')}><Forward />Forward</Button><DropdownMenu><Tooltip><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="More conversation actions"><MoreHorizontal /></Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent>More conversation actions</TooltipContent></Tooltip><DropdownMenuContent className="mail-menu" align="end"><DropdownMenuItem onSelect={() => void mute()}><Bell />{((preferences[active.accountId]?.mutedThreads || []) as string[]).includes(active.threadId) ? 'Unmute conversation' : 'Mute conversation'}</DropdownMenuItem><DropdownMenuItem onSelect={() => void block()}><ShieldAlert />{((preferences[active.accountId]?.blockedSenders || []) as string[]).includes(active.from?.[0]?.email || '') ? 'Unblock sender' : 'Block sender'}</DropdownMenuItem><DropdownMenuItem onSelect={() => followUp()}><Clock />Remind me to follow up</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
     </article>}
   </div>
 </section>}
 {compose && session && <Compose key={`${composeAccount}:${compose.recoveryId||compose.draft?.id || compose.reply?.id || 'new'}`} client={client} accountId={composeAccount} mailboxes={boxes[composeAccount]||[]} identities={identities[composeAccount] || []} undoSeconds={Number(preferences[composeAccount]?.undoSeconds??10)} suggestedContacts={rows.filter(row=>row.accountId===composeAccount).flatMap(row=>[...(row.from||[]),...(row.to||[]),...(row.cc||[])])} {...compose} docked onSetupDomain={() => openSettings('Domains')} onManageTemplates={() => openSettings('Templates')} onManageSignatures={() => openSettings('Signatures')} onClose={() => setCompose(null)} onSaved={() => {conversations.invalidate(composeAccount);void load();}} onSubmitted={(id, draftId) => {
     conversations.invalidate(composeAccount);
     const submissionAccount = composeAccount;
     const cancellationOperation = crypto.randomUUID();
     let attempted = false;
     setCompose(null); setNotice('Message queued for sending.');
     setUndo(Number(preferences[submissionAccount]?.undoSeconds ?? 10) > 0 ? () => async () => {
       const result = await client.call<GetResult<{id:string;status?:string;undoStatus?:string}>>('EmailSubmission/get',{ids:[id]},submissionAccount);
       const submission = result.list.find(value => value.id === id);
       if (!submission) throw new Error('This submission is unavailable. Check Outbox before trying again.');
       if (submission.undoStatus !== 'canceled' && submission.status !== 'canceled') {
         if (!['pending','scheduled'].includes(submission.status || '')) throw new Error('Sending has already started. This message can no longer be recalled.');
         if (attempted) throw new Error('The cancellation result is uncertain. Check Outbox before trying again.');
         attempted = true;
         await client.call('EmailSubmission/set',{operationId:cancellationOperation,ifInState:result.state,update:{[id]:{undoStatus:'canceled'}}},submissionAccount);
       }
       await load();
       if(draftId){const draft = await loadComposeEmail(client,submissionAccount,draftId,true);setAccount(submissionAccount);setCompose({draft,accountId:submissionAccount});}
     } : null);
     void load();
   }}/>}{settings && session && <Settings initialSection={settingsSection} initialRuleQuery={ruleQuery} client={client} accountId={currentAccount} onClose={() => { setSettings(false); void client.discover().then(value => { setSession(value); return Promise.all(Object.keys(value.accounts).map(async (id) => { const box = await client.call<GetResult<Mailbox>>('Mailbox/get', {}, id); setBoxes(prev => ({ ...prev, [id]: box.list })); const ids = await client.call<GetResult<Identity>>('Identity/get', {}, id); setIdentities(prev => ({ ...prev, [id]: ids.list })); const prefs = await client.call<{
        settings: Record<string, unknown>;
    }>('Settings/get', {}, id); setPreferences(prev => ({ ...prev, [id]: prefs.settings || {} })); })); }).catch(e => setError(e.message)); }}/>}
 {outbox && session && <Outbox client={client} accountId={currentAccount} onClose={() => setOutbox(false)} onEdit={emailId => {if(compose){setNotice('Save & close the current draft before opening another.');return;}void perform(async () => { const draft=await loadComposeEmail(client,currentAccount,emailId,true);setCompose({draft,accountId:currentAccount}); setOutbox(false); });}}/>}
 {offlineQueue&&session&&<OfflineQueue client={client} session={session} onClose={()=>setOfflineQueue(false)} onChanged={()=>void load()}/>}
 {command && <section className="mail-command-page" aria-labelledby="mail-command-title"><header><div><p className="mail-eyebrow">Organize your mail</p><h2 id="mail-command-title">{command.title}</h2></div><Button size="sm" variant="outline" disabled={commandBusy} onClick={() => setCommand(null)}>Back to mail</Button></header><form onSubmit={event => { event.preventDefault(); if (commandBusy || !command.value.trim()) return; setCommandBusy(true); setCommandError(''); void command.submit(command.value.trim()).then(() => setCommand(null)).catch(cause => setCommandError(cause instanceof Error ? cause.message : 'Please try again.')).finally(() => setCommandBusy(false)); }}><p>{command.description}</p><label>{command.label}<Input autoFocus required maxLength={command.type ? undefined : 100} type={command.type || 'text'} value={command.value} onChange={event => setCommand(previous => previous ? { ...previous, value: event.target.value } : previous)} /></label>{commandError && <p className="mail-command-error" role="alert">{commandError}</p>}<div className="mail-command-actions"><Button size="sm" type="submit" disabled={commandBusy || !command.value.trim()}>{commandBusy ? 'Saving…' : command.submitLabel}</Button><Button size="sm" type="button" variant="outline" disabled={commandBusy} onClick={() => setCommand(null)}>Cancel</Button></div></form></section>}
 {recoveryPicker && session && <section className="mail-recovery-page" aria-labelledby="mail-recovery-title"><header><div><p className="mail-eyebrow">Drafts & recovery</p><h2 id="mail-recovery-title">Recover local drafts</h2><p>Copies saved in this browser, for this account. Open a copy to review and continue writing.</p></div><Button size="sm" variant="outline" onClick={() => setRecoveryPicker(false)}>Back to mail</Button></header>{listDraftRecoveries(session,currentAccount).length ? <div className="mail-recovery-list">{listDraftRecoveries(session,currentAccount).map(recovery => <Button size="sm" variant="ghost" key={recovery.id} onClick={() => {if(compose){setNotice('Save & close the current draft before opening another.');return;}setCompose({recoveryId:recovery.id,accountId:currentAccount});setRecoveryPicker(false);}}><span><strong>{recovery.subject || '(Untitled draft)'}</strong><small>{recovery.pendingSend ? 'Send outcome unresolved — review before trying again' : 'Local recovery copy'}</small></span><span aria-hidden="true">Continue →</span></Button>)}</div> : <div className="mail-empty"><h3>No drafts to recover</h3><p>If writing is interrupted, local recovery copies will appear here.</p><Button size="sm" variant="outline" onClick={() => setRecoveryPicker(false)}>Return to your inbox</Button></div>}</section>}
 {palette && <section className="mail-shortcuts-page" aria-labelledby="mail-shortcuts-title"><header><div><h2 id="mail-shortcuts-title">Keyboard shortcuts</h2><p>Use these while viewing mail. They pause while you type.</p></div><Button variant="outline" size="sm" onClick={() => setPalette(false)}>Back to mail</Button></header><dl className="mail-shortcuts-list">{[['Write a message','C'],['Search mail','/'],['Archive selected messages','E'],['Next / previous message','J / K'],['Close conversation or commands','Esc'],['Open keyboard shortcuts','⌘ / Ctrl + K']].map(([label,key]) => <div key={key}><dt>{label}</dt><dd><kbd>{key}</kbd></dd></div>)}</dl></section>}
 </div></MailFrame>;
}
