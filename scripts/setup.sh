#!/bin/sh
# One-time setup, from the repository root:  sh scripts/setup.sh
# Needs Node 20+ and Python 3.10+. Chrome is needed only for the agent's eyes (render_view) and thumbnails.
set -e
cd "$(dirname "$0")/.."
echo "→ node packages"
npm install
echo "→ part data (~30 MB) and what the agent's eyes need"
sh scripts/fetch-data.sh --eyes
echo "→ python environment for the one-shot modes"
python3 -m venv .venv && .venv/bin/pip install -q anthropic
echo
echo "done. Next:"
echo "  python3 viewer/serve.py                      # browse the published runs at http://localhost:8787"
echo "  python3 build.py \"a small lighthouse\"        # build something yourself (needs ANTHROPIC_API_KEY)"
echo "  python3 reproduce.py                          # rerun the whole table"
