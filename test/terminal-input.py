"""Isolated raw-TTY receiver, not a model and never executes received text."""
import json
import os
import sys
import tty
from pathlib import Path

tty.setraw(0)
output = Path(sys.argv[1])
received = []
wire = b''
draft = b''
paste = False
context = '--context' in sys.argv


def render():
    text = draft.decode() if draft else 'Ask Codex to do anything'
    hint = '⚠ 2 warnings · f2 to view' if draft else (
        'New activity · Earlier messages available. enter/esc latest · ? shortcuts'
        if '--history' in sys.argv else '? for shortcuts')
    screen = ('• Working (1s • esc to interrupt)\r\n\r\n› '
              + text.replace('\n', '\r\n')
              + ('\r\n\r\n tab to queue message               6% context left\r\n' if draft and '--hidden-footer' in sys.argv else
                 '\r\n\r\n GPT-6.1-Sol high · /workspace · sandbox\r\n ' + hint + '\r\n'))
    os.write(1, b'\x1b[2J\x1b[23;1H' + screen.encode())


screen = '⠁  ⠈  ⡀\r\n›⠁Ask Codex to do anything ⡀\r\n⠈   ⠂' if '--animated' in sys.argv else '• Working (1s • esc to interrupt)\r\n› '
if '--claude' in sys.argv:
    screen = '✻ Working · esc to interrupt\r\n❯ \r\n auto mode on (shift+tab to cycle)'
os.write(1, b'\x1b[?2004h')
if context:
    render()
else:
    os.write(1, b'\x1b[2J\x1b[27;1H' + screen.encode())
while True:
    wire += os.read(0, 16384)
    while wire:
        marker = b'\x1b[201~' if paste else b'\x1b[200~'
        if len(wire) < len(marker) and marker.startswith(wire):
            break
        if wire.startswith(marker):
            paste = not paste
            wire = wire[len(marker):]
            if context and not paste:
                render()
        elif not paste and wire[:1] == b'\r':
            received.append({'text': draft.decode(), 'submitted': True})
            output.write_text(json.dumps(received, ensure_ascii=False))
            draft = b''
            wire = wire[1:]
            if context:
                render()
        else:
            draft += wire[:1]
            wire = wire[1:]
