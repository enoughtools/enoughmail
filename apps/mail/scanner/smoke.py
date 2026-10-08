"""Real-engine smoke test against the locally built Container (no mocked verdicts)."""
import base64
import hashlib
import io
import json
import sys
import time
import urllib.error
import urllib.request
import zipfile
from email.message import EmailMessage
from email.policy import SMTP

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18080"


def request(path, body=None, digest=None):
    headers = {} if body is None else {"Content-Type": "message/rfc822", "X-Mail-SHA256": digest or hashlib.sha256(body).hexdigest()}
    try:
        response = urllib.request.urlopen(urllib.request.Request(BASE + path, data=body, headers=headers), timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    return response.status, json.loads(response.read())


deadline = time.monotonic() + 300
while True:
    try:
        code, health = request("/health")
        if code == 200:
            break
    except (OSError, ValueError):
        pass
    if time.monotonic() > deadline:
        raise RuntimeError("scanner did not become ready with fresh loaded signatures")
    time.sleep(2)
print("fresh signature readiness:", health, flush=True)

clean = b"From: sender@example.com\r\nTo: recipient@example.com\r\n\r\nHello.\r\n"
code, receipt = request("/scan", clean)
assert code == 200 and receipt["status"] == "clean" and receipt["complete"] is True
assert receipt["sha256"] == hashlib.sha256(clean).hexdigest() and receipt["size"] == len(clean)
print("clean MIME: passed", flush=True)

large = EmailMessage()
large.set_content("Decoded attachment capacity test.")
large.add_attachment(b"0" * (25 * 1024 * 1024), maintype="application", subtype="octet-stream", filename="large.bin")
large_mime = large.as_bytes(policy=SMTP)
assert len(large_mime) > 34 * 1024 * 1024
code, receipt = request("/scan", large_mime)
assert code == 200 and receipt["status"] == "clean" and receipt["size"] == len(large_mime), (code, receipt)
print("25 MiB decoded attachment in", len(large_mime), "MIME bytes: passed", flush=True)
del large_mime, large

incoming = EmailMessage()
incoming.set_content("Large incoming/import capacity test.")
for number in range(2):
    incoming.add_attachment(b"0" * (20 * 1024 * 1024), maintype="application", subtype="octet-stream", filename=f"part-{number}.bin")
incoming_mime = incoming.as_bytes(policy=SMTP)
assert len(incoming_mime) >= 50 * 1024 * 1024
code, receipt = request("/scan", incoming_mime)
assert code == 200 and receipt["status"] == "clean" and receipt["size"] == len(incoming_mime), (code, receipt)
print("incoming/import raw MIME capacity", len(incoming_mime), "bytes: passed", flush=True)
del incoming_mime, incoming

message = EmailMessage()
message["From"] = "sender@example.com"
message["To"] = "recipient@example.com"
message.set_content("Harmless standard antivirus test attachment.")
eicar = base64.b64decode("WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=")
message.add_attachment(eicar, maintype="application", subtype="octet-stream", filename="eicar.com")
code, receipt = request("/scan", message.as_bytes())
assert code == 200 and receipt["status"] == "infected" and receipt["threats"]
print("base64 MIME EICAR detection:", receipt["threats"], flush=True)

archive = io.BytesIO()
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zipped:
    zipped.writestr("large.txt", b"0" * (101 * 1024 * 1024))
message = EmailMessage()
message.set_content("Expansion limit test.")
message.add_attachment(archive.getvalue(), maintype="application", subtype="zip", filename="large.zip")
code, receipt = request("/scan", message.as_bytes())
assert code == 503 and receipt["complete"] is False
print("archive expansion limit quarantines: passed", flush=True)

code, receipt = request("/scan", clean, "0" * 64)
assert code == 409 and receipt["complete"] is False
print("mismatched digest cannot certify clean: passed", flush=True)
