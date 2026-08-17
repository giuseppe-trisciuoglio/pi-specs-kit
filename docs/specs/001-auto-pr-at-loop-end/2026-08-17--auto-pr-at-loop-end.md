# Functional Specification: Automatic Pull Request at Loop Completion

**Spec ID**: 001-auto-pr-at-loop-end
**Date**: 2026-08-17
**Status**: Draft
**Version**: 1.1

---

## Clarifications

### Session 2026-08-17

- Q: Should a run that completes an explicit subset of the spec's tasks (from/to range) also deliver? → A: Yes — any completed run delivers.
- Q: When a re-delivery pushes new commits to a branch that already has an open pull request, what should happen? → A: A plain push updates the open pull request; the system reports the existing pull request URL instead of creating a duplicate.
- Q: How detailed should the closing delivery notice be? → A: Outcome only — one notice with the pull request URL on success; the failed step and its reason on failure.
- Q: After delivery runs from the base branch (creating the spec branch), where should the working copy end up? → A: The working copy stays on the delivery branch; no switch back to the base branch.

### Session 2026-08-17 — review findings (adversarial review follow-up)

- F3+F4 (BLOCKER/MAJOR) Q: How should spec-branch reuse work when the tree is dirty or the branch diverged? → A: Guarded reuse — reuse (local or remote) only when fast-forward from the branch tip to current HEAD is possible, carrying the working state; on divergence stop with a warning naming branch and divergence; never force.
- F1 (MAJOR) Q: How is detached HEAD classified? → A: Detached HEAD takes the spec-branch path (same as the base branch).
- F5 (MAJOR) Q: How to fix AC-022 being unsatisfiable on pre-branch failure? → A: Scope it to deliveries that performed a branch operation; pre-branch failures leave the working copy in its pre-delivery state.
- F6+F7 (MAJOR) Q: Pin the pull request content sources? → A: Title from the spec document's name (spec-id fallback); terminal warnings are exactly the warnings the closing notices report, read from the run's closing state, never persisted for delivery.
- F8 (MAJOR) Q: Define the base branch default? → A: Defaults to `main` when not configured; a differing default surfaces via the existing base-branch-not-found warning.

---

## Business Context

### Problem Statement

The task loop leaves all of its work local: commits are optional per-task checkpoints (disabled by default), nothing is pushed, and no pull request is opened. After every completed run the operator must manually perform the delivery plumbing — commit the leftovers, push a branch, open a pull request against the base branch — before anyone can review the result.

The problem is worse in projects where agent-driven git operations are blocked by policy or simply unreliable: the loop cannot be trusted to close the last mile itself, so delivery either happens by hand or not at all. The work sits on the operator's machine, invisible to reviewers, until someone remembers to ship it.

The feature closes that gap with a post-run delivery step: when the loop reaches its completed terminal state and a configuration flag is enabled, the system itself executes the remaining delivery operations — commit, push, pull request creation — programmatically, as direct command invocations that never depend on an agent subprocess.

### Target Users

| User Type | Description | Primary Goal |
|-----------|-------------|--------------|
| Loop Operator | Developer who starts the loop on a spec and monitors its progress | Receive reviewable work at every completed run, without manual git plumbing |
| Reviewer | Teammate who reviews the delivered work | Find a complete, well-described pull request with the spec context attached |

### System Fit

The loop already ends with a final documentation sync and a closing summary; delivery is the natural continuation of that epilogue. It reuses the existing base-branch configuration, the existing notification channel, and the established best-effort philosophy of auxiliary operations (checkpoints, measurements): delivery failures are reported loudly but never change the loop's outcome. The feature is opt-in through a configuration flag and stays completely inert while the flag is off.

---

## Functional Requirements

### Delivery Configuration

**Context**: Delivery is opt-in and reads from the project's existing configuration file.

| ID | Requirement | Trigger Type |
|----|-------------|--------------|
| REQ-001 | The system SHALL provide a configuration flag that enables automatic delivery at loop completion; the flag SHALL be disabled by default. | Generic |
| REQ-002 | WHEN the configuration file is absent, incomplete, or contains unknown values THEN the system SHALL apply the default delivery settings without failing the run. | State |
| REQ-003 | IF the delivery flag is enabled THEN the system SHALL perform the delivery commit even when per-task checkpoint commits are disabled. | Feature |

