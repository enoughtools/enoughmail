interface ScannerContainer {
  running: boolean;
  start(options?: { enableInternet: boolean }): void;
  setInactivityTimeout(durationMs: number): Promise<void>;
  getTcpPort(port: number): { fetch(request: Request | string, init?: RequestInit): Promise<Response> };
}
interface ScannerState {
  container?: ScannerContainer;
  blockConcurrencyWhile<T>(task: () => Promise<T>): Promise<T>;
}
interface ScannerEnvironment {
  SCANNER: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}
const unavailable = () => Response.json({ complete: false, error: 'scannerUnavailable' }, { status: 503 });

/** This Worker has no public hostname. Mail alone invokes its Cloudflare service binding. */
export default {
  async fetch(request: Request, env: ScannerEnvironment): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health') {
      try { return await env.SCANNER.get(env.SCANNER.idFromName('mail-scanner-v1')).fetch(request); }
      catch { return unavailable(); }
    }
    if (request.method !== 'POST' || path !== '/scan') return new Response('Not found', { status: 404 });
    const size = request.headers.get('Content-Length');
    if (size === null || !/^\d+$/.test(size)) return new Response('Length required', { status: 411 });
    if (Number(size) > 64 * 1024 * 1024) return new Response('Too large', { status: 413 });
    if (!/^[a-f0-9]{64}$/.test(request.headers.get('X-Mail-SHA256') ?? '')) return new Response('Digest required', { status: 400 });
    // One global instance bounds expensive engine memory and rejects overload rather than faking clean.
    try { return await env.SCANNER.get(env.SCANNER.idFromName('mail-scanner-v1')).fetch(request); }
    catch { return unavailable(); }
  },
};

export class MailScannerContainer {
  constructor(private readonly ctx: ScannerState) {
    if (ctx.container?.running) void ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(300_000));
  }
  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) return unavailable();
    try {
      await this.ctx.blockConcurrencyWhile(async () => {
        if (!container.running) container.start({ enableInternet: true });
        await container.setInactivityTimeout(300_000);
      });
      // A cold container or stale signatures returns unavailable; the durable account retries later.
      return await container.getTcpPort(8080).fetch(request);
    } catch { return unavailable(); }
  }
}
