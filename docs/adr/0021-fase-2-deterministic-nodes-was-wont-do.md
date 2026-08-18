# Fase 2 was closed as "won't do": no promotion of deterministic nodes

The graph-engineering analysis proposed promoting four pieces of deterministic
work to first-class nodes with their own I/O contract: the pre-hook gate, the
post-hook execution, the gate on the review report, the knowledge-graph
presence check, and the `reviewed` frontmatter write. Phase 2 was supposed to
apply the D8 admission test on the code and implement what survived. The test
was applied; nothing did, on the code as it stood.

## Context

The work belongs to the declared-graph refactor recorded by ADR-0011 and the
node-level contract work recorded by ADR-0012. Phase 0 already promoted the
review gate and the failure funnel to declared nodes (D0); phase 1 closed the
prompt firewall by type, not by topology. What phase 2 had left to do, on the
analysis side, was the remaining inline deterministic work — the kind of
"blueprint" nodes Stripe Minions interleaves with agentic ones for system-wide
reliability.

The candidate inventory, drawn from the code at the time:

- pre-hook execution inside `PhaseExecutor.run`
- post-hook execution inside `PhaseExecutor.run`
- knowledge-graph presence check inside the sync node
- `reviewed` frontmatter write inside `update_done`
- the report-legibility gate, already inside the review macro by decision

The admission test (D8): a candidate is promoted **only if** its outcome
routes an edge, or it produces a structured output a downstream node consumes
as declared input.

## Considered options

- **Apply the test honestly, refuse promotion for everyone (chosen).** None of
  the candidates routes anything the table does not already declare, and none
  of them feeds a downstream node — the consumers, when they exist, are the
  spawn of the *same* phase (D1: pre/post-hook I/O of the node, not a node of
  its own) or the closing-notifications reader outside the graph. Promoting
  any of them would have added nodes that decide nothing, and would have
  forced a renegotiation of D1 (the phase is one measurement unit, the meter
  spans hooks and subprocess with a single handle).
- Promote the pre-hook anyway, as a special case. Rejected: it would have
  produced four pre-hook nodes parameterised by phase, each with the same
  predicate as today, and would have either split the ledger into two rows
  per phase or required a runtime state plumbing across the node boundary to
  share one handle. Cost: a re-pinned e2e (the ten-row ledger assertion) and
  a re-derivation of `duration_ms` semantics. Benefit: none measurable.
- Promote nothing and do nothing else. Rejected as the whole answer because
  the analysis identified a real residual value: the prompt-side policy of
  what the agent reads in the `<hooks>` block.

The decision is to close phase 2 as "won't do" *and* take the one residual
value separately, on its own merits. The residual value is the hook-output
rendering policy, which is a behavioural change to the prompt builder, not a
graph refactor — see ADR-0022 for its own record.

## Consequences

- The candidate inventory and the application of the D8 admission test
  (with evidence per candidate) lives in this ADR; no separate phase plan
  document is published.
- The D8 admission test, applied on the code rather than assumed on the
  analysis, becomes the closing precedent: a declared node earns its place
  when routing or downstream consumption depends on it, and a promotion that
  would not change a prompt byte-for-byte is not a refactor, it is ceremony.
- D1 (the phase is one measurement unit) is reaffirmed by the failure of
  every candidate to pass D8: the very fact that pre-hook promotion would
  have forced a handle-share across nodes is evidence that the unit was
  drawn correctly.
- The hook-output rendering policy, the only real residue, lives in
  ADR-0022 and in the prompt builder. The two records are linked: the
  decision not to promote nodes *is* the decision that the rendering policy
  belongs to the prompt, not to a new node.
