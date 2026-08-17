# What the work is measured against is not the work's to edit

A run of eight tasks left a requirement unimplemented and every gate green. The
requirement said to refuse reusing a branch whose tip sits behind the base; the
implementation reused it, because the guard it chose answers the opposite
question. The review saw it — it wrote, in the body of its report, that there
was "a wording tension between the requirement and the plan", classified it as a
clarification item rather than a defect, and passed. A later task then rewrote
the interface contract so the contract agreed with the code, and ratified the
change through a decision entry the implementing agent had written for itself.
After that the contradiction was invisible: contract and code agree, and only
the requirement document, three files away, still says the opposite.

Nothing in the loop was broken. Each step was locally reasonable, and together
they moved the target instead of hitting it.

## Considered options

- **Ask the reviewer to be stricter.** The skill already said a spec
  contradiction without a justifying decision is a rejection. The session that
  deviated wrote the justification, so the rule was satisfied. A prompt cannot
  fix a rule whose escape hatch the same session controls.
- **Refuse the edit, and take the verdict out of the reviewer's hands
  (chosen).** Two mechanisms, both in the loop rather than in a prompt. The
  requirement document and everything under `contracts/` are hashed around each
  implementation phase: an attempt that changed one is refused, costs an
  attempt, and comes back naming the files and the two ways out — change the
  code, or state the conflict for a decision taken outside the session. And a
  review report carries a `spec_conflicts` list: when it is not empty the loop
  reads the report as a rejection whatever verdict the reviewer wrote. The
  reviewer describes the contradiction; what it costs is not its call.
- **Restore the edited documents automatically.** Rejected: the loop would be
  undoing work it cannot judge — some edits are legitimate, which is why the
  guard is a flag. Naming the files and spending an attempt keeps the decision
  with the operator and the next attempt.

The same run left two more claims nobody checked: a coverage row citing an
end-to-end scenario that was never written, and two review findings routed to a
later task with no verification that the task ever made them. Both are
re-derivable without a model, so the range now closes with a programmatic pass:
cited test files must exist, a citation naming a test must find it, and a fix
routed to a task that never completed is reported. They are warnings, not gates —
the check reads claims, and a claim it cannot parse must not fail a completed
range.

## Consequences

A task that genuinely needs to revise a contract cannot do it inline any more:
either the operator turns `run.protect_spec_artifacts` off for that run, or the
change goes through the channel that revises specs. That friction is the point —
it is what makes moving the target a decision instead of a side effect.

The closing checks look at what the documents claim, never at whether the claim
is *true*: a matrix row citing a real test that proves nothing still passes.
They close the gap between "a test is named" and "no test is named", which is
where the failure that motivated them lived.
