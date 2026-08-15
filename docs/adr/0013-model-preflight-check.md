# Configured models are checked against the CLI catalogue before the loop starts

A mistyped model id in the configuration (e.g. a wrong provider prefix) is only
discovered at spawn time, once per attempt: every implementation spawn fails
the same way, the reviewer never runs, and the run burns its budget on an
infrastructure failure that no re-implementation can fix. This decision adds a
pre-flight check: `LoopController.start` compares the models configured for the
five roles against the catalogue `pi --list-models` reports, before any
subprocess is spent.

## Considered options

- **Refuse to start on a model the CLI does not know (chosen).** A model absent
  from the catalogue is a certainty: the spawn would fail identically on every
  attempt, so starting the run means knowingly spending its budget. The start
  fails with an error naming the roles and models at fault.
- **Warn and continue on an unobtainable catalogue (chosen, same shape as
  graphify).** When the query itself fails — missing binary, non-zero exit,
  timeout, empty answer — the loop starts anyway, preceded by a `[specs-kit]`
  warning. Uncertainty does not block the operator; the alternative (refusing
  to run because the check could not run) would turn the pre-flight itself into
  the reason a run does not start.
- Let the spawn failure keep being handled downstream. Rejected: it costs an
  attempt per role per task before surfacing, and the review runner treats it
  as a lost attempt worth repeating, which re-implements working code for an
  outcome that cannot change.
- Run the check at phase spawn time instead of loop start. Rejected: by then
  the run has already spent a task attempt; the check is cheap and belongs
  before the first subprocess.

## Consequences

- `src/loop/model-check.ts` owns the catalogue query (`pi --list-models`,
  10s timeout), the table parse (header row, provider/model columns) and the
  diff between configured and known models. The query function is injectable
  (`ControllerDeps.listModels`), so tests pin a deterministic catalogue without
  spawning the real binary — the same pattern as the graphify check.
- The check runs next to the graphify check in `LoopController.start`, before
  the engine starts. With every role on `auto` (or unset) there is nothing to
  validate and the CLI is not queried at all.
- The review runner still maps a failed review spawn to an unusable verdict
  (no verdict, no re-implementation can fix it), so the environment-failure
  path stays coherent end to end and does not consume a task attempt.
- A run on a machine where `pi` is not on PATH gets a warning, not a refusal:
  the catalogue is unobtainable, and the loop must still be able to run.
