# EnoughMail MCP: standalone tools and incoming-mail events

EnoughMail's bounded public companion exposes `POST /mcp`. The private Mail
Worker remains behind verified identity. A ChatGPT connection covers all accounts
currently accessible to its verified workspace identity, including accounts added
later, clipped to the permissions approved by its user. Existing account-specific
JMAP credentials retain their original scope. Core's existing Mail tools and this
endpoint execute the same product-owned command adapter in
`apps/mail/src/server/mcp.ts`.

## Connect ChatGPT

For a new standalone installation, add these options to the normal
`npm run mail:configure -- ...` command:

```text
--mcp-hostname mail-connect.example.com
--mcp-redirect-uri https://chatgpt.com/connector_platform_oauth_redirect
--mcp-callback-origins https://EXACT-TRUSTED-CALLBACK-HOST
```

Use your actual separate connector hostname. Copy the exact redirect URI from
ChatGPT's plugin management page; the example is its documented stable URI for
servers supporting issuer identification. Callback origins are the HTTPS
origins of the event callback URLs ChatGPT supplies, not the OAuth redirect URI.
There is intentionally no guessed callback allowlist. You can initially omit
`--mcp-callback-origins`, then configure the trusted provider origin before
subscribing. Subscription errors identify an unconfigured destination without
logging signing secrets or callback URLs.

For an existing installation, preserve its Worker names, storage and routes.
Add the following variables to both the private `mail.json` and public
`ingress.json` configuration:

```json
{
  "MAIL_MCP_PUBLIC_ORIGIN": "https://mail-connect.example.com",
  "MAIL_MCP_WORKSPACE_ORIGIN": "https://mail.example.com",
  "MAIL_MCP_CLIENT_ID": "enoughmail-chatgpt",
  "MAIL_MCP_REDIRECT_URIS": "https://chatgpt.com/connector_platform_oauth_redirect"
}
```

Add `MAIL_MCP_CALLBACK_ORIGINS` to the private Worker's variables as a
comma-separated list of exact trusted HTTPS origins. The live ChatGPT listener
registration on 8 October 2026 supplied `https://connectors.api.openai.com`;
this is distinct from the OAuth callback at `https://chatgpt.com`. Configure
the observed event callback origin for the deployment. Add a custom-domain route
for the connector hostname to the public companion. Keep Cloudflare Access on
the private workspace hostname. The public companion exposes only its existing
account-token JMAP paths, MCP, and the bounded OAuth routes; it does not expose
workspace APIs, identity admission or a Core binding.

Run `npm run mail:deploy -- --dry-run` against the selected configuration first.
Deploy through the existing standalone Mail process when ready.

In ChatGPT, add a custom MCP server with URL
`https://mail-connect.example.com/mcp`. Choose OAuth and configure the public
client ID `enoughmail-chatgpt` with no client secret. This initial integration
uses a predefined public OAuth client and S256 PKCE; it does not implement
client registration or CIMD. Allow `mail.read` for monitoring; request additional
Mail actions only when the workflow needs them. The linking flow redirects to
the private Mail workspace, where the user signs in and explicitly approves the
listed permissions for all accessible accounts. There is no account selector. Install/rescan the plugin after
connecting.

Then ask ChatGPT or your dot, for example:

> Monitor new email arriving in my EnoughMail account. Flag urgent customer
> issues, prepare reply drafts, and notify me only when I need to decide
> something. Discover my accessible accounts and confirm the events you subscribed to.

Draft preparation also requires `mail.draft`. Sending requires `mail.send` and
an explicit user instruction. Connections last at most 30 days, have no refresh
token in this version, and can be revoked in Mail's client credential settings.
Reconnect after expiry. Event subscription refresh never extends the underlying
connection or its authority.

## Protocol and behavior

The stateless JSON-RPC endpoint implements `server/discover`, `initialize`,
`ping`, `tools/list`, `tools/call`, `events/list`, `events/subscribe` and
`events/unsubscribe`. It advertises MCP 2.0 (`2026-07-28`) and retains legacy
initialization compatibility for tool-only clients. Notifications are
acknowledged without executing commands. GET streaming and JSON-RPC batches
are not supported.

Tool discovery filters the installed Mail manifest by the connection's current
permissions. DNS administration tools remain unavailable through account client
credentials because `mail.manage` alone is not verified workspace administrator
membership. Mail commands retain their bounded schemas, stable `operationId`
receipts and explicit `expectedSequence`. Convert a returned JMAP `m...` state
from base 36 to obtain the sequence. Call `mail_list_accounts` to discover current
account names, IDs and effective actions; use each exact ID as `resourceId`. JMAP command failures surface as MCP `isError` results.

The first event is `mail.email.received`:

```json
{
  "name": "mail.email.received",
  "arguments": {
    "resourceId": "MAIL-ACCOUNT-UUID",
    "from": "customer@example.com",
    "subject": "urgent",
    "mailboxId": "folder-inbox"
  },
  "delivery": {
    "mode": "webhook",
    "url": "CHATGPT-SUPPLIED-HTTPS-CALLBACK",
    "secret": "CHATGPT-SUPPLIED-whsec_-KEY"
  },
  "cursor": null
}
```

The connection is workspace-wide; event subscriptions remain account-specific.
To monitor all accounts, subscribe for each account returned by `mail_list_accounts`.
Discovering newly granted accounts needs a new list call; existing per-account
subscriptions do not automatically expand to new accounts.

