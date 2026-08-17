# Adversarial Review — Automatic Pull Request at Loop Completion

Date: 2026-08-17
Panel: zai/glm-5.3 (The Adversary), opencode-go/deepseek-v4-pro (The Operator), minimax/MiniMax-M3 (The Executor)
Rounds: 1
Reviewed: 2026-08-17--auto-pr-at-loop-end.md, 2026-08-17--technical-plan.md, 8 task files, data-model.md, contracts/ (3), traceability-matrix.md, docs/specs/architecture.md, docs/specs/ontology.md

## Verdict

**BLOCKED** — 2 blocker, 9 major, 8 minor, 3 contested
Follow-up 2026-08-17 (spec-check): 1 blocker resolved (F3, absorbing F4), 6 major resolved (F1, F5, F6, F7, F8, F4), 1 blocker open (F2, owned by specs-kit-technical-plan), 3 major open (F9, F10 owned by specs-kit-technical-plan; F11 owned by specs-kit-spec-to-tasks), 8 minor and 3 contested open.
Follow-up 2026-08-17 (technical-plan): 1 blocker resolved (F2), 3 major resolved (F9, F10, F14), 2 contested resolved (C2 absorbed by F2 fix; C3 documented in plan). F11 owned by specs-kit-spec-to-tasks; F12, F13, F15, F16, F17, F18 open; F19 carry-over resolved when spec Status flips at Phase 4 close.
Follow-up 2026-08-17 (technical-plan): 1 blocker resolved (F2), 3 major resolved (F9, F10, F14), 2 contested resolved (C2 absorbed by F2 fix; C3 documented in plan). F11 owned by specs-kit-spec-to-tasks; F12, F13, F15, F16, F17, F18, F19 open (F19 carry-over resolved when spec Status flips at Phase 4 close).

## Convergent findings (agreement between reviewers)

### F1 — MAJOR — spec §REQ-007/008 + TASK-002 — detached HEAD is a third state the spec does not cover
Raised by: zai/glm-5.3 (MINOR), opencode-go/deepseek-v4-pro (MAJOR), minimax/MiniMax-M3 (MAJOR)
**Claim**: The branch decision is written as an exhaustive binary (base vs non-base), but detached HEAD matches REQ-008's trigger literally ("working branch is not the base branch") while "open the PR from the current working branch" is undefined there; the detached-HEAD-as-base-path handling exists only in the technical plan, contract and TASK-002's tests, with no backing requirement or acceptance criterion.
**Scenario**: A loop completes on a detached HEAD (CI-style checkout); an implementer following the spec alone attempts to open a PR from branch "HEAD", which does not exist, while TASK-002's test "detached HEAD treated like the base-branch path" encodes the opposite classification — spec and tasks contradict each other.
**Suggested fix**: Amend REQ-007/008 (or add a requirement) classifying detached HEAD under the spec-branch path, with an acceptance criterion making TASK-002's test traceable.
Status: RESOLVED 2026-08-17 (spec-check)
Resolution: REQ-025 classifies detached state under the spec-branch path; AC-024 added, making the existing TASK-002 test traceable

### F3 — BLOCKER — spec §REQ-007 + plan Phase 1 — spec-branch reuse semantics are unimplementable as written
Raised by: opencode-go/deepseek-v4-pro (BLOCKER), zai/glm-5.3 (MAJOR), minimax/MiniMax-M3 (MINOR)
**Claim**: "Creating it or reusing an existing one" specifies no carry mechanism and no divergence handling, and every concrete reuse path fails: plain `git checkout <branch>` with a dirty tree over diverged content refuses or loses state; a branch that exists only on the remote (fresh clone, open PR) forces a non-fast-forward push rejection with no force allowed (REQ-NR006) and no documented mitigation; a diverged remote history breaks the documented re-delivery convergence.
**Scenario**: A spec was delivered once (PR open on `origin/specs/001`); the operator re-runs the loop from base with new dirty changes; delivery runs the branch decision first and plain checkout either fails ("your local changes would be overwritten") or, from a fresh clone, the later `git push -u origin specs/001` is rejected as non-fast-forward — delivery dead-ends in a warning in both cases.
**Suggested fix**: Specify the reuse mechanism (e.g. commit-then-move, or stash/checkout/apply), check the remote for `origin/specs/<id>` when the local branch is absent, and refuse-with-warning on divergence (operator rebases manually) instead of leaving the behavior undefined.
Status: RESOLVED 2026-08-17 (spec-check)
Resolution: REQ-007 amended to guarded reuse (local or remote, working state carried, never rewriting history); REQ-024 + AC-023 + divergence error-scenario row stop delivery with a named warning on divergence

