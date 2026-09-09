# Work only a person can do never becomes a task

Nothing kept the task generator from emitting a task no agent could finish. A
task whose acceptance criteria read *"the credential exists in the vault and a
manual curl against the provider returns 200"* is not hard, it is impossible:
the implementation cannot satisfy it, the review is right to reject it every
time, and the retries spend the task's whole spawn allowance to reach the same
verdict.

Measured on a real run: four implementation sessions, three near-identical
review reports, everything an agent could do delivered on attempt 1, and then
`task budget exhausted` — a run-level halt. Six tasks after it never started,
although only one of them depended on the impossible one.

The existing safety net did not fire either. The failure learner classified
the wall as `ENV`, which is the right label for a red build or a down network —
things a retry may legitimately clear — and is not one of the `WALL_KINDS`. So
the budget ceiling was the only stop left, and it is the crudest one available:
it ends the run, not the task.

## Considered options

- **Raise the per-task allowance.** Rejected: nothing is bought with it. The
  fifth session fails exactly like the first four.
- **A `[PROCUREMENT]` / `[MANUAL]` tag the loop skips.** Rejected: a tag that
  makes such a task runnable does not exist. If a task needs the tag, it should
  not have been generated — and a tag the generator applies is a tag the
  generator can forget.
- **Let the reviewer pass it.** Rejected for the reason `spec_conflicts` exists:
  the session that cannot close the criterion is not the one allowed to absolve
  it.
- **Four layers, from generation to halt (chosen).**

## The four layers

**Generation.** The spec-to-tasks skill gained an agent-executability gate next
to its dependency pre-flight and its collision detection: every acceptance
criterion and every Definition of Done item must be satisfiable by an agent —
writing a file, running a command, asserting a test — or the task is not
emitted. The need does not vanish, it leaves the loop's reach: it is recorded in
a `## Preconditions (operator)` section of the tasks document, its
agent-executable residue (an ADR, a matrix row, a document) becomes an ordinary
task, and the tasks that consume it name its resolution in their DoR the way
they name a dependency.

**Load.** `loadTasks` refuses a task file that carries operator-only work,
reported with the other malformed files: the offending line is named and the
run stops before the first agent session, not after four.

**Review.** The report has an `escalation` list, read before every other field:
a finding no implementation pass can close ends *that task* and lets the run
walk on. It is not the same channel as `issues`, which is what the next
implementation is given to work from.

**Failure memory.** `operator_action` joined `BlockerKind` and `WALL_KINDS`,
with its own label in the failure learner's prompt — the label `ENV` was
standing in for. Hitting it twice ends the task before the spawn budget is
reached.

## The run does not halt on it

Every other task failure asks `continue_on_failure` what happens next. An
operator wall answers ahead of the setting: the task needs a person, the tasks
after it do not, and halting the whole run on a missing credential costs every
one of them for nothing. So the funnel routes an operator wall to the
continue-with-the-next-task sink whatever the setting says, and the message says
which of the two halts happened — the operator action that is missing, not a
budget the agent supposedly burned through.
