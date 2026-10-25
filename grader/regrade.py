#!/usr/bin/env python3
"""
Re-grade every record in runs/ from its final .ldr with the current grade.ts, and patch the record
in place (final grade, PASS, size fields). Use after a grader fix; the model's work is untouched.

    python3 grader/regrade.py            # report what would change
    python3 grader/regrade.py --write    # apply
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]  # the repository
TASKS = {t["id"]: t for t in json.loads((HERE / "tasks" / "tasks.json").read_text())["tasks"]}
WRITE = "--write" in sys.argv


def grade(ldr: Path, task_id: str, seed: Path | None) -> dict:
    cmd = ["npx", "tsx", "grader/grade.ts", str(ldr), "--task", task_id] + (["--seed", str(seed)] if seed else [])
    out = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr[-400:])
    return json.loads(out.stdout.strip().splitlines()[-1])


changed = 0
for p in sorted((HERE / "runs").glob("*.json")):
    r = json.loads(p.read_text())
    task = TASKS.get(r.get("task"))
    if not task:
        continue
    ldr = p.with_suffix(".ldr")
    if not ldr.exists():
        continue
    seed = HERE / "runs" / "_seeds" / f"{task['set']}.ldr" if task["type"] == "edit" and (HERE / "runs" / "_seeds" / f"{task['set']}.ldr").exists() else None
    g = grade(ldr, task["id"], seed)
    old = r.get("final") or r
    before = (bool(old.get("PASS")), old.get("footprintStuds"), (old.get("post") or {}).get("footprint"))
    after = (bool(g.get("PASS")), g.get("footprintStuds"), (g.get("post") or {}).get("footprint"))
    if before != after:
        changed += 1
        print(f"{r['runId']:48s} PASS {before[0]}→{after[0]}  footprint {before[1]}→{after[1]}  within {before[2]}→{after[2]}")
    if WRITE:
        keep = {"file": old.get("file")}
        if "final" in r:
            r["final"] = {**g, **{k: v for k, v in keep.items() if v}}
        else:
            for k in ("partCount", "heightLdu", "footprintStuds", "valid", "verifyReport", "stable", "stabilityReport", "post", "preserved", "preservedOffset", "newProblems", "seedBaseline"):
                if k in g:
                    r[k] = g[k]
        r["PASS"] = bool(g.get("PASS"))
        r["regraded"] = "footprint measure turned with the part (2026-10-24)"
        p.write_text(json.dumps(r, indent=1))
print(f"{changed} record(s) change verdict or footprint" + ("" if WRITE else " — rerun with --write to apply"))