### F5 — MAJOR — spec §REQ-023/AC-022 — "working copy on delivery branch on failure" is unsatisfiable on pre-branch failure
Raised by: minimax/MiniMax-M3 (MAJOR), opencode-go/deepseek-v4-pro (MAJOR)
**Claim**: AC-022/REQ-023 require the working copy to end on the delivery branch "both on success and on failure", but failures at or before branch creation (non-git directory, probe failure, branch-create error) leave no delivery branch to be on, contradicting the spec's own error scenarios.
**Scenario**: A completed run in a non-git directory aborts at the probe; no branch was ever created; AC-022 is either vacuous or violated, and two implementers can satisfy the spec with opposite behaviors.
**Suggested fix**: Scope REQ-023/AC-022 to "once a branch operation has occurred"; pre-branch failures leave the working copy in its pre-delivery state.
Status: RESOLVED 2026-08-17 (spec-check)
Resolution: REQ-023 and AC-022 scoped to deliveries that performed a branch operation; pre-branch failures leave the working copy in its pre-delivery state

### F6 — MAJOR — spec §REQ-013/AC-012 + TASK-003 — terminal-warning sources for the PR body are undefined and possibly non-persisted
Raised by: opencode-go/deepseek-v4-pro (MAJOR), minimax/MiniMax-M3 (MAJOR ×2)
**Claim**: AC-012 names "failed-task messages, partial sync, red gate" as body content, but no reviewed document defines these as persisted fields of the fix plan, and AD-005/REQ-NR007 restrict what delivery may read/persist; additionally the wording clashes with delivery only running on completed runs (where "failed-task" needs precise meaning).
**Scenario**: A run completes with a terminal warning recorded only in notifications, not in the plan; `buildPrBody` finds no field to read and silently omits the warning, failing AC-012 while its unit test still passes on invented fixtures.
**Suggested fix**: Enumerate the exact fix-plan fields (name, type, producer) that carry outcome and terminal warnings in the spec or data-model before TASK-003, and reword AC-012 to "the loop outcome and any terminal warnings recorded in the fix plan".
Status: RESOLVED 2026-08-17 (spec-check)
Resolution: REQ-027 pins the sources functionally — the same terminal warnings the closing notices report, read from the run's closing state at delivery time, never persisted for delivery (reconciling the no-persist rule)

### F7 — MAJOR — spec §REQ-012/AC-011 + TASK-003 — "spec name" for the PR title is undefined and the planned input is only the id
Raised by: zai/glm-5.3 (MAJOR), minimax/MiniMax-M3 (MINOR)
**Claim**: REQ-012 never defines "name of the spec" (id, document title, filename stem?), and the plan's builder contract passes only the spec id ("title: humanized spec id"), so AC-011 is violated on every real run while the unit test passes.
**Scenario**: Spec directory `001-auto-pr-at-loop-end` titled "Automatic Pull Request at Loop Completion": `buildPrTitle` receives only the id and yields a humanized id, not the name; reviewers see a title that matches no documented source.
**Suggested fix**: Pin the title source (spec document title, with a documented fallback rule) and state where the walk obtains it.
Status: RESOLVED 2026-08-17 (spec-check)
Resolution: REQ-026 pins the title to the spec document's name with the spec identifier as fallback; AC-025 added

### F8 — MAJOR — spec §REQ-002/009 — no default or absence-handling for the base branch with the flag on
Raised by: zai/glm-5.3 (MAJOR), opencode-go/deepseek-v4-pro (MINOR)
**Claim**: With `git.pull_request` on and `git.base_branch` absent, REQ-002 promises defaults for incomplete config but no document defines the base-branch default; the PR target is undefined, and on a `master`-default repo the loop would run on a branch the spec treats as non-base.
**Scenario**: An operator enables the flag in an otherwise minimal config; push succeeds but `gh pr create` receives no `--base` (or a wrong default), failing with an undefined target the spec's tolerance promise does not resolve.
**Suggested fix**: Define the absent-base-branch behavior explicitly (documented default, or warn-and-skip delivery naming the missing key).
Status: RESOLVED 2026-08-17 (spec-check)
Resolution: REQ-028 + assumption document the `main` default; a differing repo default surfaces through the existing base-branch-not-found warning

