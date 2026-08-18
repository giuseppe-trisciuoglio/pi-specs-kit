# The `<hooks>` block of the prompt renders only failed-hook output

A pre-hook that exits green contributes its command line and `status: ok` to
the prompt; it does not contribute its stdout. A pre-hook that exits red
contributes the command, `status: failed`, and a bounded slice of its output
tail. The same rule applies to post-hook failures surfaced as a gate: only
failures travel to the next attempt's prompt. The rule is implemented in the
prompt builder and pinned by tests; it is a behavioural change to the
prompt's content, not a graph refactor.

## Context

Before the change, every hook — pass or fail — contributed its full output
to the prompt of every spawn of its phase, truncated to the same hard limit
(`HOOK_OUTPUT_LIMIT = 6000`, `HOOK_TAIL = 4500`). A green test suite of a
few kilobytes travelled with every implementation attempt, repeating the
same five lines to certify something a single `status: ok` line already
certifies. The repetition was not free: it consumed input tokens on every
spawn, and it pushed the useful signal — the output of a *failed* hook — into
the same block, where the bounded tail-truncation could clip the diagnostic
that mattered.

The change was identified as the only residual value of the closed phase 2
(ADR-0021). It belongs here, not in the graph, because it does not change
routing, does not change persistence, does not change the measurement ledger,
and does not add a node: it changes what the agent reads.

## Considered options

- **Render only failures (chosen).** The agent's reading of the block becomes
  dense in signal: a green gate is a single line, a red gate is the bounded
  tail the agent needs to repair. The asymmetry — the green case loses
  stdout, the red case keeps it — is the rule.
- Drop the whole block on green. Rejected: even on green, the agent needs
  to know *which* commands ran as gates (the command line is the source of
  truth for what was just checked). Keeping the command and the status, and
  dropping only the output, preserves the gate's identity without its cost.
- Truncate harder instead of dropping. Rejected: a tighter limit does not
  remove repetition — the prompt still carries the same output across
  every spawn — and the bounded tail of a green hook is still cost without
  signal.
- Make the rule opt-in per hook configuration. Rejected: the rule is about
  the prompt, not the hook; making it configurable pushes a prompt-rendering
  decision into the hook configuration, where the operator has no signal to
  pick a value. The rule is universal; it is also reversible.

## Consequences

- The prompt builder emits `output:` *only* for entries with `ok: false`. The
  green case is reduced to `$ <command>\nstatus: ok`. Empty output on a
  failing hook still produces no `output:` line — the failure is the
  signal, not the captured text.
- The pre-hook output of the *previous attempt* is still rendered in the
  prompt of the next attempt, with the same rule. This is how the agent
  learns what the failing gate said: the bounded tail of the failed hook,
  attached to the next spawn. (See ADR-0014 for the post-hook-as-gate
  decision that made this surface possible.)
- Tests pin the asymmetry in both directions: green-hook output must not
  appear (`assert.ok(!prompt.includes("all green"))`), failed-hook output
  must appear (`assert.ok(prompt.includes("output:"))`). The pre-existing
  test that listed a green hook with non-empty output is rewritten *once*,
  and the rewrite is itself the record of the behaviour change.
- The change is reversible on evidence: if the pass-rate at the first
  attempt degrades in a recognisable way across comparable runs after the
  change, the green-hook output is restored. The criterion is part of
  this ADR because the asymmetry must be earned by measurement, not
  assumed.
- The `HOOK_OUTPUT_LIMIT` / `HOOK_TAIL` constants and the truncation logic
  stay: they apply to whatever output survives the rule, and they continue
  to bound the failed case so a runaway hook cannot blow the prompt budget.
- The measure ledger and the e2e row count are unchanged: no node was
  added, no measurement boundary moved.
