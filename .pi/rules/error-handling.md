---
description: "Domain error handling in src/: <Thing>Error extends Error classes per domain, collect-all validation, one-line-per-item rendering at the notification boundary."
globs: "src/**/*.ts"
priority: 4
---

# Typed domain errors and collect-all validation

## Convention

### Case A — One error class per domain
- Every domain that fails in a recognizable way exports a `<Thing>Error extends Error` class (e.g. `TaskParseError`, `TaskValidationError`, `BudgetExceededError`, `EnvironmentStreakError`). Generic `throw new Error` remains for cases without domain semantics.

### Case B — Collect all, don't stop at the first
- Validation of a composite input (e.g. a task bundle) collects **all** problems into a single error carrying the list of entries, instead of failing on the first one.

### Case C — One line per item at the boundary
- The point that notifies the user splits the entries: one line per problem, never a single blob.

### When not to apply
- Non-domain environmental errors (failed spawn, I/O): handled as failed phase outcomes, not as domain classes.

### Examples

**Case A** (from `src/tasks/task-validation.ts`):
```ts
export class TaskValidationError extends Error {
  /* entries: one item per thing to fix */
}
```

**Case C** (from `src/ui/pickers.ts`):
```ts
for (const line of taskValidationLines(err.entries)) ctx.ui.notify(line, "error");
```

## Evidence & Confidence
- **Confidence**: High
- **Reference files**: `src/tasks/task-validation.ts`, `src/tasks/task-parser.ts`, `src/loop/budget.ts`, `src/loop/phase-failure.ts`
- **Notes**: 4 domain classes vs ~20 generic `throw new Error`: classes are used only where the caller must distinguish the case. No `Result<T, E>` usage: the project prefers throw + typed catch.

## Rationale
Typed classes let callers distinguish "input to fix" from "run condition" without parsing messages; collecting all entries and rendering one line per item respects the notification channel (one line per message) and gives the user the complete list of fixes in one pass.
