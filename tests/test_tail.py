"""Regression tests for JSONL records written while the viewer is reading."""

import json
import tempfile
import unittest
from pathlib import Path

import serve


class ReadPageTests(unittest.TestCase):
    def test_incomplete_final_line_is_retried_after_writer_finishes(self):
        complete = {"type": "assistant", "message": {"content": "Live update"}}
        encoded = json.dumps(complete).encode("utf-8")

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "active.jsonl"
            path.write_bytes(encoded[:-2])
            session = {"file": str(path), "source": "Claude"}

            first = serve.read_page(session)
            self.assertEqual(first["records"], [])
            self.assertEqual(first["cursor"], 0)
            self.assertIsNone(first["next"])

            with path.open("ab") as output:
                output.write(encoded[-2:] + b"\n")

            second = serve.read_page(session, byte_offset=first["cursor"])
            self.assertEqual(len(second["records"]), 1)
            self.assertEqual(second["records"][0]["message"]["content"], "Live update")

    def test_valid_json_waits_for_its_newline(self):
        record = {"type": "assistant", "message": {"content": "Live update"}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "active.jsonl"
            path.write_text(json.dumps(record))
            session = {"file": str(path), "source": "Claude"}

            first = serve.read_page(session)
            self.assertEqual(first["records"], [])
            self.assertEqual(first["cursor"], 0)
            self.assertIsNone(first["next"])

            with path.open("a") as output:
                output.write("\n")
            self.assertEqual(len(serve.read_page(session)["records"]), 1)

    def test_non_object_json_line_is_skipped(self):
        record = {"type": "assistant", "message": {"content": "Still readable"}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "active.jsonl"
            path.write_text("123\n" + json.dumps(record) + "\n")
            session = {"file": str(path), "source": "Claude"}

            page = serve.read_page(session)
            self.assertEqual(page["malformed"], 1)
            self.assertEqual(len(page["records"]), 1)


if __name__ == "__main__":
    unittest.main()
