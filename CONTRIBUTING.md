# Contributing to EnoughMail

Issues and pull requests are welcome. For a substantial feature, open an issue describing the user problem and proposed scope before implementing it. Report security issues privately as described in SECURITY.md.

## Local setup

Use Node 22.14 or newer. Run `npm ci`, then `npm run demo` for the populated, synthetic UI fixture. Run `npm run check` before submitting changes. Changes to imports, dependencies or shared contracts must also pass `npm run check:architecture`.

Mail owns its domain schemas, business rules, revisions, receipts and migrations. Browser entry points must never reach server credentials, persistence or authorization through transitive imports. Do not introduce dependencies on other Enough product runtimes. Keep admission and resource permissions explicit; retries of mutations must preserve operation IDs and revision preconditions.

## Pull requests

Explain the problem, resulting behavior and relevant verification. Include synthetic screenshots for visible interface changes. Add meaningful regression coverage for changed behavior, especially sending, authorization, MIME handling and data recovery. Avoid tests that only repeat implementation details.

Never commit real mail, addresses, personal screenshots, tokens, local configuration, deployment logs or provider account identifiers. Use reserved `.test` domains in fixtures. Preserve stored mail and backward compatibility when changing schemas; explain migration and recovery behavior.

Keep changes focused and use clear commit messages. Maintainers review contributions; opening a PR does not imply immediate inclusion. By submitting a contribution, you agree it may be distributed under this repository's MIT license.
