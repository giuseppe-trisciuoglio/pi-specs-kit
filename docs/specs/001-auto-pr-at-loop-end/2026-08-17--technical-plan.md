# Technical Plan: Automatic Pull Request at Loop Completion

**Spec**: [2026-08-17--auto-pr-at-loop-end.md](./2026-08-17--auto-pr-at-loop-end.md)
**Created**: 2026-08-17
**Status**: Draft
**Version**: 1.1

> Plan revised in place by `specs-kit-technical-plan` to close the adversarial-review findings owned by this skill: **F2** (BLOCKER — `gh pr create --json` does not exist), F9 (`commitCheckpoint` gate boundary), F10 (structure map missing `run-assembly.ts`), F14 (configuration keys not enumerated), F19 (entry criteria vs spec Status), C2 (already-exists detection fragility), C3 (`--resume` post-kill limitation). The spec was clarified in parallel (REQ-024…028, AC-023…026); the plan implements those, not the earlier wording.

---

## Technology Stack

No new dependencies. All versions inherited from the project's `package.json` and the existing plan.

| Component | Technology | Version | Rationale |
|-----------|-----------|--------|-----------|
| Language | TypeScript | 5.9.x (`^5.9.0`) | Project language; Node 24 executes TS natively; no build step |
| Runtime | Node.js | 24.x (`>=24`) | Native TS; `spawn` from `node:child_process` already wrapped by `src/util/process.ts` |
| Git operations | system `git` via `spawnProcess` | git ≥ 2.30 | Same pattern as the existing checkpoint; subprocess wrapper provides timeouts/abort/capture |
| Forge CLI | GitHub CLI (`gh`) | gh ≥ 2.40 | Only PR integration surface; authenticates from the operator's existing session; **does not support `--json` on `pr create`** — URL comes from stdout (see AD-006) |
| Config parsing | `yaml` | 2.8.x (`^2.8.0`) | Existing dependency; new flag read through the existing tolerant loader |
| Testing | `node:test` | built-in (Node 24) | Project convention: unit tests inject fakes for both `git` and `gh`; e2e puts fake binaries on PATH |

### Forbidden Technologies

| Technology | Reason Not Used | Alternative Chosen |
|-----------|-----------------|-------------------|
| Any new npm runtime dependency | Project constraint: only `yaml` + pi-provided packages | External binaries (`git`, `gh`) via `spawnProcess` |
| `--json` flag on `gh pr create` | Does not exist in gh 2.x; `--json` is reserved for read commands (`pr view`, `pr list`, `issue view` …) | Capture URL from `pr create`'s stdout; fall back to `gh pr view --json url` |
| GitHub REST API client | Would need a token the system must not own (REQ-NR008); new dependency | `gh` CLI with the operator's authenticated session |
| `execSync` / blocking calls | Blocks the interactive pi session | `spawnProcess` (async, detached, timeout, abortable) |
| Agent subprocess for delivery | REQ-006, REQ-NR001: commands are executed programmatically by the loop | Deterministic module invoked by the run walk |
| Force flags (`--force`, `+refs`) | REQ-NR006 / Non-Goal: never rewrite history | Plain `git push -u origin <branch>`; `git push --force-with-lease` is never used |
| Remote default-branch detection | Non-Goal | Configured base branch, defaulting to `main` per REQ-028 |

---

## Architecture Decisions

### AD-001: Delivery is a deterministic post-run step inside the run walk, not a graph node and not an engine epilogue

**Context**: Delivery runs after the final sync and *before* the closing notifications (REQ-004), only on the completed path; it must never consume spawns, attempts or budget.

**Decision**: Delivery is a plain async function invoked in `walkSelection`'s completion branch (`src/loop/run-walk.ts`), after the final sync node is consumed, after the plan is persisted as done, and before the closing notifications. It is not added to the task graph; the run walk already owns the ordering and the fix-plan read-only view required.

**Alternatives Considered**:
1. New run-level graph node after `final_sync` — bloats the graph for a step with no verdict semantics; the interpreter would need to thread a "delivery result" no other node reads.
2. Engine-level, after `walkSelection` returns `completed` — closing notifications have already fired; the PR URL would arrive after the summary (violates REQ-004).
3. Controller-level — same ordering problem; controller also lacks the plan closure state.

