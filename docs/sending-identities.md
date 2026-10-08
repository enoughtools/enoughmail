# Sending addresses and catch-all replies

The compose **From** field lets you select a saved address or enter another address on a verified, enabled sending domain available to the current inbox. Typing an address does not create or reserve it. EnoughMail confirms the address before submitting the message; if confirmation fails, the message is not submitted and draft content is retained.

Exact addresses belong to an inbox. An address already assigned to another inbox is unavailable, even when you manage both inboxes. Move it through **Email addresses** before using it elsewhere. Disabled addresses and addresses being transferred are also unavailable. Catch-all delivery does not override an exact address assignment.

When replying to catch-all mail, EnoughMail defaults to the actual address that received the message. For example, a message delivered to `orders@example.test` gets `orders@example.test` as the reply's From address. This recipient comes from the trusted receiving transport, rather than sender-supplied `Delivered-To` or `X-Original-To` headers.

Older messages may not have a recorded transport recipient. EnoughMail then selects a From address only if To and Cc contain one unambiguous saved address or address on a supported sending domain. Otherwise, choose the address yourself. Reopening a draft preserves your own From choice, including an incomplete address, instead of replacing it with a reply default.

## JMAP extension

These fields and the address-resolution command are EnoughMail extensions. Include `urn:enough:params:jmap:mail` in the request's `using` capabilities.

### Email fields

- `deliveryRecipient` is a read-only string recorded by trusted mail ingress. It may be absent on historical or imported messages. Clients cannot set it through `Email/set`, and it is not inferred from MIME headers.
- `draftFrom` is an optional string for the pending From input on an editable draft. It can contain an incomplete address so autosave does not depend on successful address resolution. It does not authorize sending or replace a confirmed Identity.

### Identity/resolve

`Identity/resolve` confirms a complete address for the current inbox and returns its verified Identity. If the address is unclaimed, it reserves that exact address for the inbox and creates an Identity. An existing active, verified Identity in the same inbox is reused without changing its name or signatures. The command requires `mail.send`; it does not require permission to manage all identities or domains.

Arguments:

| Field | Meaning |
| --- | --- |
| `accountId` | Inbox account to send from. |
| `email` | One complete email address on an enabled, verified and approved sending domain. |
| `name` | Optional display name for a newly created Identity. |
| `ifInState` | Current state from `Identity/get`. |
| `operationId` | UUID for this exact resolution attempt. Reuse it, with the same arguments, when retrying an uncertain request. |

Example method call:

```json
[
  "Identity/resolve",
  {
    "accountId": "inbox-example",
    "email": "orders@example.test",
    "name": "Example Shop",
    "ifInState": "CURRENT_IDENTITY_STATE",
    "operationId": "cf4d5c1a-56a5-473a-a460-ae16c9c35965"
  },
  "resolve-sender"
]
```

The successful result contains `accountId`, `oldState`, `newState` and `identity`. Reusing an existing Identity leaves `oldState` and `newState` equal. Use the returned Identity's `id` as `identityId` in the normal `EmailSubmission/set` request. Resolution alone does not send a message.

An unavailable or claimed address returns `forbidden`; malformed arguments return `invalidArguments`; a stale revision returns `stateMismatch`. Without the EnoughMail capability, the method returns `unknownMethod`. Do not silently substitute a different From address after a failure. Sending still rechecks current domain approval and address ownership, including for scheduled messages.
