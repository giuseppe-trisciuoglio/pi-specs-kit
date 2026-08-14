# Measurement ledger outside the fix plan

Token consumption and duration are recorded in an append-only ledger next to the specs, not in the fix plan.
The fix plan is restartable loop state, rewritten whole on every transition and shaped for compatibility with an
external CLI; measurements are an accumulating record that spans authoring, several runs and several sessions, and
losing them must never cost a restart. Raw per-message rows are buffered in a write-ahead file under the agent state
directory rather than in the project, so a phase killed halfway still leaves its consumption on disk without the
checkpoint commits sweeping up hundreds of lines: only the consolidated per-phase and per-window rows are versioned
with the project.
