# Local UI demo

Run `npm run demo` from the repository root and open http://127.0.0.1:5198. This uses the real Mail components with fictional `.test` accounts. The fixture intercepts network requests and completes actions locally; it is not a backend or integration test.

Use `?screen=Inbox&state=populated&controls=hidden` for the inbox and `?screen=Inbox&state=thread&controls=hidden` for a conversation. Open a message or select Compose from these views to capture the complete app shell, including its compact settings, apps and account controls. `?screen=Compose&state=populated&controls=hidden` is an isolated composer example.

The inbox, conversation and compose images in `docs/screenshots/` were captured from the complete app on 2026-10-08. They show a single EnoughMail brand and the shared controls embedded beside search. Never replace fixtures with private mail for public screenshots.
