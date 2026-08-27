# A silent spawn is a failure, and a dying provider gets one fallback

A real run spent eight review spawns and roughly seventy minutes on one task
without the reviewer ever producing anything: no report, no findings, no
streamed event, no stderr line. Each spawn lasted about a minute and ended
clean, and the phase logs held nothing but the prompt. The post-mortem had
nothing to read, because every trace of what the reviewer did — or failed to
do — evaporated when the subprocess exited.

Two defects made that silence invisible, and one absence made it unfixable.

The classifier asked a narrow question: did the exit code differ from zero, or
did the closing message carry an error stop reason? Everything else counted as
delivered. But an error that fires before the first token arrives travels in
the closing message's error field while the stop reason stays unset, and a
provider that dies mid-handshake can leave a subprocess the operating system
terminated by signal with a polite exit code behind it. Both shapes walked
past the guard, and the loop went on reading the absent report as "the
reviewer forgot to write it" — a failure mode worth retrying, unlike the one
that actually happened. The formatted log shared the blind spot: lifecycle
events are deliberately not rendered, so a closing message carrying only an
error left no line behind either.

Even with the guard fixed, the old routing had no middle gear. A refusal
(quota, auth, unknown model) stopped the task; anything else burned the retry
budget against a provider that was down. Neither answer fits a provider that
dies under a running loop: retrying the same model reproduces the same outage,
while abandoning the task punishes every task in the range for one sick
endpoint. And the observability hole meant none of this could ever be
diagnosed after the fact — the subprocess runs sessionless by design, so the
phase log is the only record that will ever exist.

## Considered options

- **Classify from evidence, not from taxonomy (chosen).** The guard becomes a
  disjunction over evidence: nonzero exit, a termination signal, timeout,
  abort, an error message on the closing message, or an empty stream — zero
  completed assistant messages. The stop reason stays in the vocabulary for
  naming the failure, but it no longer gates whether one exists. A phase whose
  contract is a written artifact cannot have delivered anything when its
  stream holds no assistant messages, so the empty case is its own kind
  rather than a flavor of success.
- **Treat empty output as an ordinary lost attempt.** Rejected: the retries
  would go to the same model against the same outage, which is how the eight
  blind spawns happened. Empty output now ends the review sub-loop
  immediately with a named reason instead of entering the missing-report
  retry path, and costs the task like any other spawn failure — after the
  escalation below has had its one shot.
- **Escalate once to a configured fallback model (chosen).** Roles gain an
  optional second model. When a phase comes back refused or silent, and the
  role declares a fallback distinct from the model just tried, the phase is
  spawned exactly one more time on the fallback before the usual routing
  takes over. One attempt, not a ladder: if the fallback fails the same way,
  the environment is broken deeper than a model choice, and stopping with a
  diagnosis beats spending the range's budget proving it again per task.
- **Retry the primary model on empty output, then escalate.** Rejected as a
  wasted spawn: the evidence that classifies the outcome as empty is already
  the evidence that the provider never answered. The fallback attempt is the
  retry.
- **Persist the failure counters across runs.** Rejected for now: a resume
  already implies an operator looked at the stop message, and the per-task
  stop now names the cause. What the in-process streak cannot see — a fresh
  process repeating a doomed pattern — is bounded by the same fast stop, and
  the ledger records every spawn outcome for the post-mortem.
- **Halt the whole run after repeated silent phases (chosen).** A provider
  outage does not respect task boundaries: stopping one task just hands the
  same outage to the next. The executor counts consecutive spawn failures of
  the environmental kinds across all phases; two in a row halt the run with
  the accumulated reasons. Any delivered phase resets the count, so a flaky
  minute never stops a healthy run.
- **Log the raw closing payload per spawn (chosen).** Every spawn outcome —
  exit code, signal, stop reason, error message, duration, completed-message
  count — lands in the measurement ledger next to the usage rows, written
  best-effort like the rest of the channel. Sessionless spawns leave no other
  trace; this row is what makes the next incident diagnosable in one read.
- **Re-check the model catalog when output is empty.** Done at the moment of
  escalation: a model removed mid-run and a provider outage produce the same
  silence, and the check is one CLI call that turns "something broke" into a
  sentence naming the model.
- **Differentiate the reminder by what is actually wrong (chosen).** Three
  cases, three messages. An unreadable report kept aside tells the reviewer
  to repair its own block; a missing report states plainly that the previous
  spawn created no file and names where the file must appear; a silent spawn
  never reaches the reviewer at all. The skeleton shown in the reminder now
  quotes every value including the status literal, ending the contradiction
  between the example and the rule beneath it.

## Consequences

- `src/loop/phase-failure.ts` owns the wider evidence disjunction and a new
  empty-output kind; `src/agent/spawner.ts` reports the termination signal
  and the completed-assistant-message count alongside the existing outcome
  fields.
- `RoleConfig` gains the optional fallback model, loaded from the role's
  configuration and honored by the spawner, which performs the single
  escalation and announces it. The model pre-flight warns about a fallback
  the catalog cannot resolve, without blocking startup.
- The measurement ledger grows a spawn-outcome row; the writer stays
  best-effort and its failure never touches the loop.
- The executor keeps the consecutive-failure streak and halts the run through
  the existing halt path when it crosses the ceiling; a test can inject the
  threshold.
- The review sub-loop distinguishes the missing report from the unreadable
  one in what it tells the next spawn, and treats a silent spawn as a phase
  failure rather than an invitation to retry.
