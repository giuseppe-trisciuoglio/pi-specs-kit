# pi-specs-kit

[![CI](https://github.com/giuseppe-trisciuoglio/pi-specs-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/giuseppe-trisciuoglio/pi-specs-kit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@giuseppe.trisciuoglio/pi-specs-kit.svg)](https://www.npmjs.com/package/@giuseppe.trisciuoglio/pi-specs-kit)
[![npm downloads](https://img.shields.io/npm/dm/@giuseppe.trisciuoglio/pi-specs-kit.svg)](https://www.npmjs.com/package/@giuseppe.trisciuoglio/pi-specs-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![pi-package](https://img.shields.io/badge/pi-package-purple.svg)](https://github.com/earendil-works/pi)

**pi-specs-kit** is a native [pi](https://github.com/earendil-works/pi) extension
that runs the task loop of a specification straight from your interactive session.
For every task it drives the phases **implementation → review → cleanup → learner →
sync** as ephemeral `pi` subprocesses, with persisted state, spending ceilings and a
safe resume after a kill — turning a folder of task files into an autonomous
delivery pipeline you can watch and steer in plain English.

- **One agent, many phases.** Each phase is a fresh `pi` subprocess with a clean
  context; roles differ only by model and thinking level, configurable per phase.
- **Kill-safe by design.** State lives in an atomically rewritten `fix_plan.json`;
  `--resume` restarts exactly where it stopped, `--force` resets it.
- **Bounded spend.** `max_attempts`, `max_spawns_per_task`, `max_spawns_per_run` and
  `max_run_duration` keep an agent that won't converge from burning tokens forever.
- **Observable.** A live widget shows spec / task / phase / attempt / progress and
  the last line of the agent stream; the attach view renders the running phase like
  an interactive session (markdown, thinking blocks, tool rows, diffs).
- **Drivable in plain English.** The same surface is exposed as LLM tools, so you
  can say *"run the loop on spec 034 from task 5"*.
- **Hot-reload safe.** Nothing starts at load time; configuration is read on the
  first command, so `/reload` never breaks anything.

## Quick start

```bash
pi install npm:@giuseppe.trisciuoglio/pi-specs-kit
# or from git:
pi install git:github.com/giuseppe-trisciuoglio/pi-specs-kit
# or project-local (share with your team):
pi install -l npm:@giuseppe.trisciuoglio/pi-specs-kit
# or try without installing:
pi -e npm:@giuseppe.trisciuoglio/pi-specs-kit
# or from a local checkout (development):
pi -e /path/to/pi-specs-kit/src/index.ts
```

Requires [pi](https://github.com/earendil-works/pi) on your `PATH` and
Node.js **≥ 24** (the extension runs TypeScript natively — there is no build step).

## How it works

For each task in the active range, the loop runs a fixed pipeline:

| Phase | What happens |
|-------|--------------|
| **implementation** | pre hooks → phase prompt → `pi` subprocess → post hooks. A failure consumes one attempt (`max_attempts`). |
| **review** | must produce `tasks/<TASK>--review.md` with `review_status: PASSED\|FAILED`. The verdict is the only part the loop reads. A negative verdict sends the task back to implementation with the feedback, unless it repeats the previous one verbatim. |
| **cleanup** | skipped in `mode: fast`. |
| **learner** | extracts the task's learnings and accumulates them in the fix plan; later tasks receive them as memory. |
| **sync** | in fast mode, only after the last task of the range. |

When the loop finishes a task it updates its frontmatter to `reviewed` and
recomputes progress. State transitions are persisted atomically, so a crash at
any point leaves a snapshot you can resume from.

## Commands

| Command | Arguments | What it does |
|---------|-----------|--------------|
| `/specs-kit-run` | `[--spec p] [--from-task T] [--to-task T] [--phase f] [--resume] [--force]` | Starts the loop; with no arguments it opens the spec, range and phase pickers. |
| `/specs-kit-stop` | `[--now]` | Stop at the end of the phase, or immediately with `--now`. |
| `/specs-kit-status` | — | Current phase, attempt, progress, last error, log path. |
| `/specs-kit-refresh` | `[--spec p]` | Regenerate the fix plan from the task files: a task turned `reviewed` is marked done, one sent back to any other status returns to the queue. |
| `/specs-kit-attach` | — | Fullscreen transcript of the phase running now. |
| `/specs-kit-config` | — | Pick model (searchable list) and thinking level per role, edit the adversarial review panel, the phase hooks and the run options, written to the configuration. |
| `/specs-kit-new` | — | Brainstorm a new functional specification and set it active on completion. |
| `/specs-kit-spec` | — | Show or set the active spec. |
| `/specs-kit-continue` | — | Advance the active spec to its next authoring step. |

Only **one loop per session** is allowed, whether started from a command or a tool.

## Tools for the LLM

The same surface is exposed as tools so the loop can be driven in natural
language:

| Tool | What it does |
|------|--------------|
| `specs_kit_loop_start` | Start the loop on a spec / range / phase; with `resume` from the persisted state. |
| `specs_kit_loop_stop` | Ask the running loop to stop, graceful or `--now`. |
| `specs_kit_loop_status` | Current spec, task, phase, attempt, progress and last error. |
| `specs_kit_refresh` | Reconcile the fix plan of a spec with its task files on disk. |
| `specs_kit_set_active_spec` | Persist the active spec in the project configuration. |

Tools return the initial state immediately and never wait for the loop to
finish — progress surfaces through the widget and notifications.

## Configuration

`specs-kit.yaml` (format compatible with the existing one in use) lives in the
project root and defines the active spec, the models per role, run flags, hooks,
knowledge base and system-prompt overrides. Unknown fields are ignored.

The file is **optional** — without it every value falls back to its default —
but `/specs-kit-new` creates it with the defaults written out when the project
has none, so there is something to edit from the start. An existing file is
never touched.

```yaml
version: "1"
specs_dir: docs/specs
spec: docs/specs/034-example
mode: fast
agents:
  agent_model: "provider/id"
  agent_thinking_level: medium
  reviewer_model: "provider/id"
run:
  max_attempts: 5
  timeout: 60m
  no_commit: true
  skill_content: false
  continue_on_failure: false
  max_spawns_per_task: 8
  max_spawns_per_run: 60
  max_run_duration: 6h
  protect_spec_artifacts: true
hooks:
  timeout: 240s
  implementation:
    pre: ["npm run lint"]
    post: ["npm test"]
knowledge_base:
  files: ["./docs/architecture.md"]
```

**Durations** (`run.timeout`, `hooks.timeout`, `poll_interval`) always take a
unit: `ms`, `s`, `m` or `h`. A unitless number is read as **milliseconds**, so
`timeout: 3600` means 3.6 seconds and kills every phase almost immediately —
write `3600s` or `1h`. A duration of zero is refused rather than read as "no
limit". `max_attempts` and the `max_spawns_*` ceilings must be at least `1`;
lower values are ignored and the default is used.

**Roles** are `agent` (implementation), `reviewer` (review), `cleaner`
(cleanup), `synchronizer` (sync) and `learner` (learnings extraction); each one
has `<role>_model` and `<role>_thinking_level`. The default model is `auto`,
which leaves the choice to the agent CLI: in ephemeral mode that means the last
model used interactively, so pin `<role>_model` for reproducible runs (the loop
warns once per role). `/specs-kit-config` rewrites these fields surgically (with
a `.bak` backup on the first write of each session).

**Editing the configuration while a loop runs** takes effect at the next phase:
the loop re-reads the file before every phase, so a model fix, a repaired hook
or a raised budget applies to the phase about to start, not to the next run. A
file that does not parse mid-edit keeps the last loaded values with a warning;
a missing file changes nothing. The anchors resolved at start — the selected
spec, the task range, the resume point — stay start-time knobs.

**The adversarial review panel** is a separate, ordered list under
`adversarial_review.panel`: the models the pre-implementation review runs as
independent reviewers, each with an optional `thinking` level. It is empty by
default and is never filled in automatically — a review spends on every model
listed here, and several providers bill per token on every model they expose, so
the panel stays an explicit choice. Edit it from `/specs-kit-config` →
*Adversarial review panel*, where the order of the list decides which reviewer
holds which critique angle.

**What a task may not rewrite.** `run.protect_spec_artifacts` (on by default)
refuses an implementation attempt that changed the spec's requirement document
or any file under its `contracts/` folder: those state what the work is measured
against, and an agent that can edit them closes any mismatch by moving the
target. The attempt comes back naming the files, with the two ways out —
change the code, or report the conflict for a decision taken outside the
session. Working documents (decision log, task files, plan, README) stay
writable. Turn the flag off for a run whose job is to revise those documents.

**When a review contradicts the spec.** A review report may carry a
`spec_conflicts` list. A non-empty list is read as a rejection whatever
`review_status` says: the reviewer describes the contradiction, the loop decides
what it costs. The same applies to a fix routed to a task that is not still
pending inside the range — the deferral is refused and the fix comes back to the
task at hand.

**When the range closes**, the loop re-derives two claims it can check without a
model: every coverage-matrix row marked implemented or verified must cite a test
file that exists (and, when the citation names a test, a name that is in it), and
no review fix may be left routed to a task that never completed. Both are
warnings, printed once with the closing notices.

## Spending ceilings

`max_attempts` and `review_file_retry` bound their own step, but they multiply:
a review budget spent inside every attempt costs their product in agent
sessions. Three ceilings bound the run as a whole, charged once per agent
subprocess whatever phase asks for it:

| Key | Default | Bounds |
|-----|---------|--------|
| `run.max_spawns_per_task` | 8 | Agent sessions one task may spend across all its phases. |
| `run.max_spawns_per_run` | 60 | Agent sessions the whole run may spend. |
| `run.max_run_duration` | 6h | Wall-clock time of the whole run. |

Crossing one ends the run with `state.step: failed` and the reason in
`state.error`, whatever `continue_on_failure` says: a budget already exhausted
cannot afford the next task either.

## State, logs and measurements

- **Loop state** lives in `<spec>/_ralph_loop/fix_plan.json`, saved atomically
  after every transition. `--resume` restarts from it, `--force` resets it.
- **Per-phase logs** end up in `<spec>/_ralph_loop/logs/` (disable with
  `run.no_log_files`). Finished phases stay available there.
- **Measurements** (tokens and durations) never live in the fix plan: the
  append-only ledger is `<specs_dir>/measurements.jsonl`, fed by a write-ahead
  buffer in `~/.pi/agent/specs-kit/`. Measurement I/O is best-effort and never
  fails the loop.

## Authoring workflow

The package ships a chain of bundled skills that takes a feature idea from a
brainstorm to a trackable task list:

```
specs-kit-brainstorm            # docs/specs/[id]/YYYY-MM-DD--feature-name.md
specs-kit-spec-check            # resolve [NEEDS CLARIFICATION] markers
specs-kit-technical-plan        # architectural decisions, stack, phases
specs-kit-spec-to-tasks         # docs/specs/[id]/.../data-model.md, contracts/, tasks
specs-kit-adversarial-review    # stress-test spec + tasks with a panel of models
specs-kit-task-implementation   # /skill:specs-kit-task-implementation --task=T001
specs-kit-task-review           # validate the task against its spec
specs-kit-code-cleanup          # cosmetic hygiene before completion
specs-kit-sync                  # reconcile spec ↔ test ↔ code
```

The loop itself only consumes the **tasks** folder produced by
`specs-kit-spec-to-tasks`. Everything upstream is optional and can be skipped
when the project already has its own authoring chain.

## Known limitations

- **One loop per session.** Starting a second one returns an error — the loop's
  state and widget assume exclusive ownership of the spec/range.
- **Bash subprocess required.** The loop spawns `pi` as a child process; running
  it from a session where `pi` is not on `PATH` fails before the first phase.
- **Ephemeral mode only.** The implementation phase always runs `pi --ephemeral`
  so each attempt starts from a clean context. A non-ephemeral run with
  conversation history is not supported.
- **Range boundaries are inclusive and contiguous.** A range with a gap between
  `from_task` and `to_task` is rejected before the first phase; out-of-range
  fixes from a reviewer are sent back to the task at hand (see "When a review
  contradicts the spec").

## Development

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # unit + e2e with a fake agent on PATH
```

Tests run on Node 24 with no build step — TypeScript is executed natively. The
e2e suite replaces the agent binary with a script that emits the same JSON
stream, so the full loop (retry, halt, resume) is verifiable without calls to a
model.

Load the extension locally for exploratory runs:

```bash
pi -e ./src/index.ts
```

## Contributing

Contributions are welcome! Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md)
for setup, the coding conventions the project enforces, and the release
process. By participating you agree to abide by the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) © Giuseppe Trisciuoglio