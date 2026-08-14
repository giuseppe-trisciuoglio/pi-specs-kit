# Ship a pi-native fork of the devkit skills inside this repo

The loop depends on the `specs-*` skills (four phase skills are already injected
into the phase prompts; creating a spec needs `specs-brainstorm`). Those skills
are shaped for Claude Code (`Task` subagents, `TodoWrite`, `AskUserQuestion`,
`${CLAUDE_PLUGIN_ROOT}`, capitalized tool names) and do not run under pi — so the
existing phase-skill injection is already broken under pi, not only the new
"create" flow. We fork the eight in-scope `specs-*` skills into this repo, adapt them to pi,
and expose them through pi's `resources_discover` event so a single install gives
the whole authoring-plus-execution chain. (The two skills for changes to existing
systems and post-generation task splitting are out of scope for this extension.)

## Considered options

- **Fork the full family (chosen).** Self-contained; fixes the latent phase-skill
  breakage; create and run both work under pi. Cost: porting and maintenance.
- Leave authoring to the user's existing skill harness and bundle nothing. Rejected:
  "create a spec" would not live in this extension, and the loop's own phase skills
  would stay broken under pi.
- Bundle the skills verbatim and supply the missing tools via a companion extension.
  Rejected: would require reimplementing `Task` subagent dispatch, the hardest and
  most fragile part.

## Consequences

The fork is a one-time adaptation committed as canonical content under
`skills/` — there is no upstream snapshot or transform script to re-run. The
adaptation applied, for the record:

- namespace: every skill moves to the `specs-kit-*` family (ADR-0003);
- host glue removed: `allowed-tools`/`model:` frontmatter, `${CLAUDE_PLUGIN_ROOT}`,
  the `$ARGUMENTS` variable, `AskUserQuestion`→`ask_user_question`,
  `TodoWrite`→"a checklist", and the `/developer-kit-specs:specs.X` / `devkit.X`
  command cross-references rewritten to `/skill:specs-kit-X`;
- subagent dispatch inlined (ADR-0002): `Task(…)` blocks and the per-language
  exploration-agent table become direct instructions;
- the shared argument-parsing Python helpers were never bundled (absent from a loose
  install); their preambles became short "Inputs" notes;
- routing to `change-spec` (not shipped) reworded to "out of scope";
- each skill carries only the templates it references.
