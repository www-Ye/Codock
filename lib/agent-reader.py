"""Dispatch by the pane's actual CLI process, never by a session name or cwd."""
import importlib.util
import json
import re
import sqlite3
import sys
from pathlib import Path
from claude_reader import read as read_claude

spec = importlib.util.spec_from_file_location('codex_reader', Path(__file__).with_name('codex-reader.py'))
codex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codex)


def main(request):
    if 'runtimeBatch' in request:
        rows = request['runtimeBatch']
        if not isinstance(rows, list) or len(rows) > 32:
            raise ValueError('runtime batch')
        completions = []
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get('pid'), int) or row['pid'] < 1 or not re.fullmatch(r'%\d+', str(row.get('pane'))) or not isinstance(row.get('socket'), str):
                raise ValueError('runtime pane')
            try:
                view = main({**row, 'home': request['home'], 'claudeHome': request.get('claudeHome', str(Path.home() / '.claude')), 'runtimeOnly': True})
                marker = view.get('completion') if view.get('available') else None
                completions.append({'binding': view['binding'], **marker} if marker else None)
            except (ValueError, KeyError, OSError, sqlite3.Error):
                completions.append(None)
        return {'completions': completions}
    view = read_claude(request, codex.redact, codex.safe_value)
    return view if view is not None else codex.main(request)


if __name__ == '__main__':
    try:
        result = main(json.load(sys.stdin))
    except (ValueError, KeyError, TypeError, OSError, sqlite3.Error):
        result = {'available': False, 'reason': 'unavailable'}
    print(json.dumps(result, ensure_ascii=False))
