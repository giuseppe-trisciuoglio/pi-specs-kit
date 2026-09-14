# A specification is as wide as its plan says

A specification that passes the 15-task limit could still plan a change surface
wide enough to make the resulting pull request unreviewable. The task count
bounds how much work the loop does; it says nothing about how many files that
work touches. Fifteen tasks that each rewrite four modules is a diff no reviewer
reads in one pass, whatever the task breakdown looked like.

`spec-to-tasks` already had the shape of the control — `### Task Count Limit`,
checked in Phase 4 step 8, with a stop, a message and a two-option question. It
was missing for the file surface.

## The ceiling

**40 distinct created or modified files, documentation excluded**, enforced at
task-generation time, next to the task count and in the same step. What is
counted is the union of the paths the tasks declare as created or modified: a
path created by one task and modified by another is one file, not two, because
the reviewer opens it once.

A spec can breach either limit or both, and the message names which.

## Why the plan and not the diff

The rejected alternative was a runtime guard in the loop: diff the worktree
against `git.baseBranch` and halt above the ceiling. It measures reality instead
of a plan, which is its whole appeal — and its defect. It only trips once the
files have been written, when splitting the specification means throwing work
away. The plan is the one moment where the split is still cheap, and it is the
moment the author is present.

The plan can lie, of course: an implementation may touch files no task declared.
That is drift, and drift is what the sync phase exists for. It is not what a
ceiling is for.

## Why documentation is excluded

`docs/**`, `README.md` and `CHANGELOG.md` do not count. Documentation grows with
the feature and is read differently — a reviewer skims an ADR, they do not audit
it for behaviour. Counting it would push authors to write less of it to stay
under the ceiling, which is exactly backwards.

Everything else counts, tests included: a specification is not made narrower by
being well tested, and a test file is a file someone has to read.

## Why 40 lives in the skill text

Like the 15, it is a constant in `skills/specs-kit-spec-to-tasks/SKILL.md` and
not a key in `specs-kit.yaml`. The skills are installed for agents that never
read the extension's settings file — an authoring agent running the chain
outside the loop would silently get a different ceiling, or none. A limit that
is only sometimes enforced is not a limit.

Breaching it is allowed: the author can answer "Continue anyway", and the
Phase 7 summary records that they did. The ceiling exists to make the choice
explicit, not to take it.

## Upstream

`specs-kit-brainstorm` names both limits where its LARGE-scope classification
already warned about the task count, so the split is proposed before any task
exists. `specs-kit-adversarial-review` gives the panel the change surface as an
explicit line of attack: the reviewer counts the planned files and says whether
the specification splits along a seam it already names.