**Consequences**:
- **Positive**: walk already owns completion ordering; plan + notify are in scope; the `completed` reason is decided exactly there.
- **Negative**: `walkSelection` and `assembleRun` gain one injected dependency each.
- **Risks**: none structural; delivery cannot affect the returned reason by construction (REQ-NR002).

**Applied In**: Phase 3 (wiring). **Related ADR**: none.

### AD-002: All git operations go through `spawnProcess`; the delivery commit reuses `commitCheckpoint` unconditionally on its own call site

**Context**: The plan must state that the delivery commit is created regardless of `run.no_commit` (REQ-003, AC-010) and that this does not violate any existing semantics.

**Decision**: The delivery module calls `commitCheckpoint(projectRoot, message)` directly. The `no_commit` check that gates *per-task* checkpoints lives at the call site in `src/loop/graph/task-nodes-tail.ts` (it wraps the checkpoint helper in a `config.run.no_commit` check). `commitCheckpoint` itself does **not** consult `run.no_commit`; its helper shape (`{committed, reason}`, never throws) encodes the whole tree plus "no changes" vs. "git error". The delivery call site bypasses the `task-nodes-tail.ts` gate entirely, so the delivery commit is unconditional once the flag is on.

**Alternatives Considered**:
1. Add a parameter to `commitCheckpoint` (`bypassGating`) — rejected: parameterizes a helper that has stayed shape-stable since the loop's first run; the gating logic belongs to call sites, by established pattern.
2. Implement a separate `deliveryCommit` helper that duplicates the commit body — rejected: duplication of best-effort semantics; risk of drifting from the checkpoint helper.

**Consequences**:
- **Positive**: one helper, one subprocess path; the boundary between "checkpoint" and "delivery" is explicit at the call site, not hidden in a helper's predicate.
- **Negative**: the boundary is a project convention rather than an enforced type constraint; a future refactor needs an e2e covering `flag on + no_commit true + completed run` to keep it.
- **Risks**: a code owner who reads `commitCheckpoint` in isolation might infer that it honors `no_commit`; mitigated by an e2e scenario (TASK-006 §Push / commit interaction).

**Related ADR**: none. **Applied In**: Phase 1 (delivery module) + Phase 4 (e2e for `flag on + no_commit true`).

### AD-003: Config flag is `git.pull_request` (boolean, default false) in the existing `git:` section

**Context**: The delivery flag needs a home in `specs-kit.yaml`. `git:` already carries `baseBranch` and is the natural place for git-outcome configuration; `run:` carries per-run execution limits, which delivery is not.

**Decision**: Add `git.pull_request: boolean` under `git:` (yaml: `git.pull_request`, default `false`), parsed with the existing tolerant `flag()` helper (REQ-002). The flag implies the delivery commit regardless of `run.no_commit` (REQ-003); `no_commit` governs per-task checkpoints only. Base branch defaults to `main` when `git.base_branch` is unset (REQ-028).

**Alternatives Considered**:
1. `run.auto_pr` — rejected: mixes delivery into run-execution limits; the `git:` section already names the base branch the PR targets.
2. A dedicated top-level `delivery:` map — rejected: YAGNI; one boolean does not justify a new section.
3. Overloading `no_commit: "pr"` — rejected: tri-state boolean is a breaking surprise for existing configs.

**Consequences**:
- **Positive**: one-line loader change; config-view/TUI untouched; default-off keeps every existing project byte-identical.
- **Negative**: the name says "pull request" while the flag also implies the commit+push preamble — documented in the config template comment.
- **Risks**: users may set `pull_request: true` without `gh` installed → delivery-time warning, loop unaffected (consistent with the graphify pre-flight philosophy, ADR-0013).

**Related ADR**: none. **Applied In**: Phase 1 (config).

### AD-004: Command execution is injected; unit tests inject a scripted executor, e2e fakes git and gh on PATH

**Context**: Project test rules: unit tests must not spawn real binaries; the e2e harness already puts fake binaries on PATH (`e2e/fake-bin/`).

