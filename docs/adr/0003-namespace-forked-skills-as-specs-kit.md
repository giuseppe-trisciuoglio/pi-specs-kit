# Namespace the forked skills as specs-kit-* to win on name collisions

The resources_discover spike (see plan.md §11) verified that pi loads the default
skill locations (`~/.pi/agent/skills`, `~/.agents/skills`) **before** the
skillPaths an extension contributes, and resolves name collisions with "first
found wins". A user who already has the devkit `specs-*` skills installed globally
would therefore shadow this extension's bundled fork: the wrong (Claude-Code-shaped,
broken-under-pi) version would win silently. The authoring chain (brainstorm,
spec-to-tasks, …) is hit hardest, because those skills are invoked as
`/skill:<name>` and so go through pi's discovery — unlike the loop phase skills,
which the loop reads directly via `skill-resolver`.

## Considered options

- **Rename the fork to `specs-kit-*` (chosen).** Non-colliding with the global
  `specs-*`; the bundled fork always wins for its own names. Users may keep their
  global `specs-*` installed without interference (the two coexist as distinct
  skills). Cost: the `/skill:` commands and the cross-references inside each skill
  move to the `specs-kit-*` namespace, and the loop's phase-skill map follows.
- Document that this extension supersedes the global `specs-*` and ask users to
  remove them. Rejected: silent shadowing if a user forgets — pi only warns on
  collision and the wrong version still wins.

## Consequences

The forked skills ship as `specs-kit-brainstorm`, `specs-kit-task-implementation`,
… — same body, different name (prefix `specs-` becomes `specs-kit-`). The loop
reads them directly via `skill-resolver`, so the rename is transparent to the phase
prompts beyond updating the `PHASE_SKILL` map. Authoring skills are invoked as
`/skill:specs-kit-*`, and their trigger descriptions and mutual references use the
new namespace.
