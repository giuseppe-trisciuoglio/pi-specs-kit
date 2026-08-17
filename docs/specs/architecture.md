# Project Architecture

**Created**: 2026-08-17
**Last Updated**: 2026-08-17

---

## 1. Logical Architecture

> pi-specs-kit: a pi extension that runs the task loop of a spec (implementation → review → cleanup → sync) by orchestrating `pi` agent subprocesses from the interactive pi session, with persisted state and safe resume.

### 1.1 Domains and Bounded Contexts

| Bounded Context | Description | Key Responsibilities | Dependencies |
|-----------------|-------------|----------------------|--------------|
| Loop (Ciclo) | Execution of a spec's tasks: per-task phase cycle, retries, state persistence | Run orchestration, task selection walk, declared graph interpretation, halt/stop/resume | Configurazione, Fix plan, Misure |
| Consegna (Delivery) | Post-run delivery of completed work: commit, push, pull request creation | Branch decision, delivery commit, forge interaction, outcome notification | Loop terminal state, Configurazione, git + forge CLI |
| Configurazione | Project yaml configuration | Typed tolerant loading of flags, roles, limits, base branch | None — core context |
| Authoring | Spec creation chain and active-spec persistence | Authoring commands, spec state, authoring windows | Configurazione, Misure |
| Misure (Measurement) | Consumption/duration ledger for phases and authoring windows | WAL buffering, append-only ledger, per-phase metering | None — core context |
| Prompt | Phase prompt assembly | Skill resolution, knowledge base injection, memory, routed suggestions | Loop, Configurazione |
| UI | Interactive surfaces in pi | Live widget, transcription view, config pickers | Loop status |
| Tools | LLM-callable loop tools | start/stop/status/refresh | Loop |

### 1.2 Module Map

```
┌────────────────────────────────────────────────────────────────┐
│                        pi-specs-kit                             │
├──────────┬───────────┬──────────┬──────────┬──────────────────┤
│  loop/   │  config/  │ prompt/  │ measure/ │  ui/  tools/     │
│ engine,  │ loader +  │ builder, │ ledger,  │ widget, pickers, │
│ graph/,  │ writer    │ skills   │ wal,     │ transcript,      │
│ delivery │           │          │ meter    │ loop tools       │
│   → agent/spawner (subprocess pi)   → fixplan/ (state)         │
│   → tasks/ (parsing)               → util/process (spawn)      │
└────────────────────────────────────────────────────────────────┘
```

### 1.3 Shared Kernel

| Shared Concept | Used By | Description |
|---------------|---------|-------------|
| Fix plan (`_ralph_loop/fix_plan.json`) | Loop, UI, Tools | Single source of truth of loop state; atomic writes; tolerant reads |
| `spawnProcess` (util/process) | Loop, agent, delivery, checks | Hardened subprocess wrapper: process-group kill, timeout, abort, captured stdio |
| Notification channel (`[specs-kit]` prefixed) | Loop, Consegna, Tools | Operator-facing info/warning/error messages, English |
| Injected deps pattern (`*Deps` interfaces) | Loop, engine, tests | All side-effecting collaborators are injectable for unit tests |

### 1.4 Context Map

| Upstream | Downstream | Relationship Pattern | Notes |
|----------|-----------|---------------------|-------|
| Configurazione | Loop, Consegna, Prompt, Misure | Published Language | yaml schema shared by all consumers |
| Loop | Consegna | Event (terminal state) | Consegna consumes the completed terminal state; writes nothing back |
| graphify (external skill) | Loop (sync, validation) | Open Host Service | Single graph file `graphify-out/graph.json`, refreshed by sync |

---

## 2. Infrastructure Architecture

### 2.1 Deployment Topology

```
[Developer machine]
   pi (interactive session)
     └─ loads extension (src/index.ts, no build step)
          └─ spawns `pi` subprocesses per phase
               └─ spawn `git` / `gh` (delivery) / graphify (sync)
[npm registry] ← GitHub Release workflow (vX.Y.Z tag → publish)
```

### 2.2 Infrastructure Components

| Component | Technology | Version | Purpose | Environment |
|-----------|-----------|---------|---------|-------------|
| Distribution | npm package | node >= 24 | Public package installed as pi extension | All |
| Publish pipeline | GitHub Actions | n/a | Tag-driven publish with three gates (test, typecheck, lint) | CI |
| External binary: agent | `pi` CLI | — | Phase subprocesses (only agent) | Local |
| External binary: git | system git | ≥ 2.30 | Checkpoints, delivery (branch/commit/push) | Local |
| External binary: forge CLI | GitHub CLI (`gh`) | ≥ 2.40 | Pull request creation/view at delivery | Local |
| External skill: graphify | installed separately | — | Sole source of the codebase graph | Local |

### 2.3 Networking

