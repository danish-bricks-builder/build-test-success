#!/usr/bin/env python3
"""
A small results server: the published runs and yours in one table, each one viewable in 3D with
its grade, its attempt-by-attempt trace and its LDraw source.

    python3 serve.py              # then open http://localhost:8787
    python3 serve.py --port 9000

Standard library only. The 3D view needs LDraw part files; they are fetched from the data bucket
the first time a part is seen and cached under public/ldraw/ (the bucket has no CORS headers, so the
browser cannot fetch them itself — this server stands in between).

Routes:
    /                  the page (viewer/index.html)
    /api/runs          every run in results/runs/ (published) and runs/ (yours), normalized
    /api/run/<id>      one run: the grade record, the LDraw text, the conversation or session if recorded
    /api/snapshot/<id>/<file>   a model snapshot from the run's session folder (results/sessions/ or runs/sessions/)
    /api/blob/<id>/<file>       a picture the agent saw, from the run's session folder
    /ldraw/<path>      a part-library file, cached from the bucket
    /api/jobs          GET: running and finished jobs; POST {task, condition, model, eyes, dryRun}
                       with the API key in the x-api-key header starts one (baseline.py or env/run.ts;
                       the environment server is started here when needed, with the key in its env)
    /api/jobs/<id>/log · /api/jobs/<id>/stop · /api/env/stop
    /api/try           POST {prompt, condition, model, eyes} + x-api-key: run a free prompt, events streamed back
    /api/verify/<id>   the faulty parts of a run by index (unattached, colliding), for the viewer's highlights
    /api/thumb/<id>    PNG of the final build (results/thumbs, runs/thumbs; viewer/thumb.ts renders them)
    python3 serve.py --fill [--parallel 4] [--model …] [--eyes off] [--conditions …]   the whole table from the terminal
    /api/queue         GET: the fill-the-table queue; POST {model, eyes, conditions?} + x-api-key starts it over
                       every cell without a record in runs/ (resumable); POST /api/queue/stop {abort?}
"""
from __future__ import annotations

import argparse
import sys
import json
import os
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent  # viewer/
ROOT = HERE.parent  # the repository
ORIGIN = "https://pub-09680f02457547f9bd4034ba506c47d7.r2.dev"
_CONDS = json.loads((ROOT / "tasks" / "conditions.json").read_text())["conditions"]
# key, current name, or an earlier name → the current name
CONDITION_NAMES = {c["key"]: c["name"] for c in _CONDS}
CONDITION_NAMES.update({c["name"]: c["name"] for c in _CONDS})
CONDITION_NAMES.update({a: c["name"] for c in _CONDS for a in c.get("aliases", [])})
MISSING: set[str] = set()  # part-library paths the bucket does not have (so we ask once)


def mark(g: dict) -> str:
    """The table's mark for one grade record."""
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


def normalize(path: Path, source: str) -> dict:
    """One run, whichever harness wrote it, in one shape."""
    r = json.loads(path.read_text())
    final = r.get("final") or r  # one-shot records keep the final grade under `final`
    rounds = []
    for x in r.get("rounds") or []:
        if "grade" in x:  # baseline.py: the grade object per attempt
            g = x.get("grade") or {}
            rounds.append({"round": x["round"], "parts": g.get("partCount"), "valid": g.get("valid"), "stable": g.get("stable"),
                           "note": g.get("parseError") or (g.get("verifyReport") or "")[:300] if g else "no LDraw in the response", "ldr": x.get("ldr")})
        else:  # older records: a summary line per round
            rounds.append({"round": x.get("round"), "parts": x.get("parts"), "valid": x.get("valid"), "stable": x.get("stable"), "note": (x.get("report") or "")[:300], "ldr": None})
    run_id = r.get("runId") or path.stem
    return {
        "id": run_id, "source": source, "task": r.get("task"), "condition": CONDITION_NAMES.get(r.get("condition"), r.get("condition")),
        "model": r.get("model"), "era": run_id.rsplit("_", 1)[-1][:3], "seconds": r.get("seconds"),
        "PASS": bool(final.get("PASS")), "mark": mark(final), "partCount": final.get("partCount"), "valid": final.get("valid"),
        "stable": final.get("stable"), "post": final.get("post"), "heightLdu": final.get("heightLdu"), "footprintStuds": final.get("footprintStuds"),
        "verifyReport": final.get("verifyReport"), "stabilityReport": final.get("stabilityReport"), "rounds": rounds,
        "hasLdr": path.with_suffix(".ldr").exists(), "file": str(path.relative_to(ROOT)),
        "conversation": r.get("conversation"), "hasSession": session_dir(run_id) is not None,
        "prompt": r.get("prompt"), "kind": "prompt" if str(r.get("task", "")).startswith("prompt") else "task",
    }


