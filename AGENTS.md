# EnoughMail ownership

Read architecture.config.json and run npm run check:architecture when changing imports, dependencies, shared contracts or ownership. Mail owns its domain schemas, business rules, UI, command validation, revisions, receipts and domain migrations. Consume public platform interfaces; do not import another product runtime. Browser entry points must not reach credentials, server persistence or authorization through transitive imports.

Mutations require product-owned idempotent commands and explicit revision preconditions. Preserve existing work and historical persisted state during migration. Keep public ingress bounded to the recipient, resource and action it authorizes. The private app and scanner stay behind verified identity. Never commit private mail or credentials. Public screenshots use the demo's fictional .test data.
