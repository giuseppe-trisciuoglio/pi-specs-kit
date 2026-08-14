# graphify's graph.json is the single graph file (no per-spec projection)

The loop needs a map of the codebase to validate task dependencies and to ground
phase prompts. That map is produced once by the external **graphify** skill as
`graphify-out/graph.json`, and every consumer reads it directly.

An earlier design had the sync phase *project* that graph onto a per-spec
`knowledge-graph.json` — a reshape of graph.json plus a `provides` enrichment
mapping each task to the files it produced. This revision drops the projected
artifact: graph.json is the single graph file.

## Considered options

- **graph.json as the single graph, no projection (chosen).** One authoritative
  file, no second copy that can drift from its source, no confusion over which
  file is the truth. Consumers query graph.json directly; sync refreshes it
  (`/graphify --update`) before reading. Cost: the `provides` enrichment
  (task → file authorship) is lost — graphify indexes code but does not know
  task authorship — accepted as a smaller cost than drift and ambiguity.
- Keep the per-spec `knowledge-graph.json` projection. Rejected: a projected
  copy drifts from graph.json the moment the codebase changes, and "which file
  is authoritative?" is exactly the confusion a single source removes.
- Let the extension build its own codebase graph as a fallback. Rejected: it
  would duplicate graphify's job, drift from it, and produce two conflicting
  truths.

## Consequences

- graphify is a hard dependency for any graph-backed feature. The extension
  checks for it at loop start (`LoopController.start`, shared skill directories
  only — graphify is never bundled) and emits a `[specs-kit]` warning when it is
  not installed. The resolver is injectable, so the check is unit-tested without
  the live filesystem. The warning is informational, not a blocker: a loop
  started without graphify still runs, only graph-backed validation is off.
- No `knowledge-graph.json` is produced or read anywhere. The sync phase
  refreshes `graphify-out/graph.json` (re-running `/graphify --update` when
  stale) as its first graph-touching step, then runs gap analysis, task
  enrichment, drift detection and spec updates reading graph.json directly.
- The `provides` (task → file) enrichment is gone. Declared per-task contracts
  in task frontmatter are unaffected and still flow into prompts as upstream
  context.
- Consumer skills (task-implementation dependency validation, spec-to-tasks,
  spec-check) read graph.json instead of a per-spec file.
