# pi-specs-kit

TypeScript pi extension that re-implements a specification's task loop (state machine implementation → review → cleanup → sync), orchestrating `pi` subprocesses from inside the interactive pi session.

## Language

**Loop**:
The automated execution cycle of a spec's tasks: for each task the phases run in sequence, with retries and state persisted between runs.
_Avoid_: ralph loop, state machine (internal technical name)

**Phase**:
One of the four steps executed for a task: implementation, review, cleanup, sync. Each phase is an agent subprocess with a clean context.
_Avoid_: step, stage

**Task**:
A unit of work of a spec, described by a markdown file with frontmatter in the `tasks/` directory of the spec.
_Avoid_: todo, job

**Spec**:
A directory under `docs/specs/` (e.g. `034-mes-listing-fasi-reparto`) that holds the functional specification, technical plan, tasks and loop state.
_Avoid_: feature, specification (generic)

**Active spec**:
The spec the commands operate on by default when none is given explicitly; the only one persisted in the `spec:` field of `specs-kit.yaml`. Creating a new spec sets it automatically.
_Avoid_: current spec, default spec

**Fix plan**:
The file `_ralph_loop/fix_plan.json` inside a spec: the single source of truth for the loop's state (tasks done/pending, current phase, retries, learnings, blockers). Compatible with the existing format.
_Avoid_: state file, progress file

**Agent**:
The CLI that runs a phase as a subprocess: always and only `pi`. Roles differ only by model and thinking level configured.
_Avoid_: LLM, provider, tool, codex

**Role**:
Function an agent plays in the loop: agent (implementation), reviewer (review), cleaner (cleanup), synchronizer (sync), learner (learnings extraction, and on failed attempts the failure learner). Each role has its own model and thinking level, configurable from `specs-kit.yaml` or from pi's TUI.
_Avoid_: persona, worker

**Phase skill**:
Instructions document injected into a phase's prompt (specs-kit-task-implementation, specs-kit-task-review, specs-kit-code-cleanup, specs-kit-sync), resolved by the fork bundled in the extension.
_Avoid_: prompt template

**Hook**:
Shell command executed before (pre) or after (post) a phase; a failed pre-hook blocks the phase. A post-hook is a gate: for implementation a red gate costs the attempt and its output enters the next attempt's prompt; for phases without retries (cleanup, sync) it is recorded in the state and reported at range close.
_Avoid_: guard, script

**Learner**:
Agent role that at the end of a task extracts learnings and writes them into the fix plan; the learnings are then injected as memory into the prompts of the tasks that follow.
_Avoid_: memory (it is the data, not the role)

**Failure learner**:
Agentic node that runs on a failed attempt, before the next one: it reads what stopped the attempt and writes it into the fix plan's blockers. It is not the Learner: the input is a dead attempt rather than a change approved by review, and what it produces dies with the task.
_Avoid_: failure learner, error learner

**Blocker**:
What stopped an attempt, recorded per task in `state.blockers` and injected into the next attempt's prompt in a block separate from memory. It has a kind — `verified_fact`, `spec_contradiction`, `unowned_decision`, `operator_action`, `env` — and the kind is what decides the loop's response. Run memory: pruned when the task passes review, and reaches the project learnings only through the Learner.
_Avoid_: failure learning, memory (that one is project memory), issue

**Repeated wall**:
The same blocker of kind `spec_contradiction`, `unowned_decision` or `operator_action` in two consecutive attempts of the same task: no further attempt can resolve it, so the task closes immediately and the operator receives the blocker text instead of paying for another agent session.
_Avoid_: escalation (too generic), definitive block

**Operator wall**:
Work only a person can perform — an account, a credential, a signature, a purchase, physical or console access — discovered while a task runs, either through the review report's `escalation` list or through an `operator_action` blocker hit twice. It closes that task and, alone among the failures, never stops the run: the tasks that follow are not the ones missing a credential.
_Avoid_: manual task, procurement task (such a task is never generated), blocked task

