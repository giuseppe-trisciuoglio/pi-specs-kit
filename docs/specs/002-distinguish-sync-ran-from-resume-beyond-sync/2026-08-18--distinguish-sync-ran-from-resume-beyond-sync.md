# Functional Specification: Distinguish "sync ran" from "resume is past sync"

**Spec ID**: 002-distinguish-sync-ran-from-resume-beyond-sync
**Date**: 2026-08-18
**Status**: Draft
**Version**: 0.1

---

## Clarifications

### Session 2026-08-18

- Q: What is the right answer for a resumed run that is past the sync phase? → A: Run a sync only if no sync actually executed in this run — i.e., separate "sync was actually executed" from "the resume anchor is past the sync phase". The end-of-range sync guards on the former, not the latter.
- Q: Should the fix be minimal or maximal? → A: Minimal — change the *guard* of the end-of-range sync from `syncRan` (which the resume path already sets true) to a per-run signal that only the spawn of a sync sets. No other behaviour changes; the per-task sync guard stays as it is.
- Q: What happens to the characterisation test that pins the current behaviour? → A: The test is rewritten in the same commit as the fix, and the rewrite itself is the record of the behaviour change. The new assertion is: a resumed run past the sync phase still runs the end-of-range sync once, when the resume was not preceded by a sync in this run.
- Q: What happens to the per-task sync guard on resume past sync? → A: Stays. The per-task sync was skipped legitimately on a resume past it — that part of the current behaviour is correct and not in scope. Only the end-of-range sync was collateral damage of the shared flag.

## Business Context

### Problem Statement

In fast mode, a run resumed from a state where the current task has already
passed its sync phase (because the previous run died at `update_done` or
later) completes the range and declares itself successful without any sync
having run in this run. The fix plan reports `done`, the closing summary
reports `completed`, the spec documentation is now stale relative to the
code in the workspace. The defect is silent: no error, no warning, no exit
code signals it. The operator notices weeks later, when a spec is found
frozen in a state the code has long moved past.

The root cause is a shared flag carrying two meanings: the resume path
sets it true because the resume anchor is past the sync, and the end-of-range
sync guards on the same flag. The two meanings were once the same — the
resume was almost always preceded by a sync — but they diverged the moment
the run could die before reaching the sync (a kill, an exhausted budget, a
halt) and be resumed past it. The divergence is the defect.

### Target Users

| User Type | Description | Primary Goal |
|-----------|-------------|--------------|
| Loop Operator | Developer who starts the loop on a spec and monitors its progress | Trust that a run declared "completed" left the spec's documentation consistent with the code |
| Reviewer | Teammate consuming the synced documentation after the run | Find the doc and the code aligned, with no manual reconciliation |

### System Fit

The fix touches one guard, one flag, and one existing characterisation test.
The end-of-range sync node (`final_sync`) and the per-task sync node (`sync`)
are already declared in the graph and already documented in ADR-0011
(the topology of the run-level sync and the per-task sync, D3 on the
in-flight state). The change is a single fact: what does `syncRan`
mean, and where is it set.

The new flag must live in `TaskRuntime.runState` (the in-flight state of
the task, D3 of the graph) so that it dies with the process and is
recomputed on resume — exactly like the other in-flight variables. Putting
it in `fix_plan.json` would be a semantic change to resume that this fix
does not authorise.

### Acceptance Criteria

- AC-001: A fast-mode run resumed from a state past the per-task sync phase
  runs the end-of-range sync exactly once if no sync actually executed in
  this run, and zero times if a sync already executed in this run.
- AC-002: A fresh run (no resume) runs the end-of-range sync on the normal
  conditions recorded by the existing test suite; the fix does not change
  those conditions.
- AC-003: The characterisation test `test/resume-paths.test.ts` (case:
  resume past sync in fast mode) is rewritten to assert AC-001 in place of
  its current assertion; the rewrite is in the same commit as the fix and
  is itself the record of the behaviour change.
- AC-004: The per-task sync guard on resume past sync is unchanged: the
  per-task sync was legitimately skipped, and remains skipped on resume.
- AC-005: No new failure mode, no new exit code, no new operator warning
  surfaces. The behaviour delta is *one* additional sync spawn in the
  worst case (a resumed run past sync, no prior sync).
- AC-006: A run whose budget is exhausted, or whose user-stop request
  interrupts before the end-of-range sync, behaves as it does today — the
  fix changes one guard, not the routing around it.

## Out of scope

- The asymmetry of the stop checks between sync and `update_done` (anomaly
  A2 of the project's issue register): kept as-is, per the closed decision
  recorded there.
- A dedicated test for the catch-all edge that handles entry into a cycle
  with already-exhausted attempts (anomaly A3): a coverage gap, to be
  addressed when those anomalies are tackled as a group.
- Splitting the two files over the indicative size limit (anomaly A4):
  hygiene, separate work.
- Any change to the sync skill, the per-task sync node, or the sync
  semantics other than the guard of the end-of-range sync.

## Constraints

- The fix is a behaviour change, not a refactor: the characterisation test
  is rewritten *deliberately*, in the same commit as the fix, and the
  rewrite is the proof that the behaviour moved.
- The new signal must live in `TaskRuntime.runState`, not in
  `fix_plan.json`. Persisting it would change the meaning of resume, which
  is out of scope.
- The graph table does not change: the same edges, the same predicates, the
  same nodes. Only one fact that `final_sync` reads is renamed to mean
  what it says.

## Reference documents

- `docs/adr/0011-declared-serial-graph-for-the-task-loop.md` — the graph
  topology, D3 on the in-flight state of the task (the place where the
  `syncRan` signal lives). The actual code that exhibits the bug is in
  `src/loop/graph/task-nodes-cycle.ts:58` (entry into a task past the
  sync) and `src/loop/graph/conditions.ts:71` (the guard of the final
  sync).