Not applicable: the extension runs locally; the only network egress is the forge CLI's own authenticated session during delivery, and the agent CLI's provider traffic.

### 2.4 Scaling Strategy

Not applicable: single-process interactive extension; concurrency is bounded by spawn budgets (`max_spawns_per_task`, `max_spawns_per_run`) and wall-clock limits.

### 2.5 Environments

| Environment | Purpose | Access | Differences |
|-------------|---------|--------|-------------|
| Local dev | Development | `pi -e ./src/index.ts`, `/reload` | Hot reload first: no resources at load time |
| Published | Users | npm install | Same code; no build step |

---

## 3. Software Architecture

### 3.1 Technology Stack

| Component | Technology | Version | Notes |
|-----------|-----------|---------|-------|
| Language | TypeScript | 5.9.x | Executed natively by Node; tsconfig for typecheck/editor only |
| Runtime | Node.js | 24.x | `node:test` runs TS directly |
| Runtime dependency | yaml | ^2.8.0 | The only runtime dep beyond pi-provided packages |
| Pi-provided (peer) | pi-ai, pi-coding-agent, pi-tui, typebox | ^0.84.x / 1.3.x | Never imported by modules that unit tests load (type-only) |
| Testing | node:test | built-in | Unit with injected fakes; e2e with fake binaries on PATH |
| Lint | eslint (flat config) | ^9 | AST-level; types belong to tsc |
| Agent | `pi` CLI | — | The only agent; roles differ by model + thinking level |

### 3.2 Data Architecture

| Component | Technology | Notes |
|-----------|-----------|-------|
| Primary state | `_ralph_loop/fix_plan.json` per spec | Single source of truth; atomic tmp+rename writes; tolerant reads |
| Configuration | `specs-kit.yaml` at project root | Tolerant loader; only modeled fields written back |
| Measurement ledger | `<specs_dir>/measurements.jsonl` | Append-only, versioned; WAL buffer in `~/.pi/agent/specs-kit/` |
| Codebase graph | `graphify-out/graph.json` | Owned by graphify; never written by this extension |
| VCS state | git | Checkpoints and delivery; best-effort |

### 3.2a Configuration Keys

The yaml configuration at `specs-kit.yaml` is the operator-facing surface. Each key has a tolerant default; unknown or malformed values fall back to the default without failing the run (the loader is the source of tolerance, not the caller). The keys actually shaping the loop's behaviour:

| Key | Type | Default | Used by | Closed by |
|-----|------|---------|---------|-----------|
| `mode` | `fast` \| `full` | `fast` | Loop runner | — |
| `poll_interval` | duration string | `100ms` | Loop runner | — |
| `agents.agent_model` (and `reviewer_model`, `cleaner_model`, `synchronizer_model`, `learner_model`) | string \| `auto` | `auto` | Per-phase role | — |
| `agents.{role}_thinking_level` | string | `auto` | Per-phase role | — |
| `run.max_attempts` | int | `5` | Phase executor | — |
| `run.timeout` | duration string | `1h` | Phase executor | — |
| `run.no_commit` | bool | `true` | Per-task checkpoint gate **only** (the call site in `src/loop/graph/task-nodes-tail.ts` checks it, not the `commitCheckpoint` helper itself) | ADR-0007 + technical-plan AD-002 |
| `run.continue_on_failure` | bool | `false` | Funnel failures of the task | — |
| `run.max_spawns_per_task` / `run.max_spawns_per_run` | int | `8` / `60` | Budgets | — |
| `run.max_run_duration` | duration string | `6h` | Run budget | — |
| `run.reconcile_context` | bool | `false` | Sync phase | — |
| `git.base_branch` | string | `main` | Delivery PR target | ADR-0007 / technical-plan AD-003; default document in spec REQ-028 |
| `git.pull_request` | bool | `false` | Delivery step (opt-in) | technical-plan AD-003 / F2 follow-up |
| `hooks.timeout` | duration string | `4m` | Hook executor | — |
| `hooks.{phase}.pre` / `hooks.{phase}.post` | shell command strings | `[]` | Hook executor | — |
| `knowledge_base.files` | string list | `[]` | Prompt injection | — |
| `adversarial_review.panel` | model list | `[]` | Adversarial review | — |
| `prompts.system_overrides.{phase}.{mode,source,file,text}` | nested | per phase | Prompt injection | — |

Unknown top-level or nested keys are ignored; only modeled keys are written back by the config writer.

### 3.3 Architectural Style

**Style**: Modular single-process orchestrator with declared-graph execution and injected effects.

```
ui/ + tools/ + authoring/          (interaction surfaces)
        ↓ status / commands
loop/ engine → graph/ (declared nodes+edges) → phases (agent subprocesses)
        ↓ state                    ↓ effects
fixplan/ (persistence)      agent/spawner · hooks · checkpoint · delivery
        ↑ typed view               ↑ hardened subprocess util
config/ (yaml)                     util/process
measure/ (ledger, WAL)
```

