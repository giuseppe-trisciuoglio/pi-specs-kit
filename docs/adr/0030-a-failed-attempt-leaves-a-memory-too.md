# A failed attempt leaves a memory too

Loop memory was harvested only from a task that had passed review. A task that
kept failing left nothing, so its retries started from zero: every session
re-derived the same ambiguities and walked into the same wall.

Measured on a real run: one task, three agent sessions, four hours of agent
time, no review ever reached. The three sessions stalled on the same four
things, from scratch each time — among them a purely technical fact about a
framework method, established and verified in the first session and then
rediscovered twice, at full price, because there was nowhere to write it down.
The fix plan's learnings held a single entry, inherited from the task before.

## Considered options

- **Widen the learner to failed tasks.** Rejected: the inputs are not the same
  work. The learner reads a change that passed review and generalizes it into
  project memory; what a dead attempt has to say is local to one task and must
  die with it. Sharing the node would also share the output lifecycle, which
  is exactly what must differ.
- **Let the implementation write its own notes.** Rejected: that is the
  channel already refused in `0024`, for the same reason — an agent's mid-task
  append reaches the phases that follow through a path nobody designed.
- **Raise the ceilings.** Rejected: the ceilings are what bounded the loss.
  The cost was paid inside them, three times over.
- **A second, distinct memory channel (chosen).** A `failure_learner` node
  runs on a failed attempt and writes *blockers* into `fix_plan.state.blockers`
  — per task, classified, bounded, injected into the next attempt's prompt and
  pruned when the task passes.

## The classification is what routes

A blocker is one of four kinds, and the kind decides the answer. A
`verified_fact` is handed back to the next attempt verbatim: pure savings. A
`spec_contradiction` or an `unowned_decision` is not something the agent can
resolve by trying harder — the same wall in two consecutive attempts ends the
task and hands the operator the text, instead of buying the same deliberation
a third time. An `env` finding is context. A bullet the failure learner leaves
unlabelled is dropped rather than guessed at: a wrong kind is worse than a
missing entry.

## Where it sits in the graph

Every implementation failure that spends an attempt — a failed spawn, a red
post-hook gate, the exhausted attempt ceiling — routes through the failure
learner before the next attempt or the funnel. Two paths deliberately do not:
a failed pre hook never reached the agent, so there is no attempt to learn
from, and an environment failure says nothing about this task.

The per-task spawn ceiling is not an edge — it is refused at the spawn and
escapes as the exception it is, wherever the task happened to be. The runner
catches that one exception, lets the failure learner write down why, and
rethrows: the task still ends, the run still halts on it, but the next run of
that task no longer starts blind. For the same reason the failure learner's
own spawn is exempt from the per-task ceiling — charging the phase that
explains the exhaustion to the allowance that was exhausted would make it
unrunnable — while the run and duration ceilings still bound it.

## Consequences

A failed attempt now costs one extra agent session, and buys the next one the
wall it would otherwise rediscover. Blockers are run memory: they are bounded
like the learnings (a count cap and a character cap on what reaches the
prompt), rendered in their own prompt block so they cannot be mistaken for
project rules, and pruned when the task passes. A fact paid for by a failed
attempt outlives the task only through the learner, which is offered it as a
candidate when the task passes — `learnings-guard.ts` is untouched, and no
phase writes the learnings file directly.
