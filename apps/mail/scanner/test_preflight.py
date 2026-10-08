import io
import unittest
import zipfile
from email.message import EmailMessage
from preflight import preflight


def zipped(payload, name="file.txt"):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, payload)
    return output.getvalue()


class PreflightTests(unittest.TestCase):
    def test_clean_mime_and_small_zip_are_supported(self):
        preflight(b"From: sender@example.com\r\n\r\nHello.")
        preflight(zipped(b"hello"))

    def test_oversized_member_inside_base64_mime_cannot_certify_clean(self):
        message = EmailMessage()
        message.set_content("Attachment.")
        message.add_attachment(zipped(b"0" * (26 * 1024 * 1024)), maintype="application", subtype="zip", filename="large.zip")
        with self.assertRaises(ValueError):
            preflight(message.as_bytes())

    def test_nested_archives_exceeding_depth_are_rejected(self):
        payload = b"hello"
        for _ in range(7):
            payload = zipped(payload, "nested.zip" if payload.startswith(b"PK") else "file.txt")
        with self.assertRaises(ValueError):
            preflight(payload)

    def test_entry_bound_applies_to_archive_members(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            for number in range(1001):
                archive.writestr(str(number), b"")
        with self.assertRaises(ValueError):
            preflight(output.getvalue())

    def test_unbounded_archive_formats_and_invalid_claimed_zip_fail_closed(self):
        for payload, filename in [(b"Rar!\x1a\x07\0", "archive.rar"), (b"fake archive", "archive.zip")]:
            message = EmailMessage()
            message.set_content("Attachment.")
            message.add_attachment(payload, maintype="application", subtype="octet-stream", filename=filename)
            with self.assertRaises(ValueError):
                preflight(message.as_bytes())


if __name__ == "__main__":
    unittest.main()
