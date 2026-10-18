import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'lib'))
import claude_reader as reader
spec = importlib.util.spec_from_file_location('codex', Path(__file__).resolve().parents[1]/'lib/codex-reader.py')
codex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codex)
SID = '11111111-1111-1111-1111-111111111111'


class ClaudeReaderTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='claude-reader-', dir=os.environ['TMPDIR']))
        self.home, self.proc = self.root/'claude', self.root/'proc'
        (self.home/'sessions').mkdir(parents=True)
        self.process(100, 'bash', '10', '200')
        self.process(200, 'claude', '20', '300')
        self.process(300, 'claude', '30', '')  # nested agent must not win
        self.meta = {'pid': 200, 'procStart': '20', 'sessionId': SID, 'kind': 'interactive', 'entrypoint': 'cli', 'tmux': 'cc:@1.%1', 'cwd': '/work/demo'}
        self.save_meta()
        self.path = self.home/'projects'/'-work-demo'/(SID+'.jsonl')
        self.path.parent.mkdir(parents=True)
        self.request = {'pid': 100, 'pane': '%1', 'claudeHome': str(self.home)}
        self.rows = [self.record(i, 'user' if i%2 else 'assistant', [{'type': 'text', 'text': f'message {i}'}]) for i in range(1, 61)]
        self.save_rows()

    def process(self, pid, name, start, children):
        folder = self.proc/str(pid)
        (folder/'task'/str(pid)).mkdir(parents=True)
        (folder/'stat').write_text(f'{pid} ({name}) '+' '.join(['S']+['0']*18+[start]))
        (folder/'task'/str(pid)/'children').write_text(children)

    def save_meta(self):
        (self.home/'sessions'/'200.json').write_text(json.dumps(self.meta))

    def record(self, i, role, content, **extra):
        return {'type': role, 'sessionId': SID, 'uuid': f'00000000-0000-0000-0000-{i:012d}', 'timestamp': '2026-10-13T06:00:00Z', 'message': {'role': role, 'content': content, 'model': 'claude-test', 'stop_reason': 'end_turn'}, **extra}

    def save_rows(self):
        self.path.write_text(''.join(json.dumps(r)+'\n' for r in self.rows))

    def read(self, **extra):
        return reader.read({**self.request, **extra}, codex.redact, codex.safe_value, self.proc)

    def test_mapping_pagination_binding_and_revision(self):
        page = self.read()
        self.assertTrue(page['available'])
        self.assertEqual(page['binding'], f'200:20:{SID}')
        self.assertEqual(page['provider'], 'claude')
        self.assertEqual(page['messages'][-1]['text'], 'message 60')
        messages, cursor = page['messages'], page['before']
        while cursor is not None:
            older = self.read(binding=page['binding'], before=cursor)
            messages = older['messages']+messages
            cursor = older['before']
        self.assertEqual([m['text'] for m in messages], [f'message {i}' for i in range(1, 61)])
        self.assertEqual(len({m['id'] for m in messages}), 60)
        self.assertTrue(self.read(binding=page['binding'], revision=page['revision'])['unchanged'])
        self.assertFalse(self.read(binding=f'200:21:{SID}')['available'])
        self.meta['procStart'] = '19'
        self.save_meta()
        self.assertFalse(self.read()['available'])

    def test_no_guess_from_cwd_other_pane_or_nested_agent(self):
        self.meta['tmux'] = 'paper:@2.%2'
        self.save_meta()
        self.assertFalse(self.read()['available'])
        (self.home/'sessions'/'200.json').unlink()
        self.assertFalse(self.read()['available'])
        self.assertIsNone(reader.locate(999, self.home, '%1', self.proc))

    def test_public_blocks_tool_records_secrets_and_partial_line(self):
        self.rows += [self.record(61, 'assistant', [{'type': 'thinking', 'thinking': 'PRIVATE_THOUGHT'}, {'type': 'text', 'text': 'visible'}, {'type': 'tool_use', 'name': 'Read', 'input': {'path': '/project/demo', 'api_key': 'PRIVATE_KEY'}}]),
                      self.record(62, 'user', [{'type': 'tool_result', 'content': [{'type': 'text', 'text': 'read result'}, {'type': 'image', 'source': {'data': 'PRIVATE_IMAGE'}}]}]),
                      self.record(63, 'user', 'PRIVATE_META', isMeta=True),
                      self.record(64, 'assistant', 'PRIVATE_SIDECHAIN', isSidechain=True)]
        self.save_rows()
        with self.path.open('ab') as f:
            f.write(b'{"partial":')
        page = self.read()
        text = json.dumps(page)
        self.assertNotIn('PRIVATE_', text)
        self.assertIn('visible', text)
        self.assertIn('read result', text)
        self.assertTrue(any(m['role'] == 'activity' for m in page['messages']))
        self.assertEqual(self.read(runtimeOnly=True)['completion']['time'], 1791871200000)

    def test_receipt_lookup_and_identity_only(self):
        view = self.read(identityOnly=True)
        self.assertNotIn('messages', view)
        result = self.read(binding=view['binding'], lookup={'text': 'message 59', 'since': 1})
        self.assertEqual([m['text'] for m in result['matches']], ['message 59'])
        result = self.read(binding=view['binding'], lookup={'text': 'message 58', 'since': 1})
        self.assertEqual(result['matches'], [], 'assistant answer cannot acknowledge user send')

    def test_duplicate_uuid_has_stable_identity_across_reads(self):
        first = self.read()['messages'][-1]
        self.rows.append(self.record(60, 'assistant', 'rewritten answer'))
        self.save_rows()
        latest = self.read()['messages'][-1]
        self.assertEqual(first['sourceId'], latest['sourceId'])
        self.assertNotEqual(first['id'], latest['id'], 'offset is ordering, not identity')
        self.assertEqual(latest['text'], 'rewritten answer')

    def test_compact_summaries_hidden_across_pages_and_not_receipts(self):
        summary = 'This session is being continued from a previous conversation. INTERNAL_SUMMARY'
        for i in range(4):
            content = summary if i % 2 == 0 else [{'type': 'text', 'text': summary}]
            self.rows.insert(5+i*12, self.record(100+i, 'user', content,
                             isCompactSummary=True, isVisibleInTranscriptOnly=True))
        # The explicit summary marker is sufficient even without transcript-only.
        self.rows.append(self.record(104, 'user', summary, isCompactSummary=True))
        self.save_rows()
        before_bytes = self.path.read_bytes()
        page = self.read()
        binding = page['binding']
        messages = page['messages']
        while page['before'] is not None:
            page = self.read(binding=binding, before=page['before'])
            messages = page['messages']+messages
        self.assertEqual([m['text'] for m in messages], [f'message {i}' for i in range(1, 61)])
        self.assertEqual(self.read(binding=binding, lookup={'text': summary, 'since': 1})['matches'], [])
        self.assertEqual(self.path.read_bytes(), before_bytes, 'original model context is never rewritten')
        # Do not hide real user text merely because it mentions compact/summary.
        actual = self.record(105, 'user', summary)
        projected = reader.project_record(actual, 0, SID, codex.redact, codex.safe_value)
        self.assertEqual(projected[0]['text'], summary)

    def test_summary_only_page_is_empty_not_a_fake_user_message(self):
        self.rows = [self.record(100, 'user', 'INTERNAL_SUMMARY', isCompactSummary=True)]
        self.save_rows()
        page = self.read()
        self.assertEqual(page['messages'], [])
        self.assertIsNone(page['before'])


if __name__ == '__main__':
    unittest.main()