### Delivery Trigger

**Context**: When and how the delivery step runs, and who executes it.

| ID | Requirement | Trigger Type |
|----|-------------|--------------|
| REQ-004 | WHEN the loop reaches the completed terminal state with the delivery flag enabled THEN the system SHALL execute the delivery step after the run's final sync and before the closing notifications. | Event |
| REQ-005 | WHEN the loop ends with the halted or stopped terminal state and the delivery flag is enabled THEN the system SHALL skip the delivery step and SHALL mention the skip in the closing notice. | Event |
| REQ-006 | The system SHALL execute every delivery operation (repository inspection, branching, commit, push, pull request creation) as direct programmatic command invocations, and SHALL NOT delegate any of them to an agent subprocess. | Generic |

### Branch Handling

**Context**: A pull request cannot be opened from the base branch, so delivery adapts to where the loop ran.

| ID | Requirement | Trigger Type |
|----|-------------|--------------|
| REQ-007 | WHEN delivery runs while the working branch is the base branch THEN the system SHALL move the current working state onto a dedicated branch named after the spec identifier — creating it, or reusing an existing one (local or remote) only when the working state can be carried onto it without rewriting history — and SHALL open the pull request from it. | Event |
| REQ-008 | WHEN delivery runs while the working branch is not the base branch THEN the system SHALL open the pull request from the current working branch without creating any branch. | Event |
| REQ-009 | The system SHALL use the configured base branch as the target of every pull request it creates. | Generic |

### Commit and Pull Request Content

**Context**: What the delivery commit contains and how the pull request describes itself.

| ID | Requirement | Trigger Type |
|----|-------------|--------------|
| REQ-010 | WHEN uncommitted changes exist at delivery time THEN the system SHALL commit the entire working tree as a single delivery commit whose message identifies the spec. | Event |
| REQ-011 | WHEN the working tree is clean at delivery time THEN the system SHALL skip the delivery commit and continue with push and pull request creation. | State |
| REQ-012 | The system SHALL derive the pull request title from the name of the spec. | Generic |
| REQ-013 | The system SHALL compose the pull request description from the spec identifier, the completed task range summary, and the loop outcome including any terminal warnings. | Generic |
| REQ-014 | WHEN a pull request already exists for the delivery branch THEN the system SHALL report the existing pull request URL in a notice instead of creating a duplicate. | Event |

### Failure Handling and Reporting

**Context**: Delivery is auxiliary to the loop's result: failures are loud but never fatal.

| ID | Requirement | Trigger Type |
|----|-------------|--------------|
| REQ-015 | IF any delivery step fails THEN the system SHALL emit a warning that names the failed step and its reason, and the loop result SHALL remain completed. | Negative |
| REQ-016 | The system SHALL attempt each delivery step at most once; failed steps SHALL NOT be retried automatically. | Generic |
| REQ-017 | WHEN every delivery step succeeds THEN the closing notice SHALL include the pull request URL. | Event |
| REQ-018 | WHEN push or pull request creation fails after the delivery commit THEN the system SHALL leave the delivery commits on the delivery branch and SHALL name that branch in the warning. | Event |
| REQ-019 | The system SHALL report every delivery outcome through the existing notification channel, using the established `[specs-kit]` message prefix. | Generic |

### Delivery Semantics (clarified 2026-08-17)

**Context**: Behaviors fixed during the specification clarification pass.

| ID | Requirement | Trigger Type |
|----|-------------|--------------|
| REQ-020 | WHEN a run completes having executed an explicit subset of the spec's tasks (a from/to range) THEN the system SHALL deliver it as any other completed run. | Event |
| REQ-021 | WHEN new commits are pushed to a branch that already has an open pull request THEN the system SHALL NOT create a duplicate pull request and SHALL report the existing pull request URL. | Event |
| REQ-022 | The system SHALL report delivery success as a single notice carrying the pull request URL, and delivery failure as the failed step with its reason; the system SHALL NOT emit per-step notices when delivery succeeds. | Generic |
| REQ-023 | WHEN delivery has ended after a branch operation has occurred, successfully or not, THEN the working copy SHALL remain on the delivery branch without switching back to the base branch. | Event |

