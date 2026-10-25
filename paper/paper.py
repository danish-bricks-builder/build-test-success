#!/usr/bin/env python3
"""
Every number in the paper, from the run records — so none is ever typed by hand.

    python3 paper/paper.py           # from results/runs/ (the published runs); writes paper/out/
    python3 paper/paper.py --mine    # from runs/ (your own runs)

Writes
    paper/out/table1.tex     the 13-task × 5-condition table in the paper's notation
    paper/out/numbers.tex    \\newcommand macros for every figure the text quotes
    paper/out/numbers.json   the same, for scripts
    paper/out/cells.json     one line per cell: run id, mark, parts, seconds, usage

The latest record per (task, condition) counts, as in the viewer. Marks follow serve.py:
✓ every check passes · ×v invalid (parts collide or float) · ×s falls over · ×f too big for the
footprint · ×r another requirement missed · ∅ no model produced.
"""
import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent  # paper/
ROOT = HERE.parent
TASKS = json.loads((ROOT / "tasks" / "tasks.json").read_text())["tasks"]
CONDS = json.loads((ROOT / "tasks" / "conditions.json").read_text())["conditions"]
COND_KEYS = [c["key"] for c in CONDS]
COND_NAME = {c["key"]: c["name"] for c in CONDS}
COND_NAME.update({c["name"]: c["name"] for c in CONDS})
NAME_TO_KEY = {c["name"]: c["key"] for c in CONDS}
NAME_TO_KEY.update({a: c["key"] for c in CONDS for a in c.get("aliases", [])})  # earlier names in older records
BANDS = ["small", "medium", "monumental", "edit", "inventory"]


def mark(g: dict) -> str:
    if g.get("parseError") or g.get("partCount") is None:
        return "∅"
    if g.get("PASS"):
        return "✓"
    if not g.get("valid"):
        return "×v"
    if not g.get("stable"):
        return "×s"
    if (g.get("post") or {}).get("footprint") is False:
        return "×f"
    return "×r"


TEX = {"✓": r"\cmark", "×v": r"\xf{v}", "×s": r"\xf{s}", "×f": r"\xf{f}", "×r": r"\xf{r}", "∅": r"$\emptyset$", "—": "---"}


def load(folder: Path) -> dict[tuple[str, str], dict]:
    cells: dict[tuple[str, str], dict] = {}
    for p in sorted(folder.glob("*.json")):
        r = json.loads(p.read_text())
        task = str(r.get("task", ""))
        if task.startswith("prompt") or not r.get("condition"):
            continue
        key = NAME_TO_KEY.get(r["condition"], r["condition"])
        if key not in COND_KEYS:
            continue
        final = r.get("final") or r
        rid = r.get("runId") or p.stem
        row = {"id": rid, "task": task, "condition": key, "mark": mark(final), "PASS": bool(final.get("PASS")), "partCount": final.get("partCount"),
               "valid": final.get("valid"), "stable": final.get("stable"), "post": final.get("post"), "footprintStuds": final.get("footprintStuds"),
               "heightLdu": final.get("heightLdu"), "seconds": r.get("seconds"), "usage": r.get("usage"), "model": r.get("model"),
               "rounds": len(r.get("rounds") or []), "stamp": rid.rsplit("_", 1)[-1]}
        k = (task, key)
        if k not in cells or row["stamp"] > cells[k]["stamp"]:  # latest run per cell
            cells[k] = row
    return cells


def expressible(task: dict, key: str) -> bool:
    return True  # every task runs in every condition (the edit task's seed set goes into the one-shot prompt)


def table_tex(cells) -> str:
    cols = [COND_NAME[k] for k in COND_KEYS]
    out = [r"\begin{tabular}{l" + "c" * len(COND_KEYS) + "}", r"\toprule", "task & " + " & ".join(cols) + r" \\", r"\midrule"]
    totals = {k: [0, 0] for k in COND_KEYS}
    for band in BANDS:
        rows = [t for t in TASKS if t["band"] == band]
        if not rows:
            continue
        out.append(r"\multicolumn{%d}{l}{\textit{%s}} \\" % (len(COND_KEYS) + 1, band))
        for t in rows:
            marks = []
            for k in COND_KEYS:
                if not expressible(t, k):
                    marks.append(TEX["—"])
                    continue
                c = cells.get((t["id"], k))
                if not c:
                    marks.append("?")  # not run yet
                    continue
                totals[k][1] += 1
                totals[k][0] += c["PASS"]
                marks.append(TEX[c["mark"]])
            out.append(t["id"].replace("-", "\\mbox{-}") + " & " + " & ".join(marks) + r" \\")
    out += [r"\midrule", r"\textbf{pass} & " + " & ".join(f"{p}/{n}" if n else "---" for p, n in totals.values()) + r" \\", r"\bottomrule", r"\end{tabular}"]
    return "\n".join(out) + "\n"


