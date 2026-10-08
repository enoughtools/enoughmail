import MailCheckbox from './MailCheckbox';
import { NativeSelect } from '@rebnz/enough-ui/native-select';
import { Input } from '@rebnz/enough-ui/input';
import React, { useEffect, useState } from 'react';
import { Button } from '@open-cloud/ui';
import type { MailSession } from './jmap';
import { cacheScope, clearCachedMailCopies } from './offline';
import { clearOfflineSession } from './offline-session';
import { clearOfflineViews } from './offline-view';
import { readOfflinePreferences, saveOfflinePreferences } from './offline-preferences';

export default function OfflinePreferences({ session, onChanged }: { session: MailSession; onChanged: () => void }) {
  const scope = cacheScope(session);
  const [preferences, setPreferences] = useState(() => readOfflinePreferences(session));
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setPreferences(readOfflinePreferences(session)); setNotice(''); setError(''); }, [scope]);
  function clearCopies() {
    clearCachedMailCopies(scope); clearOfflineSession(); clearOfflineViews();
  }
  function save() {
    setNotice(''); setError('');
    try {
      const saved = saveOfflinePreferences(session, preferences);
      setPreferences(saved);
      if (!saved.enabled) clearCopies();
      onChanged();
      setNotice('Device preferences saved. Existing offline expiry times are not extended. Queued changes are kept.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Device preferences could not be saved.'); }
  }
  return <section className="mail-offline-preferences" aria-label="Offline mail on this device">
    <div className="mail-settings-subsection"><h4>Read mail without a connection</h4>
    <p>Recent plain-text mail is stored in this browser, with a total limit of 2 MB. Attachment files and HTML bodies are not cached. These settings apply only to your current identity, workspace and admitted accounts on this device.</p>

    <label className="mail-settings-check"><MailCheckbox checked={preferences.enabled} onChange={event => setPreferences({ ...preferences, enabled: event.target.checked })} /> Keep recent mail available offline</label>
    <label className="mail-settings-field">Recent messages <NativeSelect disabled={!preferences.enabled} value={preferences.maxMessages} onChange={event => setPreferences({ ...preferences, maxMessages: Number(event.target.value) })}>{[10, 25, 50, 100].map(value => <option key={value} value={value}>{value}</option>)}</NativeSelect></label>
    <label className="mail-settings-field">Keep copies for <NativeSelect disabled={!preferences.enabled} value={preferences.maxAgeHours} onChange={event => setPreferences({ ...preferences, maxAgeHours: Number(event.target.value) })}>{[1, 6, 12, 24].map(value => <option key={value} value={value}>{value} {value === 1 ? 'hour' : 'hours'}</option>)}</NativeSelect></label>
    <p>Limits apply when mail is refreshed online. Saving while offline never renews an expired session or extends an existing copy’s expiry.</p>
    <Button onClick={save}>Save device preferences</Button></div><div className="mail-settings-subsection"><h4>Clear this device</h4><p>Remove cached messages from this browser. Queued changes are kept so they can still sync when you reconnect.</p>
    <Button variant="outline" onClick={() => { setNotice(''); setError(''); try { clearCopies(); onChanged(); setNotice('Offline mail copies cleared. Queued changes are kept.'); } catch (e) { setError(e instanceof Error ? e.message : 'Offline copies could not be cleared.'); } }}>Clear offline copies</Button></div><details className="mail-secondary-tools"><summary>Privacy and offline limits</summary><p>Other people using the same browser profile may be able to read local copies. Turn offline mail off on a shared device. Text copied to the clipboard can remain there after you leave mail.</p><p>Attachments and HTML bodies are not available offline. Queued actions sync after you reconnect and your permissions are checked again.</p></details>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
