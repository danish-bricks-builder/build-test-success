#!/usr/bin/env python3
"""
Reproduce the table: every task under every mode that has no record in runs/ yet, several at a time.

    python3 reproduce.py                       # all 65 cells, 5 at a time
    python3 reproduce.py --parallel 3
    python3 reproduce.py --conditions raw-ldraw-1r,none   # only some modes (keys from tasks/conditions.json)

Resumable: stop it whenever (^C), run it again and it picks up where it left off. The API key comes from
ANTHROPIC_API_KEY or a line in .env. Results land in runs/; the viewer (python3 viewer/serve.py) shows
them next to the published ones as they land.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
os.execv(sys.executable, [sys.executable, "viewer/serve.py", "--fill", *sys.argv[1:]])
