# Measurement ledger outside the fix plan

Token consumption and duration are recorded in an append-only ledger next to the specs, not in the fix plan.
The fix plan is restartable loop state, rewritten whole on every transition and shaped for compatibility with an
external CLI; measurements are an accumulating record that spans authoring, several runs and several sessions, and
losing them must never cost a restart. Raw per-message rows are buffered in a write-ahead file under the agent state
directory rather than in the project, so a phase killed halfway still leaves its consumption on disk without the
checkpoint commits sweeping up hundreds of lines: only the consolidated per-phase and per-window rows are versioned
with the project.

**Amendment (2026-09-16, issue #45):** the `phase` row gained `outcome` and `hooks_ms`. The ledger recorded
duration, tokens and model per phase but not why it ended, so the KPIs the loop-time-reduction plan is measured
against (first-pass review rate, cost of a failed cycle, gate minutes) required joining `phase` rows with `spawn`
rows and reading archived review report frontmatter — not readable without a script. This changes only the row
schema, not the decision the ADR records: the ledger still lives outside the fix plan, and reading stays tolerant
of rows written before either field existed. See `docs/measurement-ledger.md` for the row shape and
`/specs-kit-stats`.
