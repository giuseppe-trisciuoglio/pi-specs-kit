---
id: TASK-008
title: "Code Cleanup & Workspace Hygiene for automatic pull request at loop completion"
spec: docs/specs/001-auto-pr-at-loop-end/2026-08-17--auto-pr-at-loop-end.md
status: pending
dependencies: [TASK-007]
ac-mapping: []
imp-requirements: []
---

# TASK-008: Code Cleanup & Workspace Hygiene for automatic pull request at loop completion

**Functional Description**: Final cleanup of everything the delivery feature touched, using the code-cleanup skill: remove debug logs and temporary comments, drop dead code, keep files within the one-responsibility size guidance, and leave the three gates green.

**Maps to Specification**: N/A (hygiene task over the whole feature)

## Acceptance Criteria

- [ ] No debug logging, temporary comments or leftover development artifacts in the new modules. *(hygiene)*
- [ ] Delivery modules respect the single-responsibility size guidance (~250 lines), extracting if needed. *(architecture rule)*
- [ ] All three project gates pass: unit+e2e tests, typecheck, lint. *(definition of done)*
- [ ] No new runtime dependency was introduced. *(architecture rule)*

## Definition of Ready (DoR)

- [ ] TASK-007 is complete (documentation exists, [SEF]/[EXT] checkpoints recorded, spec Status Approved).

## Technical Context (from Codebase Analysis)

- **Conventions**: comments explain why in natural language, never cite spec identifiers or doc paths; messages English; no references to the project the loop semantics derive from.
- **Gates**: `npm test`, `npm run typecheck`, `npm run lint`.

## Implementation Details (File names only, no code)

**Files to Modify**:
- All files created/modified by TASK-001…006, as cleanup findings require.

## Test Instructions

**3. Verification:**
   - [ ] Run the full gate suite; all green after cleanup.

## Definition of Done (DoD)

This task is complete when:
- [ ] Cleanup pass done via the code-cleanup skill.
- [ ] Gates green; workspace clean.

**Dependencies**: TASK-007

**Implementation Command**:
/skill:specs-kit-code-cleanup --task="docs/specs/001-auto-pr-at-loop-end/tasks/TASK-008.md"