PUBLISHED = ROOT / "results" / "runs"      # the published runs (committed)
MINE = ROOT / "runs"                        # your own runs (not committed)
RUN_DIRS = ((PUBLISHED, "paper"), (MINE, "mine"))


def session_dir(run_id: str) -> Path | None:
    for d in (ROOT / "results" / "sessions" / run_id, ROOT / "runs" / "sessions" / run_id):
        if (d / "run.json").exists():
            return d
    return None


def session(run_id: str) -> dict | None:
    """The harness's own recording of a session, when sessions/<runId>/ holds one: run.json (the
    turns, each with the message the agent was given) and toolLog.jsonl (one line per tool call:
    name, input, result, and the model snapshot taken after it)."""
    d = session_dir(run_id)
    if d is None:
        return None
    run = json.loads((d / "run.json").read_text())
    calls = []
    log = d / "toolLog.jsonl"
    if log.exists():
        for line in log.read_text().splitlines():
            if line.strip():
                try:
                    calls.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return {"run": run, "calls": calls, "snapshots": sorted(p.name for p in (d / "snapshots").glob("*.ldr")) if (d / "snapshots").exists() else []}


def all_runs() -> list[dict]:
    out = [normalize(p, "paper") for p in sorted(PUBLISHED.glob("*.json"))]
    out += [normalize(p, "mine") for p in sorted(MINE.glob("*.json"))]
    return out


# ── running conditions from the page ─────────────────────────────────────────────────────
# A job is one subprocess: runners/oneshot.py for the two one-shot conditions, runners/environment/run.ts for the three
# environment conditions (which need the environment server; it is started here on demand, with
# the key in its environment). Keys arrive in a request header, live in memory, never on disk.
CONDITIONS = {c["key"]: c for c in json.loads((ROOT / "tasks" / "conditions.json").read_text())["conditions"]}
JOBS: dict[str, dict] = {}
# runners/oneshot.py needs the anthropic package: python3 -m venv .venv && .venv/bin/pip install anthropic
PY = str(ROOT / ".venv" / "bin" / "python3") if (ROOT / ".venv" / "bin" / "python3").exists() else "python3"
JOBS_LOCK = threading.Lock()
LOG_DIR = ROOT / "runs" / "_jobs"
ENV_PORT = 8788
ENV_SERVER: dict = {"proc": None, "key": None}
ENV_LOCK = threading.Lock()  # parallel workers must not race to start the environment


def stop(proc: subprocess.Popen | None) -> None:
    """Terminate a child and everything it spawned (npx wraps node; tsx wraps the script)."""
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), 15)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), 9)


def port_open(port: int) -> bool:
    with socket.socket() as sk:
        sk.settimeout(0.3)
        return sk.connect_ex(("127.0.0.1", port)) == 0


def ensure_env_server(key: str) -> str | None:
    """Start env/server.ts (or restart it when the key changed). Returns an error string or None."""
    with ENV_LOCK:
        return _ensure_env_server(key)


