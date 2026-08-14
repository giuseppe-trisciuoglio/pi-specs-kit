---
name: specs-kit-task-review
description: "Provides capability to verify that implemented tasks meet specifications and pass code review. Use when needing to validate a completed task from /skill:specs-kit-task-implementation against its specification."
argument-hint: "[ --task=\"docs/specs/XXX-feature/tasks/TASK-XXX.md\" ]"
---

# Task Review

Verifies that implemented tasks meet specifications and pass code quality standards. This is the bridge between implementation and verification.

## Overview

This command reviews a completed task to ensure:
1. **Task Implementation**: The task was implemented according to its specifications
2. **Spec Compliance**: The implementation aligns with the functional specification
3. **Code Quality**: The code passes code review standards
4. **Acceptance Criteria**: All acceptance criteria are met
5. **Definition of Done**: The documented completion conditions are fully satisfied

**Input**: `docs/specs/[id]/tasks/TASK-XXX.md` (from /skill:specs-kit-spec-to-tasks)
**Output**: Review report with pass/fail status and findings

### Workflow Position

```
Idea → Functional Specification → Tasks → Implementation → Review → Code Cleanup → Done
              (brainstorm)           (spec-to-tasks)       (task-implementation)  (task-review)   (code-cleanup)
```

## Usage

```bash
# Review a specific task
/skill:specs-kit-task-review docs/specs/001-user-auth/tasks/TASK-001.md
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--task` | No | Task file path |
| `--spec` | No | Path to spec folder |

## Examples

### Basic Usage

```bash
/skill:specs-kit-task-review docs/specs/001-user-auth/tasks/TASK-001.md
```

### Using Spec Detection

```bash
/skill:specs-kit-task-review --task=TASK-001
```

## Inputs

Determine the task to review from the invocation context:
- when driven by the loop, the task is provided in the `<task>` block of the prompt;
- when invoked directly, the task path (`--task=`) and optional spec folder (`--spec=`) arrive as skill arguments.

Resolve, in order:
- `task` → the task file path (required)
- `spec` → the spec folder path (optional; derived from the task path when absent)
- `--no-confirm` → skip confirmation prompts when set

If any required input is missing or ambiguous, ask the user via ask_user_question.

## Core Principles

- **Thorough verification**: Check every acceptance criterion and every DoD item
- **Spec alignment**: Ensure implementation matches functional requirements
- **Code quality**: Verify code passes review standards
- **Evidence-based**: Base findings on actual code, not assumptions
- **Use a checklist**: Track all progress throughout
- **No time estimates**: DO NOT provide or request time estimates

---

## Phase 1: Task Analysis

**Goal**: Read and understand the task and its specifications

**Actions**:

1. (Argument parsing completed in Phase 0)
2. Read the task file (`docs/specs/[id]/tasks/TASK-XXX.md`)
3. Extract:
   - Task ID and title
   - Description
   - Acceptance criteria
   - Definition of Ready (DoR) and Definition of Done (DoD) sections
   - Dependencies
   - Reference to specification file
   - `imp-requirements` and `ac-mapping` from frontmatter — which spec ACs this task claims to implement
   - If either section is missing, stop the review and require the task document to be updated before continuing
