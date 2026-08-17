# The loop refreshes the codebase graph itself, once per task

Every phase reads the codebase graph, and the sync phase is what rebuilds it.
Sync is an agent session, and in fast mode it runs once per range — so a
fifteen-task run refreshed the map twice and read it fifteen times. In the run
that motivated this the graph on disk was built before the fifth task and was
still being read at the thirteenth: 530 nodes against the 1795 the tree
actually held, missing every class the loop itself had written. Nothing
signalled the gap, which is what makes a stale map worse than no map.

## Considered options

- **Re-extract the code at task entry, from the loop (chosen).** graphify's
  `update` re-extracts the code files with no model call behind it: measured at
  2.8 s over 182 source files with a cold cache, less with a warm one. At that
  price the refresh does not need to ride an agent phase at all, and once per
  task keeps the map at most one task behind instead of one range.
- Gate on `built_at_commit` and warn when it differs from HEAD. **Rejected on
  measurement.** The field exists, but the loop does not commit by default
  (`noCommit: true`), so HEAD does not move while the run works: in the
  motivating run `built_at_commit` equalled HEAD for all seven hours while the
  graph was nine hours and ten tasks out of date. The check would have reported
  "fresh" every single time it was asked.
- Warn on staleness instead of fixing it. Rejected as an answer on its own: the
  loop can predict the gap rather than discover it, and thirteen warnings that
  the operator can do nothing cheap about are noise. The warning survives only
  for the case where the refresh itself could not run.
- Run sync every task. Rejected: sync is a full agent session with a model
  behind it, and its other duties (spec text, decision log, traceability) do
  not need to run per task. The expensive half of what sync does for the graph
  is the doc/paper/image pass, which still belongs there.

## Consequences

- `src/loop/codebase-graph.ts` owns the refresh. Named for the map of the
  project, to keep it apart from `graph/`, which is the loop's own routing
  table.
- Best-effort like every other environment probe here: a missing binary is
  `unavailable` and stays silent, because loop start already warns once when
  graphify is absent; a failure or a timeout warns and the phases proceed on
  the graph they have. A stale map is still better than a halted run.
- Only the code half is refreshed. graphify says so itself when it finishes,
  and doc, paper and image nodes still need the agent-driven pass in sync. The
  code half is the one the loop's own tasks decay.
- `--force` is deliberately not passed. graphify refuses to overwrite a graph
  with a smaller one unless told to, which is its guard against a half-read
  tree. A task that legitimately deletes code has its shrink applied by sync,
  where an agent can vouch for it.
- The refresh is injectable (`TaskNodeDeps.refreshCodebaseGraph`). This is not
  only for assertions: the real function shells out, and without the seam the
  suite would depend on graphify being installed — wiring it in unstubbed took
  the state machine tests from 1.6 s to 23 s before the seam existed.
