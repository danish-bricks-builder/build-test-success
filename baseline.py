#!/usr/bin/env python3
"""
Reproduce the paper's BASELINE conditions: a frontier model writes an LDraw file directly,
with no environment and no connection language (Sec. 3.7 of "Build, Test, Success").

    raw            one shot: the task prompt in, an LDraw file out, graded offline
    raw+feedback   up to four attempts; between attempts the validator's report is pasted
                   back as plain text and the model is asked for a corrected file

Both are graded by grade.ts, the same checks the paper's harness ran
(connection validity, collision, stability, task requirements). The paper's numbers for
these conditions: raw passes 2 of the 12 attemptable tasks; raw+feedback passes 2 of 6 in
the ablation subset.

Usage, from the repository root (needs `npm install` done and the part data fetched (`sh fetch-data.sh`),
and an ANTHROPIC_API_KEY in the environment or in .env):

    pip install anthropic
    python3 baseline.py --condition raw                  # all 12 attemptable tasks
    python3 baseline.py --condition raw+feedback --tasks greek-temple,pyramid-giza
    python3 baseline.py --condition raw --dry-run        # print the prompts, call nothing
    python3 report.py                                    # the table

Every run writes runs/<runId>.ldr (the final file) and <runId>.json (every
round's file, report and grade, plus the whole conversation), the same shape as the paper's
records in records/.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent  # the repository root
HERE = Path(__file__).resolve().parent
RUNS = HERE / "runs"

# The system prompt and user message are the paper's, verbatim (scripts/agent/raw-ldraw.ts).
SYSTEM = "\n".join([
    "You are an expert LEGO designer. You output raw LDraw model files.",
    "Respond with ONLY the LDraw file in a ```ldraw fenced block — no other prose.",
    "Use standard LDraw conventions: type-1 lines `1 <color> x y z a b c d e f g h i <part>.dat`,",
    "-Y is up, 1 brick height = 24 LDU, 1 plate = 8 LDU, 1 stud pitch = 20 LDU.",
    "Use common official part files (3001.dat, 3003.dat, 3020.dat, 3024.dat, ...).",
    "Every part must be properly connected (studs seated in anti-studs) and no two parts may overlap.",
])

CONDITIONS = {"raw": 1, "raw+feedback": 4}  # name → number of attempts


def api_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key
    for name in (".env",):
        p = ROOT / name
        if p.exists():
            m = re.search(r"^ANTHROPIC_API_KEY=(.+)$", p.read_text(), re.M)
            if m:
                return m.group(1).strip()
    sys.exit("no ANTHROPIC_API_KEY in the environment or in .env")


def load_tasks() -> list[dict]:
    return json.loads((HERE / "tasks.json").read_text())["tasks"]


def user_message(task: dict) -> str:
    """The task prompt plus its machine-checked constraints, as the paper's harness phrased them."""
    post = task["post"]
    constraints = []
    if post.get("maxFootprintStuds"):
        w, l = post["maxFootprintStuds"]
        constraints.append(f"footprint must fit within {w}x{l} studs")
    if post.get("minHeightLdu"):
        constraints.append(f"height at least {post['minHeightLdu']} LDU ({round(post['minHeightLdu'] / 24)} bricks)")
    constraints.append(f"use at least {post['minParts']} parts")
    text = f"{task['prompt']}\nConstraints: {'; '.join(constraints)}."
    if task["type"] == "inventory":
        text += inventory_text(task["set"])
    return text


def inventory_text(set_id: str) -> str:
    """The restricted-inventory task lists the parts of one official set (non-spare)."""
    inv = json.loads((ROOT / "data" / "inv" / f"{set_id}.json").read_text())
    names = {r["p"]: r["n"] for r in json.loads((ROOT / "data" / "parts" / "index.json").read_text())}
    lines = [f"{r['q']}x {r['p']}.dat color {r['c']} ({names.get(r['p'], '?')})" for r in inv["parts"] if not r["spare"]]
    return "\nYou may ONLY use parts from this inventory (part, LDraw color code, quantity):\n" + "\n".join(lines) + "\n"


def extract_ldr(text: str) -> str | None:
    """The LDraw body of a response: the fenced block if there is one, else bare type-0/1 lines."""
    m = re.search(r"```(?:ldraw|ldr)?\n([\s\S]*?)```", text)
    body = m.group(1) if m else text
    lines = [l for l in body.split("\n") if re.match(r"^[01]\s", l.strip())]
    return "\n".join(lines) if len(lines) >= 2 else None


