# Brainstorming Notes — 001-auto-pr-at-loop-end

Technical context discovered during brainstorming. The functional specification stays
technology-agnostic; these notes preserve the integration details for task generation.

## Existing anchors in the codebase

- **Checkpoint mechanism**: `src/loop/checkpoint.ts` already does best-effort
  `git add -A` + `git commit` via `spawnProcess` ("util/process.ts"). The delivery
  commit can reuse this pattern (or the module itself). Result shape:
  `{ committed, reason }`, never throws.
- **Checkpoint gating**: per-task checkpoints run only when `run.noCommit` is false —
  and the default is `noCommit: true` (no commits). The delivery flag must imply the
  final commit independently of `noCommit`.
- **Base branch config**: `git.baseBranch` is already typed, loaded and defaulted
  (`specs-kit.yaml`, default `main`) but currently unused at runtime. It becomes the
  PR target.
- **Run end hook point**: `walkSelection` in `src/loop/run-walk.ts` — the completion
  path after `consumeRunNode(finalSync, …)` and the final state persistence, before
  the closing notifications ("range completed…"). Terminal reasons:
  `completed | halted | stopped` (`LoopEndReason` in `src/loop/engine.ts`).
  Delivery belongs on the `completed` path only.
- **Notifications**: engine `onNotify(message, "info" | "warning" | "error")`;
  user-facing messages are English, `[specs-kit]`-prefixed at the controller layer.
- **Dependency injection**: `EngineDeps` already injects `commitCheckpoint`,
  `spawnPhase`, etc. for tests; delivery should follow the same pattern
  (injectable executor for git/forge commands).
- **No new runtime dependencies** is a hard project constraint: git and the forge CLI
  are external binaries invoked as subprocesses, exactly like the checkpoint uses git.
- **Tests**: `node:test` unit tests with injected fakes; e2e uses a fake binary on
  PATH (`e2e/fake-bin/`) — a fake forge CLI can extend the same pattern.

## Design notes (for task generation)

- Delivery is a **deterministic post-run step**, not an agent phase and not a per-task
  graph node. It runs at run level, after final sync, before closing notices.
- Config: a boolean under the existing `git:` section (e.g. `git.pull_request` or
  `git.delivery`) — naming decided at task generation; loader keeps tolerant reads
  (unknown/absent → default off).
- Suggested command flow (all best-effort, single attempt each):
  1. `git rev-parse --abbrev-ref HEAD` (and repo check) → working branch
  2. If working branch == configured base branch → `git checkout -b specs/<spec-id>`
     (reuse the branch if it exists)
  3. `git add -A` + `git commit -m "specs-kit: deliver <spec-id>"` (skip when clean)
  4. `git push -u origin <branch>`
  5. Forge CLI (gh style): `pr create --base <base> --head <branch> --title … --body …`;
     treat "already exists" as success and report the existing PR URL
- PR title: spec name. PR body: spec id, task range summary (done/total), loop
  outcome + terminal warnings (failed tasks, partial sync, red gates) — all already
  available on the fix plan at completion.
- Never persist PR URL or delivery state in the fix plan (protects the
  single-source-of-truth shape; outcome lives only in notifications).
- Pre-flight note: unlike graphify/model checks at loop start, no new pre-flight is
  required — the forge CLI is checked at delivery time; absence is a warning.

## Decisions influencing tasks

- Delivery failures never flip the run result (consistent with checkpoints and
  measurements being best-effort).
- Halted/stopped runs skip delivery and the closing notice says so.
- `specs/<spec-id>` branch naming convention; branch is reused across deliveries of
  the same spec.
- Clean tree → skip commit (no empty commits).