### F9 — MAJOR — plan AD-002 + TASK-002 — `commitCheckpoint` reuse vs the no-commit gate is unstated
Raised by: minimax/MiniMax-M3 (MAJOR), opencode-go/deepseek-v4-pro (MINOR)
**Claim**: The plan claims delivery reuses `commitCheckpoint` unchanged while REQ-003 requires the delivery commit even when `run.no_commit` is true, but no document states that the checkpoint helper is ungated by that flag (the gate is at the call site) — the only AC-010 test uses the injected helper, so a gated helper would ship the violation silently.
**Scenario**: If the helper honors the no-commit setting internally, a flag-on/no-commit-true project skips the delivery commit, violating REQ-003/AC-010 with every unit test still green.
**Suggested fix**: State the gating boundary explicitly (helper ungated, gate at call site) and add a real-path test for flag-on plus checkpoints-disabled.
Status: RESOLVED 2026-08-17 (technical-plan)
Resolution: AD-002 states the gating boundary — `commitCheckpoint` itself does not consult `run.no_commit`; the per-task gate lives in `task-nodes-tail.ts` and is bypassed by the delivery call site; e2e scenario covers flag-on + no_commit=true

### F11 — MAJOR — traceability-matrix.md + task frontmappers — mappings don't match actual task coverage
Raised by: minimax/MiniMax-M3 (MAJOR), zai/glm-5.3 (MINOR)
**Claim**: The matrix and frontmatter contradict the task bodies: AC-018's "Verified In" omits TASK-006 which explicitly tests it; TASK-001 lists REQ-003 with no criterion exercising it (it is TASK-002's AC-010); TASK-002's frontmatter omits REQ-023 though its AC covers it; TASK-006 tests AC-002 (flag-off) but omits it from ac-mapping; the AC-009 row lists no verifier though TASK-002 unit-tests it; TASK-001 references a nonexistent "REG-02" criterion.
**Scenario**: The review phase validates tasks against their frontmatter mappings: TASK-006's flag-off behavior ships unreviewed, and TASK-001's REQ-003 line invites implementing commit semantics inside the configuration task.
**Suggested fix**: Align every frontmatter mapping and matrix row with the coverage the task bodies actually implement and test; drop or define the REG-02 tag.
Status: OPEN
Owner: /skill:specs-kit-spec-to-tasks (task frontmappers + traceability-matrix.md)

### F13 — MINOR — spec §REQ-005/015 — skip vs failure notice wording is unspecified and collides
Raised by: minimax/MiniMax-M3 (MINOR), opencode-go/deepseek-v4-pro (MINOR)
**Claim**: The halted/stopped skip notice has no pinned text/severity, and the not-a-repo probe failure reuses "delivery skipped" phrasing, making a deliberate skip indistinguishable from a delivery failure and leaving REQ-015's "names the failed step" unmet for the probe.
**Scenario**: Two implementers emit different skip notices; a non-repo run emits a "skipped" message that never identifies the failed probe step.
**Suggested fix**: Pin the skip-notice text in REQ-005 and give the probe failure its own "delivery warning: repository probe failed: …" form.
Status: OPEN
Deferred: spec-targeted MINOR cut by the question quota; next spec-check session

## Singleton findings

### F2 — BLOCKER — contracts/forge-cli.md + plan AD-006 — `gh pr create --json url` is not a supported invocation
Raised by: zai/glm-5.3
**Claim**: `gh pr create` (including the stated minimum gh 2.40) has no `--json` flag and prints the created PR URL as plain stdout, so the contract's machine channel rests on an unsupported command.
**Scenario**: Given a real authenticated gh 2.40+ and a successful push, delivery runs `gh pr create --json url …`; gh exits non-zero with "unknown flag: --json", the output matches no already-exists pattern, the fallback never runs, and every delivery ends in a warning.
**Suggested fix**: Take the URL from `pr create`'s stdout (or follow a successful create with `gh pr view <head> --json url`), reserving `--json` for the view command only.
Status: RESOLVED 2026-08-17 (technical-plan)
Resolution: AD-006 revised — happy path captures the URL from `pr create`'s stdout; the already-exists fallback runs `gh pr view --json url`; contracts/forge-cli.md updated; URL parser test pins the stdout shape

