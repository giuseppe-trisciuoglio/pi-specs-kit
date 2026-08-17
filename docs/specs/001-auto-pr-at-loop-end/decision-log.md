# Decision Log: Automatic Pull Request at Loop Completion

| ID | Date | Task | Decision | Alternatives | Impact | Decided By |
|----|------|------|----------|--------------|--------|------------|
| DEC-001 | 2026-08-17 | Brainstorming | Approach B: balanced delivery step | A: minimal push+bare PR; C: comprehensive (labels, multi-forge, persisted PR state, re-delivery command) | Spec structure, scope boundaries, acceptance criteria | user selection |
| DEC-002 | 2026-08-17 | Brainstorming | Delivery only on the completed terminal state | completion + halt; any ending | Trigger requirements (REQ-004/005), AC-003/004 | user selection |
| DEC-003 | 2026-08-17 | Brainstorming | Auto-create/reuse a spec branch when the working branch is the base branch | skip with warning; fail before starting | Branch requirements (REQ-007/008), AC-005/006 | user selection |
| DEC-004 | 2026-08-17 | Brainstorming | Delivery failures warn but never change the run outcome | flip run to failed | Failure requirements (REQ-015/018), AC-014/015 | user selection |
| DEC-005 | 2026-08-17 | Brainstorming | Create docs/specs/ontology.md with the delivery domain terms | adjust terms first; skip | Project ontology initialized | user selection |
| DEC-006 | 2026-08-17 | Technical plan | Technical plan drafted: delivery step in the run walk completion branch, git/gh via spawnProcess, `git.pull_request` flag (default off), injected executor for tests, ephemeral outcomes | engine-level epilogue; graph node; `run.auto_pr` key; persisted delivery state | Architecture decisions AD-001…006 in 2026-08-17--technical-plan.md; four implementation phases | agent (skill: specs-kit-technical-plan) |
| DEC-007 | 2026-08-17 | Spec check | All four clarification answers accepted as recommended: partial ranges deliver, push updates existing PR, outcome-only notice, working copy stays on delivery branch | alternatives per question (see spec Clarifications session 2026-08-17) | REQ-020…023, AC-019…022, Bounded Context Impact section; spec v1.1 | user selection (skill: specs-kit-spec-check) |

## DEC-001: Approach Selection
- **Date**: 2026-08-17
- **Task**: Brainstorming
- **Phase**: Approach Selection
- **Context**: Selection of functional approach for the delivery feature
- **Decision**: Approach B — balanced delivery: config-gated post-run step with branch safety, single delivery commit, push, spec-derived pull request, PR URL notification, best-effort failures
- **Alternatives Considered**: A (minimal: push current branch + bare PR), C (comprehensive: metadata config, multi-forge, persisted PR state, manual re-delivery)
- **Impact**: Specification structure, scope boundaries, acceptance criteria
- **Decided By**: user selection

## DEC-002: Delivery Trigger Scope
- **Date**: 2026-08-17
- **Task**: Brainstorming
- **Phase**: Idea Refinement
- **Context**: Which loop endings produce a delivery attempt
- **Decision**: Only the completed terminal state (including completed-with-failures ranges); halted and stopped runs skip delivery and the closing notice mentions the skip
- **Alternatives Considered**: completion + halt (partial work reviewable); any ending (most automated, riskiest)
- **Impact**: Trigger requirements, skip notice behavior, acceptance criteria
- **Decided By**: user selection

## DEC-003: Base-Branch Handling
- **Date**: 2026-08-17
- **Task**: Brainstorming
- **Phase**: Idea Refinement
- **Context**: A pull request cannot be opened from the base branch
- **Decision**: When the working branch is the base branch, the system creates or reuses a dedicated branch named after the spec identifier (`specs/<spec-id>`) and opens the PR from it
- **Alternatives Considered**: skip delivery with a warning; refuse to start the loop on the base branch
- **Impact**: Branch handling requirements, branch naming convention, acceptance criteria
- **Decided By**: user selection

## DEC-004: Failure Policy
- **Date**: 2026-08-17
- **Task**: Brainstorming
- **Phase**: Idea Refinement
- **Context**: How push/PR failures affect the run result
- **Decision**: Best-effort, consistent with checkpoints and measurements: failures surface as `[specs-kit]` warnings naming step and reason; the completed outcome stands; no automatic retries; local commits preserved
- **Alternatives Considered**: flip the run outcome to failed
- **Impact**: Failure-handling requirements, negative requirements, acceptance criteria
- **Decided By**: user selection

