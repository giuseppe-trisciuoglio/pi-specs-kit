# Render the transcript with pi's own UI components

The transcript used to be a tail of formatted strings: every subprocess event was
collapsed to one line, and every event the parser did not recognize was printed
as its raw JSON. Since the agent CLI emits several event types the parser never
handled — tool execution start/update/end, and tool-result messages carrying
whole file contents — what the operator actually saw was mostly JSON.

The parser was written against a stream the agent CLI does not emit. The e2e
suite did not catch it because the fake agent on the PATH reproduces the same
obsolete shape.

The fix is not a better line formatter. The JSON stream is the interactive
session's own event stream, serialized: the wire type is the session event type
passed through, minus one field on streaming updates. The agent CLI exports the
components its interactive mode uses — assistant message, tool execution, skill
invocation — under an explicit "UI components for extensions" entry point. We
consume the same events with the same components, mirroring the interactive
event handler, so the transcript is not merely similar to a session: it is the
same rendering code.

## Considered options

- **Reuse the exported components (chosen).** Markdown, per-tool renderers, edit
  diffs, thinking blocks, expand/collapse and theming all come for free and stay
  correct as the agent CLI evolves them. Cost: the transcript is coupled to an
  interface that is public but internal to the agent CLI's UI, and pinned to the
  version installed alongside the extension.
- Write our own renderer over formatted strings. Rejected: it can approach
  legibility but never parity, and it would mean reimplementing per-tool argument
  summaries and diff rendering that already exist a few modules away.
- Hybrid: their components for tool rows, ours for assistant text. Rejected: two
  rendering styles in one view, and the assistant text is exactly the part where
  markdown rendering matters most.

## Consequences

The wire drops the cumulative message snapshot that the interactive handler
relies on: over the JSON stream, only the initial message, the deltas and the
final message arrive. The transcript therefore rebuilds the assistant message
from the deltas itself. That reconstruction is a pure function, which is what
keeps it unit-testable — the modules that instantiate components import runtime
values from the agent CLI and so cannot be imported from unit tests, per the
project's dependency rule.

The single-line formatter is not removed. The log files and the status widget
still consume one string per event, and unrecognized events keep reaching disk as
whole JSON, which preserves the observability the raw fallback was there for.
Only the transcript stops using it.

Components need a TUI instance, which exists only while the transcript is open.
They cannot be built ahead of time, so the controller buffers events and the
transcript replays them on open. The buffer holds one phase and is cleared when
the phase changes: a phase is one agent session, and an interactive session of
the same size is already something the agent CLI holds in memory.

Unit tests run against a JSONL stream captured from a real run, because the fake
agent is a hand-written approximation of the format and was already stale once.
The fake gains a tool execution round-trip so the pipeline is exercised
end-to-end, but it is not the reference for the format.