**Decision**: The delivery module exposes `deliverRun(input): Promise<DeliveryOutcome>` where `input` carries an injectable `run` (default: `spawnProcess`) and the commit helper is the real one (default: `commitCheckpoint`) — same pattern as `EngineDeps`. Unit tests inject a scripted fake returning canned `RunResult`s per command. The e2e adds `e2e/fake-bin/gh` plus a fake `git` against a real bare `origin` fixture (the harness already creates temp git repos).

**Alternatives Considered**:
1. Mock `child_process` globally — rejected: project bans global mocks in favor of injected deps.
2. Only e2e coverage — rejected: the branch matrix (base/non-base/detached, dirty/clean, diverged, empty-range, gh missing/push-rejected/PR-existing) is far cheaper to pin in unit tests.

**Consequences**:
- **Positive**: the full step matrix is unit-testable without git/gh; e2e stays a thin smoke of the wiring + the divergence guard against a real bare remote.
- **Negative**: the fake executor must model exit code and stdout shape of both binaries faithfully (kept small by collecting URLs as strings).

**Applied In**: Phases 1 and 4.

### AD-005: Delivery outcomes are ephemeral — notifications only, nothing persisted

**Context**: The fix plan is the single source of truth of loop state and its shape is load-bearing (resume, UI, refresh). Delivery runs after the plan is already persisted as done; recording outcomes would re-open the document for purely informational value.

**Decision**: The delivery result is returned to the walk, translated into `notify` calls, and dropped. No fix-plan field, no log-file schema change. The only persisted side effects are git's own (branch, commits) and the forge CLI's own (the pull request itself).

**Consequences**:
- **Positive**: fix-plan shape untouched; resume never sees a half-delivered state (a fresh loop run simply delivers again, and the divergence guard + existing-PR view make that converge).
- **Negative**: after a session ends the PR URL lives only in the forge; acceptable (the PR is the record).
- **Risks**: a re-run of an already-delivered spec pushes new commits and reports the existing PR — by design (Open Question 2 default; re-delivery convergence).

**Related ADR**: [0007-measurement-ledger-outside-the-fix-plan](../../adr/0007-measurement-ledger-outside-the-fix-plan.md).
**Applied In**: Phases 1 and 3.

### AD-006: Forge URL acquisition: capture from `pr create` stdout, with a `pr view --json url` fallback

**Context**: F2 BLOCKER. `gh pr create` does not accept `--json` (the flag exists on read commands only). The contract's previous machine-channel invocation would fail with "unknown flag: --json" on every successful run, bypassing the fallback and converting every delivery into a warning. The fix must keep the single-forge-call happy path and stay machine-readable on failures.

**Decision**: The happy path runs `gh pr create --base <cfg> --head <branch> --title … --body …`. The URL comes from the **stdout** of a successful create (gh always prints `https://…/pull/<n>` on success). On non-zero exit, the system applies the already-exists detector on stderr/stdout (machine channel: the binary exits with a distinct code or message; the detector strips ANSI, exact-match against the recognized already-exists signature, locale-tolerant). When matched, the fallback runs `gh pr view <head> --json url` and reports that URL. When unmatched, the failure is reported as the documented "delivery warning: pull request creation failed: <reason>".

**Alternatives Considered**:
1. Always create then view (`pr create` followed by `pr view --json url` regardless of success) — always-fresh JSON; wastes a forge call on the happy path and adds a small delay.
2. Pre-flight `gh pr list --head <branch> --json url` before create — doubles the network round-trips on the happy path and races with itself; the create failure is the authoritative signal.

**Consequences**:
- **Positive**: one forge call on the happy path; machine-readable URL on both create success and existing-PR fallback; clearly bounded failure on any other error.
- **Negative**: depends on gh's stdout shape for the happy path — stabilized by a parser test that asserts the URL is captured; fall-back path keeps `--json url` as the machine channel.
- **Risks**: a major gh upgrade that hides the URL behind a non-default flag would silently change behavior → the parser test fails closed (it asserts exact stdout substring presence or a URL-shaped line; the test pins the contract).

**Related ADR**: none. **Applied In**: Phase 2 (forge steps) + Phase 4 (parser unit test).