### Branch and Content Semantics (clarified 2026-08-17, review findings)

**Context**: Behaviors fixed while closing the adversarial review findings.

| ID | Requirement | Trigger Type |
|----|-------------|--------------|
| REQ-024 | WHEN the existing spec branch (local or remote) cannot carry the working state without rewriting history — including diverged history or a stale tip behind the base branch — THEN the system SHALL stop the delivery at the branch step with a warning naming the branch and the divergence, and SHALL NOT attempt a forced update. | Event |
| REQ-025 | WHEN the working copy is on no branch (detached state) THEN the system SHALL take the spec-branch path described by REQ-007. | Event |
| REQ-026 | The system SHALL derive the pull request title from the name of the spec document, falling back to the spec identifier when no document name is available. | Generic |
| REQ-027 | The system SHALL draw the pull request description's terminal warnings from the same warnings the run's closing notices report (tasks that failed while the run continued, partial sync, failed post-hook gate), reading them from the run's closing state at delivery time; it SHALL NOT persist additional state for the description. | Generic |
| REQ-028 | The base branch SHALL default to `main` when not configured. | Generic |

### Data Requirements

| Data Entity | Purpose | Lifecycle | Constraints |
|-------------|---------|-----------|-------------|
| Delivery flag | Enable or disable automatic delivery | Read from configuration at run start; default off | Boolean; tolerant to absent or malformed values |
| Base branch | Target of the delivery pull request | Existing configuration value, reused | Must name an existing branch on the forge |
| Delivery outcome | Report per-step results and the pull request URL to the operator | Created during the delivery step; presented in the closing notices; never persisted | Ephemeral: survives only in notifications |
| Delivery commit | Persist the residual working tree of a delivered run | Created at most once per delivered run | Single commit; message identifies the spec |
| Spec branch name | Head branch when delivery starts from the base branch | Derived from the spec identifier; reused across deliveries of the same spec | Naming convention `specs/<spec-id>` |

---

## User Interactions

### Primary User Flow: Delivered Run

```
Operator → enable flag → start loop → loop completes → delivery step → closing notice with pull request URL
```

1. **Enable the flag**: The operator turns on the delivery flag in the project configuration, once per project.
2. **Start the loop**: The operator starts the loop on a spec (optionally over a task range) and lets it run unattended.
3. **Loop completes**: All selected tasks are done; the run's final sync has produced its documentation updates.
4. **Delivery runs**: The system programmatically ensures a delivery branch, commits any residual changes, pushes the branch to the remote, and creates the pull request against the base branch — or reports the existing pull request when one is already open.
5. **Closing notice**: The operator reads the usual range-completed summary, now followed by the pull request URL (or, on failure, a warning naming the failed step and reason).

### Alternative Paths

| Path | Trigger | Behavior |
|------|---------|----------|
| Flag disabled | Flag absent or off | No delivery; loop-end behavior is unchanged |
| Halted or stopped ending | Task failure without continue, exhausted budget, operator stop | Delivery skipped; the closing notice mentions the skip |
| Already on a feature branch | Loop was started on a branch other than the base branch | Pull request opened from the current branch; no branch created |
| Pull request already exists | A previous delivery of the same spec left an open pull request | Existing pull request URL reported as a notice; no duplicate created |
| Clean working tree | Checkpoint commits already captured everything | Delivery commit skipped; push and pull request creation continue |

### Error Scenarios

| Error Condition | System Response | User Message |
|----------------|-----------------|--------------|
| Not a git repository | Delivery aborts at its first step; loop result unaffected | `[specs-kit] delivery skipped: <reason>` |
| No remote configured | Push step fails with a warning | `[specs-kit] delivery warning: push failed: <reason>` |
| Forge CLI missing or unauthenticated | Pull request step fails with a warning; local commits retained | `[specs-kit] delivery warning: pull request creation failed: <reason>` |
| Push rejected (protected branch, permissions) | Push step fails with a warning; commits remain local on the named branch | `[specs-kit] delivery warning: push failed: <reason> (commits left on <branch>)` |
| Configured base branch missing | Pull request step fails with a warning naming the base branch | `[specs-kit] delivery warning: pull request creation failed: base branch <name> not found` |
| Run completed without new commits (empty range or fully-resumed run) | Pull request step fails with a warning; nothing is lost | `[specs-kit] delivery warning: pull request creation failed: no commits between <branch> and <base>` |
| Existing spec branch diverged (local or remote) | Delivery stops at the branch step with a warning naming the branch and the divergence; no forced update is attempted | `[specs-kit] delivery warning: branch reuse failed: <branch> diverged` |