### 3.4 Project Structure

```
src/
├── index.ts          # factory: registers commands, tools, events, widget (inert on load)
├── config/           # typed tolerant config loader + writer
├── tasks/            # task frontmatter parsing and loading
├── fixplan/          # fix plan types, atomic save, refresh
├── measure/          # ledger, WAL, phase meter, authoring windows
├── prompt/           # phase prompt assembly, skill resolution
├── agent/            # pi subprocess spawning, stream parsing
├── loop/             # engine, declared graph, phases, hooks, checkpoint, delivery
├── ui/               # widget, transcript, pickers, config view
├── tools/            # LLM loop tools
└── util/             # process spawning, durations, log writing
test/                 # unit tests mirroring src
e2e/                  # fake binaries + full-loop e2e
skills/               # forked authoring/phase skills bundled with the package
docs/                 # plan, ADRs, specs
```

### 3.5 Architectural Rules

- No runtime dependencies beyond `yaml` and pi-provided packages.
- One responsibility per file, roughly ≤ 250 lines; extract when exceeded.
- Hot reload first: the factory registers only; no resources started at load; config read at first command; every change must survive `/reload`.
- One loop per session, from command or tool alike.
- `pi` is the only agent; the configured agent name field is ignored.
- Modules importable from tests must not import pi-provided packages at runtime value level.
- Source comments explain why in natural language; no references to spec identifiers, use-case codes or doc paths.
- Best-effort auxiliary operations (checkpoints, measurements, delivery): failures warn, never break the loop.
- Never cite the project the loop semantics derive from; compatibility is stated in words.

### 3.6 Design Patterns

| Pattern | Usage | Example |
|---------|-------|---------|
| Declared graph + interpreter | Loop topology as data (nodes, edges, conditions) | `src/loop/graph/` |
| Dependency injection | All side-effecting collaborators injectable | `EngineDeps`, `ControllerDeps`, delivery executor |
| Write-ahead buffer | Measurement durability | `src/measure/wal.ts` |
| Atomic state writes | tmp + rename persistence | `src/fixplan/fix-plan.ts` |
| Best-effort step | Auxiliary operations that never throw | `commitCheckpoint`, delivery |

### 3.7 API Conventions

| Aspect | Convention | Example |
|--------|-----------|---------|
| User messages | English, `[specs-kit]` prefix | `[specs-kit] range completed: 3/3 tasks (100%)` |
| Tool surface | LLM tools for loop control | `start / stop / status / refresh` |
| Config keys | snake_case yaml | `run.max_attempts`, `git.base_branch` |
| Subprocess contracts | exit code + captured stdout/stderr | `RunResult` from `util/process` |

### 3.8 Library Verification

#### yaml

**Package**: `yaml` **Version**: ^2.8.0
**Approved APIs**: `YAML.parse`, `YAML.stringify` (used via loader/writer).
**Usage Constraints**: tolerant record reads via helper accessors; malformed yaml raises an error naming the file.

#### node:child_process (via util/process)

**Approved APIs**: `spawnProcess(command, args, options)` only.
**Usage Constraints**: detached process groups; timeout + abort mandatory for external binaries (git 30s, gh 90s budget per delivery command); never blocking calls.

---

## 4. Security Constraints

| Level | Rule | Rationale |
|-------|------|-----------|
| CRITICAL | No secrets, tokens or credentials are stored by the extension | Delivery authenticates through the operator's existing forge CLI session |
| CRITICAL | Subprocess timeouts mandatory | A hung binary must not pin the interactive session |
| CRITICAL | No force push / history rewriting in delivery | Local commits are never discarded or rewritten on failure |
| SHOULD | Delivery failures never flip loop outcome | Auxiliary operations are best-effort by philosophy |
| SHOULD | No new runtime dependencies without explicit decision | Dependency surface is a project constraint |
| MAY | Metered external runs (panel, graphify) are operator-declared only | Cost decisions belong to the operator |

---

## 5. AI Guardrails

- **Library verification**: check §3.8 before using any dependency; no new runtime deps.
- **Architectural compliance**: respect §3.5 rules; place files per §3.4; one responsibility per file.
- **Spec fidelity**: the functional specification's `[IMP]` criteria are the only source of task acceptance criteria; data models are advisory.
- **Test discipline**: unit tests inject fakes (no global mocks, no real binaries); e2e uses fake binaries on PATH; test files mirror src.
- **Language**: user-facing strings English with `[specs-kit]` prefix; identifiers and comments English; comments explain why, never cite spec ids or doc paths.
- **Spec death**: archive completed specs; never let them rot.
- **Context rot**: read `CONTEXT.md`, this file and `docs/specs/ontology.md` from disk at session start; do not rely on memory.
