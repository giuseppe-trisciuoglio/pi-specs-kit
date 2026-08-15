# pi-specs-kit

[![CI](https://github.com/giuseppe-trisciuoglio/pi-rules/actions/workflows/ci.yml/badge.svg)](https://github.com/giuseppe-trisciuoglio/pi-rules/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@giuseppe.trisciuoglio/pi-specs-kit.svg)](https://www.npmjs.com/package/@giuseppe.trisciuoglio/pi-specs-kit)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A524-green.svg)](https://nodejs.org)
[![pi-package](https://img.shields.io/badge/pi-package-purple.svg)](https://github.com/earendil-works/pi-coding-agent)

> A native [pi](https://github.com/earendil-works/pi-coding-agent) extension that
> runs the task loop of a specification straight from your interactive session.
> For every task it drives the phases
> **implementation → review → cleanup → sync** as ephemeral `pi` subprocesses,
> with persisted state, spending ceilings, and safe resume after a kill.

`pi-specs-kit` turns a folder of task files into an autonomous delivery pipeline
that an agent runs to completion: each task is implemented, reviewed against its
spec, cleaned up, and synchronised — while you watch a live transcript, intervene
through commands or natural language, and resume deterministically from where
you left off.

---

## Table of contents

- [Highlights](#highlights)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Tools for the LLM](#tools-for-the-llm)
- [Configuration](#configuration)
- [Spending ceilings](#spending-ceilings)
- [State, logs and measurements](#state-logs-and-measurements)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Highlights

- **One agent, many phases.** Each phase is a fresh `pi` subprocess with a
  clean context; roles differ only by model and thinking level, configurable
  per phase.
- **Kill-safe by design.** State lives in an atomically-rewritten
  `fix_plan.json`; `--resume` restarts exactly where it stopped, `--force`
  resets it.
- **Bounded spend.** Retry budgets plus whole-run ceilings
  (`max_spawns_per_task`, `max_spawns_per_run`, `max_run_duration`) keep an
  agent that won't converge from burning tokens forever.
- **Observable.** A live widget shows spec/task/phase/attempt/progress; the
  attach view renders the running phase exactly like an interactive session
  (markdown, thinking blocks, tool rows, diffs).
- **Drivable in plain English.** The same surface is exposed as LLM tools, so
  you can say "run the loop on spec 034 from task 5".
- **Hot-reload safe.** Nothing starts at load time; configuration is read on
  the first command, so `/reload` never breaks anything.

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

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) on your `PATH`.
- Node.js **≥ 24** (the extension runs TypeScript natively; there is no build step).

## Installation

`pi-specs-kit` is a pi package. Pick whichever source you prefer.

### From npm (recommended)

```bash
pi install npm:@giuseppe.trisciuoglio/pi-specs-kit
```

This registers the package in your pi settings and makes its commands, tools and
bundled skills available in every session.

### From git

```bash
pi install git:github.com/giuseppe-trisciuoglio/pi-rules
```

### Project-local (share with your team)

Add it to `.pi/settings.json` instead of the global settings:

```bash
pi install -l npm:@giuseppe.trisciuoglio/pi-specs-kit
```

### Try without installing

```bash
pi -e npm:@giuseppe.trisciuoglio/pi-specs-kit
```

### From source (development)

```bash
git clone https://github.com/giuseppe-trisciuoglio/pi-rules.git
cd pi-specs-kit
npm ci
pi -e ./src/index.ts
```

## Quick start

1. **Create a spec** with the authoring chain (or point the extension at an
   existing one):

   ```text
   /specs-kit-new          # brainstorm a new functional spec and set it active
   ```

2. **Configure models and run options** once:

   ```text
   /specs-kit-config       # searchable model + thinking picker, written to specs-kit.yaml
   ```

3. **Run the loop**:

   ```text
   /specs-kit-run          # opens the spec / range / phase pickers
   ```

   Or drive it in natural language:

   ```text
   Start the loop on spec 034 from task 5 through task 9.
   ```

4. **Watch and steer**:

   ```text
   /specs-kit-attach       # live transcript of the phase running now
   /specs-kit-status       # phase, attempt, progress, last error, log path
   /specs-kit-stop         # halt at end of phase (or --now for immediate)
   ```

While the loop runs, a widget above the editor shows spec, task, phase, attempt,
progress, elapsed time and the last line of the agent stream. In the transcript,
`q`/`Esc` closes the view (loop keeps running), `ctrl+o` toggles tool output,
`ctrl+c` interrupts the current phase (counted as a failed attempt and retried
within `max_attempts`).

## Commands

| Command | Arguments | What it does |
|---------|-----------|--------------|
| `/specs-kit-run` | `[--spec p] [--from-task T] [--to-task T] [--phase f] [--resume] [--force]` | Starts the loop; with no arguments it opens the spec, range and phase pickers. |
| `/specs-kit-stop` | `[--now]` | Stop at the end of the phase, or immediately with `--now`. |
| `/specs-kit-status` | — | Current phase, attempt, progress, last error, log path. |
| `/specs-kit-refresh` | `[--spec p]` | Regenerate the fix plan from the task files: a task turned reviewed is marked done, one sent back to any other status returns to the queue. |
| `/specs-kit-attach` | — | Fullscreen transcript of the phase running now. |
| `/specs-kit-config` | — | Pick model (searchable list) and thinking level per role, edit the adversarial review panel, the phase hooks and the run options, written to the configuration. |
| `/specs-kit-new` | — | Brainstorm a new functional specification and set it active on completion. |
| `/specs-kit-spec` | — | Show or set the active spec. |
| `/specs-kit-continue` | — | Advance the active spec to its next authoring step. |

Only **one loop per session** is allowed, whether started from a command or a tool.

## Tools for the LLM

The same surface is exposed as tools so the loop can be driven in natural
language: `specs_kit_loop_start`, `specs_kit_loop_stop`, `specs_kit_loop_status`,
`specs_kit_refresh`, `specs_kit_set_active_spec`. The tools do not wait for the
loop to finish — they return the initial state immediately and progress arrives
through the widget and notifications.

## Configuration

The `specs-kit.yaml` file in the project root (format compatible with the
existing one in use) defines the active spec, the models per role, run flags,
hooks, knowledge base and system-prompt overrides. Unknown fields are ignored.

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
  skill_content: true
  continue_on_failure: false
  max_spawns_per_task: 8
  max_spawns_per_run: 60
  max_run_duration: 6h
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

**The adversarial review panel** is a separate, ordered list under
`adversarial_review.panel`: the models the pre-implementation review runs as
independent reviewers, each with an optional `thinking` level. It is empty by
default and is never filled in automatically — a review spends on every model
listed here, and several providers bill per token on every model they expose, so
the panel stays an explicit choice. Edit it from `/specs-kit-config` →
*Adversarial review panel*, where the order of the list decides which reviewer
holds which critique angle.

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
