---
description: "Testing conventions in test/: one file per src/ module, node:test + assert/strict, injected dependencies instead of global mocks, e2e with a fake agent on the PATH in e2e/."
globs: "test/**/*.test.ts"
priority: 3
---

# Tests: mirror of src/, node:test, no global mocks

## Convention

### Case A — One test file per module
- Every `src/` module has its own `test/<module>.test.ts` with the same base name (e.g. `src/util/control-chars.ts` → `test/control-chars.test.ts`). No tested src/ module without a dedicated file.

### Case B — `node:test` + `assert/strict`, direct source import
- `import test from "node:test"` and `import assert from "node:assert/strict"`; the module under test is imported directly from `../src/...ts` (Node 24 runs TypeScript natively, no transpilation).

### Case C — Injected dependencies, not global mocks
- Tests substitute dependencies through the `Deps` interfaces (see the injectable-deps rule); no global patching of `node:` modules or the pi runtime.

### Case D — e2e with a fake agent
- The end-to-end flow (full loop, retry, halt, resume) uses a fake agent placed on the PATH (`e2e/fake-bin/`), which recognizes phases from markers in the prompt: if phase prompt text changes, the markers must be updated.

### When not to apply
- UI tests requiring the pi runtime are limited to the parts testable without it: what is not testable gets extracted into a pure module (see the pure-modules rule).

### Examples

**Case B** (from `test/control-chars.test.ts`):
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { stripControlChars } from "../src/util/control-chars.ts";

test("stripControlChars removes NUL bytes", () => {
  assert.equal(stripControlChars("Tests run: 3\0\0\0 failures"), "Tests run: 3 failures");
});
```

**Case C** (injectable surface in `src/loop/engine.ts`, used by tests):
```ts
export interface EngineDeps {
  spawnPhase?: (opts: PhaseSpawnOptions) => Promise<PhaseRunOutcome>;
  /* ... */
}
```

## Evidence & Confidence
- **Confidence**: High
- **Reference files**: `test/control-chars.test.ts`, `test/fix-plan.test.ts`, `test/state-machine.test.ts`, `e2e/loop.e2e.test.ts`, `e2e/fake-bin/`
- **Notes**: 61 test files in `test/` mirroring the `src/` modules. Command is `node --test` (`package.json`). Shared fixtures live in `test/fixtures/`.

## Rationale
The 1:1 test↔module mirror makes coverage and placement obvious; `node --test` with no build step keeps CI fast; injected dependencies remove global-mock fragility and force the design to stay testable.
