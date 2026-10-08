/** Mail-owned provider boundary. Discovery never changes DNS or delivery. */
export interface DomainDiscoveryProvider {
  list(page: number): Promise<{ domains: DiscoveredDomain[]; page: number; pages: number }>;
  inspect(zoneId: string): Promise<DomainInspection>;
}
export interface DiscoveredDomain { zoneId: string; name: string; status: string }
export interface DomainInspection {
  domain: DiscoveredDomain;
  mailExchangers: string[];
  existingMail: boolean;
  delivery: 'enoughmail' | 'cloudflare' | 'other' | 'mixed' | 'none';
  routingCheck: 'verified' | 'unavailable' | 'not-needed';
}
export class DomainDiscoveryError extends Error {}
export class CloudflareDomainDiscovery implements DomainDiscoveryProvider {
  constructor(private token: string, private accountId: string, private request: typeof fetch = (input, init) => fetch(input, init), private ingressWorker?: string) {}
  private async get(path: string) {
    const response = await this.request(`https://api.cloudflare.com/client/v4/${path}`, { headers: { Authorization: `Bearer ${this.token}` }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new DomainDiscoveryError(`Cloudflare rejected the domain request (HTTP ${response.status}). Check the domain connection permissions.`);
    const data = await response.json() as { success: boolean; result: any; result_info?: { total_pages?: number } };
    if (!data.success) throw new Error('Cloudflare could not read your domains.');
    return data;
  }
  private domain(zone: any): DiscoveredDomain {
    if (zone.account?.id !== this.accountId || !/^[a-f0-9]{32}$/i.test(zone.id) || typeof zone.name !== 'string') throw new DomainDiscoveryError('Cloudflare returned a domain outside the configured account.');
    return { zoneId: zone.id, name: zone.name, status: zone.status };
  }
  async list(page: number) {
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw new Error('Choose a valid domain page.');
    const data = await this.get(`zones?account.id=${encodeURIComponent(this.accountId)}&per_page=50&page=${page}&order=name&direction=asc`);
    if (!Array.isArray(data.result)) throw new Error('Cloudflare returned an invalid domain list.');
    return { domains: data.result.map(zone => this.domain(zone)), page, pages: data.result_info?.total_pages || 1 };
  }
  async inspect(zoneId: string) {
    if (!/^[a-f0-9]{32}$/i.test(zoneId)) throw new Error('Choose a valid domain.');
    const domain = this.domain((await this.get(`zones/${zoneId}`)).result);
    const records = await this.get(`zones/${zoneId}/dns_records?type=MX&name=${encodeURIComponent(domain.name)}&per_page=100`);
    if (!Array.isArray(records.result)) throw new Error('Cloudflare returned invalid mail records.');
    const mailExchangers = records.result.map((record: { content: string }) => record.content).filter((value: unknown): value is string => typeof value === 'string');
    const cloudflare = mailExchangers.filter(host => /(^|\.)mx\.cloudflare\.net\.?$/i.test(host));
    let delivery: DomainInspection['delivery'] = !mailExchangers.length ? 'none' : !cloudflare.length ? 'other' : cloudflare.length === mailExchangers.length ? 'cloudflare' : 'mixed';
    let routingCheck: DomainInspection['routingCheck'] = 'not-needed';
    if (cloudflare.length) {
      routingCheck = 'unavailable';
      try {
        const route = (await this.get(`zones/${zoneId}/email/routing/rules/catch_all`)).result;
        if (!route || typeof route.enabled !== 'boolean' || !Array.isArray(route.actions)) throw new Error('Invalid route');
        routingCheck = 'verified';
        const ours = this.ingressWorker && route.enabled && route.actions.length === 1 && route.actions[0].type === 'worker' && route.actions[0].value?.length === 1 && route.actions[0].value[0] === this.ingressWorker;
        if (ours && delivery === 'cloudflare') delivery = 'enoughmail';
      } catch { /* Keep the observed MX status; never infer EnoughMail from DNS alone. */ }
    }
    return { domain, mailExchangers, existingMail: mailExchangers.length > 0, delivery, routingCheck };
  }
}
