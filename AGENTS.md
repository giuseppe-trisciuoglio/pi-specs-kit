# Agent instructions for pi-specs-kit

TypeScript pi extension: runs a spec's task loop by orchestrating `pi` subprocesses. Before changing
anything, read `CONTEXT.md` (glossary and terms to avoid) and the ADR list (`docs/adr/`, ordered by number)
for architecture decisions. The domain glossary is the only canonical guide to the vocabulary.

## Commands

```bash
npm test          # unit + e2e, Node 24 runs TypeScript natively
npm run typecheck # tsc --noEmit
npm run lint      # eslint . (flat config, AST-level; types belong to tsc)
./sync-skills.sh  # re-syncs ./skills/ to ~/.agents/skills (project skills only;
                  # --dry-run for a preview, --pull for the reverse direction)
```

No build step: do not add bundlers or transpilers. npm publishing is driven by GitHub Releases
(`.github/workflows/publish.yml`): when a `vX.Y.Z` release is published, the workflow verifies that the tag
matches the `version` in `package.json`, runs the three gates, and publishes to npm.

## Code constraints

- **Hot reload first.** The factory in `src/index.ts` only registers commands, tools, and events: no
  resources started at load time, config read on first command. Every change must survive `/reload`.
- **One file, one responsibility**, roughly under 250 lines. If a file grows beyond that, extract a module.
- **Runtime dependencies**: only `yaml` and the packages provided by pi (`typebox`, the SDK types). Do not
  add others.
- Modules imported by tests must not depend on packages provided by pi at runtime: type imports get
  erased, value imports do not. If a pure function is needed by a test, keep it out of modules that import
  `typebox` or the SDK (see `src/ui/run-args.ts`).
- **Only `pi` as the agent.** Roles differ solely by model and thinking level; the agent name in the
  configuration is ignored.
- **One loop per session**, whether started from a command or a tool.

## Comments and strings

- Comments explain the why in natural language. No references to specification identifiers, use-case
  codes, numbered analysis sections, analysis phase labels, or project documentation paths.
- Do not mention, in code, comments, tests, logs, README, or package metadata, the project the loop
  semantics derive from: format compatibility is stated in words ("compatible with the existing format").
- User-facing messages (notifications, command output, shown errors) in English, prefixed with
  `[specs-kit]`; comments and identifiers in English.

## State and persistence

`<spec>/_ralph_loop/fix_plan.json` is the single source of truth for the loop. Every state transition
rewrites it atomically (tmp + rename) before proceeding, so a kill at any point leaves a snapshot that can
be restarted with `--resume`. If you add a field, keep reading tolerant of missing fields and do not break
the existing shape of the document.

Measurements (tokens and durations) do not live in the fix plan: the append-only log is
`<specs_dir>/measurements.jsonl` (versioned), fed by the write-ahead buffer
`~/.pi/agent/specs-kit/measurements-wal.jsonl` (`src/measure/` modules). Every measurement I/O is
best-effort: never let the loop fail because of a logging error.

Two channels the loop owns outright. The review prompt of a retry lists where the earlier verdicts
are archived — paths, never findings (decision documented in `docs/adr/0023`). And the project
learnings file is reverted when an implementation writes to it mid-task: the executor rereads it at
every spawn, so an agent append would publish to the phases that follow (decision documented in
`docs/adr/0024`).

A repeated implementation attempt that leaves the tree unchanged is not progress: `src/loop/workspace.ts`
computes the worktree fingerprint (throwaway git index, real staging is never touched) before and after the
phase, and only on retries. Identical fingerprints on a clean attempt close the task before respawning the
review. Best-effort: outside a git repo the fingerprint is `null` and the guard stays inert. Decision
documented in `docs/adr/0015`.

The configuration is not a start-time snapshot: the loop re-reads `specs-kit.yaml` before every phase
(`src/loop/config-reload.ts`), swapping the behavioral values into the one config object every module holds,
so no read site can go stale. The structural anchors (root paths, specs dir, active spec) stay frozen at the
start values; a file that does not parse keeps the last loaded values with a warning, a missing file is a
silent no-op (never a swap to the all-default config). The run ceilings follow the file through
`LoopBudget.reconfigure`; counters and the start timestamp carry over. Decision documented in `docs/adr/0026`.

## External dependencies

- **graphify is the single source of the codebase graph.** The knowledge graph lives in one file,
  `graphify-out/graph.json` (produced by the external graphify skill), read directly by every consumer.
  There is no per-spec projected `knowledge-graph.json`: graph.json is the only graph file. The extension
  never indexes the codebase. graphify is not bundled: it must be installed separately
  (`~/.agents/skills/graphify` or `~/.pi/agent/skills/graphify`); the sync phase refreshes it
  (`/graphify --update`) before consuming it.
- **Runtime check.** `LoopController.start` verifies that graphify is present before starting the loop and,
  if missing, emits a `[specs-kit]` warning (best-effort: the loop proceeds, but features that read the
  graph remain unavailable). The resolver is injectable (`ControllerDeps`).
- **Per-task refresh.** Entering each task re-extracts the code half of the graph with `graphify update`
  (`src/loop/codebase-graph.ts`): no model calls, ~3s. This is needed because sync — the only phase that
  rebuilds it — in fast mode runs once per range, while all phases read it. The doc/paper/image half stays
  with sync. Best-effort and injectable (`TaskNodeDeps.refreshCodebaseGraph`): without a stub, tests would
  depend on the binary. Decision documented in `docs/adr/0017`.
- **Model pre-flight.** `LoopController.start` compares the models configured for the five roles against the
  `pi --list-models` catalog (`src/loop/model-check.ts`): a missing model refuses startup naming roles and
  models; an unobtainable catalog only produces a warning and the loop starts. The lookup function is
  injectable (`ControllerDeps.listModels`). Decision documented in `docs/adr/0013`.
- Decision documented in `docs/adr/0009`.

## Testing

- Unit tests with `node:test` for parsers, fix plan, configuration, prompt builder, state machine, and
  hooks: the engine accepts injectable dependencies (`spawnPhase`, `runHooks`, `commitCheckpoint`), use
  them instead of global mocks.
- The e2e in `e2e/` puts a fake agent on the PATH and verifies the full loop, retry, halt, and resume. If
  you change phase prompt text, update the markers the fake agent and the tests use to recognize the phase.
- Test before UI wiring.
