import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("reader", Path(__file__).resolve().parents[1] / "lib/codex-reader.py")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
THREAD = "11111111-1111-1111-1111-111111111111"
CHILD = "22222222-2222-2222-2222-222222222222"


class ReaderTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="chat-reader-", dir=os.environ["TMPDIR"]))
        with sqlite3.connect(self.home / "state_5.sqlite") as db:
            db.execute("CREATE TABLE threads (id TEXT,source TEXT,history_mode TEXT,model TEXT,reasoning_effort TEXT)")
            db.executemany("INSERT INTO threads VALUES (?,?,?,?,?)", [(THREAD,"cli","paginated","test-model","high"),(CHILD,'{"subagent":{}}',"paginated","other-model","low")])
            db.execute("ALTER TABLE threads ADD COLUMN rollout_path TEXT")
        with sqlite3.connect(self.home / "thread_history_1.sqlite") as db:
            db.execute("CREATE TABLE thread_items (thread_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT,item_type TEXT,updated_at_ordinal INTEGER)")
            for i in range(1, 46):
                item = {"type":"userMessage","content":[{"type":"text","text":f"message {i}"}]} if i % 2 else {"type":"agentMessage","phase":"final_answer","text":f"reply {i}"}
                db.execute("INSERT INTO thread_items VALUES (?,?,?,?,?,?)", (THREAD,i,i*1000,json.dumps(item),item["type"],i))
            for i, kind in enumerate(["reasoning","commandExecution","agentMessage"], 46):
                item = {"type":kind,"phase":"analysis","text":"MUST_NOT_LEAK"}
                db.execute("INSERT INTO thread_items VALUES (?,?,?,?,?,?)", (THREAD,i,i*1000,json.dumps(item),kind,i))
            db.execute("INSERT INTO thread_items VALUES (?,?,?,?,?,?)", (CHILD,99,99000,json.dumps({"type":"agentMessage","text":"OTHER_THREAD_SECRET"}),"agentMessage",99))

    def test_pagination_filters_and_unchanged(self):
        first = reader.read_history(self.home, THREAD)
        self.assertNotIn("SECRET", json.dumps(first))
        self.assertNotIn("MUST_NOT_LEAK", json.dumps(first))
        self.assertEqual(first["messages"][-1]["id"], "45")
        ids = [m["id"] for m in first["messages"]]
        cursor = first["before"]
        while cursor is not None:
            page = reader.read_history(self.home, THREAD, before=cursor)
            ids = [m["id"] for m in page["messages"]] + ids
            cursor = page["before"]
        self.assertEqual(ids, [str(i) for i in range(1,46)])
        self.assertTrue(reader.read_history(self.home, THREAD, revision=first["revision"])["unchanged"])
        with sqlite3.connect(self.home / "thread_history_1.sqlite") as db:
            db.execute("UPDATE thread_items SET updated_at_ordinal=100,item_json=? WHERE thread_id=? AND rollout_ordinal=44", (json.dumps({"type":"agentMessage","phase":"final_answer","text":"updated"}),THREAD))
        self.assertNotEqual(reader.read_history(self.home, THREAD)["revision"], first["revision"])

    def test_mapping_is_root_cli_and_bound_to_process(self):
        request = {"home":str(self.home),"pid":123}
        with patch.object(reader, "locate", return_value=(456,"789",{THREAD,CHILD})):
            result = reader.main(request)
            self.assertTrue(result["available"])
            self.assertEqual(result["model"], "test-model")
            result = reader.main({**request,"binding":f"987:789:{THREAD}"})
            self.assertEqual(result["reason"], "changed")
        with patch.object(reader, "locate", side_effect=[(456,"789",{THREAD}),(457,"790",{THREAD})]):
            self.assertEqual(reader.main(request)["reason"], "changed")

    def test_receipt_lookup_uses_exact_public_user_text_and_time_beyond_first_page(self):
        self.assertFalse(any(m.get("text") == "message 1" for m in reader.read_history(self.home, THREAD)["messages"]))
        result = reader.read_history(self.home, THREAD, lookup={"text": "message 1", "since": 0})
        self.assertEqual([m["id"] for m in result["matches"]], ["1"])
        self.assertEqual(reader.read_history(self.home, THREAD, lookup={"text": "message 1", "since": 1001})["matches"], [])
        self.assertEqual(reader.read_history(self.home, THREAD, lookup={"text": "reply 2", "since": 0})["matches"], [])
        self.assertEqual(reader.read_history(self.home, CHILD, lookup={"text": "message 1", "since": 0})["matches"], [])

    def test_no_write_and_bounded_messages(self):
        with reader.database(self.home,"thread_history_1.sqlite") as db:
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("DELETE FROM thread_items")
        row = {"rollout_ordinal":1,"created_at_ms":0,"item_json":json.dumps({"type":"agentMessage","text":"x"*33000})}
        result = reader.visible(row)
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["text"]),32000)

    def test_public_actions_are_bounded_redacted_and_page_without_gaps(self):
        actions = [
            {"type":"commandExecution","command":"printf hello","status":"completed","exitCode":0,"aggregatedOutput":"API_KEY=secret-value\nAuthorization: Bearer abcdefghijk\nOK"},
            {"type":"fileChange","status":"completed","changes":[{"path":"index.html","kind":{"type":"update"},"diff":"-old\n+new"}]},
            {"type":"webSearch","query":"official documentation","action":{"type":"search","queries":["official documentation"]},"results":[{"title":"Docs","url":"https://example.com","body":"PRIVATE_SNAPSHOT"}]},
            {"type":"mcpToolCall","tool":"search","status":"failed","arguments":{"token":"PRIVATE_TOKEN","q":"hello"},"error":{"message":"retry later"}},
            {"type":"dynamicToolCall","tool":"test","status":"completed","contentItems":[{"type":"text","text":"PASS"}]},
            {"type":"functionCallOutput","name":"exec","output":"x"*40000},
            {"type":"collabAgentToolCall","tool":"spawnAgent","prompt":"PRIVATE_DELEGATED_PROMPT","agentsStates":{"private":"PRIVATE_AGENT_STATE"}},
            {"type":"plan","text":"1. Read\n2. Verify"},
            {"type":"reasoning","summary":["PRIVATE_REASONING"],"content":["PRIVATE_REASONING"]},
            {"type":"hookPrompt","fragments":["PRIVATE_HOOK"]},
        ]
        with sqlite3.connect(self.home / "thread_history_1.sqlite") as db:
            for i in range(49, 99):
                item = actions[(i-49)%len(actions)]
                db.execute("INSERT INTO thread_items VALUES (?,?,?,?,?,?)",(THREAD,i,i*1000,json.dumps(item),item["type"],i))
            item={"type":"imageGeneration","status":"completed","result":"z"*700000}
            db.execute("INSERT INTO thread_items VALUES (?,?,?,?,?,?)",(THREAD,99,99000,json.dumps(item),item["type"],99))
        all_messages, cursor = [], None
        while True:
            page = reader.read_history(self.home, THREAD, before=cursor)
            all_messages = page["messages"] + all_messages
            cursor=page["before"]
            self.assertLess(len(json.dumps(page).encode()),600000)
            if cursor is None: break
        payload=json.dumps(all_messages)
        for forbidden in ["PRIVATE_","secret-value","abcdefghijk","MUST_NOT_LEAK"]:
            self.assertNotIn(forbidden,payload)
        ids=[int(m["id"]) for m in all_messages]
        expected=list(range(1,46))+[i for i in range(49,99) if (i-49)%10<8]+[99]
        self.assertEqual(ids,expected)
        events=[m for m in all_messages if m["role"]=="activity"]
        self.assertTrue(any(m["status"]=="failed" for m in events))
        self.assertTrue(any(m["truncated"] for m in events))
        self.assertIn('+new',payload)
        self.assertIn('https://example.com',payload)
        self.assertNotIn('z'*100,payload)
        self.assertTrue(all_messages[-1]['truncated'])


if __name__ == "__main__":
    unittest.main()