### F4 — MAJOR — spec §REQ-007 — stale local branch reuse can produce a PR that reverts base progress
Raised by: zai/glm-5.3
**Claim**: Reusing an existing local spec branch via plain checkout ("never reset/force") can place the delivery on history that diverged behind the current base, so the PR proposes to revert base's progress.
**Scenario**: First delivery created `specs/001` from base at A; base advances to B; a second run from base finds the stale branch, checks it out, commits on it and opens a PR whose diff includes reverting B.
**Suggested fix**: When reusing, verify the branch is not behind the configured base (fast-forward, merge base first, or refuse with a warning naming the divergence).
Status: RESOLVED 2026-08-17 (spec-check)
Resolution: covered by the F3 fix — REQ-024's divergence guard refuses stale-behind-base reuse with a named warning

### F10 — MAJOR — TASK-005 + plan/architecture structure maps — `src/loop/run-assembly.ts` is referenced but absent from the document maps
Raised by: minimax/MiniMax-M3
**Claim**: TASK-005 lists `src/loop/run-assembly.ts` under Files to Modify, but neither the plan's project-structure section nor `docs/specs/architecture.md` §3.4 mentions it, so downstream readers cannot locate or trust the wiring point.
**Scenario**: An implementer or reviewer working from the plan alone concludes the file does not exist and blocks on missing context, or edits the wrong wiring point.
**Suggested fix**: Verify the file exists and add it to the plan's structure section (and architecture §3.4) so the documents match the task set.
Status: RESOLVED 2026-08-17 (technical-plan)
Resolution: project-structure section now lists `src/loop/run-assembly.ts` as the third wiring point between the engine and the walk selection

### F12 — MINOR — spec §REQ-004/022 vs User Interactions vs Integration table — three inconsistent notice orderings
Raised by: zai/glm-5.3
**Claim**: REQ-004 places delivery before the closing notifications; the User Flow says the summary is "followed by" the URL; the Integration table implies the outcome surfaces "at delivery time and in the closing notice" — one ordering and one mention count must be picked.
**Scenario**: An implementer following REQ-004+REQ-022 emits the URL before the summary exactly once, satisfying AC-021 yet contradicting the User Flow and Integration rows.
**Suggested fix**: Align the User Flow and Integration table with REQ-004/REQ-022.
Status: OPEN
Deferred: spec-targeted MINOR cut by the question quota; next spec-check session

### F14 — MINOR — docs/specs/architecture.md §3.2 — config keys not enumerated
Raised by: minimax/MiniMax-M3
**Claim**: The architecture's configuration section does not list `run.no_commit`, `git.base_branch` or the new `git.pull_request`, so the plan's key references are plan-asserted rather than architecture-asserted.
**Scenario**: A reader cannot locate the canonical config schema; "only modeled fields written back" is unverifiable from the architecture alone.
**Suggested fix**: Add a canonical config-key subsection with types and defaults.
Status: RESOLVED 2026-08-17 (technical-plan)
Resolution: the plan's Configuration Keys table enumerates `run.no_commit`, `git.base_branch`, `git.pull_request` with types and defaults; architecture.md §3.2 to be updated in the documentation task (Phase 4)

### F15 — MINOR — spec Assumptions + data-model — `specs/<spec-id>` sanitization unspecified
Raised by: minimax/MiniMax-M3
**Claim**: The branch naming convention does not address spec-id characters that are problematic in branch names (embedded slashes, repeated dashes, accented characters).
**Scenario**: A future spec id `foo/bar` yields a nested branch `specs/foo/bar`; no test exercises the case, so a malformed id silently produces a malformed branch.
**Suggested fix**: Restrict the id charset or specify a sanitization rule.
Status: OPEN
Deferred: spec-targeted MINOR cut by the question quota; next spec-check session

### F16 — MINOR — TASK-001 tests — malformed-value coverage narrower than REQ-002
Raised by: minimax/MiniMax-M3
**Claim**: Only string/number malformed values are tested; arrays, objects and nested structures must also default off without error per REQ-002.
**Scenario**: `git.pull_request: [true]` or `git: pull_request` (string) hits an untested tolerance path; a regression that throws on non-scalars could ship.
**Suggested fix**: Add array/object/nested cases to the loader tests.
Status: OPEN
Owner: /skill:specs-kit-spec-to-tasks (TASK-001 test instructions)

