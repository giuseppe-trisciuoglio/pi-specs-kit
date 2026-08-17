---
id: TASK-004
title: "Push and forge steps: stdout URL acquisition and existing-PR reporting"
spec: docs/specs/001-auto-pr-at-loop-end/2026-08-17--auto-pr-at-loop-end.md
status: pending
dependencies: [TASK-002, TASK-003]
ac-mapping: [AC-007, AC-013, AC-014, AC-015]
imp-requirements: [REQ-009, REQ-014, REQ-015, REQ-016, REQ-017, REQ-018]
---

# TASK-004: Push and forge steps: stdout URL acquisition and existing-PR reporting

**Functional Description**: The remote half of delivery: push the delivery branch to the remote, create the pull request against the configured base branch by capturing the URL from `pr create`'s stdout, fall back to `pr view --json url` when an existing PR is detected (machine-anchored), and aggregate outcomes so that any failure stops the sequence with the failed step, its reason and the surviving branch — a single attempt per step, no retries.

**Maps to Specification**: AC-7 (target is configured base branch), AC-13 (existing PR reported, no duplicate), AC-14 (failure → warning naming step+reason, run stays completed), AC-15 (missing/unauthenticated CLI → warning, local commits retained)

## ⚠️ External Dependency Risk

- **Depends on**: forge command-line interface (`gh` style) and the remote
- **Status**: Unverified at unit level by design (external binary, operator-authenticated)
- **Mitigation**: all forge commands run through the injected executor; the happy path reads the URL from `pr create`'s stdout (a stable channel since gh 2.x); a parser test pins the URL-shaped line the test expects; the existing-PR fallback uses `--json url` on `pr view` (machine channel). Failures are warnings, never exceptions.

## Acceptance Criteria

- [ ] The pull request target is the configured base branch. *(AC-7, REQ-9)*
- [ ] When a pull request already exists for the delivery branch, the existing URL is reported and no duplicate is created. *(AC-13, REQ-14)*
- [ ] Any step failure produces an outcome carrying the failed step and its reason, without changing the run result downstream. *(AC-14, REQ-15)*
- [ ] A missing or unauthenticated forge CLI stops delivery at that step with a warning-shaped outcome; earlier local state (branch, commits) is retained. *(AC-15)*
- [ ] Each step is attempted at most once; no automatic retry. *(REQ-16)*
- [ ] A failed push after the delivery commit leaves the commits on the delivery branch, and the outcome names that branch. *(REQ-18)*
- [ ] Success carries the pull request URL in the outcome. *(REQ-17)*
- [ ] `pr create` is invoked without `--json` (the flag is reserved for read commands on gh 2.x); the URL on the happy path comes from stdout. *(AD-006)*

## Definition of Ready (DoR)

- [ ] TASK-002 is complete (branch outcome and executor injection available).
- [ ] TASK-003 is complete (title/body builders available).
- [ ] The forge contract (`contracts/forge-cli.md`) is understood: stdout URL on success, machine-anchored already-exists detection, `--json url` on `pr view`.

## Technical Context (from Codebase Analysis)

- **Existing Patterns to Follow**: `src/loop/model-check.ts` precedent for a tolerant external-CLI query (exit-code interpretation, injectable for tests).
- **APIs to Integrate With**: injected executor (`spawnProcess` signature); `DeliveryOutcome` from TASK-002.
- **Shared Components**: title/body builders from `src/loop/delivery-content.ts`.
- **Conventions**: machine-readable channel only; timeouts per command (git 30s, gh 90s — network bound); user-visible strings English.
- **Architecture Reference**: `docs/specs/architecture.md` §3.8 subprocess wrapper constraints; `technical-plan.md` AD-006; `contracts/forge-cli.md`.
- **Domain Terms**: Forge, Ramo base, Ramo della spec, Consegna del run (ontology).

## Implementation Details (File names only, no code)

**Files to Create**:
- `src/loop/delivery-forge.ts` - push step, pull-request create step (URL captured from stdout), already-exists detection (machine-anchored), `pr view --json url` fallback, outcome completion

**Files to Modify**:
- `test/delivery.test.ts` - extend with the forge-step matrix against the scripted executor

## Test Instructions

**1. Mandatory Unit Tests:**
   - `delivery` (push):
     - [ ] Verify a successful push records no failure and proceeds to PR creation against the configured base branch. *(AC-7)*
     - [ ] Verify a rejected push stops the sequence, keeps the outcome's branch name, and reports the step with its reason. *(REQ-18)*
   - `delivery` (pull request creation):
     - [ ] Verify a successful `pr create` extracts the URL from the executor's stdout (URL-shaped line) and the outcome carries it. *(AC-14, REQ-17, AD-006)*
     - [ ] Verify that `pr create` is never invoked with `--json` (forbidden: the flag does not exist on gh's create command). *(AD-006)*
     - [ ] Verify the create invocation receives base branch, head branch, title and body. *(AC-7, AC-11/12 wiring)*
     - [ ] Verify an already-exists failure (machine-anchored signal) falls back to `pr view <head> --json url` and reports the existing URL without a second create. *(AC-13, REQ-16 single attempt, F2/C2 closure)*
     - [ ] Verify a spawn error (CLI missing) or authentication failure stops at that step, with prior state retained in the outcome. *(AC-15)*
     - [ ] Verify a missing base branch on the remote surfaces as a failure naming the base branch. *(spec error scenario)*
     - [ ] Verify no step is invoked twice after a failure. *(REQ-16)*
   - `delivery` (URL parser pin — gh stdout shape stability):
     - [ ] Verify a stdout containing `https://…/pull/<n>` is captured as the URL.
     - [ ] Verify a stdout without a URL line does not produce a phantom URL — the system surfaces a warning instead.

**3. Edge Cases and Error Conditions to Test:**
   - [ ] Completed run with no new commits between head and base (PR create fails with "no commits" message) → warning-shaped outcome, run outcome untouched. *(empty-range scenario)*

**Test Acceptance Criteria**:
- [ ] All tests described above are implemented and pass using the scripted executor (no real network or binaries).

## Definition of Done (DoD)

This task is complete when:
- [ ] Push and forge steps are implemented with single-attempt semantics and outcome aggregation.
- [ ] URL acquisition follows AD-006 (stdout on success, `--json url` on view fallback).
- [ ] The URL parser test pins the gh stdout shape; a future gh change fails the test closed.

**Dependencies**: TASK-002, TASK-003

**Implementation Command**:
/skill:specs-kit-task-implementation --task="docs/specs/001-auto-pr-at-loop-end/tasks/TASK-004.md"