def grade(ldr_path: Path, task_id: str) -> dict:
    """grade.ts: the paper's checks, one JSON object back."""
    proc = subprocess.run(
        ["npx", "tsx", "grade.ts", str(ldr_path), "--task", task_id],
        cwd=ROOT, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"grader failed:\n{proc.stderr[-2000:]}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


def feedback_message(g: dict) -> str:
    """What the model is told between attempts: the validator's own report, as text."""
    if g.get("parseError"):
        return f"The file failed to parse: {g['parseError']}. Output a corrected complete file."
    msg = f"Verifier report:\n{g['verifyReport'][:1500]}\n"
    if g["valid"]:
        msg += f"Stability report:\n{g['stabilityReport'][:1500]}\n"
    msg += "Fix these problems and output the corrected COMPLETE file as a ```ldraw fenced block."
    return msg


def run_task(client, model: str, task: dict, attempts: int, dry_run: bool) -> dict:
    condition = "raw" if attempts == 1 else "raw+feedback"
    run_id = f"{task['id']}_{condition}_{int(time.time()):x}"
    messages = [{"role": "user", "content": user_message(task)}]
    print(f"\n== {task['id']}  [{condition}]  {run_id}")
    if dry_run:
        print("--- system ---\n" + SYSTEM + "\n--- user ---\n" + messages[0]["content"][:1200] + ("…" if len(messages[0]["content"]) > 1200 else ""))
        return {}

    started = time.time()
    rounds, final_ldr, final_grade = [], None, None
    for rnd in range(1, attempts + 1):
        print(f"  attempt {rnd}/{attempts} … ", end="", flush=True)
        text = call_model(client, model, messages)
        messages.append({"role": "assistant", "content": text})
        ldr = extract_ldr(text)
        if ldr is None:
            print("no LDraw in the response")
            rounds.append({"round": rnd, "ldr": None, "grade": None})
            messages.append({"role": "user", "content": "Your response contained no LDraw lines. Output the complete model as a ```ldraw fenced block."})
            continue
        ldr_path = RUNS / f"{run_id}.round{rnd}.ldr"
        ldr_path.write_text(ldr + "\n")
        g = grade(ldr_path, task["id"])
        final_ldr, final_grade = ldr, g
        rounds.append({"round": rnd, "ldr": ldr_path.name, "grade": g})
        if g.get("parseError"):
            print(f"unparseable: {g['parseError'][:80]}")
        else:
            print(f"{g['partCount']} parts  valid={g['valid']}  stable={g['stable']}  PASS={g['PASS']}")
        if g.get("PASS") or rnd == attempts:
            break
        messages.append({"role": "user", "content": feedback_message(g)})

    record = {
        "runId": run_id, "task": task["id"], "condition": condition, "model": model,
        "seconds": round(time.time() - started), "rounds": rounds,
        "PASS": bool(final_grade and final_grade.get("PASS")),
        "final": final_grade or {"PASS": False, "verifyReport": "no LDraw produced in any round"},
        # the whole exchange, so the run can be read back later (serve.py shows it under "trace")
        "conversation": [{"role": "system", "content": SYSTEM}, *messages],
    }
    if final_ldr:
        (RUNS / f"{run_id}.ldr").write_text(final_ldr + "\n")
    (RUNS / f"{run_id}.json").write_text(json.dumps(record, indent=1))
    print(f"  → {'PASS' if record['PASS'] else 'fail'}   ({RUNS.relative_to(ROOT)}/{run_id}.json)")
    return record


def call_model(client, model: str, messages: list[dict]) -> str:
    """One model call with the paper's settings (32k output tokens, streamed); retried on network errors."""
    last = None
    for attempt in range(1, 5):
        try:
            with client.messages.stream(model=model, max_tokens=32000, system=SYSTEM, messages=messages) as stream:
                return "".join(block.text for block in stream.get_final_message().content if block.type == "text")
        except Exception as e:  # noqa: BLE001 — network flakes; the error is re-raised after four tries
            last = e
            print(f"[retry {attempt}/4: {type(e).__name__}] ", end="", flush=True)
            time.sleep(15 * attempt)
    raise last  # type: ignore[misc]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--condition", choices=CONDITIONS, default="raw")
    ap.add_argument("--tasks", default="all", help="comma-separated task ids, 'all' (the 12 attemptable), or 'ablation' (the 7-task subset minus the edit task)")
    ap.add_argument("--model", default="claude-opus-5", help="the paper used claude-opus-5")
    ap.add_argument("--dry-run", action="store_true", help="print the prompts and call nothing")
    a = ap.parse_args()

    tasks = load_tasks()
    if a.tasks == "all":
        chosen = [t for t in tasks if t["type"] != "edit"]  # the edit task cannot be expressed without the environment
    elif a.tasks == "ablation":
        subset = json.loads((HERE / "tasks.json").read_text())["ablation_subset"]
        chosen = [t for t in tasks if t["id"] in subset and t["type"] != "edit"]
    else:
        ids = a.tasks.split(",")
        chosen = [t for t in tasks if t["id"] in ids]
        missing = set(ids) - {t["id"] for t in chosen}
        if missing:
            sys.exit(f"unknown tasks: {', '.join(sorted(missing))}")
        if any(t["type"] == "edit" for t in chosen):
            sys.exit("the edit task cannot run in the raw conditions (no way to load a set without the environment)")

    RUNS.mkdir(exist_ok=True)
    client = None
    if not a.dry_run:
        try:
            import anthropic
        except ImportError:
            sys.exit("pip install anthropic")
        client = anthropic.Anthropic(api_key=api_key())

    results = [run_task(client, a.model, t, CONDITIONS[a.condition], a.dry_run) for t in chosen]
    if not a.dry_run:
        passed = sum(1 for r in results if r["PASS"])
        print(f"\n{a.condition}: {passed}/{len(results)} tasks pass   (python3 report.py for the table)")


if __name__ == "__main__":
    main()
