---
description: "File organization in src/: feature-domain folders, kebab-case file names, one responsibility per file, ~250-line target with subdomain extraction. Applies to all TypeScript source code."
globs: "src/**/*"
priority: 3
---

# Structure: feature domains and kebab-case

## Convention

### Case A — Folder per domain, kebab-case files
- `src/<domain>/<kebab-case-name>.ts`: the domains are `agent`, `authoring`, `config`, `fixplan`, `loop`, `measure`, `prompt`, `tasks`, `tools`, `ui`, `util`.
- A domain that grows is split into a subfolder (e.g. `src/loop/graph/` for the task-graph nodes), not into monolithic files.

### Case B — One responsibility per file, ~250 lines
- Each file has a single responsibility; past ~250 lines extract a module (e.g. `src/loop/engine.ts` delegates to `run-setup.ts`, `run-assembly.ts`, `run-walk.ts`).

### Case C — Explicit entrypoints
- The only extension entrypoint is `src/index.ts` (declared in `package.json` → `pi.extensions`); everything else is imported from there downward.

### When not to apply
- `e2e/` and `test/` follow their own conventions (see the testing rule); `skills/` holds markdown skills, not code.

### Examples

**Case A** (real tree):
```
src/loop/graph/task-nodes-tail.ts
src/loop/graph/task-nodes-failure.ts
src/measure/phase-meter.ts
src/fixplan/fix-plan.ts
```

**Case B** (delegation from `src/loop/engine.ts`, 282 lines, to extracted modules):
```
src/loop/run-setup.ts
src/loop/run-assembly.ts
src/loop/run-walk.ts
```

## Evidence & Confidence
- **Confidence**: High
- **Reference files**: `src/index.ts`, `src/loop/`, `src/measure/`, `src/loop/graph/`, `package.json`
- **Notes**: 89 files, all kebab-case, no camelCase or PascalCase in file names (not even for classes: the class lives in a kebab-case file, e.g. `LoopController` in `src/loop/loop-controller.ts`). No exceptions found.

## Rationale
The bijective domain→folder mapping and the regular naming keep the code navigable without indexes and let tests mirror the structure 1:1 (see the testing rule). The ~250-line ceiling keeps every file readable at a glance and reduces merge conflicts.
