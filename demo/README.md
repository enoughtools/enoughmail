# Local UI demo

Run `npm run demo` from the repository root and open http://127.0.0.1:5198. This uses the real Mail components with fictional `.test` accounts. The fixture intercepts network requests and completes actions locally; it is not a backend or integration test.

Use `?screen=Inbox&state=populated&controls=hidden` for the inbox, `?screen=Inbox&state=thread&controls=hidden` for a conversation, and `?screen=Compose&state=populated&controls=hidden` for a draft. Never replace fixtures with private mail for public screenshots.
