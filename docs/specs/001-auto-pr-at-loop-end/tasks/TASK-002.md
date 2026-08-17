---
id: TASK-002
title: "Delivery module: probe, guarded branch decision, detached-HEAD path, delivery commit"
spec: docs/specs/001-auto-pr-at-loop-end/2026-08-17--auto-pr-at-loop-end.md
status: pending
dependencies: [TASK-001]
ac-mapping: [AC-005, AC-006, AC-008, AC-010, AC-022, AC-023, AC-024]
imp-requirements: [REQ-003, REQ-006, REQ-007, REQ-008, REQ-010, REQ-011, REQ-023, REQ-024, REQ-025]
---

# TASK-002: Delivery module: probe, guarded branch decision, detached-HEAD path, delivery commit

**Functional Description**: The deterministic core of the delivery step covering the local git half: probe the repository and working branch, decide the branch path through guarded reuse (creating the spec branch when absent or fast-forward-reusing when compatible, refusing-with-warning on divergence; never forced), honour the detached-HEAD state by taking the spec-branch path, and commit the residual working tree as a single delivery commit. Command execution is injected; no agent subprocess is involved.

**Maps to Specification**: AC-5 (spec branch from base / detached), AC-6 (PR from current branch), AC-8 (single delivery commit), AC-10 (commit despite disabled checkpoints), AC-22 (working copy stays on delivery branch when one exists), AC-23 (divergence refuse-with-warning, no force), AC-24 (detached HEAD takes the spec-branch path)

## Acceptance Criteria

- [ ] On the base branch, delivery creates or reuses a dedicated branch named after the spec identifier, carrying the current working state. *(AC-5, REQ-7)*
- [ ] On a non-base branch, delivery performs no branch operation. *(AC-6, REQ-8)*
- [ ] Uncommitted changes become exactly one delivery commit covering the whole working tree, whose message identifies the spec; a clean tree produces no commit. *(AC-8, REQ-10/11)*
- [ ] The delivery commit is created whenever the delivery flag is on, regardless of the checkpoint setting. *(AC-10, REQ-3)*
- [ ] After delivery ends, successfully or not, when a delivery branch exists the working copy remains on it; pre-branch failures leave the working copy in its pre-delivery state. *(AC-22, REQ-23)*
- [ ] A diverging existing spec branch (local or remote) stops delivery at the branch step with a warning naming branch and divergence; no forced update is attempted. *(AC-23, REQ-24)*
- [ ] Delivery from a detached working state creates the spec branch and opens the pull request from it. *(AC-24, REQ-25)*
- [ ] Every operation is a direct programmatic subprocess invocation through the shared hardened wrapper, with timeouts. *(REQ-6)*

## Definition of Ready (DoR)

- [ ] TASK-001 is complete (flag available in the typed config view).
- [ ] The checkpoint helper semantics (`commitCheckpoint`: whole tree, best-effort, never throws) are understood, including the call-site gate convention (AD-002).
- [ ] The subprocess wrapper signature (`spawnProcess` options and `RunResult`) is understood.

## Technical Context (from Codebase Analysis)

- **Existing Patterns to Follow**: `src/loop/checkpoint.ts` — reuse the commit helper for the delivery commit; its `{committed, reason}` already encodes "no changes" vs "git error". The gate at `src/loop/graph/task-nodes-tail.ts` lines 198-205 wraps `commitCheckpoint` with the `run.no_commit` check; the delivery call site bypasses that gate.
- **APIs to Integrate With**: `spawnProcess` from `src/util/process.ts` (timeouts, abort, captured output); `SpecsKitConfig.git`.
- **Shared Components**: injected executor pattern mirroring `EngineDeps` (`commitCheckpoint`, `spawnPhase` precedents).
- **Conventions**: modules importable from unit tests must not import pi-provided packages; one responsibility per file (≤ ~250 lines — extract content/forge steps already).
- **Architecture Reference**: `docs/specs/architecture.md` §1.3 (spawnProcess shared kernel), §3.6 (DI, best-effort step); `contracts/git-subprocess.md`; `technical-plan.md` AD-002 / AD-007.
- **Domain Terms**: Consegna del run, Ramo della spec, Ramo base, Flag di consegna (ontology).