**Operator precondition**:
An action a person must have completed before the run starts, listed in the `## Preconditions (operator)` section of the tasks document. It is never a task and has no task file; the tasks that consume it name its resolution in their Definition of Ready, the way they name a dependency.
_Avoid_: manual task, setup task, prerequisite task

**Context reconciliation**:
Opt-in extension of the sync phase's mandate: when `run.reconcile_context` is on and there are consolidated learnings, sync patches the single contradicted instruction in a source document (AGENTS.md, architecture.md, ontology.md, .pi/rules) and reports every patch in its summary. By default the authoritative documents are not modified by the loop.
_Avoid_: self-heal / heal (already used for the implementation↔review loop), auto-fix

**graphify**:
External skill that indexes the codebase into the knowledge graph `graphify-out/graph.json`. It is the only source of the codebase graph: every phase reads it directly, there is no per-spec projected knowledge graph file. It is not bundled in this extension: install it separately (`~/.agents/skills/graphify` or `~/.pi/agent/skills/graphify`). The extension warns at loop start if it cannot find it; the sync phase refreshes it (`/graphify --update`) before consuming it.
_Avoid_: codebase indexer, KG builder, code graph

**Knowledge Graph (KG)**:
The knowledge graph of the codebase, produced by graphify in `graphify-out/graph.json` at project level. It is the only map of the codebase and the only graph file: there is no projected `knowledge-graph.json` per spec. The sync phase refreshes it (`/graphify --update`); task technical validation and task generation read it directly. Without graphify it is missing and technical validation is skipped.
_Avoid_: knowledge-graph.json, projection, per-spec KG

**Partial sync**:
Outcome of a sync phase run without the knowledge graph (graphify missing or graph not materialised): sync completes its documentary duties but the graph-based dependency validation is skipped. The loop marks this in the fix plan's `state.graphPartialSync` and reports it in the closing summary, instead of degrading silently.
_Avoid_: failed sync, degraded sync

**Routed suggestion**:
A fix a reviewer defers to a later task instead of the one just reviewed: it lives in the review report's frontmatter as a `{ to, text }` entry under `routed`, and the loop injects it into the implementation prompt of the target task as a `<routed_suggestions>` block. Prevents a task-to-task handoff from getting lost because it was buried in the prose of a previous review.
_Avoid_: deferred suggestion, textual handoff

**Review verdict**:
The structured outcome the review phase projects back to the loop at the end of its sub-cycle: passed, failed (with feedback), attemptFailed, reportUnusable or stopped. It lives in the report's frontmatter; the loop routes the task's transitions on it.
_Avoid_: review outcome, report (it is the file, not the outcome)

**Per-attempt review archive**:
A copy of a previous review report, saved as `tasks/<TASK>--review.attempt-N.md` before a retry overwrites the canonical report `<TASK>--review.md`. Preserves the verdict history (including FAILED) for audit and debug; the canonical file is always the latest verdict.
_Avoid_: review backup, review snapshot

**Measurement documents**:
The documents the implementation is judged against: the functional specification of the spec and the files under `contracts/`. The loop compares their fingerprint before and after each implementation phase (`run.protect_spec_artifacts`, on by default) and rejects the attempt that rewrote one, naming the files. Working documents (decision log, task file, technical plan) stay writable.
_Avoid_: protected files (generic), read-only files

**Spec conflict**:
A contradiction between what a requirement, an acceptance criterion or a contract prescribes and what the implementation does. The reviewer lists it in `spec_conflicts` in the report's frontmatter; a non-empty list counts as a rejection no matter what `review_status` says, because describing the conflict is the reviewer's job and deciding what it costs is the loop's.
_Avoid_: tension, clarification, review note

**Range close audit**:
Programmatic check run when a range closes, with no model calls: every coverage-matrix citation must point at an existing test file (and, when it names a test, at a name present in the file), and no routed suggestion may stay attached to a task that never completed. Produces warnings, never blocks.
_Avoid_: final gate, matrix validation