### AD-007: Guarded reuse — fetch and fast-forward check, refuse-with-warning on divergence, never force

**Context**: F3+F4 BLOCKER/MAJOR. REQ-007's "creating it or reusing an existing one" left reuse mechanics and divergence handling unspecified. Three concrete reuse paths fail under the existing text: (a) a dirty tree over a diverged content match cannot `git checkout` without conflict; (b) a remote-only branch (e.g., fresh clone with the spec branch already open there) produces a non-fast-forward push with no force allowed; (c) a stale local tip behind the base branch produces a PR that reverts base's progress.

**Decision**: Reuse is allowed only when the **local or remote** spec branch's tip is a fast-forward ancestor of current HEAD (i.e. current HEAD can be reached by replaying the branch's commits, the branch tip has not moved past current HEAD). The mechanics, in order:

1. Determine target tip: prefer local `specs/<id>` if present; otherwise fetch `origin` for the same ref (`git ls-remote origin specs/<id>`). If no tip exists anywhere, create (carry dirty state via `checkout -b`).
2. Run `git push --dry-run --no-verify origin <tip>..HEAD` — a successful dry-run means the push is fast-forward only. (A divergence between tip and current HEAD that current HEAD does not satisfy is also caught here.)
3. When fast-forward is allowed, reuse: `git checkout <branch>` carries dirty state if non-conflicting; on conflict, the system stops with the documented warning and the operator resolves.
4. When fast-forward is **not** allowed (remote tip is ahead of current HEAD, or the local tip is stale), the system refuses delivery with `[specs-kit] delivery warning: branch reuse failed: <branch> diverged`, never attempts a forced update, and the closure notice reports the divergence (operator rebases or deletes the branch manually).

**Alternatives Considered**:
1. **Fresh branch per run** (`specs/<id>-run-<date>`) — never diverges; one PR per run loses the re-delivery convergence (REQ-021 expectation that the new commits update the existing PR).
2. **Force-update with `--force-with-lease`** — would silently rewrite history on the remote; the spec's negative requirement REQ-NR006 forbids it; treating the divergence as a normal branch state (push it the way the operator would) requires a coordinated story this skill is not the place to design.
3. **No reuse** — always create the branch only when it doesn't exist locally *and* not in the remote; first delivery works, every re-delivery after a fresh clone would silently land on the wrong tip. Not a refinement — a regression.

**Consequences**:
- **Positive**: reuse converges with the existing-PR path; diverged state is loud but local (no forced push); the guard is testable against a real bare remote in e2e.
- **Negative**: an extra `fetch` + `push --dry-run` per delivery on the reuse path — both have low timeouts (15s each) and only run when a spec branch exists on either side.
- **Risks**: when both local and remote tips exist but disagree (e.g. the remote has a forced-push from another path), the local tip wins the dry-run check; the remote push then rejects → documented warning, manual resolution. Acceptable.

**Related ADR**: none. **Applied In**: Phase 1 (delivery branch step) + Phase 4 (e2e: divergence scenario on real bare remote).

### AD-008: Terminal warnings for the PR body come from the run's closing state, never persisted for delivery

**Context**: F6 MAJOR. AC-012 required "failed-task messages, partial sync, red gate" but the fix plan doesn't persist a delivery-specific warning record, and AD-005 forbids persisting one for delivery. The fix must unify the wording with what the walk already computes for its closing notices.

**Decision**: The body builder takes the **same** terminal-warning set as the closing notices, computed by the walk and passed to the delivery step explicitly (not re-derived by the delivery module). The set is: `failures[]` (collected in `walkSelection` as tasks that failed while `continue-on-failure` kept the run moving), `plan.state.graphPartialSync` (true when the codebase graph was absent), `plan.state.postHookGateFailed` (recorded but cleared by the walk before delivery reads it — so this state is captured by the walk into a local variable before the clearing step). The walk captures and passes the warning set as a delivery dep input; the builder emits a human-readable line per present warning. The delivery module never reads or writes the fix plan beyond the read-only view allowed by AD-005.

