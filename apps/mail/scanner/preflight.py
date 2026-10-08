"""Bound MIME and supported archive expansion before ClamAV can certify a scan."""
import bz2
import gzip
import io
import lzma
import tarfile
import time
import zipfile
from email import policy
from email.parser import BytesParser

MAX_FILE = 25 * 1024 * 1024
MAX_RAW = 64 * 1024 * 1024
MAX_EXPANDED = 100 * 1024 * 1024
MAX_ENTRIES = 1000
MAX_DEPTH = 5


class Budget:
    def __init__(self):
        self.expanded = 0
        self.entries = 0
        self.deadline = time.monotonic() + 10

    def check(self, depth):
        if depth > MAX_DEPTH or time.monotonic() > self.deadline:
            raise ValueError("scanLimitExceeded")

    def entry(self):
        self.entries += 1
        if self.entries > MAX_ENTRIES:
            raise ValueError("scanLimitExceeded")

    def read(self, stream):
        chunks = []
        size = 0
        while True:
            self.check(0)
            chunk = stream.read(65536)
            if not chunk:
                break
            size += len(chunk)
            self.expanded += len(chunk)
            if size > MAX_FILE or self.expanded > MAX_EXPANDED:
                raise ValueError("scanLimitExceeded")
            chunks.append(chunk)
        return b"".join(chunks)


def archive(data, budget, depth=0, declared=""):
    budget.check(depth)
    # These formats have no bounded extractor in this adapter; never imply full inspection.
    if data.startswith((b"Rar!\x1a\x07", b"7z\xbc\xaf\x27\x1c")) or declared in {"rar", "7z", "iso", "img"}:
        raise ValueError("unsupportedArchive")
    if data.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
        with zipfile.ZipFile(io.BytesIO(data)) as zipped:
            for member in zipped.infolist():
                budget.entry()
                if member.flag_bits & 1 or member.file_size > MAX_FILE or member.file_size + budget.expanded > MAX_EXPANDED:
                    raise ValueError("scanLimitExceeded")
                if not member.is_dir():
                    with zipped.open(member) as source:
                        archive(budget.read(source), budget, depth + 1, member.filename.rsplit(".", 1)[-1].lower())
        return
    compressed = None
    if data.startswith(b"\x1f\x8b"):
        compressed = gzip.GzipFile(fileobj=io.BytesIO(data))
    elif data.startswith(b"BZh"):
        compressed = bz2.BZ2File(io.BytesIO(data))
    elif data.startswith(b"\xfd7zXZ\x00"):
        compressed = lzma.LZMAFile(io.BytesIO(data))
    if compressed:
        budget.entry()
        with compressed:
            archive(budget.read(compressed), budget, depth + 1)
        return
    if data[257:262] == b"ustar" or declared == "tar":
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as tar:
            for member in tar:
                budget.entry()
                if member.size > MAX_FILE or member.size + budget.expanded > MAX_EXPANDED:
                    raise ValueError("scanLimitExceeded")
                if member.isfile():
                    with tar.extractfile(member) as source:
                        archive(budget.read(source), budget, depth + 1, member.name.rsplit(".", 1)[-1].lower())
        return
    if declared in {"zip", "gz", "bz2", "xz", "tgz"}:
        raise ValueError("invalidArchive")


def preflight(data):
    if len(data) > MAX_RAW:
        raise ValueError("messageTooLarge")
    budget = Budget()
    archive(data, budget)
    message = BytesParser(policy=policy.default).parsebytes(data)

    def walk(part, depth):
        budget.check(depth)
        budget.entry()
        if part.defects:
            raise ValueError("invalidMime")
        if part.is_multipart():
            for child in part.get_payload():
                walk(child, depth + 1)
        else:
            payload = part.get_payload(decode=True) or b""
            if part.defects or len(payload) > MAX_FILE:
                raise ValueError("invalidMime")
            name = part.get_filename() or ""
            archive(payload, budget, 0, name.rsplit(".", 1)[-1].lower())
    # A raw archive isn't itself a MIME message. Do not reinterpret its binary body.
    if not data.startswith((b"PK", b"\x1f\x8b", b"BZh", b"\xfd7zXZ")):
        walk(message, 0)
