# Installed Apple client

The browser-authenticated Apple client is in `apps/mail/native`. It is a separate
implementation from the account/token-based `enoughmail-device` repository.
Its current release is 1.0, build 2026.11.6.

The installed client retains a device grant in its device-only Keychain. The
native-auth Worker checks the saved identity and current Mail admission on every
request, then uses the private `NativeMail` service-binding entrypoint. Ordinary
web requests still require Cloudflare Access. Signing out revokes the native
grant and clears the current local session; temporary provider failures retain
credentials for retry. See the native README for browser/PKCE setup and Access
routing, and `wrangler.native-auth.toml.example` for binding/migration names.
Never deploy a generic template over an installation's live configuration.

Foundation removes a trailing slash from `URL.path`. The native navigation guard
therefore admits both `/apps/mail/native/app` and its descendants. Rejecting the
root leaves a visible but empty `about:blank` view after successful sign-in.
The iPhone shell fills the display and the Mail UI applies safe-area insets.

HTML email presentation tables retain newsletter layout. Only semantic or
repeated multi-column data tables get the horizontally scrollable data-table
wrapper. Tests use fictional content; private mail and production screenshots
must not be committed.

## Installation source provenance

The installed-app fix was deployed and verified against retained installation
source recovered from EnoughCloud commit
`cb7ba4d27f29c8ab3f767a99329de1f172f620b5`. Its baseline server build matched the
running installation byte for byte. That installation has additional Mail
features beyond this standalone checkout. This change ports the native client,
private entrypoint and reader fixes without replacing the standalone checkout's
existing MCP/webhook work. A checkout of this branch is consequently not a
byte-for-byte reproduction of that installation. Keep its retained source and
bindings when rebuilding or deploying it until those baselines are reconciled.

Validation included Swift URL-policy checks, live native inbox/message rendering
on the linked macOS VM's iOS simulator, a cold relaunch from the actual Keychain
without a fixture, native grant issue/revocation/admission checks, and newsletter
rendering at phone and desktop widths. A simulator push test is not evidence of
real-device APNs delivery.
