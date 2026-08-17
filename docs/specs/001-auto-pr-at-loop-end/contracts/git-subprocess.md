# Contract: Git subprocess boundary (delivery)

**Boundary**: Consegna context ⇄ local git repository via subprocess
**Spec source**: REQ-006/007/008/010/011/018/023/024, NR001, NR005, NR006
**Plan reference**: [2026-08-17--technical-plan.md](../2026-08-17--technical-plan.md) AD-007
**Version**: system git ≥ 2.30

## Purpose

All repository operations of the delivery step (inspection, branching with guarded reuse, commit, push) run as direct programmatic subprocess invocations — never delegated to an agent subprocess.

## Operations

| Operation | Purpose | Failure behavior |
|-----------|---------|------------------|
| Probe repository + working branch | decide the branch path | not a repo → delivery aborts with a warning; run outcome untouched |
| Branch decision — create or guarded reuse | on base branch or detached state: decide whether to reuse the spec branch or refuse | refusal due to divergence → warning naming branch + divergence; no forced update; run outcome stays completed |
| Guarded reuse (AD-007) | reuse only when fast-forward is possible (local or remote) | fetch + dry-run fast-forward; refused-with-warning on divergence; never force |
| Delivery commit | whole working tree as one commit identifying the spec (reuse of the checkpoint helper semantics: `add -A` + commit) | clean tree → skipped (no empty commit); git error → warning; sequence stops |
| Push | plain push of the delivery branch to the remote, setting upstream | rejected/absent remote → warning naming the branch; commits stay local |

## Guarded reuse mechanics

1. Determine the candidate tip: local `specs/<id>` if present; otherwise `git ls-remote origin specs/<id>` to check the remote.
2. If no tip exists anywhere → `git checkout -b specs/<id>` (creates the branch and carries the dirty tree).
3. Run `git push --dry-run --no-verify origin <tip>..HEAD`; success means the push is fast-forward only (the branch tip is an ancestor of current HEAD or current HEAD does not invalidate it).
4. On fast-forward, reuse: `git checkout <branch>` carries the dirty state if non-conflicting; on checkout conflict, the sequence stops with the documented warning and the operator resolves.
5. On divergence (the candidate tip is ahead of current HEAD or otherwise not an ancestor), delivery stops with `[specs-kit] delivery warning: branch reuse failed: <branch> diverged`. The local commits are not yet created at this point. The closure notice reports the divergence.

## Data exchanged

- Working tree state (uncommitted changes, clean tree).
- Branch names: working branch, base branch (default `main`), spec branch (`specs/<spec-id>`).
- Commit message identifying the spec.

## Invariants

- Whole working tree in scope (consistent with checkpoint behavior).
- Never force push; never rewrite or discard local commits on failure.
- Nothing pushed before uncommitted changes are committed.
- After delivery (success or failure) the working copy remains on the delivery branch, when one exists.
- Timeouts mandatory per command (`src/util/process.ts` wrapper): git operations ≤ 30s, the fetch and dry-run can be set to 15s each.
- Forcing or otherwise rewriting history is forbidden (REQ-NR006, AD-007).