---

## Acceptance Criteria

> **Taxonomy**: Every criterion MUST be tagged with `[IMP]`, `[SEF]`, or `[EXT]`.
> - **`[IMP]`** Implementable — Requires new code/configuration. Only these generate implementation tasks.
> - **`[SEF]`** Side-Effect — Automatic consequence of an `[IMP]` criterion. No standalone task.
> - **`[EXT]`** External Verification — Verified externally. No standalone task.
>
> **60% Rule**: At least 60% of criteria MUST be `[IMP]`. (This spec: 20/26 ≈ 77%.)

### Configuration and Trigger

| ID | Criterion | Taxonomy |
|----|-----------|----------|
| AC-001 | With the flag enabled and a completed run, the system executes the delivery steps programmatically; no agent subprocess performs any of them. | [IMP] |
| AC-002 | With the flag absent or disabled, loop-end behavior is identical to the behavior before this feature. | [SEF] |
| AC-003 | A halted run with the flag enabled performs no delivery step, and the closing notice mentions the skip. | [IMP] |
| AC-004 | A stopped run with the flag enabled performs no delivery step, and the closing notice mentions the skip. | [IMP] |

### Branch and Commit

| ID | Criterion | Taxonomy |
|----|-----------|----------|
| AC-005 | Delivery on the base branch creates or reuses the spec branch carrying the working state, and the pull request head is that branch. | [IMP] |
| AC-006 | Delivery on a non-base branch opens the pull request from the current branch and creates no branch. | [IMP] |
| AC-007 | The pull request target is the configured base branch. | [IMP] |
| AC-008 | Uncommitted changes at delivery time become exactly one delivery commit whose message identifies the spec, and no changes remain uncommitted. | [IMP] |
| AC-009 | A clean working tree produces no empty delivery commit. | [SEF] |
| AC-010 | With the flag enabled and per-task checkpoints disabled, the final delivery commit is still created. | [IMP] |

### Pull Request Content

| ID | Criterion | Taxonomy |
|----|-----------|----------|
| AC-011 | The pull request title is derived from the spec name. | [IMP] |
| AC-012 | The pull request description contains the spec identifier, the completed task range summary, and the loop outcome including terminal warnings. | [IMP] |
| AC-013 | When a pull request already exists for the delivery branch, the system reports the existing URL and creates no duplicate. | [IMP] |

### Failure Handling

| ID | Criterion | Taxonomy |
|----|-----------|----------|
| AC-014 | Any delivery step failure produces a `[specs-kit]` warning naming the step and its reason, while the run result stays completed. | [IMP] |
| AC-015 | A missing or unauthenticated forge CLI stops delivery at that step with a warning; earlier local commits are retained. | [IMP] |
| AC-016 | A failed push after the delivery commit leaves the commits on the delivery branch, which the warning names. | [SEF] |
| AC-017 | The pull request on the forge shows the expected base branch, head branch, title, and description. | [EXT] |
| AC-018 | The operator observes the pull request URL (or the delivery warnings) in the session notifications. | [EXT] |

### Delivery Semantics (clarified)

| ID | Criterion | Taxonomy |
|----|-----------|----------|
| AC-019 | A completed from/to partial range delivers like a full-spec run. | [IMP] |
| AC-020 | Pushing new commits to a branch with an open pull request updates that pull request; no duplicate is created and the existing URL is reported. | [SEF] |
| AC-021 | Successful delivery produces exactly one delivery notice (outcome plus pull request URL); failed delivery names the failed step and reason. | [IMP] |
| AC-022 | After a delivery that performed a branch operation, the working copy is on the delivery branch on success and failure; failures before any branch operation leave the working copy in its pre-delivery state. | [IMP] |
| AC-023 | A diverged existing spec branch (local or remote) stops delivery at the branch step with a warning naming branch and divergence; no forced update is attempted. | [IMP] |
| AC-024 | Delivery from a detached working state creates the spec branch and opens the pull request from it. | [IMP] |
| AC-025 | The pull request title comes from the spec document's name, with the spec identifier as fallback. | [IMP] |
| AC-026 | With no base branch configured, delivery targets `main`. | [IMP] |

