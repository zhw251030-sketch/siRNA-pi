"""Offline tests with temporary dummy credentials; never read docs/auth.json."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("controller_entrypoint", ROOT / "containers/agent-compose/entrypoint.py")
ENTRY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ENTRY)


class CredentialTests(unittest.TestCase):
    def setUp(self):
        base = ROOT / "runtime/credential-tests"
        base.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=base)
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "dummy-key"

    def write(self, content):
        self.path.write_bytes(content)
        self.path.chmod(0o600)

    def test_one_line_with_optional_newline(self):
        for content in (b"dummy-private-value", b"dummy-private-value\n", b"dummy-private-value\r\n"):
            self.write(content)
            self.assertEqual(ENTRY.read_key(self.path), "dummy-private-value")

    def test_rejects_invalid_content_without_echoing_it(self):
        for content in (b"", b"secret value", b"secret\nsecond", b" secret", b"secret\x00", b"a" * 4097, b"\xff"):
            self.write(content)
            with self.assertRaises(ValueError) as caught:
                ENTRY.read_key(self.path)
            self.assertEqual(str(caught.exception), "Invalid credential file")

    @unittest.skipIf(os.name == "nt", "Linux mount permissions are checked on the target server")
    def test_rejects_world_readable_file(self):
        self.write(b"dummy-private-value")
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            ENTRY.read_key(self.path)

    @unittest.skipIf(os.name == "nt", "Linux link handling is checked on the target server")
    def test_rejects_symlink_and_hardlink(self):
        self.write(b"dummy-private-value")
        link = self.path.with_name("link")
        link.symlink_to(self.path)
        with self.assertRaises(ValueError):
            ENTRY.read_key(link)
        link.unlink()
        os.link(self.path, link)
        with self.assertRaises(ValueError):
            ENTRY.read_key(self.path)


if __name__ == "__main__":
    unittest.main()
