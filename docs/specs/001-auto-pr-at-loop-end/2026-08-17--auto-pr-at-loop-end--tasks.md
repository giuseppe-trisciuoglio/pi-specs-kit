# Task List: Automatic Pull Request at Loop Completion

**Specification**: [2026-08-17--auto-pr-at-loop-end.md](./2026-08-17--auto-pr-at-loop-end.md) (v1.1)
**Technical Plan**: [2026-08-17--technical-plan.md](./2026-08-17--technical-plan.md) (v1.1)
**Generated**: 2026-08-17 (re-run after spec v1.1 + technical plan v1.1)
**Stack**: TypeScript 5.9 / Node 24 (pi extension), no new runtime dependencies — git + forge CLI as external binaries

## Codebase Analysis Summary

- **Project Structure**: modular pi extension (`src/config`, `src/loop`, `src/agent`, `src/measure`, `src/ui`, `src/tools`); unit tests in `test/` mirror `src/`; e2e in `e2e/` with fake binaries on PATH. No build step (native TS).
- **Key Patterns**: injectable deps for every side effect (`EngineDeps` precedent); hardened subprocess wrapper (`src/util/process.ts`) used by the existing checkpoint and the new delivery step (`src/loop/delivery.ts`); best-effort auxiliary operations that warn instead of throwing; tolerant config loader.
- **Integration Points**: run walk completion branch (`src/loop/run-walk.ts` — captured between the range-completed notify and the postHookGateFailed clear); `git.base_branch` / `git.pull_request` config under `git:` (default `main` / default off); `[specs-kit]` notification channel.

## Task Index

| Task ID | Title | Technical Focus | Status | Dependencies | Flags |
|---------|-------|-----------------|--------|--------------|-------|
| [TASK-001](tasks/TASK-001.md) | Delivery configuration flag | specs-kit-config.ts, config-init.ts, architecture §3.2 | [ ] pending | — | CROSS-BC (Configurazione, LOW) |
| [TASK-002](tasks/TASK-002.md) | Delivery module: probe, guarded reuse, detached, commit | src/loop/delivery.ts | [ ] pending | TASK-001 | ext: git (verified) |
| [TASK-003](tasks/TASK-003.md) | Pull request content builders (H1 title, closing-state warnings) | src/loop/delivery-content.ts | [ ] pending | — | pure functions |
| [TASK-004](tasks/TASK-004.md) | Push + forge steps (stdout URL, view fallback) | src/loop/delivery-forge.ts | [ ] pending | TASK-002, TASK-003 | EXT-DEP: forge CLI |
| [TASK-005](tasks/TASK-005.md) | Wire delivery into run walk (warning capture + spec H1 read) | run-walk.ts, engine.ts, run-assembly.ts | [ ] pending | TASK-001, TASK-002, TASK-004 | CROSS-BC (Loop, MEDIUM) |
| [TASK-006](tasks/TASK-006.md) | E2E delivery scenarios | e2e/fake-bin/gh, delivery.e2e.test.ts | [ ] pending | TASK-005 | e2e |
| [TASK-007](tasks/TASK-007.md) | Documentation | README, ADR-0019, CONTEXT.md, architecture §3.2, TECHNICAL-NOTES, spec Status→Approved | [ ] pending | TASK-001…006 | [DOCS] + [SEF]/[EXT] checkpoints + F14/F19 closure |
| [TASK-008](tasks/TASK-008.md) | Code Cleanup & Hygiene | all feature files | [ ] pending | TASK-007 | [CLEANUP] |

**Legend**: CROSS-BC = cross-boundary modification (justified in task), EXT-DEP = external dependency risk (mitigation in task), [DOCS] = documentation task, [CLEANUP] = cleanup task.

## Tasks

- [TASK-001](tasks/TASK-001.md): Delivery configuration flag (with base branch default `main`)
- [TASK-002](tasks/TASK-002.md): Delivery module — probe, guarded branch decision, detached-HEAD path, delivery commit
- [TASK-003](tasks/TASK-003.md): Pull request content builders (H1 title, closing-state warnings)
- [TASK-004](tasks/TASK-004.md): Push and forge steps — stdout URL acquisition and existing-PR reporting
- [TASK-005](tasks/TASK-005.md): Wire delivery into the run walk (with terminal-warning capture)
- [TASK-006](tasks/TASK-006.md): End-to-end delivery scenarios with fake forge
- [TASK-007](tasks/TASK-007.md): Documentation (+ [SEF]/[EXT] verification checkpoints + F14/F19 closure)
- [TASK-008](tasks/TASK-008.md): Code Cleanup & Workspace Hygiene

## Task Type Summary

- **Implementation Tasks** (TASK-001…006): core feature — 6 tasks (≤ 15 limit ✓)
- **Documentation Task** (TASK-007): README, ADR, glossary, architecture config keys, technical notes, spec Status flip; verifies [SEF]/[EXT] criteria, closes F14/F19
- **Cleanup Task** (TASK-008): final hygiene via specs-kit-code-cleanup

## Dependency Graph

```
TASK-001 ─┬─▶ TASK-002 ─┬─▶ TASK-004 ─▶ TASK-005 ─▶ TASK-006 ─▶ TASK-007 ─▶ TASK-008
TASK-003 ─┴───────────────┘
```

## Coverage Summary

| Type | Count | Mapped |
|------|-------|--------|
| [IMP] criteria (v1.1) | 20 | All covered by tasks |
| [SEF] criteria | 4 | Verified in TASK-006 e2e + TASK-007 docs |
| [EXT] criteria | 2 | Verified in TASK-007 docs |

## Notes

- Codebase graph (`graphify-out/graph.json`) absent at generation time; tasks derive from direct in-session analysis (operator's choice earlier in the session). The loop's sync phase refreshes the graph on first run.
- Spec v1.1 introduces REQ-024…028 and AC-023…026; the previous task set (generated from spec v1.0) was overwritten in place rather than renumbered to keep dependency references stable inside this document.
- The plan's AD-006 fix (URL from stdout of `pr create`) is implemented in TASK-004; the pre-fix `--json url` invocation would have failed with "unknown flag" on every successful run.
- The gate is no longer BLOCKED on blockers (F2 closed in the technical-plan follow-up; F3 closed in the spec-check follow-up). The remaining review findings (F11/F12/F13/F15/F16/F17/F18/C1) are owned by other skills or deferred.