---

## Integration Requirements

| External System | Capability Needed | Data Exchanged | Frequency |
|----------------|-------------------|----------------|-----------|
| Local git repository | Programmatic status inspection, branching, commit, push | Working tree state, branch names, base branch, commit message | Once per completed run |
| Code hosting forge, via its command-line interface | Create a pull request; detect an existing one | Title, description, head branch, base branch, pull request URL | Once per completed run |
| Session notification channel | Surface the delivery outcome to the operator | Info and warning notices with the `[specs-kit]` prefix | At delivery time and in the closing notice |
| Project configuration file | Read the delivery flag and the base branch | Flag value, branch name | At run start |

---

## Bounded Context Impact

- **Consegna (delivery)**: new bounded context (see `docs/specs/ontology.md`); consumes the loop's terminal state and the configured base branch, writes nothing back into loop state.
- **Configurazione**: gains one boolean flag; no existing key changes meaning.
- **Task and sync contexts**: untouched — delivery runs after the final sync and outside every task's phase cycle.

---

## Negative Requirements

The system SHALL NOT:

### Reliability
- REQ-NR001: The system SHALL NOT delegate any delivery operation (commit, push, pull request creation) to an agent subprocess; all delivery operations SHALL be direct programmatic command invocations.
- REQ-NR002: IF a delivery step fails THEN the system SHALL NOT change the loop outcome: a completed run SHALL remain completed.
- REQ-NR003: The system SHALL NOT execute delivery steps when the loop ends halted or stopped.
- REQ-NR004: The system SHALL NOT automatically retry a failed delivery step.

### Data Integrity
- REQ-NR005: IF uncommitted changes exist at delivery time THEN the system SHALL NOT push or create a pull request before committing them.
- REQ-NR006: WHEN push or pull request creation fails THEN the system SHALL NOT discard, revert, or rewrite the local delivery commits.
- REQ-NR007: The system SHALL NOT persist delivery outcomes or pull request URLs in the loop state document.

### Security
- REQ-NR008: The system SHALL NOT store forge credentials or authentication tokens; authentication SHALL come from the operator's existing command-line session with the forge.

---

## Non-Goals

This feature does NOT include:

- **Delivery on halted or stopped runs**: Partial work stays local under the operator's control; only a completed run delivers.
- **Configurable pull request metadata**: No labels, reviewers, draft mode, or templates; the pull request content is derived from the spec.
- **Multi-forge support**: No adapters for multiple hosting platforms; one GitHub-style forge CLI is assumed.
- **Persistence of delivery state**: No pull request URLs or delivery outcomes stored in the loop state document; delivery is reported, not recorded.
- **Manual re-delivery command**: No user command to re-run delivery; a failed delivery is finished by hand or by a new loop run.
- **Remote default-branch detection**: The pull request target comes from configuration, not from querying the remote.
- **Force push or history rewriting**: Delivery never forces a push nor rewrites existing commits.
- **Delivery outside the loop**: Authoring commands and other features never trigger delivery.

---

## Assumptions

- A GitHub-style forge command-line interface is installed and authenticated by the operator; this is verified at delivery time, and a missing or unauthenticated CLI is a warning, not an error.
- The repository has a conventional remote (origin) configured for push.
- The operator's git identity is configured, since delivery commits are authored locally.
- The delivery flag implies the final delivery commit even when per-task checkpoint commits are disabled.
- Delivery includes the whole working tree, consistently with checkpoint behavior (review reports, measurement ledger, task files).
- The spec branch naming convention is `specs/<spec-id>`.
- The base branch defaults to `main` when not configured; repositories whose default differs must set it explicitly (a missing default surfaces through the base-branch-not-found warning).
- Pull request title and description are in English, matching the notification language of the tool.

---

## Open Questions

All questions raised at creation were resolved during the clarification pass on 2026-08-17 — see [Clarifications](#clarifications).
