#!/usr/bin/env python3
"""
Build something from a prompt, in any of the five modes, and grade it.

    python3 build.py "Build a small lighthouse: a square base, a tapering tower in red and white bands, a lantern on top."
    python3 build.py "a stone bridge with three arches" --mode one-shot+feedback
    python3 build.py "a Japanese pagoda, five tiers" --mode interactive+check-tools --model claude-opus-5-5

Modes (see tasks/conditions.json): one-shot · one-shot+feedback · interactive · interactive+final-check ·
interactive+check-tools (default). The API key comes from ANTHROPIC_API_KEY or a line in .env.

The result lands in runs/ (grade record + final .ldr); interactive modes also record the whole session
under runs/sessions/. Open the viewer to look at it: python3 viewer/serve.py
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "viewer"))
import serve  # noqa: E402  (the results server: it knows how to start the environment)

CONDS = json.loads((ROOT / "tasks" / "conditions.json").read_text())["conditions"]


def mode_key(name: str) -> str:
    norm = lambda x: re.sub(r"[\s_-]+", "-", x.strip().lower())  # noqa: E731
    for c in CONDS:
        if norm(name) in {norm(c["name"]), norm(c["key"]), *(norm(a) for a in c.get("aliases", []))}:
            return c["key"]
    sys.exit(f"unknown mode {name!r}; one of: " + ", ".join(c["name"] for c in CONDS))


def api_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key and (ROOT / ".env").exists():
        m = re.search(r"^ANTHROPIC_API_KEY=(.+)$", (ROOT / ".env").read_text(), re.M)
        key = m.group(1).strip() if m else ""
    if not key:
        sys.exit("no API key: export ANTHROPIC_API_KEY=… or put ANTHROPIC_API_KEY=… in .env")
    return key


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("prompt", help="what to build")
    ap.add_argument("--mode", default="interactive+check-tools")
    ap.add_argument("--model", default="claude-opus-5")
    ap.add_argument("--no-eyes", action="store_true", help="interactive modes: no render_view (no Chrome needed)")
    a = ap.parse_args()
    key, cond = api_key(), mode_key(a.mode)
    run_id = f"prompt_{int(time.time()):x}"
    env = {**os.environ, "ANTHROPIC_API_KEY": key, "PYTHON_COLORS": "0"}
    if cond.startswith("raw-ldraw"):
        name = next(c["name"] for c in CONDS if c["key"] == cond)
        cmd = [serve.PY, "runners/oneshot.py", "--condition", name, "--prompt", a.prompt, "--run-id", run_id, "--model", a.model]
    else:
        err = serve.ensure_env_server(key)
        if err:
            sys.exit(err)
        cmd = ["npx", "tsx", "runners/environment/run.ts", f"--prompt={a.prompt}", f"--runId={run_id}", f"--condition={cond}",
               f"--model={a.model}", f"--eyes={'off' if a.no_eyes else 'on'}", f"--base=http://localhost:{serve.ENV_PORT}"]
    print(f"building in mode {a.mode} with {a.model} … (the session is recorded; ^C stops)", flush=True)
    try:
        code = subprocess.call(cmd, cwd=ROOT, env=env)
    finally:
        serve.stop(serve.ENV_SERVER["proc"])
    rec = ROOT / "runs" / f"{run_id}.json"
    if code != 0 or not rec.exists():
        sys.exit("no result — see the output above")
    r = json.loads(rec.read_text())
    g = r.get("final") or r
    print(f"\n{'PASS' if r.get('PASS') else 'fail'} · {g.get('partCount')} parts · valid {g.get('valid')} · stable {g.get('stable')}")
    print(f"record: runs/{run_id}.json · model: runs/{run_id}.ldr")
    print("look at it: python3 viewer/serve.py  →  http://localhost:8787 (tab “try it yourself” lists your prompts)")


if __name__ == "__main__":
    main()