def _ensure_env_server(key: str) -> str | None:
    p = ENV_SERVER["proc"]
    if p is not None and p.poll() is None and ENV_SERVER["key"] == key:
        return None
    if p is not None and p.poll() is None:
        stop(p)  # ours, but with another key
    if port_open(ENV_PORT):
        # An environment is already up that this process did not start (or lost track of): use it.
        # It must have been started with the same key — the README says so for a manual start.
        ENV_SERVER["proc"], ENV_SERVER["key"] = None, key
        return None
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = open(LOG_DIR / "env-server.log", "ab")
    budget = str(4 * 3600 * 1000)  # no per-turn time limit: a session runs until the agent declares it done
    ENV_SERVER["proc"] = subprocess.Popen(["npx", "tsx", "runners/environment/server.ts", "--port", str(ENV_PORT)], cwd=ROOT,
                                          env={**os.environ, "ANTHROPIC_API_KEY": key, "COPILOT_TURN_BUDGET_MAX_MS": budget, "COPILOT_TURN_BUDGET_MS": budget},
                                          stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    ENV_SERVER["key"] = key
    for _ in range(60):  # tsx compiles the route on first start; give it a while
        if port_open(ENV_PORT):
            return None
        if ENV_SERVER["proc"].poll() is not None:
            return "the environment server exited at start — see runs/_jobs/env-server.log"
        time.sleep(0.5)
    return "the environment server did not come up within 30 s — see runs/_jobs/env-server.log"


# ── thumbnails: thumb.ts renders every final build without one, one sweep at a time ──────
THUMB_LOCK = threading.Lock()
THUMB_STATE: dict = {"again": False}


def thumb_sweep() -> None:
    """Render missing thumbnails in the background; a sweep asked for during a sweep runs after it."""
    if not THUMB_LOCK.acquire(blocking=False):
        THUMB_STATE["again"] = True
        return

    def go() -> None:
        try:
            while True:
                THUMB_STATE["again"] = False
                LOG_DIR.mkdir(parents=True, exist_ok=True)
                with open(LOG_DIR / "thumbs.log", "ab") as log:
                    subprocess.run(["npx", "tsx", "viewer/thumb.ts", "--all"], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env={**os.environ, "PYTHON_COLORS": "0"})
                if not THUMB_STATE["again"]:
                    return
        finally:
            THUMB_LOCK.release()

    threading.Thread(target=go, daemon=True).start()


VERIFY_DIR = ROOT / "runs" / "_verify"


def verify_run(run_id: str) -> dict | None:
    """The grader's per-part faults for one run (unattached / colliding part indices), cached."""
    cached = VERIFY_DIR / f"{run_id}.json"
    if cached.exists():
        return json.loads(cached.read_text())
    for d, _src in RUN_DIRS:
        rec, ldr = d / f"{run_id}.json", d / f"{run_id}.ldr"
        if rec.exists() and ldr.exists():
            r = json.loads(rec.read_text())
            task = str(r.get("task") or run_id)
            tasks = {t["id"]: t for t in json.loads((ROOT / "tasks" / "tasks.json").read_text())["tasks"]}
            cmd = ["npx", "tsx", "grader/grade.ts", str(ldr), "--task", task]
            seed = ROOT / "runs" / "_seeds" / f"{tasks.get(task, {}).get('set', '')}.ldr"
            if tasks.get(task, {}).get("type") == "edit" and seed.exists():
                cmd += ["--seed", str(seed)]
            out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
            if out.returncode != 0:
                return {"error": out.stderr[-300:]}
            g = json.loads(out.stdout.strip().splitlines()[-1])
            res = {"id": run_id, "faults": g.get("faults") or {"unattached": [], "colliding": [], "reasons": {}}, "valid": g.get("valid"), "partCount": g.get("partCount"),
                   "view": g.get("view"), "post": g.get("post"), "footprintStuds": g.get("footprintStuds"), "heightLdu": g.get("heightLdu")}
            VERIFY_DIR.mkdir(parents=True, exist_ok=True)
            cached.write_text(json.dumps(res))
            return res
    return None


THUMB_DIRS = (ROOT / "results" / "thumbs", ROOT / "runs" / "thumbs")


def thumb_path(run_id: str) -> Path | None:
    for d in THUMB_DIRS:
        p = d / f"{run_id}.png"
        if p.exists():
            return p
    return None


def thumb_count() -> int:
    return sum(1 for d in THUMB_DIRS for _ in d.glob("*.png"))


def start_job(spec: dict, key: str) -> dict:
    cond = CONDITIONS.get(spec.get("condition", ""))
    if not cond:
        raise ValueError(f"unknown condition {spec.get('condition')!r}")
    task = spec.get("task")
    tasks = json.loads((ROOT / "tasks" / "tasks.json").read_text())["tasks"]
    if task not in {t["id"] for t in tasks} and task not in ("all", "ablation"):
        raise ValueError(f"unknown task {task!r}")
    model = (spec.get("model") or "claude-opus-5").strip()
    dry = bool(spec.get("dryRun"))
    if cond["key"].startswith("raw-ldraw"):
        cmd = [PY, "runners/oneshot.py", "--condition", cond["name"], "--tasks", task, "--model", model] + (["--dry-run"] if dry else [])
        env = {**os.environ, "ANTHROPIC_API_KEY": key} if key else dict(os.environ)
    else:
        if dry:
            raise ValueError("dry run is only for the ldraw conditions (the environment has no dry run)")
        if not key:
            raise ValueError("the environment conditions need an API key")
        if task in ("all", "ablation"):
            raise ValueError("the environment runs one task per job — pick a task")
        err = ensure_env_server(key)
        if err:
            raise ValueError(err)
        cmd = ["npx", "tsx", "runners/environment/run.ts", f"--task={task}", f"--condition={cond['key']}", f"--model={model}", f"--eyes={'off' if spec.get('eyes') is False else 'on'}", f"--base=http://localhost:{ENV_PORT}"]
        env = {**os.environ, "ANTHROPIC_API_KEY": key}
    job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"{job_id}.log"
    log = open(log_path, "wb")
    env["PYTHON_COLORS"] = "0"  # plain tracebacks in the job log
    proc = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    job = {"id": job_id, "cmd": " ".join(cmd), "task": task, "condition": cond["name"], "model": model, "startedAt": time.time(), "endedAt": None, "code": None, "proc": proc, "log": str(log_path)}
    with JOBS_LOCK:
        JOBS[job_id] = job
    return job


def job_view(j: dict) -> dict:
    p = j["proc"]
    if j["endedAt"] is None and p.poll() is not None:
        j["endedAt"] = time.time()
        j["code"] = p.returncode
        thumb_sweep()  # the job's final build gets its picture
    return {k: v for k, v in j.items() if k != "proc"} | {"running": j["endedAt"] is None, "seconds": round((j["endedAt"] or time.time()) - j["startedAt"])}


def tail(path: str, n: int = 4000) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - n))
            return f.read().decode("utf-8", "replace")
    except FileNotFoundError:
        return ""


