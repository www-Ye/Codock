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
screen = '⠁  ⠈  ⡀\r\n›⠁Ask Codex to do anything ⡀\r\n⠈   ⠂' if '--animated' in sys.argv else '• Working (1s • esc to interrupt)\r\n› '
os.write(1, b'\x1b[?2004h\x1b[2J\x1b[27;1H' + screen.encode())
while True:
    wire += os.read(0, 16384)
    while wire:
        marker = b'\x1b[201~' if paste else b'\x1b[200~'
        if marker.startswith(wire):
            break
        if wire.startswith(marker):
            paste = not paste
            wire = wire[len(marker):]
        elif not paste and wire[:1] == b'\r':
            received.append({'text': draft.decode(), 'submitted': True})
            output.write_text(json.dumps(received, ensure_ascii=False))
            draft = b''
            wire = wire[1:]
        else:
            draft += wire[:1]
            wire = wire[1:]