## ⚠️ External Dependency Risk

- **Depends on**: system `git` binary (probe, branch decision, commit)
- **Status**: Verified — the checkpoint module already shells out to git through the same wrapper.
- **Mitigation**: unit tests never spawn real git (injected executor); failures surface as delivery warnings, never exceptions.

## Implementation Details (File names only, no code)

**Files to Create**:
- `src/loop/delivery.ts` - step sequence, branch decision (probe → guarded reuse → commit), outcome aggregation for the local half; injectable executor and commit helper
- `test/delivery.test.ts` - unit matrix against a scripted fake executor (covers the AC-5/6/8/10/22/23/24 axes)

## Test Instructions

**1. Mandatory Unit Tests:**
   - `delivery` (branch decision):
     - [ ] On the base branch the spec branch is created and becomes the working branch. *(AC-5, REQ-7)*
     - [ ] On a non-base branch no branch command runs. *(AC-6, REQ-8)*
     - [ ] On a detached working state the spec branch path is taken (create or reuse as above). *(AC-24, REQ-25)*
     - [ ] With the branch existing locally and the candidate tip an ancestor of current HEAD, the branch is reused via a fast-forward carry (no force). *(AC-5/23)*
     - [ ] With the candidate tip diverging (ahead of current HEAD or non-ancestor), the branch step stops and reports a divergence warning naming the branch; no forced update occurs. *(AC-23, REQ-24)*
     - [ ] With the branch existing only on the remote (local absent), a fetch + fast-forward dry-run is attempted; on divergence the branch step stops with the same named warning. *(AC-23, REQ-24)*
     - [ ] No branch command runs any of `--force`, `-f`, `--force-with-lease`; asserted by inspecting the fake executor's command list. *(REQ-NR006)*
   - `delivery` (commit):
     - [ ] A dirty tree yields exactly one commit covering the whole tree, with a message identifying the spec. *(AC-8, REQ-10)*
     - [ ] A clean tree (commit helper reports no changes) skips the commit without failing the sequence. *(AC-8)*
     - [ ] The commit is requested when the delivery flag is on even though the checkpoint setting says no commits. *(AC-10, REQ-3)*
     - [ ] A failed commit stops the sequence with the failed step and reason recorded; earlier state is retained. *(REQ-15 shape)*
   - `delivery` (state):
     - [ ] When a delivery branch is created or reused, no command switches back to the base branch after the delivery step. *(AC-22, REQ-23)*
     - [ ] When delivery aborts before a branch operation (non-repo, probe failure), the working copy is in its pre-delivery state. *(AC-22 scope, F5 closure)*
   - `delivery` (execution mode):
     - [ ] Every git invocation goes through the injected executor; no non-git/non-gh binary appears in the observed command list. *(REQ-6, F18 concreteness)*

**3. Edge Cases and Error Conditions to Test:**
   - [ ] Probe fails (not a git repository) → delivery aborts with a warning; run outcome untouched. *(REQ-15)*
   - [ ] Branch creation fails (checkout error) → sequence stops, prior state intact. *(REQ-15 shape)*

**Test Acceptance Criteria**:
- [ ] All tests described above are implemented and pass using the scripted executor (no real binaries).

## Definition of Done (DoD)

This task is complete when:
- [ ] The local half of delivery is implemented with an injectable executor and unit-tested matrix.
- [ ] The guarded-reuse and detached-state behaviors are unit-tested.
- [ ] The delivery outcome shape (failed step, reason, surviving branch, divergence flag) is available to downstream tasks.
- [ ] No pi-provided package is imported by the module.

**Dependencies**: TASK-001

**Implementation Command**:
/skill:specs-kit-task-implementation --task="docs/specs/001-auto-pr-at-loop-end/tasks/TASK-002.md"
