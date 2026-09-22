import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import recover


class RestorePublicationTests(unittest.TestCase):
    def setUp(self):
        scratch = os.environ.get("CLAUDE_RECOVERY_TEST_TMPDIR")
        if scratch:
            Path(scratch).mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(dir=scratch)
        self.root = Path(self.temp_dir.name)
        self.user_dir = self.root / "desktop"
        self.user_dir.mkdir()
        self.source = self.root / "source.jsonl"
        self.source.write_text("{}\n", encoding="utf-8")
        self.session = {
            "id": "22222222-2222-2222-2222-222222222222",
            "project": "fixture",
            "preview": "restore target",
            "filepath": str(self.source),
            "work_dir": str(self.root),
        }
        self.args = SimpleNamespace(project=None, dry_run=False)

    def tearDown(self):
        self.temp_dir.cleanup()

    def run_restore(self):
        with mock.patch.object(recover, "scan_sessions", return_value=[self.session]), mock.patch.object(
            recover,
            "find_desktop_sessions_dir",
            return_value=(self.user_dir.parent, self.user_dir),
        ):
            recover.cmd_restore(self.args, self.root)

    def assert_no_incomplete_files(self):
        self.assertEqual([], list(self.user_dir.glob("*.incomplete")))
        self.assertEqual([], list(self.user_dir.glob(".*.incomplete")))

    def test_collision_preserves_sentinel_then_rerun_is_idempotent(self):
        fixed = uuid.UUID("11111111-1111-1111-1111-111111111111")
        new = uuid.UUID("33333333-3333-3333-3333-333333333333")
        sentinel = self.user_dir / f"local_{fixed}.json"
        sentinel.write_bytes(
            json.dumps(
                {
                    "sessionId": f"local_{fixed}",
                    "cliSessionId": "existing-session",
                    "title": "KEEP ME",
                },
                sort_keys=True,
            ).encode("utf-8")
        )
        sentinel_bytes = sentinel.read_bytes()

        with mock.patch.object(recover.uuid_mod, "uuid4", side_effect=[fixed, new]):
            self.run_restore()

        self.assertEqual(sentinel_bytes, sentinel.read_bytes())
        created = self.user_dir / f"local_{new}.json"
        self.assertEqual(self.session["id"], json.loads(created.read_text(encoding="utf-8"))["cliSessionId"])
        self.assertEqual(2, len(list(self.user_dir.glob("local_*.json"))))
        self.assert_no_incomplete_files()

        with mock.patch.object(recover.uuid_mod, "uuid4") as uuid4_mock:
            self.run_restore()
            uuid4_mock.assert_not_called()
        self.assertEqual(2, len(list(self.user_dir.glob("local_*.json"))))

    def test_serialization_failure_leaves_no_registration_or_incomplete_file(self):
        with mock.patch.object(recover.json, "dump", side_effect=ValueError("serialize failed")):
            with self.assertRaisesRegex(ValueError, "serialize failed"):
                self.run_restore()
        self.assertEqual([], list(self.user_dir.iterdir()))

    def test_collision_retry_limit_preserves_existing_registration(self):
        fixed = uuid.UUID("11111111-1111-1111-1111-111111111111")
        sentinel = self.user_dir / f"local_{fixed}.json"
        sentinel.write_bytes(b'{"cliSessionId":"existing-session"}')
        sentinel_bytes = sentinel.read_bytes()

        with mock.patch.object(recover, "RESTORE_REGISTRATION_ATTEMPTS", 2), mock.patch.object(
            recover.uuid_mod, "uuid4", return_value=fixed
        ):
            with self.assertRaisesRegex(RuntimeError, "after 2 attempts"):
                self.run_restore()

        self.assertEqual(sentinel_bytes, sentinel.read_bytes())
        self.assertEqual([sentinel], list(self.user_dir.iterdir()))

    def test_write_failure_leaves_no_registration_or_incomplete_file(self):
        with mock.patch.object(recover.os, "fsync", side_effect=OSError("write failed")):
            with self.assertRaisesRegex(OSError, "write failed"):
                self.run_restore()
        self.assertEqual([], list(self.user_dir.iterdir()))

    def test_publication_failure_leaves_no_registration_or_incomplete_file(self):
        with mock.patch.object(recover.os, "link", side_effect=OSError("publish failed")):
            with self.assertRaisesRegex(OSError, "publish failed"):
                self.run_restore()
        self.assertEqual([], list(self.user_dir.iterdir()))


if __name__ == "__main__":
    unittest.main()