**Consequences**:
- **Positive**: AC-012, AC-017, and the closing notice describe the same set; one source of truth per run; persistence stays untouched.
- **Negative**: walk-local capture (the `postHookGateFailed` read must happen before its clear step) → ordering becomes part of the implementation; documented as an ordering invariant.
- **Risks**: a future refactor that renames these flags would break delivery → unit tests pin the field names against the fix-plan types in `src/fixplan/fix-plan.ts`.

**Related ADR**: AD-005. **Applied In**: Phase 1 (delivery input) + Phase 3 (walk capture).

### AD-009: PR title source is the spec document's first H1, with the spec identifier as fallback

**Context**: F7 MAJOR. AC-011 said "derived from the name of the spec" without defining name. REQ-026 (clarified) fixes this. The technical decision is the implementation detail of where the name is read from.

**Decision**: The walk reads the spec document's first H1 (`# Foo Bar`) from the spec file (the one resolved to `specDir/<spec-filename>.md`). When the file is missing or has no H1, the title falls back to the spec identifier (e.g. `001-auto-pr-at-loop-end` humanized to `Auto Pr At Loop End`). The title builder stays a pure function; the walk is the sole place that reads the file.

**Alternatives Considered**:
1. Read a `title:` frontmatter field — adds a new convention and a new failure mode (missing field); the spec files already carry the H1.
2. Derive from the spec directory name only — what the original plan proposed; silently produces a stale title when the document title drifts.

**Consequences**:
- **Positive**: H1 is already where the document's name lives for humans; no new contract.
- **Negative**: walks depend on `specDir` resolving to a real file with an H1; the unit test pins both the read path and the fallback.
- **Risks**: a future spec format change to a different heading style (e.g. title-only-as-frontmatter) would land here; keep the read function in one place.

**Related ADR**: AD-005 (ephemeral read). **Applied In**: Phase 1 (content builders) + Phase 3 (walk input).

---

## Implementation Phases

### Phase 1: Foundation — configuration flag, delivery module, guarded reuse primitives

**Goal**: The delivery entry point exists with config, branch (including divergence guard and detached state) and commit semantics. No forge knowledge.

**Entry Criteria**:
- [x] Functional spec v1.1 approved (clarifications + adversarial review follow-ups closed at the spec level).
- [x] Architecture decision AD-002 (gate boundary) documented.