def sse(handler, obj: dict) -> None:
    handler.wfile.write(f"data: {json.dumps(obj)}\n\n".encode())
    handler.wfile.flush()


def grade_file(ldr_path: Path, task_id: str) -> dict:
    out = subprocess.run(["npx", "tsx", "grader/grade.ts", str(ldr_path), "--task", task_id], cwd=ROOT, capture_output=True, text=True)
    if out.returncode != 0:
        return {"PASS": False, "verifyReport": f"grader failed: {out.stderr[-400:]}"}
    return json.loads(out.stdout.strip().splitlines()[-1])


def try_prompt(handler, body: dict, key: str) -> None:
    """Run a free prompt under one condition and stream what happens, as Server-Sent Events.
    ldraw conditions: baseline.py runs with --prompt and its log is relayed line by line.
    env conditions: the environment server's own event stream is relayed as is (tool calls,
    narration, the model as it grows), then the final build is graded and recorded."""
    prompt = (body.get("prompt") or "").strip()
    cond = CONDITIONS.get(body.get("condition", ""))
    model = (body.get("model") or "claude-opus-5").strip()
    if not prompt or not cond:
        return handler.send_json({"error": "prompt and condition are required"}, 400)
    if not key:
        return handler.send_json({"error": "an API key is required"}, 400)
    run_id = f"prompt_{re.sub(r'[^a-z0-9]+', '-', cond['name'].lower()).strip('-')}_{int(time.time()):x}"
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache")
    handler.end_headers()
    sse(handler, {"type": "start", "runId": run_id, "condition": cond["name"]})
    started = time.time()
    if cond["key"].startswith("raw-ldraw"):
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log_path = LOG_DIR / f"{run_id}.log"
        with open(log_path, "wb") as log:
            proc = subprocess.Popen(["python3", "-u", "runners/oneshot.py", "--condition", cond["name"], "--prompt", prompt, "--model", model, "--run-id", run_id],
                                    cwd=ROOT, env={**os.environ, "ANTHROPIC_API_KEY": key}, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        sent = 0
        while True:
            text = tail(str(log_path), 10**6)
            if len(text) > sent:
                sse(handler, {"type": "text", "delta": text[sent:]})
                sent = len(text)
            if proc.poll() is not None:
                break
            time.sleep(0.5)
    else:
        err = ensure_env_server(key)
        if err:
            sse(handler, {"type": "error", "message": err}); sse(handler, {"type": "done"}); return
        req_body = json.dumps({"message": prompt, "model": model, "toolMode": "connect", "toolset": "full", "baseplate": "none",
                               "verifierTools": cond["key"] == "verifier", **({"gates": False} if cond["key"] == "none" else {}),
                               "eyes": body.get("eyes") is not False, "stream": "model",
                               "record": {"runId": run_id, "taskId": run_id, "condition": cond["key"] + ("" if body.get("eyes") is not False else "-noeyes"), "model": model}}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{ENV_PORT}/api/copilot", data=req_body, headers={"Content-Type": "application/json", "x-user-api-key": key}, method="POST")
        final_ldr = None
        try:
            with urllib.request.urlopen(req, timeout=3600) as resp:
                for raw in resp:
                    line = raw.decode("utf-8", "replace").rstrip("\n")
                    if not line.startswith("data: "):
                        continue
                    handler.wfile.write((line + "\n\n").encode()); handler.wfile.flush()
                    try:
                        ev = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue
                    if ev.get("type") == "result" and ev.get("ldraw"):
                        final_ldr = ev["ldraw"]
        except Exception as e:  # noqa: BLE001
            sse(handler, {"type": "error", "message": f"environment: {e}"})
        RUNS_DIR = ROOT / "runs"; RUNS_DIR.mkdir(exist_ok=True)
        grade = {"PASS": False, "verifyReport": "no final model produced"}
        if final_ldr:
            (RUNS_DIR / f"{run_id}.ldr").write_text(final_ldr)
            grade = grade_file(RUNS_DIR / f"{run_id}.ldr", run_id)
        (RUNS_DIR / f"{run_id}.json").write_text(json.dumps({"runId": run_id, "task": run_id, "condition": cond["key"], "model": model, "prompt": prompt,
                                                              "seconds": round(time.time() - started), "rounds": [], "PASS": bool(grade.get("PASS")), "final": grade}, indent=1))
    p = ROOT / "runs" / f"{run_id}.json"
    if p.exists():
        thumb_sweep()
        sse(handler, {"type": "graded", "run": normalize(p, "mine")})
    sse(handler, {"type": "done"})


# ── filling the whole table: a queue of cells, one job at a time ────────────────────────
# Every task × condition the paper reports (the edit task cannot run in the ldraw conditions).
# Cells that already have a record in runs/ are skipped, so the queue is resumable.
QUEUE: dict = {"pending": [], "running": [], "done": [], "stop": False, "threads": [], "key": None, "model": None, "eyes": True, "parallel": 1}
QUEUE_LOCK = threading.Lock()
JOB_MAX_SECONDS = 3 * 3600  # the longest real session was under two hours; three hours is far beyond that


def all_cells() -> list[tuple[str, str]]:
    tasks = json.loads((ROOT / "tasks" / "tasks.json").read_text())["tasks"]
    return [(t["id"], c["key"]) for c in CONDITIONS.values() for t in tasks]


def done_cells() -> set[tuple[str, str]]:
    """(task, condition key) pairs that already have a rerun record in runs/."""
    out = set()
    by_name = {c["name"]: c["key"] for c in CONDITIONS.values()}
    by_name.update({a: c["key"] for c in CONDITIONS.values() for a in c.get("aliases", [])})
    for p in MINE.glob("*.json"):
        try:
            r = json.loads(p.read_text())
        except json.JSONDecodeError:
            continue
        if str(r.get("task", "")).startswith("prompt"):
            continue
        cond = str(r.get("condition", ""))
        key = by_name.get(cond, cond)
        if key in CONDITIONS and "PASS" in r and r.get("task"):
            out.add((r["task"], key))
    return out


def queue_worker(slot: int) -> None:
    """One of QUEUE["parallel"] workers: takes the next cell until the list is empty or the queue is stopped.
    Cells are independent sessions; running several at once changes nothing per cell."""
    while True:
        with QUEUE_LOCK:
            if QUEUE["stop"] or not QUEUE["pending"]:
                QUEUE["running"] = [r for r in QUEUE["running"] if r["slot"] != slot]
                return
            task, cond = QUEUE["pending"].pop(0)
            mine = {"slot": slot, "task": task, "condition": cond, "startedAt": time.time()}
            QUEUE["running"] = [r for r in QUEUE["running"] if r["slot"] != slot] + [mine]
        try:
            job = start_job({"task": task, "condition": cond, "model": QUEUE["model"], "eyes": QUEUE["eyes"]}, QUEUE["key"])
            # A session that outlives every real one is stuck (a stream that never ends after the
            # network blinked): it is killed and counts as a failed job, so it cannot stall the pass.
            try:
                job["proc"].wait(timeout=JOB_MAX_SECONDS)
            except subprocess.TimeoutExpired:
                stop(job["proc"])
                job["proc"].wait(timeout=30)
                with open(job["log"], "ab") as log:
                    log.write(f"\nkilled by the queue after {JOB_MAX_SECONDS // 3600} h with no result\n".encode())
            thumb_sweep()
            with QUEUE_LOCK:
                QUEUE["done"].append({"task": task, "condition": cond, "code": job["proc"].returncode, "seconds": round(time.time() - mine["startedAt"]), "job": job["id"]})
                if all(d["code"] != 0 for d in QUEUE["done"][-3:]) and len(QUEUE["done"]) >= 3:
                    QUEUE["note"] = "stopped: three cells in a row failed — check the job log (a bad key, no Chrome for the eyes, …)"
                    QUEUE["stop"] = True
        except Exception as e:  # noqa: BLE001
            with QUEUE_LOCK:
                QUEUE["done"].append({"task": task, "condition": cond, "code": -1, "error": str(e)})
                QUEUE["stop"] = True  # an unrunnable cell stops the queue rather than failing 60 times


def queue_active() -> bool:
    return any(t.is_alive() for t in QUEUE.get("threads") or [])


def queue_start(spec: dict, key: str) -> dict:
    if not key:
        raise ValueError("an API key is required")
    with QUEUE_LOCK:
        if queue_active():
            raise ValueError("the queue is already running")
        done = done_cells()
        wanted = [c for c in all_cells() if c not in done]
        if spec.get("conditions"):
            wanted = [c for c in wanted if c[1] in spec["conditions"]]
        skip = {tuple(x.split("/", 1)) for x in (spec.get("skip") or [])}  # "task/condition-key" pairs running elsewhere
        wanted = [c for c in wanted if c not in skip]
        parallel = max(1, min(int(spec.get("parallel") or 1), 12))
        QUEUE.update({"pending": wanted, "running": [], "done": [], "stop": False, "note": None, "key": key, "model": (spec.get("model") or "claude-opus-5").strip(),
                      "eyes": spec.get("eyes") is not False, "parallel": parallel})
        QUEUE["threads"] = [threading.Thread(target=queue_worker, args=(i,), daemon=True) for i in range(min(parallel, len(wanted)) or 1)]
        for t in QUEUE["threads"]:
            t.start()
        return queue_view()


def queue_view() -> dict:
    return {"pending": QUEUE["pending"], "running": QUEUE["running"], "done": QUEUE["done"], "active": queue_active(), "parallel": QUEUE.get("parallel", 1),
            "total": len(all_cells()), "have": len(done_cells()), "model": QUEUE["model"], "eyes": QUEUE["eyes"], "note": QUEUE.get("note"), "thumbs": thumb_count()}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet, except errors
        if args and str(args[1]).startswith(("4", "5")) and "/ldraw/" not in str(args[0]):
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text: str, ctype="text/plain; charset=utf-8", code=200, cache=False):
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if cache:
            self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            return self.send_text((HERE / "index.html").read_text(), "text/html; charset=utf-8")
        if path == "/api/runs":
            tasks = json.loads((ROOT / "tasks" / "tasks.json").read_text())
            return self.send_json({"tasks": [{"id": t["id"], "band": t["band"], "type": t["type"]} for t in tasks["tasks"]], "runs": all_runs()})
        m = re.fullmatch(r"/api/run/([\w.+-]+)", path)
        if m:
            for d, src in RUN_DIRS:
                p = d / f"{m.group(1)}.json"
                if p.exists():
                    run = normalize(p, src)
                    ldr = p.with_suffix(".ldr")
                    run["ldraw"] = ldr.read_text() if ldr.exists() else None
                    run["taskSpec"] = next((t for t in json.loads((ROOT / "tasks" / "tasks.json").read_text())["tasks"] if t["id"] == run.get("task")), None)
                    if run.get("kind") == "task":
                        # measured values the requirement list needs beyond the grade summary
                        raw = json.loads(p.read_text()); fin = raw.get("final") or raw
                        run["measured"] = {k: fin.get(k) for k in ("preserved", "preservedOffset", "bomOver", "newProblems") if fin.get(k) is not None}
                        run["measured"].update({k: v for k, v in fin.items() if k.startswith("parts_")})
                    # earlier attempts of a baseline.py run, when kept
                    run["attempts"] = {x["ldr"]: (ROOT / "runs" / x["ldr"]).read_text() for x in run["rounds"] if x.get("ldr") and (ROOT / "runs" / x["ldr"]).exists()}
                    run["session"] = session(run["id"])
                    return self.send_json(run)
            return self.send_json({"error": "no such run"}, 404)
        m = re.fullmatch(r"/api/blob/([\w.+-]+)/([\w.+-]+)", path)
        if m:
            # a picture the agent was given during the session (render_view, the initial view)
            sd = session_dir(m.group(1))
            p = (sd / "blobs" / m.group(2)) if sd else ROOT / "nowhere"
            if not p.exists():
                return self.send_json({"error": "no such image"}, 404)
            data = p.read_bytes()
            self.send_response(200)
            self.send_header("content-type", "image/png")
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "max-age=3600")
            self.end_headers()
            return self.wfile.write(data)
        m = re.fullmatch(r"/api/snapshot/([\w.+-]+)/([\w.+-]+)", path)
        if m:
            sd = session_dir(m.group(1))
            p = (sd / "snapshots" / m.group(2)) if sd else ROOT / "nowhere"
            if p.exists():
                return self.send_text(p.read_text())
            return self.send_json({"error": "no such run"}, 404)
        if path == "/api/queue":
            with QUEUE_LOCK:
                return self.send_json(queue_view())
        m = re.fullmatch(r"/api/verify/([\w.+-]+)", path)
        if m:
            return self.send_json(verify_run(m.group(1)) or {"error": "no model file for this run"}, 200)
        m = re.match(r"^/api/thumb/([\w.+-]+)$", path)
        if m:
            p = thumb_path(m.group(1))
            if not p:
                return self.send_json({"error": "no thumbnail (yet)"}, 404)
            data = p.read_bytes()
            self.send_response(200)
            self.send_header("content-type", "image/png")
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "max-age=3600")
            self.end_headers()
            return self.wfile.write(data)
        if path == "/api/jobs":
            with JOBS_LOCK:
                views = [job_view(j) for j in JOBS.values()]
            env_up = (ENV_SERVER["proc"] is not None and ENV_SERVER["proc"].poll() is None) or port_open(ENV_PORT)
            return self.send_json({"jobs": sorted(views, key=lambda j: j["startedAt"], reverse=True), "envServer": env_up, "conditions": list(CONDITIONS.values()), "models": json.loads((ROOT / "tasks" / "conditions.json").read_text())["models"]})
        m = re.fullmatch(r"/api/jobs/([\w-]+)/log", path)
        if m:
            with JOBS_LOCK:
                j = JOBS.get(m.group(1))
            if not j:
                return self.send_json({"error": "no such job"}, 404)
            return self.send_text(tail(j["log"]) + ("" if j["proc"].poll() is None else ""), cache=False)
        if path.startswith("/ldraw/"):
            return self.ldraw(path[len("/ldraw/"):])
        return self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        key = (self.headers.get("x-api-key") or "").strip()
        if path == "/api/try":
            return try_prompt(self, body, key)
        if path == "/api/queue":
            try:
                return self.send_json(queue_start(body, key), 201)
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
        if path == "/api/queue/stop":
            with QUEUE_LOCK:
                QUEUE["stop"] = True
                QUEUE["pending"] = []
                running = QUEUE["running"]
            # the cells in flight finish on their own unless their jobs are stopped too
            if body.get("abort") and running:
                with JOBS_LOCK:
                    for j in JOBS.values():
                        if j["endedAt"] is None and any(j["task"] == r["task"] for r in running):
                            stop(j["proc"])
            with QUEUE_LOCK:
                return self.send_json(queue_view())
        if path == "/api/jobs":
            try:
                return self.send_json(job_view(start_job(body, key)), 201)
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
        m = re.fullmatch(r"/api/jobs/([\w-]+)/stop", path)
        if m:
            with JOBS_LOCK:
                j = JOBS.get(m.group(1))
            if not j:
                return self.send_json({"error": "no such job"}, 404)
            stop(j["proc"])
            return self.send_json(job_view(j))
        if path == "/api/env/stop":
            stop(ENV_SERVER["proc"])
            ENV_SERVER["proc"] = None
            return self.send_json({"envServer": False})
        return self.send_json({"error": "not found"}, 404)

    def ldraw(self, rel: str):
        """A part-library file: from data/ldraw/ if cached, else from the bucket (then cached)."""
        rel = rel.replace("\\", "/")
        if ".." in rel or rel.startswith("/") or not re.fullmatch(r"[\w./ -]+", rel):
            return self.send_json({"error": "bad path"}, 400)
        local = ROOT / "public" / "ldraw" / rel
        if not local.exists():
            if rel.lower() in MISSING:
                return self.send_json({"error": "no such file"}, 404)
            try:
                # (the bucket's edge refuses Python's default user agent; any other name is fine)
                req = urllib.request.Request(f"{ORIGIN}/ldraw/{rel}", headers={"User-Agent": "build-test-success/1.0"})
                with urllib.request.urlopen(req, timeout=20) as resp:
                    data = resp.read()
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    MISSING.add(rel.lower())
                return self.send_json({"error": f"bucket: {e.code}"}, e.code)
            except Exception as e:  # noqa: BLE001
                return self.send_json({"error": str(e)}, 502)
            local.parent.mkdir(parents=True, exist_ok=True)
            local.write_bytes(data)
        return self.send_text(local.read_text(errors="replace"), cache=True)


