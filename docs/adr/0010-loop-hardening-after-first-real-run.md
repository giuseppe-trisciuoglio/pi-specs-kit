# Loop hardening after the first real run

A first real loop run over a non-trivial feature surfaced six friction points
where the loop relied on agent self-discipline or degraded silently instead of
holding a structural guarantee. This ADR records the six hardening decisions
taken in response, all driven by observed behaviour rather than speculation.

## Context

Each finding came from a completed session: the shipped code was correct, but
the *process* leaked. The two costliest were a wasted implementation cycle (a
cross-task handoff the next task never saw) and a whole session run with the
Knowledge Graph absent and nobody told.

## Decisions

### 1. Routed suggestions are structured, not prose

A review can defer a fix to a later task by writing a `routed` list
(`{ to, text }`) in the review frontmatter. The loop collects every entry aimed
at the task about to run and injects it as a `<routed_suggestions>` block in the
implementation prompt. Free-text handoffs buried in earlier reviews are no
longer the only channel: the loop serves them to the right task automatically.

- *Why not keep them as prose:* the task that owed the fix had no reliable way
  to learn it existed short of grepping earlier reviews by hand, and it missed
  one — the exact failure this fixes.
- *Rejected:* making routed fixes blocking on the routing review. A suggestion
  is advisory when written; it only becomes a finding if the *target* task
  ignores it (decision 2).

### 2. An unactioned routed suggestion is a FAILED review

The review skill codifies the boundary the first run left to reviewer judgement:
a fix a prior review routed to *this* task, left unactioned, is a blocking issue
unless a task still in the range will cover it. A deferred fix with no later
owner is the gap the review exists to catch.

### 3. `completed` is an admitted task status

A cleanup hook stamps `status: completed`. The parser used to reject it, so a
mid-loop fix-plan refresh crashed on a file the loop's own phases had produced.
The parser now admits `completed` and normalises it to the canonical `reviewed`,
and the cleanup skill documents `reviewed` as the terminal it writes. One
status vocabulary, not two reconciled by a memory note.

### 4. Retried reviews archive their predecessor

Before overwriting the canonical `tasks/<TASK>--review.md`, the loop copies any
readable verdict to `tasks/<TASK>--review.attempt-N.md`. A retry no longer
silently discards the reasoning of the verdict it replaced; the failure history
stays auditable instead of living only in raw logs.

### 5. A sync without the Knowledge Graph is partial, not silent

When `graphify-out/graph.json` is absent, the sync still completes its
documentation duties, but the loop sets `state.graphPartialSync`, warns at sync
time and again in the final summary. The gap can no longer hide behind a single
start-of-loop warning. (Hard-aborting was rejected: it would stop a loop whose
other duties do not need the graph; marking partial keeps the run useful and the
gap visible.)

### 6. The technical plan owns cache/transaction read-path consistency

For any feature combining a cache with transactional mutation, the plan must
state per mutating path what the read-modify-write reads (cached value, managed
entity, or both) and when the entry is invalidated relative to commit. The
first run discovered the dual-read need at implementation time and reconciled it
reactively with a decision entry; the checkpoint moves that reasoning upstream.

## Consequences

- New prompt block `<routed_suggestions>`, new review frontmatter field
  `routed`, new fix-plan state field `graphPartialSync` (tolerant on read), new
  archive files `tasks/<TASK>--review.attempt-N.md` (excluded from the task set
  by the shared `--review` marker in `isTaskFileName`).
- The sync skill's "graphify is a hard dependency, sync must abort" stance is
  reconciled with reality: the sync runs, the result is flagged partial. The
  start-of-loop skill-missing warning stays.
- All six are covered by unit tests (routed parsing/collection, the prompt
  block, status admission + normalisation, review archival, graph existence and
  the partial warning, archive exclusion from the loader). The e2e suite still
  passes unchanged.
