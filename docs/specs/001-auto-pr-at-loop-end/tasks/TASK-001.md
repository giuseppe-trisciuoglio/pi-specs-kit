---
id: TASK-001
title: "Delivery configuration flag"
spec: docs/specs/001-auto-pr-at-loop-end/2026-08-17--auto-pr-at-loop-end.md
status: pending
dependencies: []
ac-mapping: [AC-001, AC-026]
imp-requirements: [REQ-001, REQ-002, REQ-003, REQ-028]
---

# TASK-001: Delivery configuration flag

**Functional Description**: Add the opt-in configuration flag that gates automatic delivery at loop completion. Disabled by default; read tolerantly (absent, malformed, unknown values yield the default). The flag's presence implies the delivery commit regardless of the per-task checkpoint setting, and the base branch defaults to `main` when not configured.

**Maps to Specification**: AC-1 (flag-gated programmatic delivery — configuration half), AC-26 (base branch defaults to `main`)

## ⚠️ Cross-Boundary Warning

- **Primary Context**: Consegna (delivery)
- **This Task Modifies**: `src/config/specs-kit-config.ts`, `src/config/config-init.ts` in the Configurazione context
- **Risk**: LOW
- **Justification**: the flag is project configuration; delivery reads it at run start. The Configurazione context owns every yaml key.

## Acceptance Criteria

- [ ] A boolean configuration flag enables delivery at loop completion; absent, malformed or unknown values yield the default (flag off). *(AC-1, REQ-1/2)*
- [ ] The base branch defaults to `main` when not configured. *(AC-26, REQ-28)*
- [ ] The new-project config template documents the flag with its default next to the base branch key. *(REQ-1)*
- [ ] The flag is modeled alongside the base branch in the typed config view and is read at run start, not at load time. *(REQ-1, hot-reload rule)*
- [ ] Tolerance covers scalars, arrays, objects and nested structures without throwing. *(REQ-2, F16 coverage)*

## Definition of Ready (DoR)

- [ ] No prerequisite tasks are pending.
- [ ] The tolerant-loader helper conventions (`flag()`, `text()`) are understood from the config module.
- [ ] The config-init template structure is understood.

## Technical Context (from Codebase Analysis)

- **Existing Patterns to Follow**: `git.baseBranch` parsing in `src/config/specs-kit-config.ts` — every scalar goes through a tolerant accessor before entering the typed view.
- **APIs to Integrate With**: `SpecsKitConfig.git` typed field; `config-init.ts` yaml template.
- **Shared Components**: none new.
- **Conventions**: unknown yaml fields ignored; only modeled fields written back; config is read at first command (hot reload first).
- **Architecture Reference**: `docs/specs/architecture.md` §3.2 (Configuration), `§3.5` rules; `docs/specs/001-auto-pr-at-loop-end/technical-plan.md` §AD-003.
- **Domain Terms**: Flag di consegna, Ramo base (ontology).

## Implementation Details (File names only, no code)

**Files to Modify**:
- `src/config/specs-kit-config.ts` - add `pullRequest` boolean to the git section of the typed view, its default, its tolerant parse; document the `main` base-branch default
- `src/config/config-init.ts` - document the new key with default in the generated template
- `test/config.test.ts` - loader cases for the new key and for the `main` default
- `docs/specs/architecture.md` - §3.2 config keys section enumerates `run.no_commit`, `git.base_branch`, `git.pull_request` (closes F14)

## Test Instructions

**1. Mandatory Unit Tests:**
   - `loadSpecsKitConfig` (git section):
     - [ ] Verify that a config file without `pull_request` yields flag off. *(AC-1)*
     - [ ] Verify that an explicit `pull_request: true` yields flag on. *(AC-1)*
     - [ ] Verify that a malformed value (string, number, array, object, nested) falls back to off without error. *(REQ-2, F16 coverage)*
     - [ ] Verify that the base branch parsing is unaffected by the new key. *(REQ-2)*
     - [ ] Verify that with no `base_branch` configured the typed view exposes `main` as the base branch. *(AC-26, REQ-28)*
   - `config-init` template:
     - [ ] Verify the generated file contains the new key with the off default.

**3. Edge Cases and Error Conditions to Test:**
   - [ ] Empty config file → flag off, base branch `main`, no error. *(REQ-2, REQ-28)*

**Test Acceptance Criteria**:
- [ ] All tests described above are implemented and pass.

## Definition of Done (DoD)

This task is complete when:
- [ ] The flag loads tolerantly with default off, exposed in the typed config view.
- [ ] The base branch defaults to `main` and is enumerated alongside other config keys.
- [ ] The new-project template documents the flag.
- [ ] Architecture §3.2 enumerates the config keys (F14 closure).
- [ ] Tests pass and no existing config behavior changes.

**Dependencies**: None

**Implementation Command**:
/skill:specs-kit-task-implementation --task="docs/specs/001-auto-pr-at-loop-end/tasks/TASK-001.md"
