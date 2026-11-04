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
ORPHAN = "33333333-3333-3333-3333-333333333333"


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

    def test_route_derived_preview_target_is_hidden_from_user_bubble(self):
        text = "【当前网页会话 data；预览目标 data；不要用工具进程的 TMUX/TMUX_PANE 判断】\n把结果放在这个会话"
        row = {"rollout_ordinal": 123, "created_at_ms": 123000, "item_json": json.dumps({"type": "userMessage", "content": [{"type": "text", "text": text}]}), "item_type": "userMessage"}
        self.assertEqual(reader.visible(row)["text"], "把结果放在这个会话")
        row["item_json"] = json.dumps({"type": "userMessage", "content": [{"type": "text", "text": text.replace("预览目标 data", "预览目标 paper")}]})
        self.assertEqual(reader.visible(row)["text"], text.replace("预览目标 data", "预览目标 paper"), "不匹配的标记不可隐藏")

    def test_branched_history_keeps_only_inherited_prefix_and_current_projection(self):
        folder = self.home / 'sessions/2026/10/29'
        folder.mkdir(parents=True)
        parent = folder / f'rollout-old-{THREAD}.jsonl'
        current = folder / f'rollout-new-{THREAD}_{ORPHAN}.jsonl'
        parent.write_text(json.dumps({'type':'session_meta','payload':{'id':THREAD}})+'\n')
        current.write_text(json.dumps({'type':'session_meta','payload':{'id':THREAD,'history_base':{'thread_id':THREAD,'end_ordinal_exclusive':30}}})+'\n')
        with sqlite3.connect(self.home / 'state_5.sqlite') as db:
            db.execute('UPDATE threads SET rollout_path=? WHERE id=?',(str(current),THREAD))
        with sqlite3.connect(self.home / 'thread_history_1.sqlite') as db:
            for i in range(30,56):
                item={'type':'userMessage','content':[{'type':'text','text':f'current {i}'}]}
                db.execute('INSERT INTO thread_items VALUES (?,?,?,?,?,?)',(ORPHAN,i,i*1000,json.dumps(item),'userMessage',i))
        segments=reader.history_segments(self.home,THREAD,str(current))
        self.assertEqual(segments,[(ORPHAN,30,9223372036854775807),(THREAD,0,30)])
        # Storage maintenance may relocate a parent without changing history.
        store=self.home / 'storage-fixture'
        store.mkdir()
        moved=store / parent.name
        parent.rename(moved);parent.symlink_to(moved)
        with patch.object(reader,'HISTORY_STORAGE_ROOT',store):
            self.assertEqual(reader.history_segments(self.home,THREAD,str(current)),segments)
        with self.assertRaises(ValueError):
            reader.history_segments(self.home,THREAD,str(current))
        parent.unlink();moved.rename(parent)
        page=reader.read_history(self.home,THREAD,segments=segments)
        all_messages=page['messages'];cursor=page['before']
        while cursor is not None:
            page=reader.read_history(self.home,THREAD,before=cursor,segments=segments)
            all_messages=page['messages']+all_messages;cursor=page['before']
        self.assertEqual([m['id'] for m in all_messages],[str(i) for i in range(1,56)])
        self.assertEqual(all_messages[29]['text'],'current 30')
        self.assertNotIn('reply 44',json.dumps(all_messages))
        self.assertEqual(reader.read_history(self.home,THREAD,lookup={'text':'current 55','since':0},segments=segments)['matches'][0]['id'],'55')
        self.assertEqual(reader.read_history(self.home,THREAD,lookup={'text':'reply 44','since':0},segments=segments)['matches'],[])
        request={'home':str(self.home),'pid':123,'binding':f'456:789:{THREAD}','before':10,'historyVersion':'old'}
        with patch.object(reader,'locate',return_value=(456,'789',{THREAD})):
            view=reader.main(request)
            self.assertTrue(view['historyReset']);self.assertEqual(view['messages'][-1]['text'],'current 55')
            older=reader.main({**request,'before':view['before'],'historyVersion':view['historyVersion']})
            self.assertFalse(older['historyReset']);self.assertLess(int(older['messages'][-1]['id']),view['before'])

    def test_canonical_migrated_history_requires_this_accounts_original_link(self):
        relative = Path('2026/09/20') / f'rollout-2026-09-20T15-19-32-{THREAD}.jsonl'
        original = self.home / 'sessions' / relative
        store = self.home / 'storage-fixture'
        moved = store / 'root-sessions' / relative
        moved.parent.mkdir(parents=True)
        original.parent.mkdir(parents=True)
        moved.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': THREAD}}) + '\n')
        original.symlink_to(moved)
        with sqlite3.connect(self.home / 'state_5.sqlite') as db:
            db.execute('UPDATE threads SET rollout_path=? WHERE id=?', (str(moved), THREAD))
        with patch.object(reader, 'HISTORY_STORAGE_ROOT', store), patch.object(reader, 'locate', return_value=(456, '789', {THREAD})):
            self.assertEqual(reader.rollout_path(self.home, original), moved)
            view = reader.main({'home': str(self.home), 'pid': 123})
            self.assertTrue(view['available'])
            self.assertEqual(view['messages'][-1]['id'], '45')
            self.assertFalse(view['readOnly'])
            original.unlink()
            with self.assertRaises(ValueError):
                reader.rollout_path(self.home, moved)
            other = store / 'another-account' / relative
            other.parent.mkdir(parents=True)
            other.write_text(moved.read_text())
            original.symlink_to(other)
            with self.assertRaises(ValueError):
                reader.rollout_path(self.home, moved)
            original.unlink()
            archived = self.home / 'archived_sessions' / relative
            archived.parent.mkdir(parents=True)
            archived.symlink_to(moved)
            self.assertEqual(reader.rollout_path(self.home, moved), moved)

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

    def test_identity_only_never_parses_history_and_still_rechecks_the_process(self):
        request = {"home":str(self.home),"pid":123,"identityOnly":True}
        with patch.object(reader,"read_history",side_effect=AssertionError("identity lookup must not parse history")), patch.object(reader,"read_legacy",side_effect=AssertionError("identity lookup must not parse rollout")):
            with patch.object(reader,"locate",return_value=(456,"789",{THREAD})):
                result=reader.main(request)
                self.assertTrue(result["available"])
                self.assertFalse(result["readOnly"])
                self.assertNotIn("messages",result)
            with patch.object(reader,"locate",return_value=(456,"789",set())), patch.object(reader,"resume_hint",return_value=None), patch.object(reader,"resume_initial",return_value=THREAD):
                self.assertTrue(reader.main(request)["readOnly"])
            with patch.object(reader,"locate",side_effect=[(456,"789",{THREAD}),(457,"790",{THREAD})]):
                self.assertEqual(reader.main(request)["reason"],"changed")

    def test_runtime_batch_reports_only_latest_verified_completed_final(self):
        with sqlite3.connect(self.home / "thread_history_1.sqlite") as db:
            db.execute("ALTER TABLE thread_items ADD COLUMN turn_id TEXT")
            db.execute("ALTER TABLE thread_items ADD COLUMN item_id TEXT")
            db.execute("UPDATE thread_items SET turn_id='done',item_id='final' WHERE thread_id=? AND rollout_ordinal=44", (THREAD,))
            db.execute("CREATE TABLE thread_turns (thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT,completed_at INTEGER,final_agent_item_id TEXT)")
            db.executemany("INSERT INTO thread_turns VALUES (?,?,?,?,?,?)",[(THREAD,"done",44,"completed",1790532000,"final"),(THREAD,"now",50,"inProgress",None,None)])
        request={"home":str(self.home),"pid":123,"pane":"%15","socket":"/workspace/tmux.sock","runtimeOnly":True}
        with patch.object(reader,"locate",return_value=(456,"789",{THREAD})):
            result=reader.main(request)
            batch=reader.main({"home":str(self.home),"runtimeBatch":[request]})
        self.assertEqual(result["completion"],{"id":"44","time":1790532000000})
        self.assertNotIn("messages",result)
        self.assertEqual(batch["completions"],[{"binding":f"456:789:{THREAD}","id":"44","time":1790532000000}])
        self.assertNotIn("reply 44",json.dumps(batch))
        with patch.object(reader,"locate",return_value=(456,"789",set())),patch.object(reader,"resume_hint",return_value=None),patch.object(reader,"resume_initial",return_value=None):
            self.assertEqual(reader.main(request)["reason"],"unverified_codex")
        with self.assertRaises(ValueError): reader.main({"home":str(self.home),"runtimeBatch":[request]*33})

    def test_unregistered_writer_locks_use_only_verified_visible_resume(self):
        request = {"home":str(self.home),"pid":123,"pane":"%15","socket":"/workspace/tmux.sock"}
        locks = {CHILD, ORPHAN}
        with patch.object(reader,"locate",return_value=(456,"789",locks)), patch.object(reader,"resume_hint",return_value=THREAD):
            result=reader.main(request)
            self.assertTrue(result["available"])
            self.assertEqual(result["binding"],f"456:789:{THREAD}")
        with patch.object(reader,"locate",return_value=(456,"789",locks)), patch.object(reader,"resume_hint",return_value=None), patch.object(reader,"resume_initial",return_value=None):
            self.assertEqual(reader.main(request)["reason"],"unverified_codex")
        with patch.object(reader,"locate",return_value=(456,"789",locks)), patch.object(reader,"resume_hint",side_effect=[THREAD,None]):
            self.assertEqual(reader.main(request)["reason"],"changed")

    def test_resume_hint_requires_the_same_cli_thread_on_current_screen(self):
        argv=b"/path/codex\0resume\0"+THREAD.encode()+b"\0"
        self.assertEqual(reader.resume_from_argv(argv),THREAD)
        self.assertIsNone(reader.resume_from_argv(b"/path/codex\0exec\0"+THREAD.encode()+b"\0"))
        screen="Welcome to Codex\nTo resume this session, run codex resume "+THREAD+"\n› "
        self.assertEqual(reader.resume_from_ui(argv,screen),THREAD)
        selection="To resume this session, run codex resume, then select the chat ("+THREAD+")"
        self.assertEqual(reader.resume_from_ui(argv,selection),THREAD)
        self.assertIsNone(reader.resume_from_ui(argv,screen.replace(THREAD,CHILD)))
        self.assertIsNone(reader.resume_from_ui(argv,"› codex resume "+THREAD))
        self.assertIsNone(reader.resume_from_ui(b"/path/codex\0exec\0"+THREAD.encode()+b"\0",screen))

    def test_unverified_resumed_cli_can_only_show_saved_history(self):
        request={"home":str(self.home),"pid":123,"pane":"%15","socket":"/workspace/tmux.sock"}
        with patch.object(reader,"locate",return_value=(456,"789",set())), patch.object(reader,"resume_hint",return_value=None), patch.object(reader,"resume_initial",return_value=THREAD):
            result=reader.main(request)
        self.assertTrue(result["available"])
        self.assertTrue(result["readOnly"])
        self.assertEqual(result["binding"],f"456:789:{THREAD}")
        self.assertEqual(result["messages"][-1]["id"],"45")
        with patch.object(reader,"locate",return_value=(456,"789",set())), patch.object(reader,"resume_hint",return_value=None), patch.object(reader,"resume_initial",side_effect=[THREAD,None]):
            self.assertEqual(reader.main(request)["reason"],"changed")

    def test_native_metadata_proof_selects_current_cli_thread_without_daemon_lock(self):
        request={"home":str(self.home),"pid":123,"verifiedThread":THREAD}
        with patch.object(reader,"locate",return_value=(456,"789",set())), patch.object(reader,"resume_hint",return_value=None), patch.object(reader,"resume_initial",return_value=None):
            result=reader.main(request)
        self.assertTrue(result["available"])
        self.assertFalse(result["readOnly"])
        self.assertEqual(result["binding"],f"456:789:{THREAD}")
        with patch.object(reader,"locate",return_value=(456,"789",set())), patch.object(reader,"resume_hint",return_value=None), patch.object(reader,"resume_initial",return_value=None):
            self.assertEqual(reader.main({"home":str(self.home),"pid":123})["reason"],"unverified_codex")
        with patch.object(reader,"locate",return_value=(456,"789",{THREAD})), patch.object(reader,"resume_hint",return_value=None):
            self.assertEqual(reader.main({**request,"verifiedThread":CHILD})["reason"],"changed")

    def test_vscode_origin_thread_resumed_by_cli_uses_only_fresh_metadata_proof(self):
        sessions=self.home / "sessions"
        sessions.mkdir()
        rollout=sessions / "old-vscode.jsonl"
        rollout.write_text("\n".join([
            json.dumps({"type":"session_meta","payload":{"id":THREAD}}),
            json.dumps({"type":"event_msg","timestamp":"2026-09-26T00:00:00Z","payload":{"type":"user_message","message":"saved request"}}),
        ])+"\n")
        with sqlite3.connect(self.home / "state_5.sqlite") as db:
            db.execute("UPDATE threads SET source='vscode',history_mode='legacy',rollout_path=? WHERE id=?",(str(rollout),THREAD))
        request={"home":str(self.home),"pid":123,"pane":"%15","socket":"/workspace/tmux.sock"}
        with patch.object(reader,"locate",return_value=(456,"789",set())), patch.object(reader,"resume_hint",return_value=None), patch.object(reader,"resume_initial",return_value=THREAD):
            self.assertEqual(reader.main(request)["reason"],"unverified_codex")
            result=reader.main({**request,"verifiedThread":THREAD})
        self.assertTrue(result["available"])
        self.assertFalse(result["readOnly"])
        self.assertEqual(result["binding"],f"456:789:{THREAD}")
        self.assertEqual(result["messages"][0]["text"],"saved request")

    def test_legacy_reverse_page_skips_a_tool_record_larger_than_one_window(self):
        sessions=self.home / "sessions"
        sessions.mkdir()
        rollout=sessions / "large-tail.jsonl"
        with rollout.open("w") as file:
            file.write(json.dumps({"type":"session_meta","payload":{"id":THREAD}})+"\n")
            file.write(json.dumps({"type":"event_msg","timestamp":"2026-09-26T00:00:00Z","payload":{"type":"user_message","message":"before giant output"}})+"\n")
            file.write(json.dumps({"type":"response_item","timestamp":"2026-09-26T00:00:01Z","payload":{"type":"function_call_output","output":"X"*(9*1024*1024)}})+"\n")
        result=reader.read_legacy(self.home,THREAD,str(rollout))
        self.assertEqual([m["text"] for m in result["messages"]],["before giant output"])
        self.assertIn("略过",result["notice"])

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
