# The report is the memory when the report can speak

The failure learner is an agent session spent on the memory of a dead
attempt, and a session is the most expensive thing the loop buys. Measured on
a real run, the learner cost about seven minutes per failed attempt, and in
the common case what it was asked to write down was already written: a review
that rejected the attempt left a readable report naming exactly what stopped
it, and the loop had already turned those findings into the retry's feedback.
Spawning a second agent to restate the first one's verdict bought a restated
verdict, at full session price.

This amends the routing, not the memory. A failed attempt still leaves
blockers, still bounded, still per task, still pruned when the task passes —
everything the earlier decision established about the channel stays. What
changes is who writes the entries in the common case.

## Considered options

- **Route every failure through the learner and let the learner decide.**
  Rejected: it is the spawn, not the decision, that costs the seven minutes.
- **Drop the memory for review rejections entirely.** Rejected: the findings
  ride to the retry as feedback, but the attempt's trace and the
  consecutive-wall rule both read the blockers, and a rejection that repeats
  is exactly the wall the rule exists to catch.
- **Derive the entries from the report, no spawn (chosen).** A readable
  FAILED verdict becomes one blocker per finding: a requirement conflict
  keeps its contradiction kind, an escalation its operator kind, and an
  ordinary issue takes the inert catch-all — recorded for the trace, never
  tripping the escalation on its own. A summary line covers a report whose
  lists are empty.

## What still buys the spawn

- A red post-hook gate: the report never judged what the gate rejected.
- A silent, refused or timed-out spawn: there is nothing to read.
- A report that is missing, unreadable, or not a FAILED verdict.
- A verdict the review never stated — a red pre-review gate, an interrupted
  reviewer beyond its budget — since whatever is on disk does not describe
  this attempt.
- A report carrying a requirement conflict or an escalation: those are the
  kinds the consecutive-wall rule routes on, and the rule keeps judging them
  on the reviewer's own words through the learner.

The operator keeps a switch, `run.failure_learner`: `always` restores a spawn
on every failed attempt, `when_needed` (the default) applies the rule above.
Skipped learners are visible in the measurement ledger as phase rows marked
`outcome: "skipped"` with the reason, so the saving stays measurable next to
the spawns they replaced.

## Consequences

The rejected-review path now walks through the learner node on its way back
to the implementation: the node decides, derives or spawns, and the same wall
bookkeeping runs on whatever it recorded. A failed attempt no longer costs an
extra agent session in the common case, and the memory it leaves is the
reviewer's own findings rather than a second agent's paraphrase of them.
