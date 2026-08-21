# The configuration is re-read between phases

The engine received the configuration as a snapshot at loop start and held it
for the whole run: an operator editing `specs-kit.yaml` mid-run — fixing a
mistyped role model, unblocking a hook that keeps gating phases, raising a run
ceiling about to halt the loop — saw no effect until stopping and resuming,
and a resume inside the same session still reused the cached values. Yet every
read site downstream of the start already goes back to the same shared object
at use time: the spawner reads the role at every spawn, the executor reads the
hooks at every phase, the task graph reads the retry policy when each task is
declared. The snapshot was a property of the loader, not of the readers.

## Considered options

- **Re-read the file before every phase, swapping the values into the one
  shared config object (chosen).** The reload runs at the top of the phase
  executor, before the pre-hooks, so the hooks, the prompt inputs, the role
  and the timeout of one phase all come from the same load. Swapping the
  behavioral sections in place — roles, run options, hooks, knowledge base,
  prompt overrides, mode, panel, git, poll interval — keeps object identity
  stable, so no read site can keep stale values by accident. The cost is one
  file read and parse per phase, no model calls, no subprocesses.
- **Reload at the task boundary only.** Rejected: coarser for no saving. A
  hook fixed mid-task would keep blocking, and a model fix would not apply,
  until the task ends — burning attempts on values the operator already
  corrected. The per-phase read is the same cheap operation at the finer
  boundary.
- **Watch the file and apply the moment it changes.** Rejected: an edit would
  land mid-phase, so one phase could read its pre-hooks from the old file and
  its role model from the new one. The phase boundary makes the phase the
  unit of consistency: what a phase reads, it reads from a single load.
- **Reload the structural anchors too.** Rejected: `projectRoot`,
  `configPath`, `specsDir` and the active `spec` anchor the run — the spec
  directory, the fix plan and the measurement ledger path were resolved from
  them at start. Swapping them mid-run would split one run across two roots.
  They stay frozen at the start values.
- **Re-validate the role models against the CLI catalogue on every reload.**
  Rejected: the pre-flight is a start-time check and a catalogue query costs a
  subprocess; spending one per phase to catch a typo is the wrong trade. A
  model mistyped mid-run surfaces as a refused spawn at the next phase, the
  same failure shape it has when the typo is there at start.

## Consequences

- A new module owns the reload (`src/loop/config-reload.ts`): it loads through
  an injectable function (engine dep `reloadConfig`, defaulting to the real
  loader), swaps the behavioral sections into the shared object, and leaves
  the anchors untouched. The engine wires it in the run assembly.
- A file that does not load — malformed yaml while the operator is mid-edit —
  keeps the last loaded values and produces a `[specs-kit]` warning, never a
  loop failure: an editor save must not be able to kill a run, the same
  best-effort shape the measurement logging has. A file that is not there is
  a different case: the reload is a silent no-op rather than a swap to the
  all-default config, so a run started on hand-set values (or whose file is
  deleted mid-run) is not reset; a file created mid-run is picked up by the
  next reload.
- The run ceilings follow the file: `LoopBudget.reconfigure` re-applies the
  limits on every successful reload while the counters and the start timestamp
  carry over, so raising a ceiling mid-run lets a run continue that would have
  halted, and lowering one tightens a run that is spending too much.
- The learner spawns read the values of the most recent phase reload; knobs
  consumed once at start stay start-time — the task range, the resume anchor,
  the selected spec — and editing them mid-run has no effect on the walk in
  progress.
- Editing the configuration through `/specs-kit-config` while a loop runs now
  takes effect at the next phase, not at the next run: the write flows keep
  refreshing the controller cache for the UI, and the loop re-reads the same
  file at the next boundary.
