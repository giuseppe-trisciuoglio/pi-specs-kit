---
id: TASK-003
title: "Pull request content builders (title from spec H1, body from run closing state)"
spec: docs/specs/001-auto-pr-at-loop-end/2026-08-17--auto-pr-at-loop-end.md
status: pending
dependencies: []
ac-mapping: [AC-011, AC-012, AC-025]
imp-requirements: [REQ-012, REQ-013, REQ-026, REQ-027]
---

# TASK-003: Pull request content builders (title from spec H1, body from run closing state)

**Functional Description**: Pure builders that compose the pull request title and description. The title comes from the spec document's first H1 (spec identifier is the fallback when no H1 is available). The description carries the spec identifier, the completed task range summary and the loop outcome — including the same terminal warnings the run's closing notices report — drawn from plain data the walk passes in, never re-derived from the fix plan for delivery.

**Maps to Specification**: AC-11 (title from spec document name), AC-12 (description content + terminal warnings), AC-25 (title source pin)

## Acceptance Criteria

- [ ] The title is derived from the spec document's name; the spec identifier is the fallback when no document name is available. *(AC-11, AC-25, REQ-12, REQ-26)*
- [ ] The description contains the spec identifier, the completed range summary (done/total), and the loop outcome. *(AC-12, REQ-13)*
- [ ] The description draws its terminal warnings from the same set the run's closing notices report — tasks that failed while the run continued, partial sync, failed post-hook gate — passed in as plain data, not re-read from the fix plan. *(AC-12, REQ-27)*
- [ ] Both builders are pure: plain data in, strings out, no I/O. *(testability convention)*

## Definition of Ready (DoR)

- [ ] The fix-plan fields used to compute the range summary are listed by name and type in the unit-test fixture.
- [ ] The terminal-warning input shape is concrete: an object `{ failedTasks: string[]; partialSync: boolean; postHookGateFailed: string | null }`. *(F17 concreteness)*

## Technical Context (from Codebase Analysis)

- **Existing Patterns to Follow**: pure-function modules kept out of pi-provided imports (`src/ui/run-args.ts` is the precedent for testable purity).
- **APIs to Integrate With**: the walk in TASK-005 reads the spec document's first H1 (pure file read, scoped to the spec folder) and passes it as a string to `buildPrTitle`; the walk passes the warning object to `buildPrBody` (AD-008).
- **Conventions**: user-visible strings in English; the document-name read is a single function in TASK-005 (this task stays I/O-free).
- **Architecture Reference**: `docs/specs/architecture.md` §3.5 (testable modules); `technical-plan.md` AD-008 / AD-009.
- **Domain Terms**: Consegna del run, Spec (ontology).

## Implementation Details (File names only, no code)

**Files to Create**:
- `src/loop/delivery-content.ts` - `buildPrTitle(specDocumentName, specId)` and `buildPrBody(input)` over plain data; `input` carries `{ specId, rangeDone, rangeTotal, outcome, terminalWarnings }`
- `test/delivery-content.test.ts` - content assertions; includes the terminal-warning input shape in the fixtures

## Test Instructions

**1. Mandatory Unit Tests:**
   - `buildPrTitle`:
     - [ ] Verify the title is the spec document's name when provided. *(AC-11, AC-25, REQ-12/26)*
     - [ ] Verify the title falls back to the spec identifier when no document name is available. *(AC-25, REQ-26)*
     - [ ] Verify that an empty document name falls back to the spec identifier. *(AC-25)*
   - `buildPrBody`:
     - [ ] Verify the body contains the spec identifier. *(AC-12)*
     - [ ] Verify the body contains the completed range summary (done/total). *(AC-12)*
     - [ ] Verify the body contains the loop outcome. *(AC-12)*
     - [ ] Verify that terminal warnings present in the input — failed-task messages, partial-sync flag, post-hook gate — appear in the body as named lines, and a clean run produces a body without warning lines. *(AC-12, REQ-27)*
     - [ ] Verify the builders perform no I/O (no filesystem or network access). *(purity convention)*

**Test Acceptance Criteria**:
- [ ] All tests described above are implemented and pass; builders perform no I/O.

## Definition of Done (DoD)

This task is complete when:
- [ ] Title and description builders exist as pure functions with passing unit tests.

**Dependencies**: None

**Implementation Command**:
/skill:specs-kit-task-implementation --task="docs/specs/001-auto-pr-at-loop-end/tasks/TASK-003.md"
