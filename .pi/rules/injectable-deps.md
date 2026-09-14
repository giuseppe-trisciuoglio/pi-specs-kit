---
description: "Dependency injection pattern for stateful modules in src/: a <Thing>Deps interface with optional injectable members, stored in a private #deps field resolved in the constructor. Keeps modules testable without global mocks."
globs: "src/**/*.ts"
priority: 2
---

# Injectable dependencies via `<Thing>Deps`

## Convention

### Case A — `Deps` interface with optional members
- Every module with state or side effects exports a `<Thing>Deps` interface where the replaceable dependencies (subprocess spawning, I/O, clock, lookup functions) are **optional properties**; required values stay mandatory.
- Optional members have an internal default: when not injected, the module uses the real implementation.

### Case B — Private `#deps` field, resolved in the constructor
- Dependencies are stored in a private `#deps` field, typed with defaults applied (e.g. `Required<Pick<Deps, ...>> & Deps` when only some fields have defaults).
- The constructor receives the `Deps` and normalizes them once; no dependency reads scattered across method bodies.

### Case C — Injectability in tests
- Tests pass stubs for the injectable dependencies instead of globally mocking `node:` modules or the pi runtime (see the testing rule).

### When not to apply
- **Pure modules** (functions and types only, no side effects) need no `Deps`: see the pure-modules rule.
- The extension factory (`src/index.ts`) starts no resources and reads no config at load time: lazy loading is itself a convention, not something to "fix" with a `Deps`.

### Examples

**Case A+B** (from `src/measure/phase-meter.ts`):
```ts
export interface PhaseMeterDeps {
  /* ... */
}

readonly #deps: Required<Pick<PhaseMeterDeps, "ledgerFile" | "walFile" | "projectRoot">> & PhaseMeterDeps;

constructor(deps: PhaseMeterDeps) { /* ... */ }
```

**Case A** (from `src/loop/engine.ts`):
```ts
export interface EngineDeps {
  config: SpecsKitConfig;
  spawnPhase?: (opts: PhaseSpawnOptions) => Promise<PhaseRunOutcome>;
  /* ... */
}
```

## Evidence & Confidence
- **Confidence**: High
- **Reference files**: `src/loop/engine.ts`, `src/loop/phase-spawn.ts`, `src/measure/phase-meter.ts`, `src/loop/config-reload.ts`, `src/measure/authoring-window.ts`
- **Notes**: observed variant in `src/measure/phase-meter.ts` using `Required<Pick<...>>` for defaulted fields; `src/loop/graph/types.ts` shares `TaskNodeDeps` across several nodes. No counterexamples found.

## Rationale
The engine accepts injectable dependencies precisely so it can be tested with stubs (`spawnPhase`, `runHooks`, `commitCheckpoint`): making the `Deps` interface explicit keeps the boundary between logic and side effects visible in the type system, removes global mocks, and lets each test substitute only what it cares about.
