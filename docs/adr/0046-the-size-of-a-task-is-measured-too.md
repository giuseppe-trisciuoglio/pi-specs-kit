# The size of a task is measured too, and its price returns to its author

Amends `0038`.

The ceilings of `0038` measure a specification as a whole — how many tasks, how
wide a file surface. They do not look at the size of a single task, and nothing
told the task author that a task was hard to land. The measured runs say the
single task is where the retries come from: across the getokens specifications
011–015, the tasks that passed review at the first attempt declare a median of
5 files, the tasks that needed three or more attempts a median of 8, and no
task declaring more than 8 files passed at the first attempt. A task that asks
for six attempts is almost always ambiguous or too large, and both defects were
born at authoring time.

## Two changes, both at the authoring boundary

**A per-task ceiling in `spec-to-tasks`.** Phase 4 step 8, next to the
spec-level ceilings, checks each planned task before its file is written: more
than **8 declared files** or more than **6 acceptance criteria** triggers a
split proposal with the same shape as the spec-level one — a proposed split, a
two-option question, and a "continued anyway" warning recorded in the Phase 7
summary. The file count is the strong signal in the data; the criteria count
does not separate first-time passes from retries (median 4 in both groups) and
is kept at 6 as a guard against ambiguity, not against size. Both numbers live
in the skill text and nowhere else, for the same reason as the spec-level ones
in `0038`: the skills are installed for agents that never read
`specs-kit.yaml`.

**The price of a task returns to the author.** When a task passes review after
more than one attempt, the learner receives among its candidates a one-line
summary — how many attempts the task needed and what stopped the failed ones,
read from the blocker memory of the run. It is a candidate, not a write: the
learner stays the only sanctioned writer of the project learnings, and it
decides whether the cost of this task is a lesson. What reaches
`learnings.md` is then read by `spec-to-tasks` at decomposition time, closing
the loop from the run back to whoever writes the next tasks.

## What was rejected

**A hard rejection of oversized tasks**, like the 15-task limit. Rejected: the
per-task numbers come from four runs of one project and the criteria signal is
weak, so the ceiling proposes a split and lets the author overrule it. If the
data harden, making it a rejection is a one-line change in the skill text.

**Writing the attempt cost straight into the project learnings.** Rejected for
the reason the fact candidates were rejected in `0030`: the learner is the one
that can tell "this task was too large" (a lesson for the author) from "this
task hit a broken provider twice" (noise). The summary therefore travels with
the facts, inside the same candidate list, and the learner decides.

**A code-enforced ceiling.** Rejected: the check lives where the plan is
written, and the plan is written by an agent following the skill, not by the
extension. This is the same placement decision as `0038`, which this document
amends.