## DEC-005: Ontology Initialization
- **Date**: 2026-08-17
- **Task**: Brainstorming
- **Phase**: Documentation
- **Context**: Domain terms emerged during refinement (delivery step, delivery flag, spec branch, base branch, forge)
- **Decision**: Create `docs/specs/ontology.md` with the five delivery-domain terms, in the style of CONTEXT.md
- **Alternatives Considered**: adjust terms first; skip ontology creation
- **Impact**: Shared ubiquitous language for task generation and review
- **Decided By**: user selection

## DEC-006: Technical Plan Approach
- **Date**: 2026-08-17
- **Task**: Technical plan
- **Phase**: Documentation (specs-kit-technical-plan)
- **Context**: HOW the delivery feature gets built within pi-specs-kit's constraints (no new runtime deps, injectable tests, fix plan as single source of truth)
- **Decision**: Delivery is a deterministic step in the run walk's completion branch (after final sync, before closing notices); git and gh run through the existing spawnProcess wrapper with the checkpoint helper reused for the commit; the flag is `git.pull_request` (boolean, default off); command execution is injected for unit tests with a fake gh binary in e2e; outcomes are ephemeral (notifications only, nothing persisted)
- **Alternatives Considered**: engine-level epilogue after walkSelection (breaks REQ-004 ordering); new graph node (no verdict semantics); `run.auto_pr` config key (wrong section); persisted delivery state in the fix plan (shape pollution, violates REQ-NR007)
- **Impact**: Six architecture decisions (AD-001…006), four implementation phases, file plan (src/loop/delivery*.ts, test/delivery.test.ts, e2e/fake-bin/gh), ADR-0019 deferred to implementation Phase 4
- **Decided By**: agent (specs-kit-technical-plan), consistent with user decisions DEC-001…004

## DEC-007: Specification Clarification Pass
- **Date**: 2026-08-17
- **Task**: Spec check
- **Phase**: Clarification (specs-kit-spec-check)
- **Context**: No markers and no adversarial review findings; structured scan flagged the three open questions plus the post-delivery branch state
- **Decision**: All four answers accepted as recommended — (1) any completed run delivers, including from/to partial ranges; (2) a plain push to a branch with an open pull request updates it and the existing URL is reported; (3) outcome-only notice (URL on success, failed step + reason on failure); (4) the working copy stays on the delivery branch after delivery
- **Alternatives Considered**: full-spec-only delivery; report-and-skip-push on existing PR; per-step notices; switch back to base branch
- **Impact**: REQ-020…023 and AC-019…022 added; error scenario for empty runs documented; Bounded Context Impact section added; Open Questions closed; spec version 1.1
- **Decided By**: user selection (all recommended options)

## DEC-008: Task Generation
- **Date**: 2026-08-17
- **Task**: Spec-to-tasks
- **Phase**: Task generation (specs-kit-spec-to-tasks)
- **Context**: Converting the clarified specification into an executable task set; graph absent, operator chose in-session codebase analysis over building the graph
- **Decision**: 6 implementation tasks (config flag → delivery module → PR content builders → push/forge steps → run-walk wiring → e2e) + documentation task (also the [SEF]/[EXT] checkpoint) + cleanup task; created docs/specs/architecture.md (TS/Node pi extension, file-based no-DB, npm package) and spec artifacts (data-model, contracts for forge CLI and git subprocess)
- **Alternatives Considered**: building graphify-out/graph.json first; merging content builders into the forge task; putting e2e inside the wiring task
- **Impact**: tasks/TASK-001…008, task list index, traceability matrix; two cross-boundary tasks flagged (Configurazione, Loop) with justification; one external-dependency risk flagged (forge CLI)
- **Decided By**: agent (specs-kit-spec-to-tasks), following user answers (architecture questions, graph skipped)

