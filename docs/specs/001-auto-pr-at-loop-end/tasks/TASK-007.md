---
id: TASK-007
title: "Documentation for automatic pull request at loop completion"
spec: docs/specs/001-auto-pr-at-loop-end/2026-08-17--auto-pr-at-loop-end.md
status: pending
dependencies: [TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-006]
ac-mapping: [AC-002, AC-009, AC-016, AC-017, AC-018, AC-020]
imp-requirements: []
---

# TASK-007: Documentation for automatic pull request at loop completion

**Functional Description**: Produce the documentation for the delivery feature: user-facing flag semantics and prerequisites, the project ADR recording the delivery decisions, the glossary entries in `CONTEXT.md` and the architecture's configuration key table updated per F14, and developer notes. This task is also the verification checkpoint for the [SEF] and [EXT] acceptance criteria. Finally, flip the specification's Status from `Draft` to `Approved` per F19.

**Maps to Specification**: AC-2 [SEF], AC-9 [SEF], AC-16 [SEF], AC-17 [EXT], AC-18 [EXT], AC-20 [SEF] — documentation checkpoints

## Acceptance Criteria

- [ ] Feature documentation covers the flag (default off), its interaction with the checkpoint setting (`run.no_commit` does not affect delivery), prerequisites (forge CLI installed and authenticated, `origin` remote), base branch default (`main`) and the branch behavior on/off the base branch. *(user-facing completeness)*
- [ ] A project ADR (`docs/adr/0019-*.md`) records the delivery decisions (deterministic post-run step, best-effort failures, ephemeral outcomes, guarded reuse, stdout URL acquisition) in the project's ADR style. *(decision trail)*
- [ ] `CONTEXT.md` gains the delivery terms (Consegna del run, Flag di consegna, Ramo della spec, Ramo base, Forge) with their avoid-lists, consistent with `docs/specs/ontology.md`. *(terminology)*
- [ ] `docs/specs/architecture.md` §3.2 enumerates `run.no_commit`, `git.base_branch`, `git.pull_request` with types and defaults. *(F14 closure)*
- [ ] Developer notes (`TECHNICAL-NOTES.md`) document the module layout, contracts, the divergence guard mechanics, the URL parser test, the warning-capture ordering invariant, and the `--resume` post-kill limitation. *(maintainability)*
- [ ] The specification flips Status from `Draft` to `Approved` once all review findings owned by other skills are closed. *(F19 closure)*
- [ ] [SEF]/[EXT] checkpoints verified and recorded: flag-off behavior unchanged (AC-2), no empty commits (AC-9), commits retained on named branch after failed push (AC-16), PR visible on forge with expected base/head/title/description (AC-17), URL/warnings observed in session notifications (AC-18), push updates existing PR (AC-20). *(documentation task purpose)*

## Definition of Ready (DoR)

- [ ] All implementation tasks (TASK-001…006) are complete and their tests pass.

## Technical Context (from Codebase Analysis)

- **Existing Patterns to Follow**: ADR style in `docs/adr/` (numbered, options-considered, consequences); `CONTEXT.md` glossary entries with `_Avoid_` lists; README configuration sections.
- **Conventions**: user-facing strings English; comments/docs never cite spec identifiers; compatibility stated in words.
- **Domain Terms**: Consegna del run, Flag di consegna, Ramo della spec, Ramo base, Forge (ontology).

## Implementation Details (File names only, no code)

**Files to Create**:
- `docs/specs/001-auto-pr-at-loop-end/README.md` - feature README: purpose, flag, prerequisites, behavior, troubleshooting
- `docs/specs/001-auto-pr-at-loop-end/TECHNICAL-NOTES.md` - module layout, contracts, divergence guard, URL parser test, warning-capture ordering, `--resume` limitation

**Files to Modify**:
- `docs/adr/0019-*.md` (new ADR) - the loop delivers its own work, best-effort
- `CONTEXT.md` - delivery glossary terms with avoid-lists
- `docs/specs/architecture.md` §3.2 - enumerate the config keys (F14)
- `README.md` (project) - configuration documentation for the new key
- `docs/specs/001-auto-pr-at-loop-end/2026-08-17--auto-pr-at-loop-end.md` - flip Status to Approved (F19 closure)

## Test Instructions

**3. Verification checkpoints (no new automated tests):**
   - [ ] Walk the [SEF]/[EXT] checklist against the e2e suite and the running feature; record results in TECHNICAL-NOTES. *(task purpose)*
   - [ ] Verify the architecture config-keys table reflects the loader's tolerant defaults. *(F14 closure)*

## Definition of Done (DoD)

This task is complete when:
- [ ] README, TECHNICAL-NOTES, ADR, glossary, architecture §3.2 and project README updates exist and are consistent.
- [ ] The specification Status is `Approved`.
- [ ] All [SEF]/[EXT] checkpoints are verified and recorded.

**Dependencies**: TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-006

**Implementation Command**:
/skill:specs-kit-task-implementation --task="docs/specs/001-auto-pr-at-loop-end/tasks/TASK-007.md"
