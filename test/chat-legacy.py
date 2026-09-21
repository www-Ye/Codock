import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("reader", Path(__file__).resolve().parents[1] / "lib/codex-reader.py")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
THREAD = "11111111-1111-1111-1111-111111111111"
CHILD = "22222222-2222-2222-2222-222222222222"


class LegacyTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="chat-legacy-", dir=os.environ["TMPDIR"]))
        (self.home / "sessions").mkdir()
        self.file = self.home / "sessions" / "rollout-fixture.jsonl"
        self.file.write_bytes(self.line("session_meta", {"id": THREAD, "base_instructions": "PRIVATE_SYSTEM"}))

    def line(self, kind, payload):
        return (json.dumps({"timestamp": "2026-09-21T00:00:00Z", "type": kind, "payload": payload}, ensure_ascii=False)+"\n").encode()

    def append(self, kind, payload):
        with self.file.open("ab") as f:
            offset = f.tell()
            f.write(self.line(kind, payload))
        return str(offset)

    def read(self, **kwargs):
        return reader.read_legacy(self.home, THREAD, str(self.file), **kwargs)

    def test_paging_only_public_messages_not_injected_or_duplicate_responses(self):
        expected = []
        for i in range(85):
            self.append("turn_context", {"summary": "PRIVATE_CONTEXT"})
            self.append("response_item", {"type": "reasoning", "summary": ["PRIVATE_REASONING"]})
            self.append("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "PRIVATE_INJECTED"}]})
            self.append("event_msg", {"type": "agent_message", "phase": "analysis", "message": "PRIVATE_ANALYSIS"})
            self.append("response_item", {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "DUPLICATE"}]})
            event = {"type": "user_message", "message": f"问题 {i}", "images": ["PRIVATE_IMAGE"]} if i % 2 else {"type": "agent_message", "phase": "final_answer", "message": f"回答 {i}"}
            expected.append(self.append("event_msg", event))
        original = self.file.read_bytes()
        page = self.read(window_bytes=4096)
        actual = [m["id"] for m in page["messages"]]
        cursor = page["before"]
        while cursor is not None:
            page = self.read(before=cursor, window_bytes=4096)
            self.assertTrue(page["before"] is None or page["before"] < cursor)
            actual = [m["id"] for m in page["messages"]]+actual
            self.assertNotIn("PRIVATE", json.dumps(page))
            self.assertNotIn("DUPLICATE", json.dumps(page))
            cursor = page["before"]
        self.assertEqual(actual, expected)
        self.assertEqual(original, self.file.read_bytes())
        self.assertTrue(self.read(revision=page["revision"])["unchanged"])

    def test_tools_redaction_and_bounds_share_existing_renderer(self):
        self.append("response_item", {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "echo hi", "api_key": "PRIVATE_TOKEN"}), "status": "completed"})
        self.append("response_item", {"type": "custom_tool_call", "name": "apply_patch", "input": "*** update index.html\n+new"})
        self.append("response_item", {"type": "function_call_output", "output": "API_KEY=PRIVATE_TOKEN\n"+"x"*40000})
        self.append("response_item", {"type": "custom_tool_call", "name": "spawn_agent", "input": "PRIVATE_DELEGATED_PROMPT"})
        self.append("response_item", {"type": "web_search_call", "action": {"type": "search", "query": "官方文档"}})
        self.append("event_msg", {"type": "context_compacted"})
        self.append("world_state", {"state": "PRIVATE_STATE"})
        page = self.read()
        self.assertEqual(len(page["messages"]), 6)
        self.assertNotIn("PRIVATE", json.dumps(page))
        self.assertIn("+new", json.dumps(page))
        self.assertEqual(page["messages"][0]["status"], "recorded", "call emission isn't completed execution")
        self.assertTrue(any(m["truncated"] for m in page["messages"]))
        self.assertLess(len(json.dumps(page).encode()), 256000)

    def test_receipt_lookup_only_matches_public_user_events(self):
        self.append("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "INJECTED"}]})
        expected = self.append("event_msg", {"type": "user_message", "message": "手动回车的原文"})
        for n in range(100):
            self.append("event_msg", {"type": "agent_message", "message": "later "+str(n)})
        self.assertFalse(any(m["id"] == expected for m in self.read()["messages"]))
        self.assertEqual([m["id"] for m in self.read(lookup={"text": "手动回车的原文", "since": 0})["matches"]], [expected])
        self.assertEqual(self.read(lookup={"text": "INJECTED", "since": 0})["matches"], [])

    def test_partial_append_and_large_windows_do_not_drop_valid_messages(self):
        older = self.append("event_msg", {"type": "user_message", "message": "older"})
        self.append("world_state", {"state": "z"*2500000})
        latest = self.append("event_msg", {"type": "agent_message", "message": "latest"})
        partial = self.line("event_msg", {"type": "user_message", "message": "partial"})
        with self.file.open("ab") as f:
            f.write(partial[:-5])
        page = self.read(window_bytes=131072)
        ids = [m["id"] for m in page["messages"]]
        cursor = page["before"]
        rounds = 0
        while cursor is not None:
            rounds += 1
            self.assertLess(rounds, 30)
            page = self.read(before=cursor, window_bytes=131072)
            ids = [m["id"] for m in page["messages"]]+ids
            self.assertTrue(page["before"] is None or page["before"] < cursor)
            cursor = page["before"]
        self.assertEqual(ids, [older, latest])
        with self.file.open("ab") as f:
            f.write(partial[-5:])
        self.assertEqual(self.read()["messages"][-1]["text"], "partial")

    def test_sparse_near_gigabyte_file_reads_tail_without_index_or_copy(self):
        with self.file.open("r+b") as f:
            f.seek(900000000)
            f.write(b"\n")
            f.write(self.line("event_msg", {"type": "user_message", "message": "tail only"}))
        page = self.read()
        self.assertEqual(page["messages"][-1]["text"], "tail only")
        self.assertEqual(page["messages"][-1]["id"], "900000001")
        self.assertIsNotNone(page["before"])
        self.assertEqual(len(list(self.home.iterdir())), 1, "reader creates no index/cache/second history")

    def test_identity_path_and_truncation_fail_closed(self):
        self.append("event_msg", {"type": "user_message", "message": "hello"})
        with self.assertRaises(ValueError):
            reader.read_legacy(self.home, CHILD, str(self.file))
        outside = self.home / "secret.jsonl"
        outside.write_bytes(self.file.read_bytes())
        with self.assertRaises(ValueError):
            reader.read_legacy(self.home, THREAD, str(outside))
        link = self.home / "sessions" / "link.jsonl"
        link.symlink_to(outside)
        with self.assertRaises(ValueError):
            reader.read_legacy(self.home, THREAD, str(link))
        self.assertEqual(self.read(before=self.file.stat().st_size+1)["reason"], "changed")
        with sqlite3.connect(self.home / "state_5.sqlite") as db:
            db.execute("CREATE TABLE threads (id TEXT,source TEXT,history_mode TEXT,model TEXT,reasoning_effort TEXT,rollout_path TEXT)")
            db.execute("INSERT INTO threads VALUES (?,?,?,?,?,?)", (THREAD,"vscode","legacy","test-model","high",str(self.file)))
        request = {"home": str(self.home), "pid": 123}
        with patch.object(reader, "locate", return_value=(456,"789",{THREAD})):
            result = reader.main(request)
            self.assertTrue(result["available"])
            self.assertEqual(result["binding"], f"456:789:{THREAD}")
            self.assertEqual(reader.main({**request,"binding":f"457:789:{THREAD}"})["reason"],"changed")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--fixture":
        home = Path(sys.argv[2])
        (home / "sessions").mkdir(parents=True)
        rollout = home / "sessions" / "rollout-browser.jsonl"
        rows = [{"type": "session_meta", "payload": {"id": THREAD}}]
        for i in range(60):
            rows.append({"type": "event_msg", "timestamp": "2026-09-21T00:00:00Z", "payload": {"type": "user_message" if i % 2 else "agent_message", "message": f"历史消息 {i}"}})
        rollout.write_text("\n".join(json.dumps(row) for row in rows)+"\n")
        with sqlite3.connect(home / "state_5.sqlite") as db:
            db.execute("CREATE TABLE threads (id TEXT,source TEXT,history_mode TEXT,model TEXT,reasoning_effort TEXT,rollout_path TEXT)")
            db.execute("INSERT INTO threads VALUES (?,?,?,?,?,?)", (THREAD,"vscode","legacy","fixture","high",str(rollout)))
    elif len(sys.argv) > 1 and sys.argv[1] == "--read":
        with patch.object(reader, "locate", return_value=(456,"789",{THREAD})):
            print(json.dumps(reader.main(json.loads(sys.argv[2])), ensure_ascii=False))
    else:
        unittest.main()
