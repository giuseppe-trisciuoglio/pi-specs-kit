# The run duration ceiling has two levels

A spec ran for 14.2 hours of loop time under `max_run_duration: 10h`. The
ceiling did what it was configured to do: it halted the run partway through the
range, left a resumable snapshot, and waited. Nobody was at the terminal, so it
waited for hours — 24.6 hours of wall clock for 14.2 hours of work, most of the
gap spent by a finished-with-this-phase loop sitting still until someone typed
`--resume`.

The ceiling exists against a runaway: an agent that will not converge, retrying
the same failing phase until the token budget is gone. It does not exist
against ordinary work that took longer than the operator guessed. The single
number could not tell the two apart, and it was set at the guess, because that
is the only number an operator has when the file is written.

## Considered options

- **Two levels: `max_run_duration` warns and continues, `max_run_duration_hard`
  halts (chosen).** The first number goes back to being what it always really
  was — how long the run is expected to take — and crossing it produces one
  `[specs-kit]` warning and nothing else. The second is the one that ends the
  run, set far enough above that only a run that stopped making progress
  reaches it. An operator who sees the warning can let the run finish, raise
  the expectation, or stop it; the ones who are asleep get the range finished
  instead of a halted loop.
- **Raise the single ceiling and leave the semantics alone.** Rejected: it
  moves the same wrong cut somewhere else. Any number low enough to catch a
  runaway in useful time is a number an honest long run can reach, and the
  operator has no way to learn which of the two happened except by reading the
  log afterwards.
- **Drop the wall clock entirely and rely on `max_spawns_per_run`.** Rejected:
  the spawn counter bounds how many subprocesses a run opens, not how long
  they take. A phase that hangs against a slow provider spends hours per spawn
  and never reaches the count.
- **Unset hard ceiling means no halt at all.** Rejected as the default: it
  turns the guard off for every project that does not know the field exists,
  which is every project until it reads this file. An explicit
  `max_run_duration_hard` is still free to be set very high.

## The default

Left out of the file, the halting ceiling is **three times** the expected one
(`HARD_RUN_DURATION_MULTIPLE` in `src/loop/budget.ts`): 18 hours under the
default `max_run_duration: 6h`, 30 hours for the run that prompted this. Far
enough that a run merely slower than planned reaches the end of its range,
close enough that a run stuck in a loop still stops on its own. A hard ceiling
configured *below* the expected one would make the warning unreachable, so the
two coincide instead of inverting.

## Consequences

- `BudgetLimits` carries both numbers and `hardRunDurationMs` derives the
  effective halt, pure and exported so the config view and the generated file
  can show the operator the number that actually applies.
- The warning is one per soft ceiling, not one per spawn, and moving the soft
  ceiling through a reload arms it again: an operator who raised it after the
  first warning wants to hear about the new one too.
- The halting ceiling is checked first, so a run that crosses both at the same
  spawn halts rather than warning about a limit it has already passed. The
  refused spawn is not charged, as before.
- Both numbers follow `specs-kit.yaml` through `LoopBudget.reconfigure`
  (`docs/adr/0026`), so an operator who sees the warning can raise either
  ceiling in the file and the next phase picks it up — no stop, no `--resume`.
  This was already true of the single ceiling and was documented nowhere.
- **Migration.** A file that names only `max_run_duration` keeps its number,
  which now warns instead of halting, and gains a halting ceiling at three
  times that value. A project that wants the old behaviour back writes
  `max_run_duration_hard` equal to `max_run_duration`. `specs-kit init` writes
  both fields out explicitly.
- Any ceiling that halts the run now also fires a desktop notification through
  the terminal's own channel (`src/util/push-notify.ts`, decision documented in
  `docs/adr/0041`): a halt after fourteen hours is the case the in-session
  message cannot reach.
