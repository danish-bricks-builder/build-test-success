#!/usr/bin/env python3
"""
The results table, in the paper's notation (Table 1 legend):

    ✓   every check passes
    ×v  invalid: parts collide or float
    ×s  falls over
    ×f  too big for the footprint
    ×r  another requirement missed (part count, height, part names, inventory)
    ∅   no model produced (nothing parseable in any attempt)
    —   not run

    python3 report.py            your runs (runs/)
    python3 report.py --paper    the paper's own records (records/)
    python3 report.py --both

When a task was run more than once under a condition, the latest run is shown and the count noted.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE
PAPER_CONDITIONS = {  # the paper's names → the harness's condition strings in the records
    "raw": ("raw-ldraw-1r",), "raw+feedback": ("raw-ldraw-4r",),
    "env": ("none",), "env+gates": ("bare",), "env+full": ("verifier",),
}


def mark(g: dict | None) -> str:
    if not g or g.get("parseError") or g.get("partCount") is None:
        return "∅"
    if g.get("PASS"):
        return "✓"
    if not g.get("valid"):
        return "×v"
    if not g.get("stable"):
        return "×s"
    post = g.get("post") or {}
    if post.get("footprint") is False:
        return "×f"
    return "×r"


def my_runs() -> dict[tuple[str, str], list[dict]]:
    out: dict[tuple[str, str], list[dict]] = {}
    for p in sorted((HERE / "runs").glob("*.json")):
        r = json.loads(p.read_text())
        out.setdefault((r["task"], r["condition"]), []).append({"grade": r["final"], "id": r["runId"]})
    return out


def paper_runs() -> dict[tuple[str, str], list[dict]]:
    """The paper's grade records, records/*.json, every era. The run id's suffix is a
    base-36 timestamp: the full-suite raw and env+full runs are the 'mtf…' era (the final
    prompts, Aug 29); the five-condition ablation on the seven-task subset is the 'mte…'
    era (Aug 28–29). The latest record per cell is what the table shows."""
    out: dict[tuple[str, str], list[dict]] = {}
    names = {v: k for k, vs in PAPER_CONDITIONS.items() for v in vs}
    for p in sorted((ROOT / "records").glob("*.json")):
        r = json.loads(p.read_text())
        if r.get("condition") not in names:
            continue
        out.setdefault((r["task"], names[r["condition"]]), []).append({"grade": r, "id": r["runId"]})
    for cell in out.values():
        cell.sort(key=lambda x: x["id"].rsplit("_", 1)[-1])
    return out


def table(title: str, runs: dict[tuple[str, str], list[dict]], tasks: list[dict], conditions: list[str]) -> None:
    print(f"\n{title}")
    width = max(len(t["id"]) for t in tasks) + 2
    print("task".ljust(width) + "".join(c.rjust(14) for c in conditions))
    totals = {c: [0, 0] for c in conditions}
    for t in tasks:
        row = t["id"].ljust(width)
        for c in conditions:
            cell = runs.get((t["id"], c))
            if not cell:
                row += "—".rjust(14)
                continue
            m = mark(cell[-1]["grade"])
            totals[c][1] += 1
            totals[c][0] += m == "✓"
            row += (m + (f" (×{len(cell)})" if len(cell) > 1 else "")).rjust(14)
        print(row)
    print("pass".ljust(width) + "".join((f"{p}/{n}" if n else "—").rjust(14) for p, n in (totals[c] for c in conditions)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--paper", action="store_true", help="the paper's records instead of yours")
    ap.add_argument("--both", action="store_true")
    a = ap.parse_args()
    tasks = json.loads((HERE / "tasks.json").read_text())["tasks"]
    if a.paper or a.both:
        table("the paper's records (records/; latest run per cell)", paper_runs(), tasks, list(PAPER_CONDITIONS))
    if not a.paper or a.both:
        table("your runs (runs/)", my_runs(), tasks, ["raw", "raw+feedback"])


if __name__ == "__main__":
    main()
