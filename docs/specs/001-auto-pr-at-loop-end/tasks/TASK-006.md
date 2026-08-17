---
id: TASK-006
title: "End-to-end delivery scenarios with fake forge"
spec: docs/specs/001-auto-pr-at-loop-end/2026-08-17--auto-pr-at-loop-end.md
status: pending
dependencies: [TASK-005]
ac-mapping: [AC-001, AC-005, AC-016, AC-018, AC-020, AC-002]
imp-requirements: [REQ-003, REQ-004, REQ-021]
---

# TASK-006: End-to-end delivery scenarios with fake forge

**Functional Description**: Prove the wired feature end-to-end with the existing e2e harness: a completed loop run (fake agent binary on PATH) in a real git repository with a bare remote, plus a fake forge CLI on PATH. Scenarios cover delivery on (base branch, dirty tree), guarded reuse across a diverged remote branch, flag on with `no_commit` true (delivery commit still created), re-delivery with an existing pull request, and delivery off.

**Maps to Specification**: AC-1 (e2e: programmatic delivery on completion), AC-5 (e2e evidence of the spec branch), AC-16 [SEF verification] (commits stay on the named branch after a failed push), AC-18 [EXT verification] (operator observes the URL / warnings in notifications), AC-20 [SEF verification] (push updates the existing pull request), AC-2 [SEF verification] (flag off → no delivery side effects)

## Acceptance Criteria

- [ ] A completed run with the flag on, starting on the base branch with a dirty tree, creates the spec branch, commits, pushes to the remote and notifies the pull request URL emitted by the fake forge (stdout URL). *(AC-1, AC-5 e2e)*
- [ ] A run with the flag on and `run.no_commit` true still produces the delivery commit (AD-002 gate boundary). *(REQ-3)*
- [ ] With a diverged remote spec branch, a completed run refuses delivery with a warning naming the branch and divergence; no force is attempted. *(AC-23 e2e evidence, REQ-24)*
- [ ] A second delivery to the same branch reports the existing pull request URL and creates no duplicate; the plain push has updated the existing pull request's branch. *(AC-20 [SEF], REQ-21)*
- [ ] A simulated push rejection leaves the commits on the delivery branch, which the warning names. *(AC-16 [SEF], REQ-18)*
- [ ] With the flag off, a completed run performs no delivery side effects (no branch, no push, no forge call). *(AC-2 [SEF])*

## Definition of Ready (DoR)

- [ ] TASK-005 is complete (feature wired).
- [ ] The e2e harness conventions are understood (fake binary on PATH, temporary project fixture).

## Technical Context (from Codebase Analysis)

- **Existing Patterns to Follow**: `e2e/fake-bin/pi` — the fake forge CLI follows the same PATH-injection pattern; `e2e/loop.e2e.test.ts` shows fixture setup.
- **APIs to Integrate With**: real `git` against a bare repository fixture acting as origin; fake `gh` answering with the documented stdout URL on create (mirroring AD-006) and `--json url` on view.
- **Conventions**: e2e never contacts a real forge; the remote is a local bare repository.
- **Architecture Reference**: `docs/specs/architecture.md` §2.2 (external binaries); `technical-plan.md` AD-002 / AD-006.
- **Domain Terms**: Forge, Ramo della spec (ontology).

## Implementation Details (File names only, no code)

**Files to Create**:
- `e2e/fake-bin/gh` - fake forge CLI: success mode prints the documented URL on stdout; second-call mode signals already-exists (drives the fallback path); scriptable failure modes
- `e2e/delivery.e2e.test.ts` - scenario suite covering delivery on base, divergence refusal, flag-on + no_commit true, re-delivery existing PR, push rejection, flag off

## Test Instructions

**2. Mandatory Integration (e2e) Tests:**
   - `delivery e2e`:
     - [ ] Verify the delivered branch exists on the bare remote and carries the delivery commit. *(AC-1, AC-5)*
     - [ ] Verify the session notifications contain the pull request URL. *(AC-18, AC-1)*
     - [ ] Verify the re-delivery scenario reports the existing URL without a second create. *(AC-20 [SEF])*
     - [ ] Verify the push-rejection scenario leaves the delivery commit on the local delivery branch and the warning names it. *(AC-16 [SEF])*
     - [ ] Verify the divergence scenario refuses delivery with the named warning; nothing is pushed with force. *(AC-23 e2e)*
     - [ ] Verify the flag-on + no_commit true scenario creates the delivery commit anyway. *(REQ-3)*
     - [ ] Verify the flag-off scenario produces no remote branch and no forge invocation. *(AC-2 [SEF])*

**Test Acceptance Criteria**:
- [ ] All e2e scenarios pass with real git and the fake forge; no network access.

## Definition of Done (DoD)

This task is complete when:
- [ ] The e2e suite covers delivery on, divergence, flag-on + no_commit true, re-delivery, push rejection and flag off, and passes.

**Dependencies**: TASK-005

**Implementation Command**:
/skill:specs-kit-task-implementation --task="docs/specs/001-auto-pr-at-loop-end/tasks/TASK-006.md"
