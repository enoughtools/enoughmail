# EnoughMail on its own Cloudflare account

EnoughMail has a separate deployment path. It builds and deploys Mail alone, with no Core Worker, Core database, workspace installation, gateway or `open-cloud.config.json`. Shared source packages are built from this repository; no other product is deployed.

The private web app runs at your own hostname. A separate bounded ingress Worker receives email; the web app, account storage, authority and scanner stay private. Mail owns accounts, grants, domain approvals and job leases. The integrated deployment can continue using Core through the same private `MailAuthority` interface.

## Configure once

Install dependencies with `npm install` using Node 22.14 or newer. Enable Workers, R2, Queues, Containers and Email Sending on your Cloudflare account. The scanner deployment builds a container, so Docker must be available. Cloudflare service availability, storage and sending quotas still apply.

Create a [Cloudflare Access self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) covering **all paths** on the hostname you will use for Mail. Give your intended users access. Record its team hostname, application audience and your exact Access token subject (`sub`). The owner subject identifies an account, not an email address. Workers verifies the JWT signature, issuer, audience and expiry itself, in addition to Access protecting the hostname.

Run from the repository root, substituting your own settings:

```sh
npm run mail:configure -- \
  --account YOUR_CLOUDFLARE_ACCOUNT_ID \
  --team YOUR_TEAM.cloudflareaccess.com \
  --audience YOUR_ACCESS_APPLICATION_AUDIENCE \
  --owner YOUR_ACCESS_SUBJECT \
  --hostname mail.example.com
```

`--name enough-mail` is optional; use a different name for each independent installation. Use a fresh name rather than the name of an existing integrated Mail deployment. This does not migrate existing Core resource IDs, grants or mail storage.

Configuration is saved under ignored `.open-cloud/mail-standalone/`. No secret is saved there. Re-running configure refuses to overwrite it. Edit the existing JSON files to change settings; keep names and migrations stable to preserve stored mail. `--config-dir PATH` selects a different configuration directory for both commands.

## Deploy

Supply these environment variables using your secret manager or shell environment:

- `CLOUDFLARE_API_TOKEN`: deployment token for the target account, able to manage Workers, routes, R2 buckets, queues and the scanner container.
- `MAIL_CF_API_TOKEN`: runtime token for zone discovery/read, DNS editing, Email Sending and Email Routing in the domains you intend to add. Routing enablement also requires Zone Settings Write. Scope it to this account and the intended zones. It is uploaded as the private web Worker's `CF_API_TOKEN` secret.

Then run:

```sh
npm run mail:deploy
```

The command builds the standalone web UI, reads existing buckets/queues before creating missing resources, deploys the private scanner, deploys the web Worker and authority, uploads the runtime secret, and deploys the ingress Worker. It never invokes the stack deployment command or reads Core's installation settings. Repeat the same command to update Mail. Existing data is retained.

Open `https://mail.example.com/apps/mail/` and sign in. The root URL also opens Mail. Create your first mail account from the welcome screen.

A local bundle check is available without Cloudflare credentials:

```sh
npm run mail:deploy -- --dry-run
```

This builds and checks the web and ingress Workers without provisioning or deploying. It does not build or validate the scanner's container image or verify remote account entitlement. A real deployment does those Cloudflare steps.

## Add domains in the app

Domains must already be active Cloudflare zones in the configured account, accessible to the runtime API token. You can add additional domains after deployment without changing Worker configuration.

For each domain, in **Settings & domains → Domains**:

1. Add its domain name and Cloudflare zone ID. Choose whether unmatched addresses deliver to this mail account. Save.
2. **Approve domain** as the installation owner. The app verifies the zone's name and Cloudflare account, and records an approval scoped to this Mail account.
3. **Prepare sending**. Mail creates or reuses the provider's sending identity; you do not need to obtain its ID separately.
4. Open **DNS records**, review the proposed changes and apply them. Mail preserves unrelated DNS and refuses conflicting MX/CNAME records.
5. **Verify** the domain. Sending stays disabled until DNS verification succeeds.
6. **Connect receiving** to the installation's ingress Worker. This enables Cloudflare Email Routing and its catch-all Worker destination. Mail refuses to replace an active catch-all belonging to another service. Existing explicit Cloudflare routing rules retain their precedence; review those in Cloudflare if they intercept an intended address.
7. Add sending addresses in **Identities**, or enable unmatched-address delivery. The private directory rejects recipients that have no enabled identity, configured recipient or catch-all account.

Repeat for each domain, using one account for several domains or creating separate accounts. Mail has no configured domain-count limit; Cloudflare's account and API limits apply. Sending configuration and DNS propagate asynchronously, so verification can require a later retry.

## Additional users and optional features

Set `MAIL_MEMBER_SUBJECTS` in `.open-cloud/mail-standalone/mail.json` to a JSON string of additional verified Access subjects, for example `"[\"subject-2\",\"subject-3\"]"`, and redeploy. These users must also be allowed by your Access application. Members can create their own mail accounts; use **Delegation** to grant access to another account. Only the configured owner approves domains. Removing a subject from admission, or removing an account grant, causes existing job leases to fail revalidation. Leases are opaque, bounded and checked against current permissions before background dispatch.

For public JMAP clients, assign a separate hostname to the ingress Worker and set `MAIL_CLIENT_ORIGIN` on the web Worker to that HTTPS origin. Issue scoped, expiring credentials from **Client access**. The web Worker's `/internal/*` routes are never public; the bounded ingress reaches client handling through the private credential object.

For asynchronous delivery events, configure Cloudflare's Email Sending event subscription to the generated delivery queue, and put its identifiers in `MAIL_DELIVERY_EVENT_SUBSCRIPTION_IDS` on the web Worker. See the existing Mail delivery-event contract for the accepted provider envelope. Background browser notifications use actor-scoped VAPID keys generated by Mail, JMAP PushSubscription verification and encrypted Web Push. The generated configuration sets allowed browser push origins and the contact subject; users opt in from Notifications settings and renew their device subscription periodically. No shared VAPID secret is required. These optional integrations are not prerequisites for the web app or domain setup.

## Verification and boundaries

The standalone web and ingress Workers have no Core service binding. `MAIL_AUTHORITY` resolves to Mail's private authority Durable Object; existing stack installations fall back to their Core service. Browser admission is supplied only after verified authentication by the standalone composition root. Background account, client credential and push checks use the same authority interface without browser identity headers.

New accounts, grants and lease renewals use Mail-owned durable commands with operation receipts; grant updates and domain changes require current revisions. Stored account content remains in the existing Mail account objects and R2 format. No public MCP server is added: product MCP stays available through Core only in an integrated installation.

Run `npx tsc --noEmit -p apps/mail/tsconfig.json`, `npx vitest run tests/mail-*.test.ts`, and `npm run check:architecture` for local checks.
