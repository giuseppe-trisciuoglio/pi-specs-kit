# A refused spawn is not a failed attempt

The loop used to ask one question of a finished phase — did the spawn fail —
and every yes routed the same way: spend an attempt, implement again. That
answer conflates two unrelated worlds. An agent that wrote bad code deserves
another attempt with the review feedback; a provider that refused the request
will refuse the next one identically, and re-implementing working code cannot
change its mind. The review step already drew this line for its own spawns
(ADR 0013 names it); the implementation phase did not, so a rate limit or a
mistyped model id read exactly like code the agent got wrong.

## Considered options

- **Classify the failure from the text the CLI already emits (chosen).** pi
  puts the transport error verbatim into the closing message and the CLI's own
  complaints on stderr, so a rate limit arrives as
  `429 {"type":"error","error":{"type":"rate_limit_error",…}}` and a mistyped
  provider prefix as `Model "…" not found`. `classifyPhaseFailure` reads those
  into a kind (`quota`, `auth`, `model`, `timeout`, `aborted`, `agent-error`)
  and one predicate that actually drives routing: `environment`, true when the
  same spawn against the same configuration fails the same way.
- **Leave everything the loop cannot attribute on the retry path.** Only a
  recognized refusal ends the task. A connection reset, a crash, an
  unrecognized message: all still cost an attempt and get retried, because a
  retry might genuinely get through. The guard can only ever stop early on
  positive evidence.
- **Report a refusal as an error, not a warning.** It names a provider or a
  configuration the operator has to change; sharing the severity of a lost
  round is what let a rate limit scroll past as one more failed attempt.
- Parse the `auto_retry_start` / `auto_retry_end` events instead. Rejected as
  redundant: pi's own retry loop reports the same payload, and by the time the
  phase ends the final error is already on the outcome. The events remain
  unparsed, and the log still shows them.
- Probe every configured model for budget before the run starts. Rejected: the
  answer decays immediately. In the run that motivated this, the model that
  died at 12:27 was healthy at 07:26 and would have passed any pre-flight;
  providers also change plans and limits under a running loop. A check whose
  green is meaningless an hour later buys false confidence.
- Refuse to start when a previous run recorded a refusal for the same role.
  Rejected for the same reason: quotas reset, keys get renewed. Any latch of
  that kind has to be advisory, and is left for a separate decision.

## Consequences

- `src/loop/phase-failure.ts` owns the vocabulary and the patterns, and now
  also owns `spawnFailed`, which becomes "classification found something". Its
  callers are unchanged.
- The routing stays declarative: an `environment-failed` implementation status,
  a named condition (`impl_environment_failed`) and one edge from
  `implementation` to `task_failed`, ahead of the exhaustion guard so the cause
  is named even on the last attempt — where "attempts exhausted" would hide it.
- An environment failure costs no attempt on either side of the cycle, so the
  two phases finally agree. The reviewer is never spawned on a tree that no
  implementation produced.
- The operator message quotes the provider verbatim and states plainly that
  spawning again changes nothing. That sentence is the one that was missing.
- The patterns are heuristics over free text. A provider wording no signature
  matches degrades to `agent-error` and keeps the old retry behaviour, which is
  the safe direction: the cost of missing a refusal is the behaviour we had,
  while the cost of inventing one would be a task stopped for nothing.
