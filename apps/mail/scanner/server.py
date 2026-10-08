"""Private HTTP-to-ClamD adapter; raw MIME never leaves this Cloudflare Container."""
import datetime
import hashlib
import http.server
import json
import re
import socket
import struct
import threading
from preflight import preflight

LIMITS = {"maxBytes": 64 * 1024 * 1024, "maxExpandedBytes": 100 * 1024 * 1024, "maxDepth": 5, "maxEntries": 1000}
SOCKET_PATH = "/run/clamav/clamd.sock"
CAPACITY = threading.BoundedSemaphore(1)
MAX_SIGNATURE_AGE = datetime.timedelta(hours=72)


def reply(sock):
    data = bytearray()
    while len(data) <= 4096:
        chunk = sock.recv(4096 - len(data) + 1)
        if not chunk:
            raise RuntimeError("incompleteClamdReply")
        data.extend(chunk)
        if b"\0" in data:
            return bytes(data).split(b"\0", 1)[0].decode("utf-8", errors="strict")
    raise RuntimeError("clamdReplyTooLarge")


def connection():
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.connect(SOCKET_PATH)
    return sock


def version():
    with connection() as sock:
        sock.sendall(b"zVERSION\0")
        raw = reply(sock)
    parts = raw.split("/", 2)
    if len(parts) != 3 or not parts[0].startswith("ClamAV ") or not parts[1].isdigit():
        raise RuntimeError("invalidClamdVersion")
    issued = datetime.datetime.strptime(parts[2], "%a %b %d %H:%M:%S %Y").replace(tzinfo=datetime.timezone.utc)
    age = datetime.datetime.now(datetime.timezone.utc) - issued
    if age < -datetime.timedelta(hours=1) or age > MAX_SIGNATURE_AGE:
        raise RuntimeError("staleScannerSignatures")
    return parts[0], parts[1] + "/" + issued.isoformat()


def verdict(raw):
    if raw == "stream: OK":
        return "clean", []
    match = re.fullmatch(r"stream: (.{1,256}) FOUND", raw)
    if not match:
        raise RuntimeError("scannerIncomplete")
    threat = match.group(1)
    # These are scan limitations, not claims that the input contains malware.
    if threat.startswith(("Heuristics.Limits.Exceeded", "Heuristics.Encrypted")):
        raise RuntimeError("scannerIncomplete")
    return "infected", [threat]


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_args):
        # Never log mail contents, envelope addresses, or potentially private filenames.
        pass

    def send_json(self, code, value):
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):
        if self.path != "/health":
            return self.send_json(404, {"error": "notFound"})
        try:
            engine, signature = version()
            return self.send_json(200, {"ready": True, "engine": engine, "signatureVersion": signature})
        except Exception:
            return self.send_json(503, {"ready": False})

    def do_POST(self):
        if self.path != "/scan":
            return self.send_json(404, {"error": "notFound"})
        length = self.headers.get("Content-Length", "")
        expected = self.headers.get("X-Mail-SHA256", "")
        if not length.isdigit() or self.headers.get("Transfer-Encoding"):
            return self.send_json(411, {"error": "lengthRequired"})
        size = int(length)
        if size > LIMITS["maxBytes"]:
            return self.send_json(413, {"error": "messageTooLarge"})
        if not re.fullmatch(r"[a-f0-9]{64}", expected):
            return self.send_json(400, {"error": "digestRequired"})
        if not CAPACITY.acquire(blocking=False):
            return self.send_json(429, {"error": "scannerBusy"})
        try:
            engine, signature = version()
            sha = hashlib.sha256()
            remaining = size
            chunks = []
            with connection() as sock:
                sock.sendall(b"zINSTREAM\0")
                while remaining:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        raise RuntimeError("truncatedMessage")
                    sha.update(chunk)
                    chunks.append(chunk)
                    remaining -= len(chunk)
                    sock.sendall(struct.pack("!I", len(chunk)) + chunk)
                sock.sendall(struct.pack("!I", 0))
                raw = reply(sock)
            if sha.hexdigest() != expected:
                return self.send_json(409, {"error": "digestMismatch", "complete": False})
            # ClamAV may silently skip oversized archive members. Independent bounded
            # extraction is required before an OK can mean complete inspection.
            preflight(b"".join(chunks))
            status, threats = verdict(raw)
            if version() != (engine, signature):
                raise RuntimeError("signaturesChangedDuringScan")
            return self.send_json(200, {"status": status, "verdict": status, "complete": True,
                                       "sha256": sha.hexdigest(), "size": size, "engine": engine,
                                       "signatureVersion": signature, "limits": LIMITS, "threats": threats})
        except Exception:
            return self.send_json(503, {"error": "scannerUnavailable", "complete": False})
        finally:
            CAPACITY.release()


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    server.daemon_threads = True
    server.serve_forever()
