# Connect a domain with existing mail delivery

EnoughMail can adopt a Cloudflare domain that already has MX records or Email Routing rules. This changes future delivery; it does not import messages from the previous provider.

## Review before switching

Open **Domains** in settings, add or select the domain, then choose **Review setup**. The review shows the exact DNS records to add, update or remove, the current catch-all destination, and recipient routes that would be disabled. Download the review before applying it.

Existing MX records that already match Cloudflare's required values are preserved, including protected matching records. Unrelated DNS records remain outside the setup changes. Conflicting protected records block setup: review their Email Routing DNS settings in Cloudflare, resolve the protection or conflict there, then refresh the review. EnoughMail does not automatically unlock records.

Applying requires acknowledgment of the displayed changes. EnoughMail checks the current provider configuration against that review again. If it changed, obtain a fresh review before proceeding.

## Assign recipients to inboxes

Domain setup is shared across the inboxes you can manage. Use **Email addresses**, with the intended inbox selected, to add or move addresses. To use an existing domain in another inbox, choose **Use a domain from another inbox** there.

If all addresses at a domain should be accepted, enable **Unmatched-address delivery** for its destination inbox. Otherwise, recipients without an enabled address assignment are rejected. Review these assignments before switching delivery.

## Apply and verify

EnoughMail saves recovery evidence before provider changes, applies the reviewed DNS changes, and verifies DNS and sending. Existing forwarding routes stay active while those checks are pending. After verification and address registration succeed, it disables the reviewed recipient routes and switches the catch-all to EnoughMail's ingress Worker. It then checks the final DNS and receiving route.

DNS propagation or a provider failure can leave setup pending. DNS changes can affect delivery during propagation even while the old forwarding routes remain enabled. The setup status identifies the operation and available Cloudflare error codes; refresh the review to inspect the current configuration before continuing.

## Recover an interrupted setup

**Previous setup backup** remains available after an interrupted attempt. Continuing an incomplete setup retains the original backup across retries, alongside the progress recorded for later attempts. Download it for manual recovery.

EnoughMail does not automatically roll back changes or blindly repeat an uncertain mutation. Compare the backup with the current DNS and routing configuration in Cloudflare before restoring anything; another administrator may have made changes since the original review.
