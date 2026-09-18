# The attempts of a task are not worth the same model

A role is a model and a thinking level, and until now it was one model for the
whole run. That made every attempt of a task cost the same, which is not what
the attempts are worth. Measured over a full spec, all the implementation
attempts ran on the cheapest model while the reviewer ran on a stronger one —
and the expensive point of the loop turned out not to be the review. It is the
*second* implementation attempt: it is spawned because the first one was wrong,
and it drags another review and another gate behind it whether it is right or
not.

The first attempt is speculative. Most tasks are ordinary and a cheap model
closes them, so paying for intelligence there is paying for the common case not
to need it. Once that attempt has failed, the arithmetic inverts: the run has
already spent an implementation, a review and a gate on being wrong, and it will
spend another review and another gate on whatever comes next. Intelligence
should be proportional to the cost of the error, and from the second attempt on
that cost is several spawns, not one.

## Considered options

- **Raise the primary model for the whole role.** Rejected: it pays the strong
  price on the first attempt of every task, which is the attempt that usually
  did not need it. The saving being chased is exactly the tasks that close on
  the cheap model.
- **Raise the thinking level instead of the model.** Rejected as the only
  mechanism: it does not reach the cases where the cheap model simply does not
  know enough. It is offered alongside — `<role>_retry_thinking_level` — so a
  retry can change the level, the model, or both.
- **Reuse the fallback model as the retry model.** Rejected: the fallback is
  an answer to an environment failure (`0027`, `0033`), reached when a model
  is refusing or silent. Overloading it would mean a quota outage and a wrong
  diff route to the same place, and a role could no longer have both a spare
  provider and a stronger brain.
- **A retry model per role, from a configurable attempt (chosen).**
  `<role>_retry_model`, optionally `<role>_retry_thinking_level`, and
  `<role>_retry_from_attempt` (default `2`). Absent, the role behaves exactly
  as before.

## Where the rule lives

In `src/loop/phase-escalation.ts`, as `attemptModel(role, attempt)`: pure, no
SDK imports, decided from the role configuration and the attempt number alone.
The spawner applies it; it does not own it. Everything downstream of that one
call — the `auto` warning, the escalation, the sticky memory, the ledger row —
is about the model actually being spawned, whichever one it turned out to be.

A `<role>_retry_from_attempt` below two is read as absent. Attempt one is not a
retry, and such a value would only give the role a second name for its primary
model.

A spawn request that names no attempt counts as the first one. The subroutines
that have no attempt of their own — the learner, the failure learner, the
learnings compaction — never retry, so they must not quietly spend the retry
model.

## What it does to the fallback

Nothing, except that a role now has two models that can be the primary of a
spawn. The escalation still fires once, against whichever model was tried, and
the sticky memory of `0033` is keyed by the model string rather than by the
role: a dead cheap model does not condemn the strong one, and a dead strong one
leaves the first attempt of the next task alone. That is an amendment to `0033`,
not a reversal — the memory was always about the model the run found dead, and
it now says so in its shape.

The pre-flight of `0013` treats the retry model like a primary, not like a
fallback: every attempt after the first spawns on it, so a mistyped id there is
as certain a failure as a mistyped primary — just one attempt later, with the
first attempt's tokens already spent. An unknown retry model refuses the start
and the message names the field, so `agent: x` and `agent (retry): y` are two
distinct lines to fix.

## How it is read back

The ledger already records the model of each phase and each spawn, with the
attempt beside it, so the trade — one strong retry against two weak attempts and
their reviews — is a query over `measurements.jsonl` rather than a new
measurement. The switch is also notified once per spawn that uses the retry
model, naming the attempt that earned it, so the transcript shows the decision
instead of leaving it to be inferred from the rows.