**Knowledge base**:
List of context files (from `specs-kit.yaml`) injected into every phase's prompt.
_Avoid_: context files, generic KB

**Reference documents**:
List of additional document paths (`reference_documents.files` in `specs-kit.yaml`) injected into every phase's prompt, before the knowledge-base files, in the same `<knowledge_base>` block. Missing files are silently omitted.
_Avoid_: context files, extra docs

**Transcript**:
A readable rendering of what the agent is doing in the current phase, rendered like the interactive session. Opens and closes without touching the loop, which proceeds independently.
_Avoid_: stream view, attach view, log, output

**Measurement ledger**:
Append-only file next to the specs, versioned with the project, where consumption and duration measurements accumulate: one row per loop phase and one per authoring window. It is not loop state: losing it does not prevent resuming.
_Avoid_: metrics (generic), log

**Authoring window**:
A slice of the interactive session attributed to the creation of a spec: it opens with an authoring command and closes at the next specs-kit command or at session close. The first window is attributed to the spec retroactively, when the spec becomes active.
_Avoid_: session, turn

**Loop cost**:
Tokens consumed and spend of the agent subprocesses the loop executes for a spec: every phase of every task, retries included. It is a total per spec, not per phase or per task.
_Avoid_: implementation tokens, implementation phase cost

**Loop duration**:
Sum of the durations of the loop's executions on a spec, hooks and checkpoints included. The pauses between successive executions do not count.
_Avoid_: implementation time, wall clock

**Fast mode**:
Loop mode that skips cleanup and the `reviewed` frontmatter write, and syncs only the last task of the range. Completed tasks are still recorded as done and the git checkpoint is still created.
_Avoid_: quick mode

**Declared graph**:
The loop's topology expressed as data — nodes, edges and conditions — separate from the small interpreter that runs it. The loop always ran it; declaring it makes it inspectable and testable.
_Avoid_: state machine, hard-wired pipeline, implicit graph

**Node**:
Unit of the declared graph, of two kinds: agentic (a phase or the learner, run by an agent subprocess) or deterministic (gates, funnels and state writes, pure loop logic with no agent).
_Avoid_: step, stage, phase (for the deterministic ones)

**Edge**:
Declared transition between two nodes, with condition and type. The edge's payload is what the downstream node reads (e.g. the review feedback on the back-edge into implementation).
_Avoid_: transition, jump, branch

**Edge type**:
An edge's classification, assigned only when it drives a routing decision. Four families: advance, verdict (the kinds of the review verdict), derived (stall guard, exhausted attempts, failed pre-hook or spawn) and config/environment (jump for mode, continue-on-failure, operator stop, exhausted budget).
_Avoid_: generic ok/failed labels, types for events that do not route

**Task failure funnel**:
Deterministic node on which every non-pass outcome of a task converges (stall guard, unusable report, exhausted attempts); it decides only once whether the run continues with the next task or stops.
_Avoid_: halt, direct halt

**Stall guard**:
Guard that declares the task failed when review rejects it twice in a row with identical feedback: the implementation is not acting on the feedback.
_Avoid_: anti-loop, feedback loop

**Task runtime state**:
The in-flight variables of a task's cycle (review feedback, routed suggestions, run progress), declared in the graph but not persisted in the fix plan: they die with the process and resume recomputes them.
_Avoid_: loop state (that one is the fix plan), session

**Final sync**:
The sync the run performs at range end when no task has run one (e.g. a queue failed in fast mode), followed by compaction of the project learnings. Guarantees at least one documentary sync per run.
_Avoid_: final sync, closing sync

**Phase compaction**:
The summary a phase makes of its own conversation once it passes `run.auto_compact_threshold` percent of the model context window, when `run.auto_compact` is on: the phase prompt and the recent turns stay whole, everything before them becomes a summary written by the phase model, and every later request of that phase reuses it. It is not the compaction of the project learnings, which is the learner rewriting the memory list at range end.
_Avoid_: auto-compact (as a noun), truncation, pruning, context window management