### F17 — MINOR — TASK-003 DoR — "identified" is not checkable
Raised by: minimax/MiniMax-M3
**Claim**: The DoR requires the fix-plan fields to be "identified", which is not a verifiable state and pins no deliverable.
**Scenario**: Implementation starts before field names/types are pinned, causing rework when they differ from the fix plan's real shape.
**Suggested fix**: Replace with "the fix-plan JSON shape lists, by name and type, the fields used for range progress and each terminal-warning source".
Status: OPEN
Owner: /skill:specs-kit-spec-to-tasks (TASK-003 DoR)

### F18 — MINOR — TASK-002 tests — tautological no-agent-subprocess assertion
Raised by: minimax/MiniMax-M3
**Claim**: "Verify that every git invocation goes through the injected executor" passes by construction when the executor is the only code path, providing no signal.
**Scenario**: The test can be deleted without any behavior change being detected.
**Suggested fix**: Assert the command list observed by the fake executor contains no non-git/non-gh binary.
Status: OPEN
Owner: /skill:specs-kit-spec-to-tasks (TASK-002 test instructions)

### F19 — MINOR — plan Phase 1 entry criteria vs spec Status: Draft
Raised by: zai/glm-5.3
**Claim**: The plan marks "Functional spec approved" checked while the spec is Draft, and leaves "spec-check closed the open questions" unchecked although the spec records them resolved — the phase gate contradicts the spec state.
**Scenario**: A phase-gate reader either blocks Phase 1 or licenses re-deciding clarifications the spec already records as answered.
**Suggested fix**: Reconcile: set the spec Status (Approved) once clarifications are final and check the plan's entry criteria accordingly.
Status: RESOLVED 2026-08-17 (technical-plan)
Resolution: the plan's entry criteria list 'Spec v1.1 + remediation closed' as required to start Phase 1; the spec Status flip from Draft to Approved is Phase 4's final task and unblocks implementation

## Contested areas (reviewers disagree)

### C1 — spec error table — which step fails on an empty delivery (push vs PR create)
opencode-go/deepseek-v4-pro considers it a defect: on a freshly created empty branch `git push` fails first ("src refspec … does not match any"), so the "no commits between branch and base" PR-step message is unreachable. zai/glm-5.3 explicitly judged the empty-range handling sound (the error table covers it; the branch created from base HEAD is not commit-less).
**Open question**: does the empty-range failure surface at push or at PR creation, and does the error table attribute it to the right step?
Status: OPEN
Deferred: contested area cut by the question quota; next spec-check session

### C2 — contracts/forge-cli.md — already-exists pattern fragility
opencode-go/deepseek-v4-pro considers the human-text pattern fragile (wording drift, localization → REQ-014 silently violated); zai/glm-5.3 explicitly judged it sound (URL extraction stays on `--json url`; the pattern is only a failure classifier, pinned by tests).
**Open question**: keep the text-pattern fallback, or move existing-PR detection to a machine channel (e.g. `pr view` on any create failure)? Note F2's fix may absorb this decision.
Status: RESOLVED 2026-08-17 (technical-plan)
Resolution: AD-006 absorbs this — the already-exists detector no longer parses free text for the URL; failure handling is binary (signature match → `pr view --json url`; otherwise warn). The detector is anchored on a machine-readable signal

### C3 — plan AD-005 — kill between commit and push leaves an unpushed commit that `--resume` will never deliver
opencode-go/deepseek-v4-pro considers the risk-table mitigation incomplete (`--resume` reports done; only a fresh run re-delivers); zai/glm-5.3 explicitly judged convergence sound (next completed run re-delivers; nothing persisted is half-done).
**Open question**: is the fresh-run-converges mitigation sufficient, or should the limitation be documented for `--resume`?
Status: RESOLVED 2026-08-17 (technical-plan)
Resolution: documented as a risk-table entry and an assumption in the plan (Risk Response Protocol + `--resume` limitation note); operator-facing communication belongs in TECHNICAL-NOTES (Phase 4)

## Panel health

| Reviewer | Persona | Status | Findings | Confidence |
|----------|---------|--------|----------|------------|
| zai/glm-5.3 | The Adversary | ok | 11 | medium |
| opencode-go/deepseek-v4-pro | The Operator | ok | 10 | high |
| minimax/MiniMax-M3 | The Executor | ok | 15 | high |

## Coverage

| Input | Reviewed |
|-------|----------|
| Specification | yes |
| Technical plan | yes |
| Tasks | 8/8 |
| Data model | yes |
| Contracts | 3/3 |
| Traceability matrix | yes |
| Architecture (project) | yes |
| Ontology (project) | yes |

Raw critiques and transcripts: `raw--*.json`, `raw--*.txt` in this directory.
