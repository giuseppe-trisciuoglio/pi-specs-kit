# User Request

**Source**: anomaly A1 of the project's issue register (high priority)

**Original observation (Italian)**:

> In modalità veloce, un run ripreso da un punto oltre la fase di sync completa il
> range e si dichiara concluso senza che nessuna sync sia mai girata: né quella
> del task, né quella di fine range.

**Translation**:

In fast mode, a run resumed at a point past the sync phase completes the range
and reports success without any sync having run — neither the per-task sync
nor the end-of-range sync.

## Why this is a request, not a known issue

The anomaly was already characterised by a test (`test/resume-paths.test.ts`)
that pins the *current* behaviour. That test is the safety net: the moment
the loop is touched in the wrong place, it fails. It also makes the
behaviour change visible: when the fix lands, the test is rewritten
*deliberately*, and that rewrite is the record that the loop's behaviour
moved.

The fix is a single concept — *separate "sync was actually executed" from
"the resume anchor is past the sync phase"* — and the test rewrite is the
contract that proves the change is what the spec asked for.

## Key requirements

- A resumed run past the sync phase must not silently skip every sync.
  Whether the right answer is "always run one more sync" or "run a sync only
  if the last attempt did not" is a decision the spec must surface; the
  test will pin whichever is chosen.
- The change must remain a refactor in the sense that matters: no new
  failure mode, no new exit code, no new operator surprise. The behaviour
  delta is *one* additional sync in the worst case.
- The fix must be reversible: if the chosen answer turns out wrong, the
  alternative must be reachable by inverting a single decision.

## Out of scope

- The asymmetry of the stop checks between sync and `update_done` (A2 of
  the project's issue register): a separate decision, kept as-is for now.
- The catch-all edge test for entry into a cycle with already-exhausted
  attempts (A3): a coverage gap, not a behaviour change.
- Two files over the indicative size limit (A4): hygiene, separate work.
