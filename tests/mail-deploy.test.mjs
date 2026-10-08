import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('standalone deployment config is isolated, complete and refuses to overwrite existing installation settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-config-'));
  try {
    const args = ['scripts/deploy-mail.mjs', '--configure', '--config-dir', directory, '--account', 'a'.repeat(32), '--owner', 'owner-subject', '--team', 'example.cloudflareaccess.com', '--audience', 'application-aud', '--hostname', 'mail.example.com', '--name', 'mail-test'];
    const configured = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr);
    const files = await Promise.all(['mail.json', 'ingress.json', 'scanner.json'].map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))));
    const [app, ingress, scanner] = files;
    assert.equal(app.main, resolve('apps/mail/src/standalone.ts'));
    assert.equal(app.name, 'mail-test');
    assert.equal(app.assets.directory, resolve('apps/mail/dist-standalone'));
    assert.deepEqual(app.services, [{ binding: 'MAIL_SCANNER', service: scanner.name }]);
    assert.equal(app.vars.MAIL_INGRESS_WORKER, ingress.name);
    assert.equal(app.vars.MAIL_OWNER_SUBJECT, 'owner-subject');
    assert.equal(app.vars.AUTH_PROVIDER, 'cloudflare-access');
    assert.deepEqual(app.routes, [{ pattern: 'mail.example.com', custom_domain: true }]);
    assert.equal(app.vars.CF_API_TOKEN, undefined);
    assert(app.durable_objects.bindings.some(binding => binding.name === 'MAIL_AUTHORITY'));
    assert(app.migrations.some(migration => migration.new_sqlite_classes.includes('StandaloneMailAuthority')));
    for (const config of files) {
      assert.equal(config.account_id, 'a'.repeat(32));
      assert.equal(config.workers_dev, false);
      assert.equal(config.preview_urls, false);
      assert(!JSON.stringify(config).includes('open-cloud-core'));
    }
    assert(ingress.durable_objects.bindings.every(binding => binding.script_name === app.name));
    assert.equal(ingress.r2_buckets[0].bucket_name, app.r2_buckets[0].bucket_name);
    const before = await readFile(join(directory, 'mail.json'), 'utf8');
    assert.notEqual(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0);
    assert.equal(await readFile(join(directory, 'mail.json'), 'utf8'), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