**Milestones**:
- [ ] Loader reads `git.pull_request` with tolerant default-off; config-init template documents the key; `git.base_branch` continues defaulting to `main`.
- [ ] `src/loop/delivery.ts`: probe, branch step (create / guarded reuse per AD-007), delivery commit via `commitCheckpoint`; detached HEAD under the spec-branch path; outcome aggregation. ≤ ~250 lines.
- [ ] `src/loop/delivery-content.ts`: `buildPrTitle` (AD-009: H1 from spec file, spec-id fallback), `buildPrBody` (AD-008: terminal-warning sources from the walk's closing state).
- [ ] Unit tests: branch matrix (on-base / non-base / detached / diverged / dirty / clean / pre-branch failure), commit matrix (flag on + `no_commit` true), title source matrix.

**Key Deliverables**: `src/loop/delivery.ts`, `src/loop/delivery-content.ts`, `test/delivery.test.ts`, `test/delivery-content.test.ts`.

**Dependencies**: none. **Blocked By**: none.

**Risks**:
- File creep past the 250-line guidance → split the forge step out (it already lives in `delivery-forge.ts` per the task plan).
- Divergence guard bugs → fast-forward dry-run unit + e2e against a real bare remote.

### Phase 2: Forge integration — push and pull request (F2 fixed)

**Goal**: Remote half with the corrected URL-acquisition strategy; push and PR view/create with parser-stable machine channels.

**Milestones**:
- [ ] Push step: `git push -u origin <branch>`; 30s timeout; failure preserves commits on the named branch, warning names branch.
- [ ] Forge create: `gh pr create --base <cfg> --head <branch> --title … --body …`; URL extracted from stdout.
- [ ] URL parser test: asserts URL capture from realistic create stdout; guards against a future gh change.
- [ ] Already-exists fallback: on detect, `gh pr view <head> --json url`; 90s timeout.
- [ ] `DeliveryOutcome` aggregation: first failure stops the sequence (single attempt per step).

**Key Deliverables**: `src/loop/delivery-forge.ts`; URL parser unit test; `contracts/forge-cli.md` revised.

**Dependencies**: Phase 1. **Blocked By**: Phase 1.

**Risks**:
- gh upgrade changes stdout shape → parser test fails closed.
- Already-exists detector fragility (contested C2) → relocated to a dedicated detector with machine-readable anchoring, not free-text scraping on the success path.

### Phase 3: Wiring — run walk, engine deps, controller

**Goal**: Delivery runs for completed runs at the right moment with the right notifications and the right inputs from the walk.

**Milestones**:
- [ ] `walkSelection` calls the injected delivery step after the final-sync consume and the done-persist, before the closing notices.
- [ ] Walk captures the terminal-warning set (AD-008) **before** the postHookGateFailed clear; passes it to the delivery step.
- [ ] Walk passes the spec file path (`specDir/<file>`) so the title builder can read the H1.
- [ ] Engine/controller thread the dependency (real default, injectable for tests).
- [ ] Halted/stopped closings surface the skip notice; flag off leaves the run untouched.

**Key Deliverables**: `src/loop/run-walk.ts`, `src/loop/engine.ts`, `src/loop/run-assembly.ts` (dependency threaded), notifications composed.

**Dependencies**: Phase 1–2. **Blocked By**: Phase 2.

**Risks**: Walk signature churn → keep the delivery dep optional in tests with a no-op default.

### Phase 4: Hardening — e2e, ADR, project documentation

**Goal**: The feature is proven end-to-end and documented.

**Milestones**:
- [ ] `e2e/fake-bin/gh`: fake forge CLI; scriptable modes (success / already-exists / missing / unauthenticated); URL emitted as plain stdout (mirroring the real channel used by AD-006).
- [ ] `e2e/fake-bin/git`: not needed (real git against a real bare remote fixture; the divergence test pushes against origin and reads the fast-forward behavior).
- [ ] E2E scenarios: completed run on base + dirty tree → branch created, commit, push, PR URL notified; second delivery with existing PR (URL reported, no duplicate); diverged remote branch → warning + branch named; flag off → no side effects; flag on + `no_commit` true → final commit still created (AD-002).
- [ ] ADR-0019 ("the loop delivers its own work, best-effort") in project ADR style.
- [ ] `CONTEXT.md`: receive the new delivery entries (flag di consegna, consegna del run, ramo della spec) with avoid-lists; the ontology created earlier remains the canonical glossary.
- [ ] `docs/specs/architecture.md §3.2`: enumerate `run.no_commit`, `git.base_branch`, `git.pull_request` with types and defaults (closes F14).
- [ ] Project README: section on the delivery flag and prerequisites.
- [ ] Spec Status: flip from `Draft` to `Approved` after the remediation closes (final task in this phase — closes F19).

**Key Deliverables**: `e2e/fake-bin/gh`, `e2e/delivery.e2e.test.ts`, `docs/adr/0019-*.md`, ontology in `CONTEXT.md`, architecture config-key enumeration, spec Status flip.

**Dependencies**: Phase 3. **Blocked By**: Phase 3.

---

**Dependency chain** (critical path): Phase 1 → Phase 2 → Phase 3 → Phase 4. Phases 2 and 3 share the TypeScript imports of Phase 1; the forge split keeps Phase 2 reviewable without touching Phase 1.

---

## Performance Requirements

CLI extension targets: subprocess budgets and zero-impact guarantees, not request rates. All measurements come from the existing `RunResult.elapsedMs` and the phase meter.

| Metric | Target | Measurement Method | Notes |
|--------|--------|--------------------|-------|
| Token spend of delivery | 0 tokens | Phase meter (no agent subprocess) | Hard requirement (REQ-006, AD-002) |
| Per-git command duration | < 30s (hard timeout) | `spawnProcess` timeout | Branch + commit + dry-run + push |
| `gh pr create / pr view` duration | < 90s (hard timeout) | `spawnProcess` timeout | Network-bound |
| Total delivery wall-clock | ≤ 2 min typical | Sum of `elapsedMs` | 5–7 subprocesses in the worst case |
| Loop phase impact | None | Delivery runs after final sync, outside every phase | Never inside a task's spawn budget |
| Memory footprint | Negligible (< 10 MB transient) | No new resident state | Strings only; nothing cached |

### Monitoring

- Step outcomes surface through the existing notification channel (`[specs-kit]` info/warning); no new monitoring surface.
- Post-run diagnostics rely on git (`git log`, `git branch`) and the session transcript; delivery writes no logs of its own (AD-005).

---

## Risk Assessment

| Risk | Likelihood | Impact | Overall | Mitigation | Detection |
|------|------------|--------|---------|------------|-----------|
| `gh` not installed / unauthenticated on operator machine | MEDIUM | MEDIUM | MEDIUM | Delivery-time warning, run stays completed (REQ-015); documented prerequisite | Warning names step + reason |
| `gh` stdout URL shape drifts across versions | LOW | MEDIUM | LOW | Parser test asserts a URL-shaped line capture (AD-006); --json on view path unchanged | Parser test fails closed |
| Remote-only spec branch forces non-fast-forward push | MEDIUM | MEDIUM | MEDIUM | Dry-run fast-forward check (AD-007); refuse-with-warning on divergence | Warning names branch + divergence |
| Spec branch diverged after a previous remote-side push | LOW | MEDIUM | LOW | Same dry-run guard (AD-007); operator resolves manually | Warning names branch |
| Detached HEAD loop run | LOW | LOW | LOW | Treat as spec-branch path (AD-001 + spec REQ-025) | Unit test pin |
| Loop killed between delivery commit and push | LOW | LOW | LOW | Nothing persisted is half-done (AD-005); next completed run re-delivers, divergence guard makes it converge | Resume + re-run e2e |
| Force flag ever smuggled into the helper or plan | LOW | HIGH | LOW | REQ-NR006 + AD-007 forbids it; lint/test review checklist item | Code review / test grep |
| Temptation to persist delivery state | MEDIUM | LOW | LOW | REQ-NR007 + AD-005; review checklist item | Task review |
| New runtime dependency smuggled in | LOW | HIGH | LOW | Forbidden Technologies table; project constraint | `npm ls` / review |

### Risk Response Protocol

1. **Detect** — delivery warning in the closing notices names the failed step.
2. **Triage** — operator checks the named step (`gh auth status`, `git remote -v`, `git branch -a`).
3. **Mitigate** — finish delivery by hand from the named branch (`git push`, `gh pr create`); local state is intact.
4. **Resolve** — fix environment (authenticate, rebase/manual fast-forward the diverged branch); document in TECHNICAL-NOTES if new forever-bug.

### `--resume` limitation (C3)

Documented assumption: a `--resume` after a kill between commit and push does not re-deliver; the fix plan is already `done`, so resume reports completion. The operator must start a fresh run to deliver. Re-delivery converges via the divergence guard + existing-PR view.

---

## Project Structure

```
src/
├── config/
│   └── specs-kit-config.ts      # + git.pull_request (boolean, default false); default 'main' documented
├── loop/
│   ├── checkpoint.ts            # unchanged, reused by delivery (AD-002: call site controls no_commit gate)
│   ├── delivery.ts              # NEW: probe, guarded branch step (AD-007), commit, outcome aggregation
│   ├── delivery-content.ts      # NEW: pure title/body builders (AD-008, AD-009)
│   ├── delivery-forge.ts        # NEW: forge steps — push + create (stdout URL) + view fallback (AD-006)
│   ├── engine.ts                # threading the injectable delivery dep
│   ├── run-assembly.ts          # threading the injectable delivery dep into the assembled run
│   └── run-walk.ts              # completion branch captures terminal warnings + spec file path, calls deliver()
test/                            # unit tests mirror src/, all use injected fakes
e2e/
├── fake-bin/                    # + fake gh; real git against a bare remote fixture
└── delivery.e2e.test.ts         # NE
```

> `run-assembly.ts` is the natural wiring point between the engine and the walk; it is the **third file** in the wiring path (engine → assembleRun → walkSelection). Plan v1.0's project-structure section omitted it; v1.1 corrects that (F10).

### Structure Rules

1. **Delivery modules import no pi-provided packages** (`typebox`, SDK): they must stay importable from unit tests per project rules.
2. **One responsibility per file, ≤ ~250 lines**: delivery.ts stays tight by extracting content (delivered) and forge steps (extracted in Phase 2).
3. **Pure functions for content**: title and body builders take plain data from the walk.
4. **Injectable execution, no global mocks**.
5. **No fix-plan writes from delivery** (AD-005); the walk persists *before* delivery runs.
6. **Test files mirror source** with `.test.ts` suffix, `node:test` runner.

---

## Configuration Keys

Updated enumeration of `docs/specs/architecture.md` §3.2 (closes F14):

| Key | Type | Default | Used by |
|-----|------|---------|---------|
| `run.no_commit` | boolean | true | Per-task checkpoints (gating is at the call site in `task-nodes-tail.ts`, not in `commitCheckpoint` itself) |
| `git.base_branch` | string | `main` | PR target (delivery) |
| `git.pull_request` | boolean | false | Enables the delivery step (delivery) |
| `run.max_attempts`, `run.timeout`, `run.continue_on_failure`, … | … | … | loop defaults (unchanged) |

---

## Compliance Checklist

- [x] All dependencies have exact versions (inherited from package.json; external binaries versioned by minimum; gh stdout URL pinned by parser test).
- [x] All decisions have rationale with alternatives (AD-001…AD-009).
- [x] All risks have mitigation and detection.
- [x] Performance targets are measurable (subprocess budgets, zero tokens).
- [x] Structure follows project conventions (no new deps, injectable, ≤250 lines).

---

## Technical Plan Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| AD-001 | Delivery in the run walk completion branch | Order matches REQ-004; outside graph, budget and spawn accounting |
| AD-002 | `commitCheckpoint` helper ungated; gate at the call site | One helper, one subprocess path; covers REQ-003 + AC-010 |
| AD-003 | `git.pull_request` boolean, default off | Sits with `base_branch`; tolerant loader; default keeps behavior identical |
| AD-004 | Injected executor + fake `gh` in e2e | Full matrix unit-testable without binaries |
| AD-005 | Ephemeral outcomes, notifications only | Fix-plan shape untouched; convergence via AD-007 |
| AD-006 | `pr create` stdout URL; `pr view --json url` fallback | gh has no `--json` on create; happy path stays single-call |
| AD-007 | Guarded reuse: fetch + fast-forward dry-run; refuse-with-warning; never force | Closes F3/F4; re-delivery converges |
| AD-008 | Terminal warnings from the run's closing state | Same source as closing notices; no persistence |
| AD-009 | Title from spec H1; spec-id fallback | Closes F7; the file already carries the name |

### Top Risks

| Risk | Overall | Mitigation |
|------|---------|------------|
| `gh` missing / stdout drift | MEDIUM | Delivery-time warning; parser test fails closed |
| Diverged spec branch on reuse | MEDIUM | Dry-run fast-forward check (AD-007) |
| New runtime dependency smuggled in | LOW | Forbidden Technologies table + review |

---

## Next Steps

1. Re-run `/skill:specs-kit-spec-to-tasks docs/specs/001-auto-pr-at-loop-end/` (or surgical edits to TASK-002 / TASK-004 / TASK-005) — task bodies must reflect REQ-024…028 / AC-023…026 / AD-006 / AD-007 / AD-008 / AD-009. The tasks were generated from the spec's previous version; alignment with the v1.1 spec is mandatory before implementation begins.
2. Surface-level corrections to `tests/task-frontmatter` and `traceability-matrix.md` (closes F11, F16–F18; tracks Phase 4 deliverables anyway).
3. Re-run `/skill:specs-kit-adversarial-review --spec=docs/specs/001-auto-pr-at-loop-end/` — operator's decision.

### File Output

**Technical Plan**: `docs/specs/001-auto-pr-at-loop-end/2026-08-17--technical-plan.md` (this document, v1.1)
**Updated contracts**: `docs/specs/001-auto-pr-at-loop-end/contracts/forge-cli.md`
**Spec Folder**: `docs/specs/001-auto-pr-at-loop-end/`
