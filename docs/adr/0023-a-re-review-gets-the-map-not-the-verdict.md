# A re-review gets the map, not the verdict

Measured on a real run: seven tasks, nine review spawns, two rejected verdicts
converted into retries. The review ingress carries no channel about earlier
attempts — the feedback of a rejected verdict goes to the retried
implementation, and the re-review is meant to judge fresh. In both retries the
prompt of the second review was identical to the first's, and what happened
next was identical too: the reviewer noticed inconsistencies in the workspace,
hypothesized a retry, went looking, and found the archived report of the
earlier attempt on its own initiative — several tool calls of archaeology that
nothing in the loop guaranteed. The single most urgent question of a re-review
— was what the previous review blocked actually fixed — was answered by model
quality, not by the loop.

## Considered options

- **Deliver the full previous report.** Rejected: it hands the fresh evaluation
  a conclusion to anchor on, and the reviewer ends up checking the old findings
  and little else.
- **Deliver only the previous issues.** Rejected for the same reason, narrower.
- **Do nothing.** Rejected: the behavior was real but unguaranteed. A reviewer
  that does not reconstruct the retry costs the same spawn and may skip
  verifying the fix the retry existed for.
- **Deliver the archive paths only (chosen).** After the rotation that archives
  the last rejected verdict, the loop lists the archived reports from disk and
  the prompt says: earlier verdicts exist, here is where, this is a fresh
  independent evaluation, and what the retry was asked to fix deserves
  particular verification. Where the verdicts live is a fact the loop measures;
  what they concluded stays undelivered.

## Consequences

The prompt of a re-review differs from the first review's by one block.
Byte-identity of review prompts was the equivalence oracle of the ingress cut,
never a product promise; the golden tests now pin both shapes.

The listing trusts the disk over any counter: an archive a hand removed is not
listed, one a hand added is listed like any other. The pointer is gathered
after the rotation, so the freshest state of the disk is what the reviewer is
told about.
