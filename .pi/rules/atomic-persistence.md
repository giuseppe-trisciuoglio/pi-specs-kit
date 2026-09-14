---
description: "Atomic state persistence on disk in src/: every state-file rewrite goes through tmp + rename, loads are tolerant of missing fields. Protects resumable runs from interruption mid-write."
globs: "src/**/*.ts"
priority: 2
---

# Atomic persistence (tmp + rename)

## Convention

### Case A — Atomic writes
- Every write of a state file (fix plan, config, ledger/WAL) goes through: write to a temporary file in the same directory → `rename` onto the final path. The rename is atomic on the filesystem: a kill at any point leaves either the old file intact or the new one complete, never a truncated file.

### Case B — Tolerant loads
- Readers of state files tolerate missing fields: no strict access to recently introduced fields, never breaking the existing on-disk shape.

### Case C — No measurements in the state file
- Measurements (tokens, durations) never land in the state file: they live in the dedicated append-only log with its own write-ahead buffer.

### When not to apply
- Pure append-only log files (appending needs no atomicity): the convention covers state rewrites.

### Examples

**Case A** (from `src/fixplan/fix-plan.ts`):
```ts
/** Persist the fix plan atomically (tmp file + rename), creating the state
 *  folder when missing. */
await rename(tmp, target);
```

**Case B** (header of `src/fixplan/fix-plan.ts`):
```ts
/** ... loads are tolerant of missing fields, saves are atomic
 *  (tmp file + rename). */
```

## Evidence & Confidence
- **Confidence**: High
- **Reference files**: `src/fixplan/fix-plan.ts`, `src/config/config-writer.ts`, `src/measure/wal.ts`
- **Notes**: the same tmp+rename scheme also backs up files before overwriting (`src/loop/review-runner.ts`). No counterexamples: no direct `writeFile` onto a state file.

## Rationale
The fix plan is the single source of truth for the loop and every state transition rewrites it before proceeding: without atomic writes, a kill mid-write would corrupt the snapshot and make resume impossible. Tolerance to missing fields allows adding fields without invalidating state persisted by earlier runs.
