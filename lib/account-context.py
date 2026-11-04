"""Read the last saved execution settings, without exporting prompts or secrets."""
import json
import pathlib
import sqlite3
import sys

home, thread = sys.argv[1:]
db = sqlite3.connect(pathlib.Path(home, 'state_5.sqlite').as_uri() + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
row = db.execute('SELECT sandbox_policy,approval_mode,rollout_path,model,reasoning_effort FROM threads WHERE id=?', (thread,)).fetchone()
if row is None:
    raise ValueError('missing thread')
file = pathlib.Path(row['rollout_path']).resolve(strict=True)
if not file.is_relative_to(pathlib.Path(home).resolve(strict=True)):
    raise ValueError('outside home')
context = {}
with file.open('rb') as stream:
    # Context records may be far behind a long tool result; search backwards,
    # retaining one record only, not loading the conversation into memory.
    end = stream.seek(0, 2)
    tail = b''
    while end and not context:
        start = max(0, end - 1024 * 1024)
        stream.seek(start)
        chunk = stream.read(end - start) + tail
        lines = chunk.split(b'\n')
        tail = lines.pop(0) if start else b''
        for line in reversed(lines):
            if b'"turn_context"' not in line:
                continue
            try:
                record = json.loads(line)
                if record.get('type') == 'turn_context':
                    context = record['payload']
                    break
            except (ValueError, KeyError):
                pass
        end = start
policy = context.get('permission_profile') or context.get('sandbox_policy') or json.loads(row['sandbox_policy'])
approval = context.get('approval_policy', row['approval_mode'])
config = {'approval_policy': approval}
if context.get('approvals_reviewer') in ('user', 'auto_review', 'guardian_subagent'):
    config['approvals_reviewer'] = context['approvals_reviewer']
kind = policy.get('type')
params = {'approvalPolicy': approval}
if kind == 'managed' and policy.get('file_system', {}).get('type') == 'restricted':
    filesystem = {}
    for entry in policy['file_system']['entries']:
        target = entry['path']
        key = target['path'] if target['type'] == 'path' else ':' + target['value']['kind']
        if entry['access'] not in ('read', 'write', 'deny'):
            raise ValueError('unsupported access')
        filesystem[key] = entry['access']
    config['permissions'] = {'desk_session': {'filesystem': filesystem, 'network': {'enabled': policy.get('network') == 'enabled'}}}
    config['default_permissions'] = 'desk_session'
    params['permissions'] = 'desk_session'
elif kind in ('read-only', 'workspace-write', 'danger-full-access'):
    config['sandbox_mode'] = kind
    params['sandbox'] = kind
    if kind == 'workspace-write':
        config['sandbox_workspace_write'] = {k: v for k, v in policy.items() if k != 'type'}
else:
    raise ValueError('unsupported permission policy')
if context.get('approvals_reviewer'):
    params['approvalsReviewer'] = context['approvals_reviewer']
if context.get('workspace_roots'):
    params['runtimeWorkspaceRoots'] = context['workspace_roots']
print(json.dumps({'config': config, 'params': params}))
