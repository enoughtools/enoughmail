# EnoughMail Apple clients

The iOS/iPadOS and macOS apps connect to a user-selected EnoughMail HTTPS origin.
They present the deployment's current Mail UI in an isolated WebKit store and use
the system authentication browser for Cloudflare Access sign-in.

## Build

Generate the project with `xcodegen generate --spec apps/mail/native/project.yml`.
Open `EnoughMail.xcodeproj` and select `EnoughMail-iOS` or `EnoughMail-macOS`.
iOS requires iOS 17; macOS requires macOS 14. Distribution uses the same
`tools.enough.mail` bundle identifier on both platforms. Set your signing team,
distribution profiles, and build number in `project.yml` before archiving.
No signing credentials belong in this directory.

## Enable a deployment

Deploy `auth/worker.ts` as a separate bounded Worker, with:

- `DEPLOYMENT_ORIGIN`: the exact HTTPS origin entered in the app.
- `AUTH_PROVIDER=cloudflare-access`, `ACCESS_TEAM_DOMAIN`, and the existing private
  Mail application's `ACCESS_AUDIENCE`.
- `MAIL`: a service binding to the deployment's Mail Worker.
- `CODES`: the `MailNativeCodes` SQLite Durable Object, initialized with a migration.
- A route for `<host>/apps/mail/native/*`; disable public workers.dev and previews.

Retain the deployment's verified identity policy for Mail and native login.
The two public handshake paths are exactly `/apps/mail/native/configuration` and
`/apps/mail/native/exchange`. Configuration returns connection metadata. Exchange
requires a random, single-use code issued after verified identity and current Mail
admission, plus its private PKCE proof, within 60 seconds. Do not bypass Access
for `/apps/mail/`, `/apps/mail/api/session`, or `/apps/mail/native/login`.

The protocol advertises fixed product-owned paths and the fixed callback
`enoughmail-workspace://authentication/callback`. The app checks origin, state,
callback, configuration and the live session before persisting a credential or
showing Mail. Passwords remain in the system sign-in browser. Credentials live
in this app's device-only Keychain; recovery data is scoped by deployment,
actor, organization and workspace. Sign-out clears the current local store.

## Validation

The macOS menu integration uses the Mail-owned `window.enoughMailNative` version-1
command surface. The page publishes enabled command names through the
`enoughMailCommands` WebKit message handler. Native accepts only the current
verified deployment's main Mail document and the fixed command whitelist; Mail's
existing handlers retain draft guards and mutation authority. Older deployments
without the bridge leave these menu commands disabled. No content or credentials
are sent through this bridge. The precise web integration proposal is recorded in
`output/ux-taste-stack/mail-native/web-command-proposal.md`.

Run `npm run typecheck`, `npm run check:architecture`, and the Mail native-auth
tests. `tests/DeploymentChecks.swift` can be compiled with `Apple/Deployment.swift`
for domain, protocol and proof checks. Archive both Apple schemes, including the
universal macOS target. Use opaque RGB app icons for Apple upload validation.

Release evidence and the independent UX audit for the October 2026 private
TestFlight release are under `output/mail-native-release/`. This client is a
native authenticated shell around Mail's deployed UI. The iOS client supports
Apple push notifications when its deployment supplies scoped APNs provider keys;
a complete offline mailbox is not provided.

## Apple push notifications

Enable Push Notifications for `tools.enough.mail` and regenerate its signing
profiles. iOS reads the installed profile's `aps-environment`; App Store installs
use production. Device registration and notification permission run only from
Mail's Notifications settings. The bridge accepts only the active main Mail
frame at the selected verified deployment.

Mail's existing authenticated `PushSubscription/set` accepts an `apns` device
with `deviceToken` and `environment`, exclusively for `EmailDelivery`. The
product-owned registry retains its command receipts, revision fence, current
workspace/account authorization checks and 30-day upper lifetime bound. Apple
receives only a generic alert, deployment origin and setup challenge; account
identifiers, sender names, content and mail state are omitted. A device must
receive and acknowledge Apple's challenge before new-mail alerts or provider
tests are enabled. Invalid/unregistered tokens are erased; transient failures
back off. Turning off or using the in-app disconnect controls removes the
actor's matching subscription before stopping local registration.

Worker configuration: `MAIL_APNS_ORIGIN` is the exact deployment HTTPS origin;
`MAIL_APNS_TEAM_ID` is the Apple team. For topic-specific Apple keys use separate
`MAIL_APNS_SANDBOX_KEY_ID`/`MAIL_APNS_SANDBOX_PRIVATE_KEY` and
`MAIL_APNS_KEY_ID`/`MAIL_APNS_PRIVATE_KEY` bindings for development and production.
Private keys belong in Worker secrets, never client assets or source control.
Both keys must be restricted to the app's topic. Production Workers negotiate
APNs transport; local workerd transport is not equivalent. A passing build or
local notification does not prove APNs delivery: validate a real provider
challenge, server test, and incoming inbox-mail notification on an Apple device.



## Persistent installed-app sign-in

The updated native client requests a device grant after the existing browser and
PKCE sign-in. It keeps that opaque grant in the device Keychain until sign-out;
the browser Access cookie continues to use its existing lifetime. A still-valid
saved cookie can be upgraded without opening the browser. An already expired
cookie needs one more sign-in to establish the device grant.

The native-auth Worker stores only the grant digest and verified identity. Every
app request checks current Mail admission and its exact actor, organization and
workspace before using the private `NativeMail` service-binding entrypoint.
The normal public Mail entrypoint still requires Cloudflare Access. The native
route stays on the original origin and identity-scoped WebKit store, preserving
local draft storage. Keychain updates preserve the prior record on a write error.
Sign-out clears local storage and attempts server revocation of that device grant.

Deployment requires the `NATIVE_MAIL` service binding to `NativeMail`, the
`MailNativeSessions` Durable Object migration, and Access routing for exactly:

- `/apps/mail/native/app/*`: the opaque device grant guards the app and APIs.
- `/apps/mail/native/upgrade`: a current, verified Access cookie can mint a grant.
- `/apps/mail/native/revoke`: the current device grant can revoke itself.

These routes use the native-auth Worker rather than Access-cookie admission.
`/apps/mail/native/login` and the normal web app retain their Access policy.
Older installed clients keep the original handoff until updated.
