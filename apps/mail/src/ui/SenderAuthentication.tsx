/**
 * Imported and forwarded headers are message content, not authentication proof.
 * Display a positive result only after ingress exposes separate provider-verified
 * provenance; the current Email contract does not contain that evidence.
 */
export default function SenderAuthentication() {
  return <div className="mail-sender-authentication">
    <strong>Sender verification details unavailable</strong>
    <p>Enough Mail has no trusted SPF, DKIM or DMARC results for this message. This does not mean authentication failed; the sender’s identity is unconfirmed.</p>
  </div>;
}
