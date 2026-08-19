# The learnings file is written by the loop alone

The executor rereads the project learnings file at every spawn and injects it
into the prompts of every role. Measured on a real run: during a retried
implementation the agent appended its own failure note to that file with a
shell redirect, and seconds later the re-review was spawned and received that
note as a prompt line the loop never chose to deliver — failure history
reaching the reviewer laundered as a general lesson. The note also entered
without the warmth bookkeeping the merge path maintains, and it made the
prompts of the two reviews differ depending on whether an agent happened to
write.

## Considered options

- **Accept and document.** Rejected: prompts become nondeterministic between
  attempts of the same task, and the isolation of the re-review is pierced by
  a channel nobody designed.
- **Prompt instruction only.** Rejected as the sole mechanism: it is the same
  class of guarantee already refused for the requirement documents — an
  instruction that can be ignored unobserved buys nothing the loop can check.
- **Mechanical revert plus instruction (chosen).** The implementation node
  captures the file before the spawn and reverts it after when the phase
  changed it, warning the operator; the implementation instructions state that
  learnings are collected by the loop after the task passes review.

## Consequences

A learning an agent wrote mid-task is discarded. The sanctioned channel is the
learner that runs once the task passes review — the path that also assigns
warmth and caps the list.

The guard covers the implementation phase, where the write was observed;
extending it to the other phases is the same three lines if evidence ever
demands it. Best-effort like the rest of the protection machinery: a revert
that itself fails is reported as a change rather than raised.
