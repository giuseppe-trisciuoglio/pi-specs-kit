# A lost verdict is repaired, not re-earned

Measured over one eight-task run: eleven review spawns and nine implementation
spawns for eight tasks, and the four extra ones cost 3.2 million tokens of 27.3
million — twelve percent of the run — without changing a line of code.

Two causes, both mechanical.

The frontmatter of a review report is parsed as YAML, and the values reviewers
fill it with are prose. Prose contains colons. A summary or a routed fix
carrying a colon followed by a space is a YAML parse error, so the report was
discarded — verdict, findings and all — and the phase re-spawned from scratch to
reach the same conclusion again. One task paid for this twice, 2.3 million
tokens, and the reminder it was sent named the block but never the quoting rule
that breaks it, so the second attempt reproduced the first.

The other: a review interrupted mid-flight was routed back to the
implementation. But an interrupted review judged nothing. Re-implementing code
the reviewer never looked at buys two agent sessions to arrive at the tree the
loop already had — which is exactly what happened, the second implementation
reporting that everything was already in place.

## Considered options

- **Ask reviewers to quote their values.** Done, in the skill and the template,
  but it cannot be the mechanism: the failure only shows up on the values that
  happen to contain a colon, so the prompt is right about ninety percent of the
  time and the loop pays full price for the rest.
- **Read the verdict without YAML when YAML fails (chosen).** The strict parse
  runs first and unchanged; when it fails, the block is read one line at a time
  for the four keys the loop consumes. A verdict the loop can act on is worth
  more than a document the loop can validate. The salvage is flagged, so the
  operator learns the format slipped without paying for it. A heading written
  above the block is tolerated for the same reason.
- **Keep the unreadable report and ask for a repair (chosen).** The findings are
  the expensive half of a review. The file is moved aside instead of deleted and
  the next spawn is told where it is and to rewrite only the block — not to
  review the task again.
- **Re-spawn the reviewer after an interrupt (chosen).** Bounded by the review
  file budget the task already has, so a phase the operator keeps interrupting
  still ends the attempt, and the attempt counter is left alone.

## Consequences

An interrupt now spends the review budget rather than a task attempt. An
operator interrupting a review to force a re-implementation no longer gets one —
that is what stopping the loop is for.

The salvage accepts blocks no YAML parser would. That is deliberate, and it is
one-directional: it only ever recovers a verdict that is already written down.
It never invents one, and a block with no readable verdict is still no report.
