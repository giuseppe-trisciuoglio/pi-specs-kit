# sync reconciles source-of-truth docs with consolidated learnings

Learnings collected by the learner role are injected into later phase prompts as
advisory memory (`<memory>` from the fix plan, `<project_learnings>` from the
project file). That channel is one-way: learnings flow *into* prompts but
nothing writes them back to the documents that asserted the disproved
instruction. A learning like "no `./mvnw` wrapper exists despite AGENTS.md
documenting it" is therefore applied behaviourally (later phases use `mvn`) yet
the source document stays wrong and misleads every fresh run that starts without
the in-memory learnings.

The back-edge is added to the existing `sync` phase rather than a new phase.
sync already mutates documentation, already runs after the learner, already
behaves once at the end of the range in fast mode, and already receives the
learnings blocks; the only thing missing was the mandate to act on them for
source-of-truth files. A dedicated phase would have added a `PhaseName`, a role,
a `LoopStep`, resume-anchor handling and UI/config surface for a separation of
concerns that does not pay off: "fix docs that went stale" is already sync's job,
and a contradicted instruction is a doc that went stale.

Because the target set includes project-root files the operator authored
(`AGENTS.md`, `.pi/rules`), the behaviour is opt-in behind `run.reconcile_context`
(default `false`) and gated on the presence of at least one learning, so sync
does not scan when there is nothing to reconcile. When the flag is on, sync is
instructed to correct the single contradicted instruction (never rewrite a whole
document), to leave implementation code untouched, and to list every correction
in its summary; with `no_commit: false` the change rides the regular checkpoint
and is therefore revertible. The trust boundary is preserved by default and
widened only on explicit request.
