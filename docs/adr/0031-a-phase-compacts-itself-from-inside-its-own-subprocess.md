# A phase compacts itself from inside its own subprocess

A phase is one prompt driven through a long tool loop: every tool result stays
in the request until the phase ends, so the last turns of a long task are the
most expensive and the least focused ones, and a phase can die of context
overflow after an hour of wall clock. The run should be able to ask for a phase
to summarize itself once it has grown past a share of the model window.

The agent CLI already compacts automatically, but it triggers at
`context tokens > window - reserve tokens`, which is the edge of overflow, and
the reserve is read from the CLI settings file — there is no flag, no
environment variable and no extension call that moves it for one spawn. Nor can
the loop write that file: the global one is the operator's, and the project one
belongs to the repository under test.

## Considered options

- **Ask the CLI to compact from inside the phase.** Rejected: the manual
  compaction entry point aborts the running agent before summarizing. For an
  unattended phase that means losing the task instead of shortening it.
- **Write the reserve into the CLI settings file before the run and restore it
  after.** Rejected: it mutates a file the loop does not own, and a run killed
  at the wrong moment leaves the operator's setting rewritten.
- **Rewrite the request on its way out (chosen).** The loop loads a small
  extension into the phase subprocess and passes it the threshold through the
  environment. The extension answers the context event: below the threshold it
  returns nothing, above it summarizes everything before a cut point with one
  request on the phase model and returns the phase prompt, that summary, and the
  recent turns kept whole.

## Consequences

The compaction is the loop's own, not the CLI's: nothing is written to the
session, so the compaction in force is reapplied to every later request, and a
second compaction merges the earlier summary rather than restating it.

The cut always lands on an assistant message. A tool result whose call had been
summarized away would be dangling, and this is the one rule that keeps the
rewritten request well-formed for every provider.

It costs one extra request per compaction, on the phase model, which is why the
option is off by default and the threshold is an operator knob rather than a
constant. The threshold is held between 10% and 90%: below the floor a phase
would spend its budget summarizing itself, above the ceiling the CLI's own
overflow handling gets there first and the option means nothing.

Everything is best effort. No model, no context window, no cut point worth
making, a summarizer that fails or returns nothing: the phase runs on its full
context and says so on its log. A phase never fails because compaction did.
