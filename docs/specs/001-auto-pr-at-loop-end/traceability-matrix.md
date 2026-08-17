# Traceability Matrix: Automatic Pull Request at Loop Completion

**Spec**: [2026-08-17--auto-pr-at-loop-end.md](./2026-08-17--auto-pr-at-loop-end.md) (v1.1)
**Generated**: 2026-08-17
**Last Updated**: 2026-08-17

## Coverage Summary

- **Acceptance criteria**: 26 total — 20 `[IMP]` / 4 `[SEF]` / 2 `[EXT]`
- **[IMP] covered by tasks**: 20/20 (100%)
- **[SEF] verified**: 4/4 (100%) — e2e verification + documentation task
- **[EXT] checkpoints**: 2/2 (100%) — documentation task
- **Implemented**: 0/20 (pending)

## Coverage Type Legend

| Type | Meaning | Task Generated? | Verified In |
|------|---------|-----------------|-------------|
| `[IMP]` Implementable | Requires new code | YES — dedicated task(s) | Unit + e2e tests |
| `[SEF]` Side-Effect | Natural consequence of [IMP] | NO — verification only | TASK-006 e2e + TASK-007 checklist |
| `[EXT]` External | Verified externally/by observation | NO — checkpoint only | TASK-007 checklist |

## Matrix

| AC ID | REQ(s) | Type | Criterion (short) | Task(s) | Test Files | Status |
|--------|--------|------|-------------------|---------|------------|--------|
| AC-001 | REQ-001/004/006 | [IMP] | Flag on + completed → programmatic delivery | TASK-001, TASK-005, TASK-006 | test/config.test.ts, test/run-walk-delivery.test.ts, e2e/delivery.e2e.test.ts | Pending |
| AC-002 | REQ-001 | [SEF] | Flag off → behavior unchanged | — (e2e + docs) | e2e/delivery.e2e.test.ts (flag-off scenario) | Pending |
| AC-003 | REQ-005 | [IMP] | Halted → no delivery + skip notice | TASK-005 | test/run-walk-delivery.test.ts | Pending |
| AC-004 | REQ-005 | [IMP] | Stopped → no delivery + skip notice | TASK-005 | test/run-walk-delivery.test.ts | Pending |
| AC-005 | REQ-007/025 | [IMP] | Base branch or detached → spec branch is PR head | TASK-002, TASK-006 | test/delivery.test.ts, e2e/delivery.e2e.test.ts | Pending |
| AC-006 | REQ-008 | [IMP] | Non-base → PR from current branch, no branch op | TASK-002 | test/delivery.test.ts | Pending |
| AC-007 | REQ-009 | [IMP] | PR target = configured base branch | TASK-004 | test/delivery.test.ts | Pending |
| AC-008 | REQ-010/011 | [IMP] | Dirty tree → exactly one delivery commit, nothing left | TASK-002 | test/delivery.test.ts | Pending |
| AC-009 | REQ-011 | [SEF] | Clean tree → no empty commit | — (e2e + docs) | e2e/delivery.e2e.test.ts (clean tree scenario in TASK-006) | Pending |
| AC-010 | REQ-003 | [IMP] | Flag on + checkpoints off → commit still created | TASK-002 | test/delivery.test.ts | Pending |
| AC-011 | REQ-012/026 | [IMP] | Title from spec document name (with id fallback) | TASK-003, TASK-005 | test/delivery-content.test.ts, test/run-walk-delivery.test.ts | Pending |
| AC-012 | REQ-013/027 | [IMP] | Body: spec id + range summary + outcome + terminal warnings (closing-state source) | TASK-003, TASK-005 | test/delivery-content.test.ts, test/run-walk-delivery.test.ts | Pending |
| AC-013 | REQ-014 | [IMP] | Existing PR → report URL, no duplicate | TASK-004 | test/delivery.test.ts | Pending |
| AC-014 | REQ-015 | [IMP] | Failure → warning (step+reason), run stays completed | TASK-004, TASK-005 | test/delivery.test.ts, test/run-walk-delivery.test.ts | Pending |
| AC-015 | REQ-015 | [IMP] | Missing/unauth CLI → warning, commits retained | TASK-004 | test/delivery.test.ts | Pending |
| AC-016 | REQ-018 | [SEF] | Failed push → commits on named branch | — (e2e + docs) | e2e/delivery.e2e.test.ts | Pending |
| AC-017 | — | [EXT] | PR on forge shows expected base/head/title/body | — (docs checkpoint) | — | Pending |
| AC-018 | REQ-019 | [EXT] | URL/warnings observed in notifications | — (docs checkpoint + e2e) | e2e/delivery.e2e.test.ts | Pending |
| AC-019 | REQ-020 | [IMP] | Partial range delivers like full run | TASK-005 | test/run-walk-delivery.test.ts | Pending |
| AC-020 | REQ-021 | [SEF] | Push updates existing PR | — (e2e + docs) | e2e/delivery.e2e.test.ts | Pending |
| AC-021 | REQ-022 | [IMP] | Outcome-only notice (URL / step+reason) | TASK-005 | test/run-walk-delivery.test.ts | Pending |
| AC-022 | REQ-023 | [IMP] | Working copy stays on delivery branch when one exists | TASK-002 | test/delivery.test.ts | Pending |
| AC-023 | REQ-024 | [IMP] | Diverged branch → refuse-with-warning, no force | TASK-002, TASK-006 | test/delivery.test.ts, e2e/delivery.e2e.test.ts | Pending |
| AC-024 | REQ-025 | [IMP] | Detached HEAD → spec-branch path | TASK-002 | test/delivery.test.ts | Pending |
| AC-025 | REQ-026 | [IMP] | Title from spec document name, spec-id fallback | TASK-003 | test/delivery-content.test.ts | Pending |
| AC-026 | REQ-028 | [IMP] | Base branch defaults to `main` | TASK-001 | test/config.test.ts | Pending |

**Negative requirements** (REQ-NR001…008) are enforced as constraints across TASK-002/004/005 (no agent delegation, no outcome flips, no delivery on halt/stop, no retries, commit before push, no history rewriting, nothing persisted, no credentials) and re-checked in TASK-007/008.

**Review-finding closures mapped**: F9 (commitCheckpoint gate boundary) → TASK-002 unit + TASK-006 e2e (flag-on + no_commit scenario, AD-002); F11 (matrix/frontmatter consistency) → refreshed matrix above; F16 (loader array/object coverage) → TASK-001; F17 (TASK-003 DoR concreteness) → TASK-003 DoR rewrites inputs; F18 (tautological no-agent-subprocess test) → TASK-002 specific binary assertion; F4/F11/A MAJORs addressed by TASK-002/005 wiring.
