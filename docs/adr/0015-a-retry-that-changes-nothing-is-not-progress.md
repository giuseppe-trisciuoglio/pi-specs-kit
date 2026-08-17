# A retry that changes nothing is not progress

A review rejects a task, the implementation runs again, re-reads the task,
re-runs the gate, concludes the work is already complete and writes nothing.
The tree handed to the reviewer is the one it just rejected, so it rejects it
again, and the pair repeats until the attempts run out. The loop had no way to
tell that round apart from a productive one: an attempt that exits zero with a
green gate looks identical whether it rewrote half the codebase or nothing at
all. This decision gives the loop that signal — a content fingerprint of the
worktree, read around a retried implementation.

## Considered options

- **Fingerprint the worktree around retried attempts only (chosen).** The
  implementation node reads a fingerprint before the spawn and again after the
  gate. Equal fingerprints on a clean attempt mean the round produced nothing,
  and the task stops there. A first attempt is never measured: nothing has
  rejected the work yet, so writing nothing is a verdict for the reviewer to
  reach, not a stall. This also keeps the happy path free of the measurement.
- **Stop before the review, not after it.** The guard fires at the end of the
  implementation node, so the reviewer is never spawned on a tree it has
  already seen. Stopping at the review gate instead would have cost one more
  agent session per round to learn nothing.
- Commit a checkpoint per attempt and diff against it. Rejected: it writes the
  loop's retry mechanics into the project history, and the checkpoint commit is
  a deliberate end-of-task event.
- Ask the agent whether it changed anything. Rejected: the phase that lost the
  plot is the one being asked, and its report is exactly what cannot be
  trusted here.
- Compare the review feedback instead. Already covered by the sibling stall
  guard (identical feedback twice). That one catches a reviewer repeating
  itself; this one catches an implementation repeating itself, one round
  earlier and one agent session cheaper.

## Consequences

- `src/loop/workspace.ts` owns the fingerprint. It stages the worktree into a
  throwaway git index (`GIT_INDEX_FILE` in a temp dir) and takes the tree
  object id git derives from it: an exact content hash of everything git would
  track, with ignored paths (build output) excluded for free and the user's own
  staging area untouched.
- The loop's own writes are excluded by pathspec: the state file and the phase
  logs under `_ralph_loop/` are produced while the phase runs, and counting
  them would make every attempt look productive.
- Best-effort, like every other environment probe here: outside a git
  repository, or on any git failure, the fingerprint is null, the signal is
  absent and the attempt is taken at face value. The guard can only ever end a
  task early on positive evidence that nothing changed.
- The routing stays declarative: a new `no-op-retry` implementation status, a
  named condition (`impl_no_op_retry`) and one `stall-guard` edge from
  `implementation` to `task_failed`, next to the exhaustion guard for the same
  reason — both say another round cannot help.
- The halt detail travels in `state.review_file_error`, the channel the
  sibling stall guard already reuses for a non-review halt reason. The field
  name has outgrown its meaning; renaming it would change the on-disk shape of
  the fix plan, so it stays until there is a reason to migrate the format.
