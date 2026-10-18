"""Read the original interactive Claude session; never resume, write or use tokens."""
import json
import os
import re
import stat
from datetime import datetime
from pathlib import Path

UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")


def locate(pane_pid, home, pane, proc=Path('/proc')):
    queue, seen, found, other_cli = [pane_pid], set(), [], False
    while queue and len(seen) < 256:
        pid = queue.pop(0)
        if pid in seen:
            continue
        seen.add(pid)
        try:
            text = (proc / str(pid) / 'stat').read_text()
            name = text[text.find('(')+1:text.rfind(')')]
            started = text[text.rfind(')')+2:].split()[19]
            # Never walk through another coding CLI into its tools/subagents.
            if name == 'codex':
                other_cli = True
                continue
            if name == 'claude':
                found.append((pid, started))
                continue
            queue.extend(int(x) for x in (proc / str(pid) / 'task' / str(pid) / 'children').read_text().split())
        except (OSError, IndexError):
            continue
    if not found:
        return None
    if len(found) != 1 or other_cli:
        raise ValueError('ambiguous Claude process')
    pid, started = found[0]
    # This public metadata file is written by Claude itself. Never read *.key.
    path = home / 'sessions' / f'{pid}.json'
    if path.is_symlink() or path.stat().st_size > 65536:
        raise ValueError('metadata')
    meta = json.loads(path.read_text())
    if (meta.get('pid') != pid or str(meta.get('procStart')) != started
            or meta.get('kind') != 'interactive' or meta.get('entrypoint') != 'cli'
            or not UUID.fullmatch(str(meta.get('sessionId', '')))
            or not str(meta.get('tmux', '')).endswith('.'+pane)
            or not isinstance(meta.get('cwd'), str) or not os.path.isabs(meta['cwd'])):
        raise ValueError('metadata identity')
    return pid, started, meta['sessionId'], meta['cwd']


def project_record(record, offset, session, redact, safe_value):
    # Compact summaries use role=user in Claude's log but are generated context,
    # not user input. Filter before both history rendering and receipt matching.
    if (record.get('sessionId') != session or record.get('isSidechain')
            or record.get('isMeta') or record.get('isCompactSummary')
            or record.get('type') not in ('user', 'assistant')):
        return []
    message = record.get('message', {})
    if not isinstance(message, dict) or message.get('role') != record['type']:
        return []
    try:
        when = int(datetime.fromisoformat(record['timestamp'].replace('Z', '+00:00')).timestamp()*1000)
    except (ValueError, KeyError, AttributeError):
        return []
    content = message.get('content', [])
    if isinstance(content, str):
        content = [{'type': 'text', 'text': content}]
    if not isinstance(content, list):
        return []
    rows = []
    for i, block in enumerate(content[:100]):
        if not isinstance(block, dict):
            continue
        base = {'id': str(offset*100+i), 'time': when, 'provider': 'claude'}
        if UUID.fullmatch(str(record.get('uuid', ''))):
            base['sourceId'] = record['uuid']+':'+str(i)
        kind = block.get('type')
        if kind == 'text' and isinstance(block.get('text'), str) and block['text'].strip():
            # CLI commands/notifications are not user instructions or answers.
            text = block['text']
            if record['type'] == 'user' and re.match(r'^\s*<(?:local-command|command-name|system-reminder)', text):
                continue
            rows.append({**base, 'role': record['type'], 'text': redact(text)[:16000],
                         'truncated': len(text) > 16000,
                         'phase': 'final_answer' if message.get('stop_reason') == 'end_turn' else 'commentary'})
        elif kind in ('tool_use', 'tool_result'):
            title = '调用 '+str(block.get('name', '工具'))[:100] if kind == 'tool_use' else '工具结果'
            value = block.get('input') if kind == 'tool_use' else block.get('content')
            # Images and thinking are never serialized into tool details.
            if isinstance(value, list):
                value = [b.get('text', '') for b in value if isinstance(b, dict) and b.get('type') == 'text']
            clean = safe_value(value)
            detail = clean if isinstance(clean, str) else json.dumps(clean, ensure_ascii=False)
            rows.append({**base, 'role': 'activity', 'type': 'mcpToolCall' if kind == 'tool_use' else 'functionCallOutput',
                         'title': redact(title), 'text': redact(title), 'status': 'failed' if block.get('is_error') else 'recorded',
                         'details': [{'label': '参数' if kind == 'tool_use' else '结果', 'text': detail[:10000]}],
                         'truncated': len(detail) > 10000})
        elif kind in ('image', 'document') and record['type'] == 'user':
            rows.append({**base, 'role': 'user', 'text': '[图片附件]' if kind == 'image' else '[文档附件]'})
    return rows


