---
description: "User-facing messages in src/: English, prefixed with [specs-kit], emitted through ctx.ui.notify with type info/warning/error. One notification channel, one line per item."
globs: "src/**/*.ts"
priority: 4
---

# User messages: prefix and single channel

## Convention

### Case A — Prefix and language
- Every message shown to the user (notifications, command output, shown errors) is in English and prefixed with `[specs-kit]`.
- Comments and identifiers are English too; no other language in messages.

### Case B — Single typed channel
- Messages go through `ctx.ui.notify(message, type)` with type `"info" | "warning" | "error"`; no `console.log` as a user-facing channel.
- The `onNotify` callback in `Deps` interfaces follows the same signature, so non-UI modules can notify without depending on the UI context.

### Case C — One line per item
- Errors with multiple items (e.g. validation) emit one line per item, never a single concatenated blob.

### When not to apply
- File logs (not shown in the UI flow) and subprocess output: those are not user-facing messages.

### Examples

**Case A** (from `src/ui/panel-view.ts`):
```ts
ctx.ui.notify(`[specs-kit] Config write failed: ${err instanceof Error ? err.message : String(err)}`, "error");
```

**Case C** (from `src/ui/pickers.ts`):
```ts
for (const line of taskValidationLines(err.entries)) ctx.ui.notify(line, "error");
```

## Evidence & Confidence
- **Confidence**: High
- **Reference files**: `src/ui/report.ts`, `src/ui/pickers.ts`, `src/ui/panel-view.ts`, `src/index.ts`
- **Notes**: 64 occurrences of the `[specs-kit]` prefix in `src/`. Notification is gated on `ctx?.hasUI` when the command context may lack a UI. No user-facing `console.log` usage found.

## Rationale
The prefix makes the extension's messages recognizable in any transcript, distinct from runtime or other packages' output; the single typed channel lets the UI treat info, warning and error differently, and the one-line-per-item rule keeps multi-item validation errors readable.
