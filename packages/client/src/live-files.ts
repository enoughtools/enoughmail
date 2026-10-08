/**
 * Subscribe to Core's generic file invalidations. The callback refetches an
 * authorized catalog; this socket never carries names, bytes or permissions.
 * Reconnection always refetches so a sleeping tab catches up without polling.
 */
export function subscribeWorkspaceChanges(onChange: () => void): () => void {
  let disposed = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let delay = 500;
  const invalidate = () => {
    if (debounce) return;
    debounce = setTimeout(() => { debounce = undefined; if (!disposed) onChange(); }, 150);
  };
  const connect = () => {
    if (disposed || document.visibilityState === 'hidden') return;
    const url = new URL('/api/changes/live', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(url);
    socket.onopen = () => { delay = 500; invalidate(); };
    socket.onmessage = (event) => {
      try { if (JSON.parse(String(event.data)).type === 'catalog.invalidate') invalidate(); }
      catch { /* Unsupported hints are ignored; HTTP remains authoritative. */ }
    };
    socket.onclose = (event) => {
      socket = undefined;
      if (!disposed && event.code !== 1008 && document.visibilityState !== 'hidden') {
        retry = setTimeout(connect, delay); delay = Math.min(delay * 2, 15000);
      }
    };
  };
  const visibility = () => {
    if (document.visibilityState === 'hidden') { if (retry) clearTimeout(retry); socket?.close(1000, 'Tab sleeping'); }
    else if (!socket) { invalidate(); connect(); }
  };
  document.addEventListener('visibilitychange', visibility);
  connect();
  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', visibility);
    if (retry) clearTimeout(retry);
    if (debounce) clearTimeout(debounce);
    socket?.close(1000, 'Leaving workspace');
  };
}
