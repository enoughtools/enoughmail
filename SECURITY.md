# Security policy

EnoughMail is a self-hosted beta. Keep your deployment updated, restrict Cloudflare API tokens to the necessary accounts and zones, and protect every app path with Cloudflare Access. The app also verifies Access JWTs. Never expose the internal Worker or scanner as a public application.

## Report privately

Use the repository's **Security → Report a vulnerability** feature on GitHub. Do not open a public issue containing exploit details, private mail or credentials. Include affected revision, reproduction steps, expected behavior and impact. Use synthetic messages. Maintainers will coordinate disclosure and remediation through that report; no response-time guarantee is offered.

Only the current main branch is supported during beta. Updates must preserve stored mail; review deployment and migration notes before upgrading.