def numbers(cells) -> dict:
    n: dict = {}
    for k in COND_KEYS:
        have = [c for (t, kk), c in cells.items() if kk == k]
        n[f"{k}:pass"] = sum(c["PASS"] for c in have)
        n[f"{k}:attempted"] = sum(1 for t in TASKS if expressible(t, k))
        n[f"{k}:recorded"] = len(have)
    for (t, k), c in cells.items():
        n[f"{t}:{k}:parts"] = c["partCount"]
        n[f"{t}:{k}:mark"] = c["mark"]
        n[f"{t}:{k}:seconds"] = c["seconds"]
    # the figures the text quotes by name
    n["monumental:raw:no-model"] = sum(1 for t in TASKS if t["band"] == "monumental" and cells.get((t["id"], "raw-ldraw-1r"), {}).get("mark") == "∅")
    n["env-full:fails"] = [t for (t, k), c in cells.items() if k == "verifier" and not c["PASS"]]
    n["env-gates:fails"] = [t for (t, k), c in cells.items() if k == "bare" and not c["PASS"]]
    n["raw:passes"] = [t for (t, k), c in cells.items() if k == "raw-ldraw-1r" and c["PASS"]]
    n["raw-fb:passes"] = [t for (t, k), c in cells.items() if k == "raw-ldraw-4r" and c["PASS"]]
    n["env:passes"] = [t for (t, k), c in cells.items() if k == "none" and c["PASS"]]
    usage = [c["usage"] for c in cells.values() if c.get("usage")]
    n["usage:cells"] = len(usage)
    n["usage:output-tokens"] = sum(u.get("output", 0) for u in usage)
    n["usage:input-tokens"] = sum(u.get("input", 0) + u.get("cacheRead", 0) + u.get("cacheWrite", 0) for u in usage)
    return n


WORDS = {0: "none", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve", 13: "thirteen"}
MACRO = {"raw-ldraw-1r": "Raw", "raw-ldraw-4r": "RawFb", "none": "Env", "bare": "EnvGates", "verifier": "EnvFull"}


def macros(n: dict) -> str:
    out = ["% generated by paper.py — do not edit; \\input{numbers} in main.tex"]
    for k, m in MACRO.items():
        p, a = n[f"{k}:pass"], n[f"{k}:attempted"]
        out.append(f"\\newcommand{{\\n{m}Pass}}{{{p}}}")
        out.append(f"\\newcommand{{\\n{m}Of}}{{{a}}}")
        out.append(f"\\newcommand{{\\w{m}Pass}}{{{WORDS.get(p, p)}}}")
        out.append(f"\\newcommand{{\\w{m}Of}}{{{WORDS.get(a, a)}}}")
    for t in TASKS:
        for k, m in MACRO.items():
            parts = n.get(f"{t['id']}:{k}:parts")
            if parts is not None:
                out.append(f"\\newcommand{{\\parts{m}{''.join(w.capitalize() for w in t['id'].split('-'))}}}{{{parts}}}")
    return "\n".join(out) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mine", action="store_true", help="your own runs (runs/) instead of the published results (results/runs/)")
    a = ap.parse_args()
    cells = load(ROOT / "runs" if a.mine else ROOT / "results" / "runs")
    out = HERE / "out"
    out.mkdir(exist_ok=True)
    (out / "table1.tex").write_text(table_tex(cells))
    n = numbers(cells)
    (out / "numbers.json").write_text(json.dumps(n, indent=1, ensure_ascii=False))
    (out / "numbers.tex").write_text(macros(n))
    (out / "cells.json").write_text(json.dumps([cells[k] for k in sorted(cells)], indent=1, ensure_ascii=False))
    missing = [(t["id"], COND_NAME[k]) for t in TASKS for k in COND_KEYS if expressible(t, k) and (t["id"], k) not in cells]
    print(f"{len(cells)} cells → {out}/ · pass: " + " · ".join(f"{COND_NAME[k]} {n[f'{k}:pass']}/{n[f'{k}:attempted']}" for k in COND_KEYS))
    if missing:
        print(f"{len(missing)} cells not run yet: " + ", ".join(f"{t}/{c}" for t, c in missing[:8]) + (" …" if len(missing) > 8 else ""))


if __name__ == "__main__":
    main()