def fill(a) -> None:
    """The whole table from the terminal, no page: every cell without a record, one at a time."""
    key = os.environ.get("ANTHROPIC_API_KEY") or ""
    if not key and (ROOT / ".env").exists():
        m = re.search(r"^ANTHROPIC_API_KEY=(.+)$", (ROOT / ".env").read_text(), re.M)
        key = m.group(1).strip() if m else ""
    if not key:
        sys.exit("no ANTHROPIC_API_KEY in the environment or in .env")
    spec = {"model": a.model, "eyes": a.eyes != "off", "conditions": a.conditions.split(",") if a.conditions else None, "parallel": a.parallel,
            "skip": a.skip.split(",") if a.skip else []}
    resumes = 0
    try:
        while True:
            q = queue_start(spec, key)
            print(f"{q['have']}/{q['total']} cells have a record · {len(q['pending'])} to run · model {q['model']} · eyes {'on' if q['eyes'] else 'off'} · {q['parallel']} at a time", flush=True)
            seen = 0
            while True:
                with QUEUE_LOCK:
                    done, active, note = list(QUEUE["done"]), queue_active(), QUEUE.get("note")
                for d in done[seen:]:
                    status = "done" if d["code"] == 0 else "FAILED (exit %s)" % d["code"]
                    print(f"  {status}  {d['task']} · {CONDITION_NAMES.get(d['condition'], d['condition'])}  {d.get('seconds', '?')}s   runs/_jobs/{d.get('job', '?')}.log" + (f"\n      {d['error']}" if d.get('error') else ""), flush=True)
                seen = len(done)
                if not active:
                    break
                time.sleep(5)
            thumb_sweep()
            with THUMB_LOCK:  # wait for the last pictures
                pass
            missing = len(all_cells()) - len(done_cells())
            stopped_itself = note or any(d.get("error") for d in done)
            if not stopped_itself or not missing or resumes >= 3:
                print(note or f"{len(done_cells())}/{len(all_cells())} cells have a record")
                break
            # Stopped on repeated failures. The usual cause is the network or the API being away;
            # wait until the API answers again (up to two hours), then take up the missing cells.
            print(f"{note or 'stopped: a cell could not be started (see above)'}\n  {missing} cells still missing — waiting for the API to answer before resuming ({resumes + 1}/3)…", flush=True)
            stop(ENV_SERVER["proc"])
            ENV_SERVER["proc"] = None
            waited = 0
            while waited < 7200:
                time.sleep(60)
                waited += 60
                try:
                    req = urllib.request.Request("https://api.anthropic.com/v1/models", headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        if resp.status == 200:
                            break
                except Exception:  # noqa: BLE001
                    continue
            else:
                print("the API did not answer for two hours — giving up; run again to resume")
                break
            resumes += 1
            print(f"  API reachable again after {waited // 60} min — resuming", flush=True)
    except KeyboardInterrupt:
        print("\nstopping — the cell in flight is cut; run again to resume")
        with QUEUE_LOCK:
            QUEUE["stop"] = True
            QUEUE["pending"] = []
        with JOBS_LOCK:
            for j in JOBS.values():
                stop(j["proc"])
    finally:
        stop(ENV_SERVER["proc"])


def main() -> None:
    ap = argparse.ArgumentParser(description="the results page, or (--fill) a pass over every cell of the table without a record")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--fill", action="store_true", help="no page: run every missing task × condition, then exit (resumable; ^C stops)")
    ap.add_argument("--model", default="claude-opus-5")
    ap.add_argument("--eyes", choices=("on", "off"), default="on")
    ap.add_argument("--conditions", default="", help="comma-separated condition keys to restrict the pass to (see conditions.json)")
    ap.add_argument("--parallel", type=int, default=4, help="cells run at the same time (independent sessions; the API's rate limit is the ceiling)")
    ap.add_argument("--skip", default="", help="comma-separated task/condition-key cells to leave alone (e.g. running elsewhere)")
    a = ap.parse_args()
    (ROOT / "runs").mkdir(exist_ok=True)
    if a.fill:
        return fill(a)
    thumb_sweep()
    server = ThreadingHTTPServer(("127.0.0.1", a.port), partial(Handler, directory=str(HERE)))
    print(f"results at http://localhost:{a.port}   (results/runs/: {len(list(PUBLISHED.glob('*.json')))} published runs · runs/: {len(list(MINE.glob('*.json')))} of yours)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop(ENV_SERVER["proc"])
        with JOBS_LOCK:
            for j in JOBS.values():
                stop(j["proc"])


if __name__ == "__main__":
    main()
