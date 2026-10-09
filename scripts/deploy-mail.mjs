import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const local = resolve(root, option('--config-dir') ?? '.open-cloud/mail-standalone');
const load = async file => JSON.parse(await readFile(file, 'utf8'));
function run(command, parameters, input) {
  return new Promise((accept, reject) => {
    const child = spawn(command, parameters, { cwd: root, env: process.env, stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'] });
    if (input) child.stdin.end(input);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? accept() : reject(new Error(`${command} failed (${code}).`)));
  });
}
const wrangler = (...parameters) => run(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), ...parameters]);

async function configure() {
  const account = option('--account'), owner = option('--owner'), team = option('--team'), audience = option('--audience'), hostname = option('--hostname');
  const name = option('--name') ?? 'enough-mail';
  if (!/^[a-f0-9]{32}$/i.test(account ?? '') || !owner || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team ?? '') || !audience || !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(hostname ?? '') || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error('Use --account ACCOUNT_ID --owner ACCESS_SUBJECT --team TEAM.cloudflareaccess.com --audience ACCESS_AUD --hostname mail.example.com [--name enough-mail].');
  const mcpHostname = option('--mcp-hostname'), mcpRedirect = option('--mcp-redirect-uri');
  if (mcpHostname && (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(mcpHostname) || mcpHostname === hostname || !mcpRedirect || !mcpRedirect.startsWith('https://') || new URL(mcpRedirect).username || new URL(mcpRedirect).password || new URL(mcpRedirect).hash)) throw new Error('Use a separate --mcp-hostname and the exact HTTPS --mcp-redirect-uri shown in plugin management.');
  const file = resolve(local, 'mail.json');
  try { await readFile(file); throw new Error('Standalone configuration already exists. Edit .open-cloud/mail-standalone/*.json to preserve its resource names.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(local, { recursive: true });
  const app = await load(resolve(root, 'apps/mail/wrangler.json'));
  app.name = name; app.account_id = account; app.main = resolve(root, 'apps/mail/src/standalone.ts');
  app.assets.directory = resolve(root, 'apps/mail/dist-standalone');
  app.services = [{ binding: 'MAIL_SCANNER', service: `${name}-scanner` }];
  app.vars = { AUTH_PROVIDER: 'cloudflare-access', ACCESS_TEAM_DOMAIN: team, ACCESS_AUDIENCE: audience, MAIL_OWNER_SUBJECT: owner, MAIL_MEMBER_SUBJECTS: '[]', MAIL_PUSH_SUBJECT: `https://${hostname}/`, MAIL_PUSH_ORIGINS: JSON.stringify(['https://fcm.googleapis.com','https://updates.push.services.mozilla.com','https://web.push.apple.com']), CF_ACCOUNT_ID: account, MAIL_INGRESS_WORKER: `${name}-ingress`, MAIL_DELIVERY_EVENTS_QUEUE: `${name}-delivery` };
  app.routes = [{ pattern: hostname, custom_domain: true }];
  app.durable_objects.bindings.push({ name: 'MAIL_AUTHORITY', class_name: 'StandaloneMailAuthority' });
  app.migrations.push({ tag: 'v3-standalone-authority', new_sqlite_classes: ['StandaloneMailAuthority'] });
  app.r2_buckets[0].bucket_name = `${name}-blobs`;
  app.queues.consumers[0].queue = `${name}-delivery`;
  app.queues.consumers[0].dead_letter_queue = `${name}-delivery-dead`;
  const ingress = await load(resolve(root, 'apps/mail/public.wrangler.json'));
  ingress.name = `${name}-ingress`; ingress.account_id = account; ingress.main = resolve(root, 'apps/mail/src/ingress.ts');
  ingress.durable_objects.bindings.forEach(binding => { binding.script_name = name; });
  ingress.r2_buckets = app.r2_buckets;
  if (mcpHostname) {
    const oauth = { MAIL_MCP_PUBLIC_ORIGIN: `https://${mcpHostname}`, MAIL_MCP_WORKSPACE_ORIGIN: `https://${hostname}`, MAIL_MCP_CLIENT_ID: 'enoughmail-chatgpt', MAIL_MCP_REDIRECT_URIS: mcpRedirect };
    Object.assign(app.vars, oauth, { MAIL_MCP_CALLBACK_ORIGINS: option('--mcp-callback-origins') ?? '' });
    ingress.vars = { ...(ingress.vars ?? {}), ...oauth };
    ingress.routes = [{ pattern: mcpHostname, custom_domain: true }];
  }

  const scanner = await load(resolve(root, 'apps/mail/scanner.wrangler.json'));
  scanner.name = `${name}-scanner`; scanner.account_id = account; scanner.main = resolve(root, 'apps/mail/scanner-worker.ts');
  scanner.containers[0].image = resolve(root, 'apps/mail/scanner/Dockerfile');
  for (const [filename, value] of [['mail.json', app], ['ingress.json', ingress], ['scanner.json', scanner]]) await writeFile(resolve(local, filename), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  console.log(`Standalone Mail configured in ${local}. Deploy with npm run mail:deploy${option('--config-dir') ? ` -- --config-dir ${local}` : ''}.`);
}

async function deploy() {
  const app = await load(resolve(local, 'mail.json'));
  const ingress = await load(resolve(local, 'ingress.json'));
  const scanner = await load(resolve(local, 'scanner.json'));
  if (app.main !== resolve(root, 'apps/mail/src/standalone.ts') || app.services.some(binding => binding.binding === 'CORE') || !app.vars.MAIL_OWNER_SUBJECT || app.account_id !== ingress.account_id || app.account_id !== scanner.account_id || app.workers_dev !== false || app.preview_urls !== false) throw new Error('Invalid standalone configuration. Reconfigure Mail; no Core binding or unprotected preview hostname is allowed.');
  if (args.includes('--dry-run')) {
    await run('npm', ['run', 'build', '--workspace', '@open-cloud/mail', '--', '--mode', 'standalone']);
    // Containers need a Docker daemon for a full scanner dry-run. Bundle its Worker
    // separately; the production deploy below still validates and builds the image.
    await wrangler('deploy', '--config', resolve(local, 'mail.json'), '--dry-run', '--outdir', resolve(local, 'bundle'));
    await wrangler('deploy', '--config', resolve(local, 'ingress.json'), '--dry-run', '--outdir', resolve(local, 'ingress-bundle'));
    return;
  }
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.MAIL_CF_API_TOKEN) throw new Error('Set CLOUDFLARE_API_TOKEN for deployment and MAIL_CF_API_TOKEN for Mail DNS, routing and sending. Secrets are never written to configuration.');
  await run('npm', ['run', 'build', '--workspace', '@open-cloud/mail', '--', '--mode', 'standalone']);
  const account = app.account_id;
  async function api(path, method = 'GET', body, allowMissing = false) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { method, headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (allowMissing && response.status === 404) return undefined;
    const value = await response.json();
    if (!response.ok || value.success !== true) throw new Error(`Cloudflare provisioning failed (${response.status}) at ${path}. Check account permissions.`);
    return value.result;
  }
  // Read before creating; rerunning deployment preserves existing mail and queues.
  for (const bucket of app.r2_buckets) if (!await api(`/r2/buckets/${bucket.bucket_name}`, 'GET', undefined, true)) await api('/r2/buckets', 'POST', { name: bucket.bucket_name });
  const queues = [];
  for (let page = 1; ; page++) { const result = await api(`/queues?per_page=100&page=${page}`); queues.push(...result); if (result.length < 100) break; }
  for (const consumer of app.queues.consumers) for (const queue of [consumer.dead_letter_queue, consumer.queue]) if (!queues.some(existing => existing.queue_name === queue)) { queues.push(await api('/queues', 'POST', { queue_name: queue })); }
  await wrangler('deploy', '--config', resolve(local, 'scanner.json'));
  await wrangler('deploy', '--config', resolve(local, 'mail.json'));
  await run(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'bulk', '--config', resolve(local, 'mail.json')], JSON.stringify({ CF_API_TOKEN: process.env.MAIL_CF_API_TOKEN }));
  await wrangler('deploy', '--config', resolve(local, 'ingress.json'));
  console.log(`EnoughMail deployed at https://${app.routes[0].pattern}/apps/mail/. Sign in, create an account and add domains in Settings.`);
}
try { if (args.includes('--configure')) await configure(); else await deploy(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