4. Read the functional specification file (from task's spec reference)
5. Verify both files exist and are valid
6. If files not found, ask user for correct path via ask_user_question

---

## Phase 2: Implementation Verification

**Goal**: Verify the task was implemented according to specifications

**Actions**:

1. Identify what files/components were created for this task:
   - Check git diff to see what changed since task was started
   - Look for new files matching the task scope
   - Review implementation details

2. Verify implementation matches task description:
   - Compare implemented functionality with task description
   - Check if all described features are present
   - Identify any deviations or missing parts

3. Document findings:
   - What was implemented vs. what was specified
   - Any deviations from the original plan
   - Additional changes that were made

4. **Read decision-log.md if exists**:
   - Check for `decision-log.md` in the spec folder
   - If file exists, read any DEC entries related to this task (TASK-XXX)
   - Use decision context to understand WHY deviations were made
   - Reference specific decision IDs when explaining deviations in findings

5. **Verify test count** (do not estimate):
   - Count the actual `@Test` (or language-equivalent) annotations in the task's test files:
     run `grep -r "@Test" src/test/ --include="*.java" | wc -l` or the equivalent for the project language
   - Report the exact count in the review; never guess or round
   - If the count cannot be determined programmatically (non-standard test framework), state only
     "tests pass" without a number, or use the count reported by the build output (e.g. `Tests run: N`)

---

## Phase 3: Acceptance Criteria and DoD Validation

**Goal**: Verify all acceptance criteria and DoD items are met

**Actions**:

1. List all acceptance criteria from the task file
2. List all DoD items from the task file
3. For each acceptance criterion and DoD item:
   - Identify code/tests/review evidence that validate it
   - Check if tests exist and pass when relevant
   - Verify the requirement is actually met
4. Mark each item as:
   - ✅ Met (with evidence)
   - ❌ Not met (with explanation)
   - ⚠️ Partially met (with details) — treated as FAILED for `review_status`

5. **Update traceability-matrix.md**:
   - Read `docs/specs/[id]/traceability-matrix.md`
   - For this task (TASK-XXX), update the matrix:
     - Fill in "Test Files" column with test file names created for this task
     - Fill in "Code Files" column with source files created for this task
     - Update "Status" to "Implemented" for REQ-IDs covered by this task
   - Save updated matrix back to `docs/specs/[id]/traceability-matrix.md`

6. **BOUNDED CONTEXT ADHERENCE CHECK **:
   - Read `docs/specs/ontology.md` for bounded context definitions
   - Determine the primary bounded context of the feature
   - For each file modified/created in the implementation:
     - Determine its bounded context from path conventions or ontology
     - If DIFFERENT from the feature's primary context:
       - Check if the task file has a "Cross-Boundary Warning" section
       - If YES and justification is valid: note in review as "acknowledged cross-boundary"
       - If YES but justification is weak: add `warning` issue
       - If NO warning section: add `blocking` issue
   - **Why this matters**: Tasks that silently cross bounded context boundaries are the #1 cause of architectural drift.

---

## Phase 4: Specification Compliance Check

**Goal**: Ensure implementation aligns with functional specification AND verify task necessity

**Actions**:

1. Review the functional specification to verify compliance
2. Compare implementation against:
   - User stories and use cases
   - Business rules
   - Integration requirements
   - Data requirements
3. Identify any gaps or misalignments
4. Check if implementation introduces any out-of-scope changes

5. **SPEC FIDELITY CHECK **:
   - Read the task's `imp-requirements` and `ac-mapping` from frontmatter
   - For each AC-ID in `ac-mapping`:
     - Verify the implementation actually satisfies the acceptance criterion
     - Check the criterion's taxonomy in the spec: `[IMP]`, `[SEF]`, or `[EXT]`
     - **If the task claims to implement `[SEF]` or `[EXT]` criteria**: 
       - Flag as "Task Over-Specification"
   - **If the task has NO `ac-mapping` or `imp-requirements`**:
     - Flag as "Legacy Task — no traceability metadata"

6. **Verify task necessity**:
   - Ask: "Is this task implementing a criterion that requires new code?"
   - If ALL the task's ACs are `[SEF]` or `[EXT]`: 
     - Flag as "Unnecessary Task — no implementation needed"
   - If the task creates entities/structs NOT mentioned in the functional spec:
     - Check `data-model.md` for `(derived)` marking
     - If NOT marked `(derived)`: Flag as "Invented Entity — not in spec"

7. **Check for spec contradictions**:
   - If the implementation does something DIFFERENT from the spec:
     - Check `decision-log.md` for a DEC entry justifying the deviation
     - If NO DEC entry: flag as critical issue

---

## Phase 5: Convention Provenance Check

**Goal**: Verify that every convention the implementation relied on was
already documented in the project before this task started, and that the
agent did not silently invent new patterns that will be picked up as
"pre-existing" by downstream tasks.

The motivation is that `decision-log.md` entries whose `Decided By` field
is the implementation agent itself are not actually authoritative — the
reviewer cannot use them as evidence that a convention was followed if
the convention was created in the same pass. This phase rebuilds the
authority check from the source documents (`architecture.md`,
`ontology.md`, `data-model.md`, prior task files, and DEC entries with
a pre-existing `Decided By`).

**Runs**: Always, on every review (including `--no-confirm` reviews and
reviews driven by the loop). It is the cheapest check in the pipeline
and the one most often skipped by mistake.

**Actions**:

1. **Build the set of pre-existing conventions**:

   - Read `architecture.md` (the project architecture document, not the
     spec's technical plan) and collect every architectural rule that
     appears as a bullet, list item, or numbered item. Record the file's
     `Last Updated` header — anything added later is not pre-existing.
   - Read `ontology.md` and collect every bounded-context definition,
     glossary entry, and naming convention.
   - Read `data-model.md` and collect every invariant listed under
     "Business invariants" / "Regole di business" / equivalent headings.
   - Walk every DEC entry in `decision-log.md` whose `Decided By` is
     **not** the implementation agent for the current task. Mark them
     pre-existing.
   - Walk every DEC entry whose `Decided By` **is** the implementation
     agent. Mark them as "agent-claimed" — they are candidates to be
     flagged unless the corresponding convention can be sourced from the
     architecture / ontology / data-model docs above.

2. **Enumerate the conventions the implementation introduced or relied on**:

   - For each file the implementation created or modified, read it and
     list every non-trivial pattern: factory methods, builder APIs,
     annotations used as markers, package layouts, naming conventions,
     visibility choices, constructor signatures, JSON property names,
     log message shapes, etc.
   - For each pattern, note the file and line where it appears.

3. **Cross-check each implementation pattern against the pre-existing set**:

   For every pattern from step 2, run these three questions in order:

   a. **Is the pattern already in `architecture.md` / `ontology.md` /
      `data-model.md` as written before this task started?** If yes:
      ✅ pre-existing, no issue.

   b. **Is the pattern backed by a DEC entry with `Decided By` ≠ this
      implementation?** If yes: ✅ pre-existing (the DEC predates the
      task even though the implementation honours it), no issue.

   c. **Is the pattern only documented by a DEC entry whose `Decided By`
      is the implementation itself (or by nothing at all)?** If yes:
      ❌ **`invented-convention`** issue. Severity depends on impact:
      - **blocking** if the convention is observable from outside the
        task's own files (package name, public API shape, JSON
        property, schema annotation that the OpenAPI contract picks up,
        marker annotation other modules will import). Downstream tasks
        will read this convention as "the way things are done" without
        knowing it was invented this morning.
      - **warning** if the convention is purely internal to the task's
        own classes (private helper, package-private overload,
        internal validation order). Document it but do not block.
      - **suggestion** if the convention is cosmetic (comment style,
        blank line placement, import ordering).

4. **For every `invented-convention` finding, recommend a remediation**:

   - **Promote to architecture**: add a bullet to `architecture.md`
     §3.5 (or the equivalent Architectural Rules section) describing
     the convention in the same style as the surrounding bullets.
     Cite the DEC entry that introduced it. Until the bullet exists,
     downstream tasks cannot rely on the convention.
   - **Or ratify via DEC**: if the convention is too narrow to belong
     in `architecture.md`, add a new DEC entry with `Decided By: User`
     or `Decided By: Architecture review` rather than leaving the
     agent-claimed DEC in place. The reviewer should not sign off on
     patterns that are only justified by an agent-claimed DEC.
   - **Or revert**: if the convention is not actually necessary, change
     the implementation to match an existing documented pattern and
     drop the agent-claimed DEC.

5. **Add the findings to `issues`** with the same severity vocabulary
   already used in this skill (`blocking` / `warning` / `suggestion`).
   A `blocking` `invented-convention` is enough to flip
   `review_status` to `FAILED` — the implementation passes its ACs but
   leaves the codebase without an authority for a convention downstream
   tasks will assume is canonical.

6. **Cross-reference with Phase 4** (Spec Compliance): if the
   implementation already added a DEC entry in `decision-log.md` to
   justify the deviation, do NOT treat that DEC as automatic authority.
   Re-apply the same three-question check to the DEC itself. A DEC
   written by the implementation to justify its own deviation is
   exactly the case this phase exists to catch.

**Why this phase is mandatory**: every task downstream of TASK-N depends
on TASK-N's output being consistent with project conventions. If TASK-N
invented a convention without documenting it in `architecture.md`, TASK-(N+1)
will adopt it without knowing it is one task old. Three tasks downstream
the convention looks "established", and removing it requires touching
every consumer. Catching it at the review of the task that introduced it
is the cheapest place to intervene.

---

## Phase 6: Code Review

**Goal**: Verify code passes quality standards

**Actions**:

1. Perform the code review focusing on:
   - Architectural alignment
   - Coding standards and patterns
   - Security and performance
   - Error handling and edge cases
   - Maintainability and readability
2. Document specific code findings (file, line, issue, recommendation)

---

## Phase 7: Review Report Generation

**Goal**: Generate a summary of review findings and set status

**Actions**:

1. **Calculate overall status** — `review_status` takes one of two values and no
   others:
   - `PASSED`: all ACs and DoD met, no critical code issue, no architectural drift
   - `FAILED`: anything else — an unmet or partially met AC, a DoD item left
     open, a critical finding, a spec contradiction without a DEC, an
     architectural drift or an impossible requirement

   A finding too large for the next implementation pass is still `FAILED`: put
   the escalation in the first `issues` entry rather than inventing a status
   for it. Automation reads this field and understands nothing else.

   A non-blocking suggestion you route to a *later* task does not by itself flip
   the verdict, but a suggestion a prior review routed to *this* task that the
   implementation left unactioned is a blocking issue (`FAILED`) — unless a
   task still in the range will cover it. A deferred fix with no later owner is
   exactly the gap the review exists to catch.

2. **Generate review report** (`docs/specs/[id]/tasks/TASK-XXX--review.md`):
   Read the review template using this lookup order:
   1. `templates/task-review.md`
   2. `templates/task-review.md` inside the installed skill folder for non-Claude agents.
   Fill in the gathered findings and save to the tasks directory.

   The file **must open with the YAML frontmatter block of the template**,
   before the first heading, carrying `review_status`, a one-line `summary`, an
   `issues` list (`issues: []` when the review passes) and an optional `routed`
   list. Every required fix listed in the body has a matching `issues` entry:
   that list is what the next implementation pass is given to work from.

   `routed` carries fixes you defer to a later task, not this one: each entry is
   `{ to: "<task-id>", text: "<one-line fix>" }`, and `[]` when there is
   nothing to route. The loop feeds routed entries to the target task's prompt
   automatically, so they survive between reviews instead of living only as
   prose a later task would have to grep for.

   The review template defines these sections:
   | Section | Purpose |
   |---------|----------|
   | Review Summary | High-level status table (AC, DoD, Code Quality, Spec Compliance, Architecture) |
   | Acceptance Criteria & DoD Results | Per-criterion and per-item status with evidence |
   | Code Review Findings | Table of issues with severity, file, category, recommendation |
   | Spec Compliance & Architectural Alignment | Fidelity check, cross-boundary adherence, decision log, traceability update |
   | Required Fixes | Critical / Warnings / Suggestions tables |
   | Next Steps | Action by review status |

3. **Update task status**:
   - Set `status: reviewed` and `reviewed_date: YYYY-MM-DD` in the task
     frontmatter if `PASSED`
   - Leave the task status untouched if `FAILED`: the report is the record of
     what has to change

   Skip this step entirely when an automated loop drives the review — it owns
   the task frontmatter and writes it once the whole task is closed.

4. **Synchronization**:
   - Run `/skill:specs-kit-sync [spec-folder]` to synchronize all components
   - Skip this step under an automated loop: synchronization is a phase of its
     own there, and running it from inside the review doubles the work

5. **Inform user**:
   - Display review summary and status
   - Provide link to full review report
   - If `PASSED`, suggest running Phase T-7 cleanup in `task-implementation`

---

## Phase 8: Report the convention provenance verdict explicitly

**Goal**: Make the Convention Provenance Check from Phase 5 visible in the
review summary, not buried in the issues table.

**Runs**: Always.

**Actions**:

1. In the review report's summary section, add a row to the standard
   summary table:

   | Convention provenance | ✅ All conventions pre-existing / ⚠️ N invented-convention findings / ❌ N blocking |

2. List every `invented-convention` finding by DEC ID and file in a
   dedicated section after "Code Review Findings", titled
   "Convention Provenance Findings". Each entry must include:

   - The pattern (one sentence)
   - Where it appears (file + line)
   - Whether it is `blocking` / `warning` / `suggestion`
   - The proposed remediation (promote to architecture, ratify via DEC,
     or revert)

3. The verdict participates in `review_status`:

   - any `blocking` `invented-convention` → `FAILED`
   - only `warning` / `suggestion` → still `PASSED`, but the report must
     enumerate them

   This rule mirrors the existing rule that an unmet AC flips the status
   to `FAILED`. The motivation is the same: the implementation may have
   shipped working code, but the loop cannot move on to the next task
   while the codebase carries undocumented conventions that future tasks
   will treat as canonical.
