# A spent escalation reports both models, and the fallback routes

The escalation of `0027` gives a role a second model: on a classified failure
the phase is spawned once more on `<role>_fallback_model`. When that second
spawn failed too, the spawner returned the *primary's* outcome and dropped the
fallback's on the floor.

That is what an operator saw in a real run: the primary answered `429 Token
plan usage limit reached`, the fallback was spawned one second later, worked
for a minute and a half and died on a truncated provider stream — and the run
stopped with a message about the rate limit and nothing else. Two log files for
the same task said the fallback had run; the notification did not, so from the
outside the escalation looked like it had never happened.

The misreporting was the smaller half. The primary's failure was a quota, which
is environmental: the phase routing reads that flag, writes `review_file_error`
and stops the task rather than spending an attempt on a spawn that would be
refused identically. Applied to the primary's verdict, that reasoning is sound.
Applied through it to a fallback that merely stumbled on a truncated stream, it
ended a run that one more spawn would have carried.

## The shape

When both models are spent the spawner returns the fallback's outcome, carrying
a diagnosis it composed itself:

- **kind and environment come from the fallback.** It is the last state of the
  path actually taken. The primary's refusal says nothing about whether
  spawning the fallback again would work, and it is the fallback that the next
  attempt would use anyway — the primary is recorded dead by the same failure.
- **the detail keeps both, in the order they happened**
  (`primary <model> <kind>: <detail>; fallback <model> <kind>: <detail>`). The
  operator has to change something about one of the two models and cannot
  choose without seeing both.
- **the failure names its model.** `PhaseFailure` gained an optional `model`,
  filled in by the spawner — the classifier reads only the CLI text and cannot
  know which model produced it — and `environmentFailureMessage` cites it. This
  applies to a role with no fallback too: the refusal now names the model that
  was refused.

A composed diagnosis cannot be re-derived from text: the sentence naming both
failures contains the primary's `429`, and re-matching the signatures against
it would classify the fallback's stumble as a rate limit. So the outcome
carries the verdict itself (`composedFailure`), and `classifyPhaseFailure`
honours it before reading anything.

## The retry

The primary enjoys the agent CLI's own internal retries; the fallback used to
get a single sample, and a transient truncated stream ended the task on it. A
fallback whose failure is not environmental earns **one** more spawn, on the
same model — not a ladder, and not a new budget: it is charged to
`run.max_spawns_per_task` and `run.max_spawns_per_run` like any other
subprocess. A ceiling that refuses it is not an error either; the caller
already holds a diagnosable failure, and letting the budget exception escape
would lose it.

Three kinds are excluded. An environmental failure answers identically every
time — that is what the flag means. An interrupt was asked for. A timeout would
cost the whole wall-clock ceiling a second time before saying the same thing.

The two decisions are pure and live in `src/loop/phase-escalation.ts`, apart
from the subprocess handling in `src/loop/phase-spawn.ts`.

## The dead primary

`0033` records a primary that died environmentally so the rest of the run stops
probing it. That memory used to be written only when the fallback *delivered* —
an accident of where the early return sat. The primary's verdict is complete on
its own: it is now recorded whatever the fallback then did, so a run that
survives a stumbling fallback does not pay for the dead primary again on the
next phase.
