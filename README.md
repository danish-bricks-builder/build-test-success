# Build, Test, Success

Can a language model build a physical structure? We gave a frontier model LEGO® bricks, in the
machine-readable LDraw format, and asked it to build a wall, a lighthouse, a Greek temple, Notre-Dame.
Then we checked every build the way physics would: does every part connect, does nothing overlap, does it
stand, does it fit the brief. This repository is the whole experiment: the tasks, the grader, the
building environment, the runs behind every number, and a viewer to look at them in 3D.

What we found, in short: writing the file in one go, the model passes 2 of 13 tasks. Told *which*
parts are wrong, it passes 10. Building piece by piece in an environment that refuses an invalid
placement, 12. With the validator at hand during the build, all 13.

| | one-shot | one-shot+feedback | interactive | +final check | +check tools |
|---|:-:|:-:|:-:|:-:|:-:|
| tasks passed | 2/13 | 10/13 | 12/13 | 12/13 | 13/13 |

Paper: [`paper/build-test-success.pdf`](paper/build-test-success.pdf) (NeurIPS 2026, workshop on
Evaluation of Interactive Agents). This work is part of a larger project, [Danish Bricks
Builder](https://github.com/danish-bricks-builder), a LEGO studio where people and AI build together.
Check it out.

## Setup

Needs Node 20+ and Python 3.10+. Chrome is needed for the agent's eyes (it renders its own build) and for
thumbnails; without Chrome, build with `--no-eyes`.

```sh
git clone https://github.com/danish-bricks-builder/build-test-success.git
cd build-test-success
sh scripts/setup.sh        # npm install · ~30 MB of part data · a python venv for the one-shot modes
```

Everything runs from the repository root. To build anything you need an Anthropic API key: export
`ANTHROPIC_API_KEY`, or put `ANTHROPIC_API_KEY=…` in a file called `.env` (git ignores it), or paste it
into the viewer, which keeps it in your browser and in the server's memory only.

## 1. Look at our results, and reproduce them

```sh
python3 viewer/serve.py        # → http://localhost:8787
```

The **results** tab is the table above with a picture in every cell. Click a cell: the build in 3D, its
grade with every check the task set (asked vs measured), the faults painted on the model (orange floats,
red collides; tick a stage to see what each check saw), the full trace of the session — every tool call,
every picture the model was shown, every file it wrote — and the LDraw source.

The pieces behind it:

- `tasks/tasks.json` — the 13 tasks: each one's prompt and machine-checked limits.
- `tasks/conditions.json` — the five modes and what each adds.
- `results/runs/` — one grade record and one final `.ldr` per cell; `results/sessions/` — the full
  recording of every interactive session; `results/thumbs/` — the pictures.
- `grader/grade.ts` — the grader: `npx tsx grader/grade.ts results/runs/<run>.ldr --task <task>`.
- `paper/report.py` prints the table; `paper/paper.py` regenerates every number in the paper from the
  records.

To rerun everything yourself:

```sh
python3 reproduce.py                          # every cell without a record in runs/, 5 at a time; ^C and rerun to resume
python3 reproduce.py --conditions none,bare   # only some modes (keys in tasks/conditions.json)
```

Your runs land in `runs/` and show up in the viewer next to ours. **What it costs**, from our runs with
`claude-opus-5`: the whole table was about **$115** and **6 hours** with five cells in parallel (0.6M
input, 2.6M output and 52M cached tokens). A cell is usually $1–2 and 5–30 minutes; the monumental tasks
run 30–110 minutes, and the expensive cells reach $8–10. More cells in parallel shortens the wall time, not
the bill; the API's rate limit is the ceiling. The **run cells** tab in the viewer does the same thing from
the browser, one cell or the whole table.

## 2. Build something yourself

```sh
python3 build.py "Build a small lighthouse: a square base, a tapering tower in red and white bands, a lantern on top."
python3 build.py "a stone bridge with three arches" --mode one-shot+feedback
python3 build.py "a Japanese pagoda, five tiers" --model claude-opus-5-5 --no-eyes
```

The default mode is `interactive+check-tools`, the one that passes everything. The result is graded like
ours (valid, stable), and the viewer's **try it yourself** tab shows it; in the interactive modes you can
also build from that tab and watch the model grow in 3D, tool call by tool call. One build costs a few
cents in one-shot and $1–5 in the interactive modes, depending on size.

To add a task of your own, append it to `tasks/tasks.json`: a prompt, a band, and whichever limits you
want checked (`minParts`, `minHeightLdu`, `maxFootprintStuds`; for special tasks `minPreserved`,
`partNames`, or a `set` inventory). Then run it with `python3 reproduce.py` or from the run tab.

## The modes

Each adds one thing to the one before it.

| mode | what the model gets |
|---|---|
| `one-shot` | the prompt; it writes the whole LDraw file in one reply |
| `one-shot+feedback` | up to four replies; between them, the grader's report naming every faulty part and why |
| `interactive` | builds piece by piece in the environment; each placement is checked as it is made; nothing checks the finished build |
| `interactive+final check` | …and when it declares the build done, the validator runs and it gets two repair rounds per failing check |
| `interactive+check tools` | …and the validator is also a tool it can call at any point |

## Layout

```
build.py · reproduce.py      the two entry points above
tasks/                       tasks.json, conditions.json
grader/                      grade.ts (the grader), regrade.py, flatten.ts
runners/                     oneshot.py (the one-shot modes) · environment/ (the building environment: server.ts, route.ts, run.ts)
viewer/                      serve.py (results server and run queue) · index.html · thumb.ts
results/                     runs/ · sessions/ · thumbs/ — the published runs
paper/                       the PDF · paper.py (table and numbers) · figures.ts (the appendix grid) · out/
lib/                         the engine: connections, collisions, stability, rendering, the agent's tools
scripts/                     setup.sh, fetch-data.sh
runs/                        your own runs (not committed)
```

## Citing

```bibtex
@inproceedings{bondarenko2026buildtestsuccess,
  title     = {Build, Test, Success: Verification in the Loop Turns LLM Agents into Brick Builders},
  author    = {Bondarenko, Maksym},
  booktitle = {NeurIPS 2026 Workshop on Evaluation of Interactive Agents},
  year      = {2026}
}
```

Code is MIT (`LICENSE`); the part data has its own licenses (`DATA-LICENSES.md`). LEGO® is a trademark
of the LEGO Group, which does not sponsor, authorize or endorse this work.
