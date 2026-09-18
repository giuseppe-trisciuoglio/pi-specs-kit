# The reading brief is a node, not an orchestrator

Context: implementation attempts do their own reconnaissance, and repeat it
at every retry, because each phase starts clean. Measured on one spec: a
single attempt spending 34 file reads and 174 shell commands before writing
its first line of code. The idea taken from the "cheap model reads" half of
the reference material: let a cheap model read once per task and hand every
attempt the result, without handing any of them the authority an agentic
orchestrator would need.

## The decision

One new node in the declared task graph, `brief`, between task entry and the
first implementation attempt. It runs read-only, on its own `brief` role,
and writes exactly one artifact: `tasks/<TASK>--brief.md`, a short reading
brief — files to touch with the signatures already there, patterns of the
area, tests to run, what earlier work left behind. The file is injected into
every implementation attempt of the task as its own prompt block; a retry
reads the file again instead of regenerating it. The node passes the graph's
own test for membership: it produces a structured output consumed
downstream, not prose that evaporates with the session.

The brief stays off by default (`brief.enabled`), because the acceptance is
a measurement, not a mechanism: the extra spawn — a minute or two on a cheap
model — is paid back only if attempts get shorter by more than it costs.
Until that median is measured, the default must not bet the operator's
budget on it.

## Why a node and not an orchestrator

An orchestrator that decided what to read, read it, and steered the
implementation would move the graph's routing into a model's judgment. The
node keeps the graph declared: topology in the table, conditions in the
closed registry, and the brief is just one more vertex whose product is a
file. What the brief agent reads is suggested by the prompt (the codebase
graph, the project rules, the spec documents); what it writes is bounded by
the same protected-path and learnings rules every other phase obeys. If the
brief comes back empty or refused, the implementation falls back to doing
its own reconnaissance — a lost optimization, never a failed attempt.

The model choice spells the cost intent: the role defaults to the learner's
model, and the pre-flight checks the role only while the brief is enabled —
a model no spawn asks for must not be able to refuse a run.

## Consequences

- One extra ledger phase, `brief`, so the spawn is visible in the stats and
  the payback question stays answerable.
- Resume skips the node: a task entering at a named step never re-runs it,
  and a run killed mid-brief resumes at the attempt without one.
- The failure learner's blockers keep their own block, next to the brief:
  run memory of a dead attempt is not a reading list.
