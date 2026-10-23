# Build, Test, Success: Verification in the Loop Turns LLM Agents into Brick Builders

Code, tasks and results for the paper (Evaluation of Interactive Agents workshop, NeurIPS 2026).
Maksym Bondarenko, Independent Researcher.

The paper asks whether a language model can build a physical structure out of LEGO® bricks. Its
finding: the same frontier model that passes almost none of thirteen construction tasks when
writing a brick file directly passes nearly all of them inside a build-and-check loop, and an
ablation attributes the difference to verification.

This repository holds all five conditions of the paper — the two baselines and the three
environment conditions — the grader, a results viewer, and the grade records behind every number
in the paper. The environment is the copilot of [Danish Bricks Builder](https://danish-bricks-builder.vercel.app),
carved out so it runs on its own (`env/`).

## What is here

| | |
|---|---|
| `tasks.json` | the thirteen tasks, verbatim: prompt, type, the official set behind the edit and inventory tasks, and `post`, the machine-checked requirements |
| `grade.ts` | the grader: connection validity and collision, stability, task requirements. The same engine code (`lib/`) that graded the paper's runs |
| `baseline.py` | the baseline runner: `raw` (one shot) and `raw+feedback` (four attempts with the validator's report pasted back as text), with the paper's exact prompts |
| `report.py` | the results table in the paper's notation, for your runs and for the paper's records |
| `env/` | the environment: `server.ts` serves the copilot route on plain Node; `run.ts` drives one session per task and condition |
| `conditions.json` | the five conditions: harness key, paper name, what each one is |
| `records/` | the paper's grade records, one JSON per run (55 runs over the five conditions), with the final `.ldr` model beside most of them |
| `sessions/` | the harness's recording of each session, `run.json` + `toolLog.jsonl` + `snapshots/` — the paper's are being restored from the machine that ran them and will land here |
| `lib/` | the engine: connector library and mate detection, voxel collision, statics, LDraw parsing |

## The paper's results, from the records

```
$ python3 report.py --paper
task                            raw  raw+feedback           env     env+gates      env+full
wall-doorway                      ✓             —             —             —             ✓
tower-square                     ×v             —             —             ✓             ✓
house-gable                      ×v             —             —             —             ✓
pyramid-steps                     ✓             —             —             —             ✓
lighthouse-tall                  ×v            ×v            ×f             ✓             ✓
roman-aqueduct                   ×v             ✓            ×f             ✓             ✓
greek-temple                     ×v            ×v             ∅             ✓             ✓
pyramid-giza                     ×s             ✓            ×s             ✓             ✓
colosseum-ring                    ∅            ×v            ×f             ✓             ✓
notre-dame-de-paris               ∅             —             —             —            ×f
taj-mahal                         ∅             —             —             —             ✓
edit-ghost-pedestal               —             —             ∅             ✓             ✓
inv-dinosaur                     ×v            ×v             ✓             ✓             ✓
pass                           2/12           2/6           1/7           8/8         12/13
```

`✓` every check passes · `×v` parts collide or float · `×s` falls over · `×f` too big for the
footprint · `∅` no model produced · `—` not run or not expressible. Conditions as in Sec. 3.7:
`raw` writes an LDraw file in one shot; `raw+feedback` gets the validator's report back as text
for up to four attempts; `env` is the interactive environment with no verification;
`env+gates` verifies when the agent declares completion, with bounded repair; `env+full` adds
the checks as tools the agent may call. The five-condition ablation ran on the seven-task subset.

## Reproducing the baseline

Needs Node 20+, Python 3.10+, and an Anthropic API key.

```sh
npm install
sh fetch-data.sh                      # ~28 MB of part data, see DATA-LICENSES.md
pip install anthropic
export ANTHROPIC_API_KEY=…            # or put it in .env

python3 baseline.py --condition raw                          # the 12 attemptable tasks
python3 baseline.py --condition raw+feedback --tasks ablation
python3 baseline.py --condition raw --tasks wall-doorway,pyramid-steps
python3 baseline.py --dry-run --tasks greek-temple           # print the prompt, call nothing
python3 report.py                                            # your table
```

Each run writes `runs/<runId>.json` (every attempt's file, report and grade) and
`runs/<runId>.ldr` (the final model). The model is `claude-opus-5` as in the paper, one session
per task: a rerun can differ from the paper's single run, which measures the existence of the
effect rather than its variance. The edit task cannot run without the environment, which is why
the paper reports it as not expressible in the raw conditions.

Grade any LDraw file against a task:

```sh
npx tsx grade.ts some-model.ldr --task greek-temple
```

## Reproducing the environment conditions

The three env conditions run the agent inside the environment. Two terminals:

```sh
sh fetch-data.sh --eyes               # part data, the edit task's set, and what render_view needs
export ANTHROPIC_API_KEY=…
npx tsx env/server.ts                 # terminal 1: the environment, http://localhost:8788

npx tsx env/run.ts --task=greek-temple --condition=verifier    # terminal 2: env+full
npx tsx env/run.ts --task=greek-temple --condition=bare        # env+gates
npx tsx env/run.ts --task=greek-temple --condition=none        # env
```

`verifier` offers the validator as tools and gates completion; `bare` gates only; `none` neither,
though every placement is still checked as it is made. Each session is recorded under
`sessions/<runId>/` and graded into `runs/<runId>.json`. The agent's "eyes" (`render_view`) need
Chrome on the machine (`CHROME_PATH` or a standard install) and the packed part files from
`fetch-data.sh --eyes`; pass `--eyes=off` to run blind, which the paper did not. The paper's runs
used `claude-opus-5` with up to 90 tool-loop iterations; a session takes minutes and the
monumental tasks tens of minutes.

## Looking at the runs, and trying it yourself

```sh
python3 serve.py            # http://localhost:8787
```

Two tabs. **Paper results**: the paper's runs and your reruns in one table, every task against
every condition. **Try it yourself**: type any prompt, pick a condition, press run, and watch it
happen — for the environment conditions every tool call streams into the page and the model grows
in 3D as the agent places parts; at the end the build is graded like the paper's runs and listed
under "your prompts". The rerun panel on the paper tab
runs a condition from the page: paste your API key (it stays in this browser and in the server's
memory, never on disk), pick a task and a condition, and press run; the log streams below and the
result lands in the table. The three environment conditions start the environment server for you
on port 8788. Click a cell: the
model in 3D (orbit, zoom, x-ray), its grade with the validator's and the stability reports, the
attempt-by-attempt trace where the record has one (your own runs keep the whole conversation;
a session folder shows every tool call with its snapshot), and the LDraw source. Standard library only;
part geometry is fetched from the data bucket as needed and cached under `data/ldraw/`.

## Citing

```bibtex
@inproceedings{bondarenko2026buildtestsuccess,
  title     = {Build, Test, Success: Verification in the Loop Turns LLM Agents into Brick Builders},
  author    = {Bondarenko, Maksym},
  booktitle = {NeurIPS 2026 Workshop on Evaluation of Interactive Agents},
  year      = {2026}
}
```

Code is MIT; the part data keeps its sources' licenses (see `DATA-LICENSES.md`). LEGO® is a
trademark of the LEGO Group, which does not sponsor, authorize or endorse this work.
