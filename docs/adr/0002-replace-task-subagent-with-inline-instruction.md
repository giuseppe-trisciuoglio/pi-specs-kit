# Replace subagent dispatch with inline instructions in the pi skill fork

The devkit skills delegate specialized work to subagents in two forms:
`Task(subagent_type: "developer-kit:…")` blocks in `specs-brainstorm` (codebase
exploration, document generation, spec review), and a per-language
`developer-kit-<lang>:…` exploration-agent table in `specs-spec-to-tasks`. pi is
single-agent: it has no `Task` tool and no subagent dispatch, so that
specialization cannot survive the port. In the pi fork both forms are rewritten as
instructions for the same agent to perform the work inline, in context, with the
same output contract (the original prompts are kept verbatim).

## Consequences

This adaptation is not purely mechanical — the replacement prose must preserve the
original intent — so it was done by hand and committed as part of the canonical
fork under `skills/`. The same hand pass also replaced the host
argument-parsing preambles (shared Python helpers that were never bundled) and
reworded the routing to a sibling skill this extension does not ship. We accept a
real quality drop versus specialized subagents (e.g. `document-generator-expert`):
the single agent now does exploration and generation in one context.
