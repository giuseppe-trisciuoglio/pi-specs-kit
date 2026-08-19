# Contributing to pi-specs-kit

Thanks for your interest in contributing! This guide covers setup, the coding
conventions the project enforces, and the release process.

> **TL;DR** — fork & branch → `npm ci` → `npm run typecheck && npm run lint && npm test`
> → open a pull request against `main`.

## Prerequisites

- **Node.js ≥ 24** (the project runs TypeScript natively; there is no build step).
- **npm** (ships with Node).
- A working [pi](https://github.com/earendil-works/pi) install is
  only needed for manual/exploratory runs; tests use a fake agent binary.

## Getting started

```bash
git clone https://github.com/giuseppe-trisciuoglio/pi-specs-kit.git
cd pi-specs-kit
npm ci
npm run typecheck   # tsc --noEmit (static analysis / types)
npm run lint        # eslint . (style & correctness)
npm test            # node:test (unit + e2e with a fake agent on PATH)
```

There is **no build, no bundler, no transpiler**. pi loads `src/index.ts`
directly via [jiti](https://github.com/unjs/jiti); `tsc` exists only for
type-checking and editor support.

## Architecture in one paragraph

`src/index.ts` is a factory that registers commands, tools and event handlers
and starts **nothing** at load time. Configuration is read lazily on the first
command so `/reload` is always safe. Each loop phase is an ephemeral `pi`
subprocess (the roles differ only by model and thinking level). The single
source of truth for loop state is `<spec>/_ralph_loop/fix_plan.json`, rewritten
atomically (tmp + rename) after every state transition. See [`docs/adr/`](docs/adr/) for the architectural decisions (ordered by
number) and [`CONTEXT.md`](CONTEXT.md) for the glossary of domain terms.

## Coding conventions

These rules exist for a reason; violating them makes review harder and the
codebase more fragile.

### Hot reload first

- The factory in `src/index.ts` registers commands, tools and events **only**.
  Never start background resources (timers, sockets, watchers, processes) from
  the factory. Defer them to `session_start` or the command/tool that needs
  them.
- Configuration is read at the first command, not at load time. Every change
  must survive `/reload`.

### One file, one responsibility

- Keep modules focused and roughly under ~250 lines. When a file grows,
  extract a module.

### Dependencies

- **Runtime dependencies are limited to `yaml` plus the packages pi bundles**
  (`typebox`, `@earendil-works/*`). Do **not** add other runtime dependencies
  without discussing it first.
- Pi runtime packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, `typebox`) belong in `peerDependencies` with a `"*"`
  range and must **not** be bundled — pi provides them. They are also listed as
  `devDependencies` (pinned) so `tsc`/ESLint resolve types in dev and CI.
- Pure functions that tests import must **not** transitively import `typebox` or
  the pi SDK as values (type imports are erased, value imports are not). Keep
  them out of modules that import those packages (see `src/ui/run-args.ts`).

### Comments and strings

- Comments explain the **why** in natural language. No references to spec IDs,
  use-case codes, numbered sections, analysis-phase labels, or project-doc paths.
- Do **not** cite, in code, comments, tests, logs, README, or package metadata,
  the upstream project the loop semantics derive from. Format compatibility is
  expressed in prose ("compatible with the existing format").
- User-facing strings (notifications, command output, errors) are in **English**
  and prefixed with `[specs-kit]`. Identifiers and internal comments are in
  English.

### State and persistence

- `<spec>/_ralph_loop/fix_plan.json` is the only loop state. Every transition
  rewrites it atomically before proceeding. When adding a field, keep reading
  tolerant of absent fields and don't break the existing document shape.
- Measurements (tokens, durations) never live in the fix plan: the append-only
  ledger is `<specs_dir>/measurements.jsonl`, fed by the write-ahead buffer in
  `~/.pi/agent/specs-kit/`. All measurement I/O is best-effort and must never
  fail the loop.

## Tests

- Unit tests (`test/`) cover parsers, fix plan, configuration, prompt builder,
  state machine and hooks. The engine accepts injectable dependencies
  (`spawnPhase`, `runHooks`, `commitCheckpoint`) — use those instead of global
  mocks.
- End-to-end tests (`e2e/`) put a fake agent on `PATH` and exercise the full
  loop including retry, halt and resume. If you change phase prompt text,
  update the markers the fake agent and tests use to recognise phases.
- Write tests **before** wiring UI.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(loop): add per-task spawn ceiling
fix(config): tolerate missing durations field
docs(readme): clarify resume semantics
test(e2e): cover force-reset path
chore(deps): bump yaml
```

Keep the subject line ≤ 72 characters, imperative mood, no trailing period.

## Pull requests

- Branch from `main` and rebase if it has moved.
- One logical change per PR.
- Ensure `npm run typecheck`, `npm run lint` and `npm test` all pass locally.
- Reference any related issue (`Closes #123`).
- Describe **what** changed and **why**; call out breaking changes explicitly.
- If you change phase prompt text, note it so the e2e markers can be updated.

The PR template (`.github/PULL_REQUEST_TEMPLATE.md`) mirrors this checklist.

## Versioning & releases

This project follows [Semantic Versioning](https://semver.org/):

- **MAJOR** — incompatible API/config format changes.
- **MINOR** — backwards-compatible features.
- **PATCH** — backwards-compatible fixes.

The release flow is driven by GitHub Releases (mirrors the `pi-rules`
repository):

1. Update `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit as `chore(release): vX.Y.Z` and push to `main`.
3. Create a GitHub Release from tag `vX.Y.Z`, e.g.
   `gh release create vX.Y.Z --generate-notes`.
4. The `Publish` workflow fires on release publication: it verifies the tag
   matches `package.json`'s `version`, runs the full quality gate
   (typecheck + lint + test), and publishes to npm.

The `version` in `package.json` and the release tag must match exactly — the
workflow fails the run otherwise.

> The npm package is `@giuseppe.trisciuoglio/pi-specs-kit`, hosted in the
> [`giuseppe-trisciuoglio/pi-specs-kit`](https://github.com/giuseppe-trisciuoglio/pi-specs-kit)
> repository.

## Code of conduct

Participation in this project is governed by the
[Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). Please be excellent
to each other.