def history(path, session, request, redact, safe_value):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        snap = os.fstat(source.fileno())
        if not stat.S_ISREG(snap.st_mode):
            raise ValueError('transcript file')
        stamp = str(snap.st_mtime_ns//1000)
        before = request.get('before')
        if before is not None and (not request.get('binding') or not isinstance(before, int) or not 0 <= before <= snap.st_size):
            return {'available': False, 'reason': 'changed'}
        lookup = request.get('lookup')
        if lookup is not None and (not request.get('binding') or not isinstance(lookup, dict)
                or not isinstance(lookup.get('text'), str) or not 0 < len(lookup['text'].encode()) <= 12000
                or not isinstance(lookup.get('since'), int) or lookup['since'] < 0):
            raise ValueError('receipt lookup')
        if not lookup and not request.get('runtimeOnly') and before is None and request.get('binding') and request.get('revision') == stamp:
            return {'unchanged': True, 'revision': stamp}
        end = snap.st_size if before is None else before
        start = max(0, end-8*1024*1024)
        source.seek(start)
        data = source.read(end-start)
        floor = data.find(b'\n')+1 if start else 0
        cursor = data.rfind(b'\n')+1
        messages, seen, budget, public, model, completion, skipped = [], set(), 0, 0, None, None, False
        while cursor > floor:
            previous = data.rfind(b'\n', 0, cursor-1)+1
            if previous < floor:
                break
            line, rows = data[previous:cursor-1], []
            try:
                if len(line) > 524288:
                    raise ValueError('oversized')
                record = json.loads(line)
                uid = record.get('uuid')
                if not uid or uid not in seen:
                    rows = project_record(record, start+previous, session, redact, safe_value)
                    if rows and uid:
                        seen.add(uid)
                    if rows and record.get('type') == 'assistant':
                        model = model or record.get('message', {}).get('model')
                        if record.get('message', {}).get('stop_reason') == 'end_turn' and completion is None:
                            completion = {'id': rows[-1]['id'], 'time': rows[-1]['time']}
            except (ValueError, TypeError, AttributeError):
                skipped = True
            if lookup:
                rows = [r for r in rows if r['role'] == 'user' and r['text'] == lookup['text'] and r['time'] >= lookup['since'] and not r.get('truncated')]
            size = len(json.dumps(rows, ensure_ascii=False).encode())
            if not request.get('runtimeOnly') and budget+size > 256000 and messages:
                break
            cursor = previous
            messages[0:0] = rows
            budget += size
            public += sum(r['role'] != 'activity' for r in rows)
            if request.get('runtimeOnly'):
                if completion:
                    break
                messages.clear()
            elif len(messages) >= 80 or (len(messages) >= 20 and public >= 6):
                break
        current = path.stat()
        if (current.st_dev, current.st_ino) != (snap.st_dev, snap.st_ino) or current.st_size < snap.st_size:
            return {'available': False, 'reason': 'changed'}
        if request.get('runtimeOnly'):
            return {'completion': completion}
        if lookup:
            return {'matches': messages}
        older = start+cursor if cursor > floor else start+floor
        if older >= end:
            older = start
        result = {'messages': messages, 'before': older or None, 'revision': stamp, 'model': model, 'effort': None}
        if skipped or not messages and older:
            result['notice'] = '部分内部或超大记录未展示，可继续查看更早消息；原记录未改动。'
        return result


def read(request, redact, safe_value, proc=Path('/proc')):
    home = Path(request.get('claudeHome', str(Path.home() / '.claude')))
    try:
        identity = locate(int(request['pid']), home, request['pane'], proc)
        if identity is None:
            return None
        pid, started, session, cwd = identity
        binding = f'{pid}:{started}:{session}'
        if request.get('binding') and request['binding'] != binding:
            return {'available': False, 'provider': 'claude', 'reason': 'changed'}
        if request.get('identityOnly'):
            result = {}
        else:
            projects = (home/'projects').resolve(strict=True)
            path = (projects/re.sub(r'[^a-zA-Z0-9]', '-', cwd)/(session+'.jsonl')).resolve(strict=True)
            if not path.is_relative_to(projects):
                raise ValueError('transcript path')
            result = history(path, session, request, redact, safe_value)
        if locate(int(request['pid']), home, request['pane'], proc) != identity:
            return {'available': False, 'provider': 'claude', 'reason': 'changed'}
        return {'available': True, 'provider': 'claude', 'binding': binding, 'readOnly': False, **result}
    except (ValueError, KeyError, OSError, TypeError):
        return {'available': False, 'provider': 'claude', 'reason': 'unverified_claude'}
