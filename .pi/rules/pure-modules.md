---
description: "Pure-logic vs glue separation in src/: decisions (parsing, bounds, planning) live in pure modules free of pi-runtime imports, glue lives apart. Required so tests never depend on packages provided by pi at runtime."
globs: "src/**/*.ts"
priority: 2
---

# Pure modules, glue kept apart

## Convention

### Case A — Decision logic in a pure module
- When a module must glue into a runtime (extension loaded into the phase subprocess, UI handler, spawner), the decision logic — when to act, where to cut, how to reassemble the result — is extracted into a **pure** module: functions, types and constants only, no imports from `typebox`, the pi SDK, or unnecessary `node:*` modules.
- The module's header doc-comment states the purity and the reason explicitly ("Pure module: ... so both the loop and the tests can import it...").

### Case B — Glue lives in its own file
- The file importing the runtime (extension, view, spawner) is glue only: it calls the pure functions and handles I/O and events. Never inline a decision in the glue.

### Case C — Pure functions kept out of modules importing typebox/SDK
- If a function is needed by a test, it must not live in a module that imports pi-provided packages at runtime: type imports get erased, value imports do not.

### When not to apply
- A module already pure by construction (e.g. `src/util/control-chars.ts`, `src/ui/run-args.ts`) needs no further extraction.
- Types imported with `import type` from the SDK are allowed even in modules consumed by tests.

### Examples

**Case A** (from `src/agent/compaction-plan.ts`):
```ts
/**
 * Decision logic for the context compaction a phase performs on itself: ...
 * Pure on purpose — the extension loaded into the phase subprocess is only
 * the glue around these functions, and the glue cannot be unit-tested
 * without the agent runtime while this can.
 */
export const AUTO_COMPACT_ENV = "SPECS_KIT_AUTO_COMPACT_PERCENT";
```

**Case C** (from `src/ui/run-args.ts`):
```ts
/**
 * Argument parsing for the slash commands. Kept apart from the extension
 * factory so it stays testable without loading the pi runtime modules.
 */
export function parseRunArgs(args: string): RunArgs { /* ... */ }
```

## Evidence & Confidence
- **Confidence**: High
- **Reference files**: `src/agent/compaction-plan.ts`, `src/loop/blockers.ts`, `src/ui/run-args.ts`, `src/agent/autocompact-extension.ts` (glue counterpart), `src/index.ts` (factory glue)
- **Notes**: systematic pattern: every glue module has a pure counterpart with its own tests (`compaction-plan` ↔ `autocompact-extension`, `blockers` ↔ the learner node). No exceptions found.

## Rationale
The project runs on Node 24 with no build step: tests import sources directly, so a single value import from the pi runtime would make a module untestable outside pi. Separating decisions from glue guarantees the hard part (thresholds, cuts, bounds) is always verifiable with `node --test`.