Only `resourceId` is required in the filters. Sender matching is exact and case
insensitive; subject matching is a case-insensitive substring. Mailbox filtering
uses the incoming-rule result. The sender filter examines MIME `From` and is a
convenience filter, not proof of sender identity or a trusted instruction.

Accepted SMTP ingress creates the event in the same SQLite transaction as the
mail receipt. A repeated SMTP delivery receipt does not create a new event.
Draft creation, imports and later message edits do not emit arrival events.
Payloads contain only `resourceId` and `emailId`; ChatGPT reads content through
an authorized tool. Email bodies never become subscription instructions.

Subscriptions and pending deliveries survive account restarts. Creation and
refresh use a deterministic identity including the credential/version, account,
callback, event and canonical filters. Different connections remain isolated.
Callbacks are verified with a signed single-use challenge before activation.
Deliveries use Standard Webhooks HMAC signatures over the exact body bytes.
Rotated secrets overlap for five minutes. Redirects are forbidden and requests
time out after ten seconds.

Subscription lifetimes are capped at 24 hours and by the credential's remaining
lifetime. Smaller positive `ttlMs` values are respected; `ttlMs: null` receives a
finite grant. Refresh returns `refreshBefore`; unsubscribe is idempotent.
`cursor` is always null: historical replay and draft protocol control messages
are not implemented. Only events accepted while a subscription is active are
queued.

Before each delivery, Mail checks the current connection credential/version, live
workspace admission and account grants, original lease scope, expiry and lifecycle
generation. Workspace grants mint stable, bounded native leases per account;
account queues keep their own lifecycle authority. A persisted generation cache
avoids callbacks re-entering an account's serial queue. It never grants access: the
account checks its current generation locally. Losing one account grant removes
that account from discovery and blocks its deliveries, while other accounts remain
available. Revoking the workspace connection blocks all accounts and pending sends.
Suspension removes subscriptions and their queues. New account lifecycle
permission does not revive an old subscription.

Transient failures use exponential backoff, at most eight attempts, and preserve
the event ID and bytes while refreshing the signature timestamp. HTTP 410 stops
the subscription; 413 drops that oversized event without retry. Other permanent
4xx responses stop the subscription, except 408 and 429. Limits are 100 active
subscriptions per account, 1,000 queued events per subscription, and 20 attempted
events per alarm. A saturated queue stops its subscription without rejecting
incoming mail. Delivery is bounded best effort; retries can duplicate a webhook,
and terminal failure can lose an event. Recipient actions must be idempotent.

Outbound callbacks are restricted to exact operator-trusted provider origins.
Workers requires a wrapper around global `fetch` when stored as an object method.
It supports `redirect: "manual"`, not `"error"`; verification rejects non-2xx
responses and deliveries never follow redirects. These runtime requirements
were reproduced and the signed verification exchange tested in Cloudflare.
Workers fetch does not provide arbitrary destination DNS pinning; this version
uses a strict trusted-origin boundary rather than accepting arbitrary webhook
hosts. Do not add untrusted, user-controlled or dynamically rebound hosts to
that configuration. A future arbitrary-provider integration needs a transport
that validates and pins resolved public addresses.

## Core integration boundary

Core Mail tools already use the shared product executor through `/internal/mcp`.
The standalone adapter supplies workspace connection or legacy account credential
authority; Core supplies its
existing verified delegation and current grant checks. Core does not import Mail
business logic, inspect email fields or own mail content.

Event discovery/routing through Core is deferred. The Mail-owned
`MailMcpEvents` engine and account-local `/mcp-events` service implementation are
available for an adapter. A later central router must authenticate and authorize
an exact account/event/filter request, issue bounded Mail read authority, and
revalidate the originating MCP client grant/version for the subscription's whole
lifetime. A native account lease alone must not substitute for that client grant.
Any generic provider contract needs a second consumer or independent schema
proof, plus the architecture gate. Do not publish a product's `/internal/mcp`
handler or import Mail implementation into Core.

## Verification and operational checks

Tests exercise real SQLite account commands, SMTP deduplication and atomic
outbox rollback; signed callback verification; filtering; restart/retry;
expiration; unsubscribe; key rotation; revoked credentials/grants/lifecycle;
public-route isolation; OAuth PKCE, single-use codes and audience binding; dynamic
workspace account discovery, per-account permissions and global connection revocation.

Local tests and Worker dry runs cannot confirm workspace feature availability,
real ChatGPT callback origins, production identity redirects, or that ChatGPT
creates/runs a task. After deployment, verify linking, rescan events, ask ChatGPT
to subscribe, send one matching and one nonmatching email, revoke the connection,
and confirm that subsequent deliveries stop.

A live installation verified OAuth account discovery, accepted event subscriptions,
and a ChatGPT task wake-up from an incoming-email webhook without inbox polling
on 8 October 2026. The event payload arrived after the initial wake-up report;
callback receipt and task processing are asynchronous, so a wake-up alone does
not prove the payload is visible yet. Read the exact email using `mail_get_email`
with the delivered `resourceId` and `emailId` to obtain its sender and subject.

Official references:

- https://developers.openai.com/plugins/build/mcp-events
- https://developers.openai.com/plugins/build/auth
- https://learn.chatgpt.com/docs/dots/tasks-and-memory
