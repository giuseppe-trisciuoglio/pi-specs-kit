# Measurement ledger

`<specs_dir>/measurements.jsonl` is the append-only record of token
consumption and duration, one JSON object per line, versioned with the
project (ADR-0007). It never gates the loop: losing it does not block a
resume. Three row kinds share the file, told apart by `kind`:

- `phase` — one consolidated row per executed phase (implementation, review,
  cleanup, sync, learner, failure_learner, or the learnings compaction).
- `spawn` — one row per agent subprocess, recorded whether it delivered or
  not; the raw evidence a post-mortem reads for a silent or refused spawn.
- `authoring` — one row per authoring window of the interactive session,
  attributed to the spec being drafted.

## The `phase` row

```jsonc
{
  "v": 1,
  "kind": "phase",
  "ts": "2026-09-16T10:03:21.000Z",
  "spec": "045-ledger-outcome",
  "task": "TASK-003",
  "phase": "implementation",
  "attempt": 2,
  "role": "agent",
  "model": "provider/model",
  "duration_ms": 543210,
  "usage": { "input": 12000, "output": 800, "cache_read": 0, "cache_write": 0, "total": 12800 },
  "cost_total": 0.42,
  "outcome": "passed",
  "hooks_ms": 12500
}
```

`outcome` and `hooks_ms` were added to answer *why* a phase ended, not only
*how long* it took: before them, computing a first-pass review rate or the
cost of the gate meant joining `phase` rows with `spawn` rows and reading the
frontmatter of archived review reports. Reading stays tolerant of missing
fields, as for the fix plan: a row written before either field existed has
neither, and every reader treats that as "unclassified" rather than as an
error.

- `outcome` — one value per way a phase attempt can end (`src/measure/ledger.ts`,
  type `PhaseOutcome`): `passed`, `review_failed`, `gate_failed`,
  `spawn_failed`, `pre_hook_failed`, `protected_paths`, `unchanged_tree`,
  `halted`. It is set by whichever code judges the phase result — the task
  nodes in `src/loop/graph/` and `src/loop/review-runner.ts` for
  implementation and review, `src/loop/phase-spawn.ts` for the learner
  subroutines — never inferred from other fields after the fact.
- `hooks_ms` — time spent in the phase's pre/post hooks, a subset of
  `duration_ms` (which keeps including them, so existing readers of
  `duration_ms` do not change meaning). Absent for phases that run no hooks
  (learner, failure_learner, the learnings compaction).

## Reading the KPIs

`/specs-kit-stats <spec>` (`src/measure/ledger-stats.ts`, pure and
test-importable) prints, per spec: tasks seen, attempts per task (mean and
max), first-pass review rate, overall review pass rate, median minutes per
failed cycle, gate minutes per attempt and in total, loop hours (sum of phase
durations) and wall-clock hours (first row to last row). The same figures are
printed in the closing notification when a range completes
(`src/loop/range-stats.ts`), so a run ends with its own numbers.

A "failed cycle" is every attempt whose implementation or review row did not
carry `outcome: "passed"`: the work paid for a retry rather than for the
task's progress. Rows without a classified `outcome` are excluded from the
ratios and counted separately as unclassified, so an old ledger still parses
and reports, just with fewer numbers.
