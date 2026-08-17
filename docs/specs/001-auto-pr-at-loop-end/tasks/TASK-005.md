---
id: TASK-005
title: "Wire delivery into the run walk completion (with terminal-warning capture)"
spec: docs/specs/001-auto-pr-at-loop-end/2026-08-17--auto-pr-at-loop-end.md
status: pending
dependencies: [TASK-001, TASK-002, TASK-004]
ac-mapping: [AC-001, AC-003, AC-004, AC-014, AC-019, AC-021]
imp-requirements: [REQ-004, REQ-005, REQ-017, REQ-019, REQ-020, REQ-021, REQ-022, REQ-023]
---

# TASK-005: Wire delivery into the run walk completion (with terminal-warning capture)

**Functional Description**: Connect the delivery step to the loop. On the completed terminal state, with the flag on, delivery runs after the final sync and before the closing notifications. The walk captures the run's terminal-warning set (failed tasks carried past, partial sync, post-hook gate) and the spec document's first H1, and passes them to delivery alongside the spec id and the outcome. Halted and stopped runs skip delivery and the closing notice says so. Outcomes become exactly one success notice (with the pull request URL) or one warning naming the failed step and reason. The run result is never flipped by delivery.

**Maps to Specification**: AC-1 (programmatic delivery on completion), AC-3 (halted skips + notice), AC-4 (stopped skips + notice), AC-14 (warning on failure, run stays completed), AC-19 (partial ranges deliver), AC-21 (outcome-only notice — single notice on success)

## ⚠️ Cross-Boundary Warning

- **Primary Context**: Consegna (delivery)
- **This Task Modifies**: `src/loop/run-walk.ts`, `src/loop/engine.ts`, `src/loop/run-assembly.ts` in the Loop context
- **Risk**: MEDIUM
- **Justification**: delivery consumes the loop's completed terminal state; the walk owns the completion ordering (after final sync and done-persist, before closing notifications). The Consegna context stays the owner of delivery logic; the Loop context only calls it.

## Acceptance Criteria

- [ ] A completed run with the flag on invokes delivery exactly once, after the final sync and the done-persist, before the closing notifications. *(AC-1, REQ-4)*
- [ ] Halted and stopped runs never invoke delivery, and their closing notices mention the skip. *(AC-3, AC-4, REQ-5)*
- [ ] With the flag off, no delivery code path executes and loop-end behavior is unchanged. *(REQ-1 gate)*
- [ ] Any completed run delivers, including a from/to partial range. *(AC-19, REQ-20)*
- [ ] Successful delivery produces exactly one notice carrying the pull request URL; failed delivery produces one warning naming the failed step and reason. *(AC-21, REQ-21/22, REQ-17/19)*
- [ ] A delivery failure never changes the returned run reason; a completed run stays completed. *(AC-14, REQ-15, NR002)*
- [ ] The terminal-warning input passed to delivery (failed tasks, partial sync, post-hook gate) is the same set the closing notices report, captured before the post-hook clear. *(AC-12 wiring, AD-008)*
- [ ] The spec document's first H1 (or the spec id as fallback) is read from the spec file and passed to the title builder. *(AC-11, AC-25, AD-009)*
- [ ] The delivery dependency is injectable with a no-op default, so existing walk tests keep running unchanged. *(project DI convention)*

## Definition of Ready (DoR)

- [ ] TASK-001/002/004 are complete (flag, delivery entry point with guarded reuse, forge steps with URL acquisition).
- [ ] The walk's completion branch and its injectable deps are understood.
- [ ] The postHookGateFailed clear timing in `src/loop/run-walk.ts` is understood (the capture happens before the clear).

## Technical Context (from Codebase Analysis)

- **Existing Patterns to Follow**: `walkSelection` deps object (`WalkDeps`) — delivery joins `stopping/notify/persist` as an injected collaborator; `assembleRun`/`EngineDeps` thread the dependency with a real default.
- **APIs to Integrate With**: `notify(message, "info" | "warning")` channel; fix plan read-only at delivery time (range progress, spec id/name, outcome flags).
- **Conventions**: user-facing messages English; `[specs-kit]` prefix applied by the controller layer; nothing persisted to the fix plan by delivery.
- **Architecture Reference**: `docs/specs/architecture.md` §1.4 (Loop → Consegna event relationship), §3.6 (DI); `technical-plan.md` AD-001, AD-005, AD-008, AD-009.
- **Domain Terms**: Consegna del run, Flag di consegna, Loop (ontology).

## Implementation Details (File names only, no code)

**Files to Modify**:
- `src/loop/run-walk.ts` - completion branch calls the injected delivery step between the range-completed notify and the post-hook clear notifications (so the postHookGateFailed field is still populated for capture); skip notices for halted/stopped closings
- `src/loop/engine.ts` - thread the delivery dependency (EngineDeps-style, real default)
- `src/loop/run-assembly.ts` - pass the dependency through the assembled run

**Files to Create**:
- `test/run-walk-delivery.test.ts` - wiring unit tests with a fake delivery step; covers ordering, skip notices, run-warn composition, fix-plan immutability, injectable dep

## Test Instructions

**1. Mandatory Unit Tests:**
   - `walkSelection` (trigger):
     - [ ] Verify a completed run invokes the delivery step after the final sync node and the done-persist, before the closing notifications. *(AC-1, REQ-4)*
     - [ ] Verify a halted ending and a stopped ending never invoke delivery, each with a closing notice mentioning the skip. *(AC-3, AC-4)*
     - [ ] Verify the flag off produces no delivery invocation and no skip notice. *(AC-2 unchanged behavior)*
     - [ ] Verify a completed partial range (subset of tasks) invokes delivery like a full run. *(AC-19)*
   - `walkSelection` (warning capture ordering):
     - [ ] Verify the terminal-warning input delivered to the step reflects the run's captured state at the time of invocation; failures past, partial sync, post-hook gate. *(AD-008)*
     - [ ] Verify the postHookGateFailed field is still populated when the walk prepares the delivery input. *(AD-008 ordering invariant)*
   - `walkSelection` (spec document name):
     - [ ] Verify the walk reads the spec document's first H1 and passes it to delivery (mocked file fixture); fallback to spec id when no H1. *(AD-009, AC-25)*
   - `walkSelection` (reporting):
     - [ ] Verify a successful outcome with a URL emits exactly one delivery notice containing the URL. *(AC-21)*
     - [ ] Verify a failed outcome emits exactly one warning naming the failed step and reason. *(AC-21, AC-14)*
     - [ ] Verify the returned run reason stays "completed" when delivery fails. *(AC-14, NR002)*
     - [ ] Verify the fix plan object is not mutated by the delivery call. *(NR007, data integrity)*
   - `engine` (threading):
     - [ ] Verify the real delivery dependency is used by default and an injected fake replaces it. *(DI convention)*

**Test Acceptance Criteria**:
- [ ] All tests described above are implemented and pass with the fake delivery step (no binaries).

## Definition of Done (DoD)

This task is complete when:
- [ ] Delivery runs at the right moment with the right notices, single-attempt best-effort semantics.
- [ ] The terminal-warning capture ordering invariant is implemented and unit-tested.
- [ ] The spec-document-name read is in the walk, not the delivery module.
- [ ] Existing walk/engine tests pass unchanged (no-op default).

**Dependencies**: TASK-001, TASK-002, TASK-004

**Implementation Command**:
/skill:specs-kit-task-implementation --task="docs/specs/001-auto-pr-at-loop-end/tasks/TASK-005.md"
