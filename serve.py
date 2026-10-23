#!/usr/bin/env python3
"""
A small results server: the paper's runs and yours in one table, each one viewable in 3D with
its grade, its attempt-by-attempt trace and its LDraw source.

    python3 serve.py              # then open http://localhost:8787
    python3 serve.py --port 9000

Standard library only. The 3D view needs LDraw part files; they are fetched from the data bucket
the first time a part is seen and cached under public/ldraw/ (the bucket has no CORS headers, so the
browser cannot fetch them itself — this server stands in between).

Routes:
    /                  the page (viewer/index.html)
    /api/runs          every run in records/ (the paper's) and runs/ (yours), normalized
    /api/run/<id>      one run: the grade record, the LDraw text, the conversation or session if recorded
    /api/snapshot/<id>/<file>   a model snapshot from sessions/<id>/snapshots/
    /ldraw/<path>      a part-library file, cached from the bucket
"""
from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ORIGIN = "https://pub-09680f02457547f9bd4034ba506c47d7.r2.dev"
CONDITION_NAMES = {c["key"]: c["name"] for c in json.loads((HERE / "conditions.json").read_text())["conditions"]}
CONDITION_NAMES.update({c["name"]: c["name"] for c in json.loads((HERE / "conditions.json").read_text())["conditions"]})
MISSING: set[str] = set()  # part-library paths the bucket does not have (so we ask once)


def mark(g: dict) -> str:
    """The paper's Table 1 notation for one grade record."""
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
    final = r.get("final") or r  # baseline.py records keep the final grade under `final`
    rounds = []
    for x in r.get("rounds") or []:
        if "grade" in x:  # baseline.py: the grade object per attempt
            g = x.get("grade") or {}
            rounds.append({"round": x["round"], "parts": g.get("partCount"), "valid": g.get("valid"), "stable": g.get("stable"),
                           "note": g.get("parseError") or (g.get("verifyReport") or "")[:300] if g else "no LDraw in the response", "ldr": x.get("ldr")})
        else:  # the paper's harness: a summary line per round
            rounds.append({"round": x.get("round"), "parts": x.get("parts"), "valid": x.get("valid"), "stable": x.get("stable"), "note": (x.get("report") or "")[:300], "ldr": None})
    run_id = r.get("runId") or path.stem
    return {
        "id": run_id, "source": source, "task": r.get("task"), "condition": CONDITION_NAMES.get(r.get("condition"), r.get("condition")),
        "model": r.get("model"), "era": run_id.rsplit("_", 1)[-1][:3], "seconds": r.get("seconds"),
        "PASS": bool(final.get("PASS")), "mark": mark(final), "partCount": final.get("partCount"), "valid": final.get("valid"),
        "stable": final.get("stable"), "post": final.get("post"), "heightLdu": final.get("heightLdu"), "footprintStuds": final.get("footprintStuds"),
        "verifyReport": final.get("verifyReport"), "stabilityReport": final.get("stabilityReport"), "rounds": rounds,
        "hasLdr": path.with_suffix(".ldr").exists(), "file": str(path.relative_to(HERE)),
        "conversation": r.get("conversation"), "hasSession": (HERE / "sessions" / run_id / "run.json").exists(),
    }


def session(run_id: str) -> dict | None:
    """The harness's own recording of a session, when sessions/<runId>/ holds one: run.json (the
    turns, each with the message the agent was given) and toolLog.jsonl (one line per tool call:
    name, input, result, and the model snapshot taken after it)."""
    d = HERE / "sessions" / run_id
    if not (d / "run.json").exists():
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
    out = [normalize(p, "paper") for p in sorted((HERE / "records").glob("*.json"))]
    out += [normalize(p, "mine") for p in sorted((HERE / "runs").glob("*.json"))]
    return out


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
            return self.send_text((HERE / "viewer" / "index.html").read_text(), "text/html; charset=utf-8")
        if path == "/api/runs":
            tasks = json.loads((HERE / "tasks.json").read_text())
            return self.send_json({"tasks": [{"id": t["id"], "band": t["band"], "type": t["type"]} for t in tasks["tasks"]], "runs": all_runs()})
        m = re.fullmatch(r"/api/run/([\w.-]+)", path)
        if m:
            for d in ("records", "runs"):
                p = HERE / d / f"{m.group(1)}.json"
                if p.exists():
                    run = normalize(p, "paper" if d == "records" else "mine")
                    ldr = p.with_suffix(".ldr")
                    run["ldraw"] = ldr.read_text() if ldr.exists() else None
                    # earlier attempts of a baseline.py run, when kept
                    run["attempts"] = {x["ldr"]: (HERE / "runs" / x["ldr"]).read_text() for x in run["rounds"] if x.get("ldr") and (HERE / "runs" / x["ldr"]).exists()}
                    run["session"] = session(run["id"])
                    return self.send_json(run)
            return self.send_json({"error": "no such run"}, 404)
        m = re.fullmatch(r"/api/snapshot/([\w.-]+)/([\w.-]+)", path)
        if m:
            p = HERE / "sessions" / m.group(1) / "snapshots" / m.group(2)
            if p.exists():
                return self.send_text(p.read_text())
            return self.send_json({"error": "no such run"}, 404)
        if path.startswith("/ldraw/"):
            return self.ldraw(path[len("/ldraw/"):])
        return self.send_json({"error": "not found"}, 404)

    def ldraw(self, rel: str):
        """A part-library file: from data/ldraw/ if cached, else from the bucket (then cached)."""
        rel = rel.replace("\\", "/")
        if ".." in rel or rel.startswith("/") or not re.fullmatch(r"[\w./ -]+", rel):
            return self.send_json({"error": "bad path"}, 400)
        local = HERE / "public" / "ldraw" / rel
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    a = ap.parse_args()
    (HERE / "runs").mkdir(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", a.port), partial(Handler, directory=str(HERE / "viewer")))
    print(f"results at http://localhost:{a.port}   (records/: {len(list((HERE / 'records').glob('*.json')))} paper runs · runs/: {len(list((HERE / 'runs').glob('*.json')))} of yours)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