## DEC-009: Adversarial Review Remediation (spec half)
- **Date**: 2026-08-17
- **Task**: Spec check (second pass)
- **Phase**: Review findings closure (specs-kit-spec-check × specs-kit-adversarial-review follow-up)
- **Context**: Panel returned BLOCKED (2 blocker, 9 major, 8 minor, 3 contested); 7 findings target the specification and entered the question queue
- **Decision**: All five questions answered with the recommended options — guarded spec-branch reuse (REQ-007 amended, REQ-024 divergence guard, AC-023, new error row), detached HEAD under the spec-branch path (REQ-025, AC-024), AC-022/REQ-023 scoped to post-branch failures, PR content sources pinned (REQ-026 title from spec document name, REQ-027 warnings from the run's closing state), base branch default `main` (REQ-028, assumption)
- **Alternatives Considered**: fresh branch per run; delivery failure on detached HEAD; minimal content sources; warn-and-skip on missing base branch
- **Impact**: Spec v1.1 +5 REQ (024–028), +4 IMP AC (023–026), 77% IMP; report statuses written (7 RESOLVED, 10 Owner-routed, deferred MINORs/contested); spec-level blockers closed, gate remains BLOCKED on F2 (technical-plan)
- **Decided By**: user selection (all recommended)

## DEC-010: Technical Plan Revision (post review)
- **Date**: 2026-08-17
- **Task**: Technical plan (v1.1)
- **Phase**: Review findings closure (specs-kit-technical-plan × specs-kit-adversarial-review follow-up)
- **Context**: Spec v1.1 added REQ-024…028 and AC-023…026; the panel found that AD-002's gate boundary was unstated, AD-006 depended on a gh flag that does not exist, AD-007 was missing, AD-008/AD-009 sources were undefined, the structure omitted `run-assembly.ts`, the architecture's config keys weren't enumerated, and the `--resume` post-kill limitation was undocumented
- **Decision**: Plan rewritten as v1.1. AD-002: `commitCheckpoint` is ungated by `run.no_commit`; the per-task gate lives at the call site. AD-006: capture URL from `pr create` stdout; fall back to `pr view --json url`. AD-007: guarded reuse — fetch + fast-forward dry-run; refuse-with-warning on divergence; never force. AD-008: terminal warnings come from the run's closing state (failures[], graphPartialSync, postHookGateFailed), captured by the walk before the post-hook clear. AD-009: title from spec document H1, spec-id fallback. `run-assembly.ts` added to the structure map. Configuration Keys table added with `run.no_commit`, `git.base_branch`, `git.pull_request`. `--resume` post-kill limitation documented as a risk-table assumption
- **Alternatives Considered**: fresh branch per run; force-with-lease; spec-list pre-flight for existing PR; title-from-id only
- **Impact**: 9 ADs total; `contracts/forge-cli.md` revised; report F2/F9/F10/F14/C2/C3 closed; F11 (spec-to-tasks), F12-F19, C1 remain open
- **Decided By**: agent (specs-kit-technical-plan), following the clarified spec and the adversarial-review routing


## DEC-011: Task Set Re-run (spec v1.1 alignment)
- **Date**: 2026-08-17
- **Task**: Spec-to-tasks (re-run)
- **Phase**: Task regeneration after spec + plan revisions (specs-kit-spec-to-tasks)
- **Context**: Spec v1.1 added REQ-024…028 and AC-023…026 in response to F1, F3+F4, F5, F6, F7, F8; the technical-plan v1.1 added AD-006 (stdout URL acquisition), AD-007 (guarded reuse), AD-008 (warning sources), AD-009 (title source). The previous task set was generated against spec v1.0 and did not cover these. The review report (F11/F16/F17/F18) flagged mapping and test-fidelity gaps that the regenerated tasks resolve by construction.
- **Decision**: Regenerate the task set in place (8 tasks, same numbering, IDs preserved for stability), refresh `data-model.md` to reflect the new entities and the divergence guard, refresh `contracts/git-subprocess.md` to capture AD-007 mechanics, refresh `traceability-matrix.md` against the v1.1 AC set, and update `docs/specs/architecture.md` §3.2a with the canonical config-keys table (closes F14). TASK-002 absorbs guarded reuse, detached-HEAD path, the force-prohibition assertion, and a concrete binary-presence assertion in place of the tautological no-agent-subprocess test. TASK-003 pins H1-with-id-fallback title and the closing-state warning input shape with a concrete DoR. TASK-004 removes the unsupported `gh pr create --json` invocation and replaces it with the AD-006 stdout-URL acquisition plus a machine-anchored fallback. TASK-005 implements the warning-capture ordering (between the range-completed notify and the postHookGateFailed clear in `src/loop/run-walk.ts`) and the spec H1 read in the walk. TASK-006 adds a flag-on + no_commit true scenario (closes F9 in this skill) and a divergence refusal scenario. TASK-007 retains docs/test checkpoints and adds the spec Status flip from Draft to Approved (closes F19) plus architecture §3.2a upkeep (closes F14).
- **Alternatives Considered**: surgical edits to the existing 8 tasks (rejected: too many touch points, error-prone); renumbering (rejected: disturbs cross-document references; in-place overwrite keeps the doc set atomic)
- **Impact**: AC-001…AC-026, all 20 [IMP] mapped; review closures: F11 (matrix consistency), F14 (architecture keys), F16 (loader tolerance), F17 (DoR concreteness), F18 (tautological test), F19 (spec Status flip — final task). Remaining review findings (F12/F13/F15/C1) still OPEN and intentionally outside this skill (spec-side MINORs + contested empty-range attribution)
- **Decided By**: agent (specs-kit-spec-to-tasks), per the spec v1.1 + technical-plan v1.1 updates

