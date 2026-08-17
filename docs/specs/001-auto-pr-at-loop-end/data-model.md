# Data Model: Automatic Pull Request at Loop Completion

**Spec**: [2026-08-17--auto-pr-at-loop-end.md](./2026-08-17--auto-pr-at-loop-end.md)
**Ontology**: [../ontology.md](../ontology.md)
**Generated**: 2026-08-17 (revised after spec v1.1)
**Technical Plan**: [2026-08-17--technical-plan.md](./2026-08-17--technical-plan.md) — AD-006 to AD-009

Fidelity note: entities below come from the specification's Data Requirements. Elements that are implementation choices rather than spec statements are marked `(derived)` and never generate acceptance criteria.

## Entities

| Entity | Purpose | Lifecycle | Constraints | Source |
|--------|---------|-----------|-------------|--------|
| Delivery flag (`git.pull_request`) | Enable/disable automatic delivery | Read from config at run start | Boolean, default **off**; tolerant to absent/malformed values; implies the delivery commit regardless of per-task checkpoint setting | spec (REQ-001/002/003) |
| Base branch (`git.base_branch`) | Target of the delivery pull request | Existing config value, reused across deliveries | Defaults to `main` (REQ-028); the tolerant loader supplies the default when the key is absent | spec (REQ-009, REQ-028) |
| Delivery outcome | Per-step results and PR URL for the operator | Created during delivery; presented in closing notices; never persisted | Ephemeral: lives only in notifications; single attempt per step | spec (REQ-015…019, NR007) |
| Delivery commit | Persist the residual working tree | Created at most once per delivered run | Single commit covering the whole working tree; message identifies the spec; skipped when the tree is clean | spec (REQ-010/011) |
| Spec branch | Head branch when delivery starts from the base branch or a detached state | Derived from spec id; reused across deliveries only when fast-forward reuse is possible | Naming convention `specs/<spec-id>`; reused (local or remote) only when a fast-forward dry-run succeeds; refused-with-warning otherwise; never forced (REQ-024) | spec (REQ-007/008/024, REQ-025) |
| Pull request content (title + body) | Title and description of the delivery PR | Composed at delivery | Title derived from the spec document's first H1 with spec-id fallback (REQ-026); body contains spec id, completed range summary, loop outcome incl. terminal warnings (REQ-013, REQ-027) | spec (REQ-012/013, REQ-026/027) |
| Terminal warnings fed to the body | Same set the run's closing notices report | Captured by the walk at delivery time | Read once, never persisted for delivery; sources: tasks that failed while the run continued, partial sync, failed post-hook gate | spec (REQ-013, REQ-027; AD-008) |
| Delivery ordering invariant | Walk captures the postHookGateFailed field before the closing-notifications clear | Walk writes the field's value into a local; clear happens afterwards | The runner never re-enters delivery between the capture and the clear | plan AD-008; AD-005 persistence rule |

## Relationships

```
Delivery flag (Configurazione) ──gates──▶ Delivery step (Consegna)
Base branch (Configurazione) ─────target─▶ Pull request
Spec branch ◀──derived from── Spec identifier
Fix plan (read-only at delivery) ──range summary + outcome──▶ PR description
Delivery step ──emits──▶ Delivery outcome ──reported via──▶ Notifications
Terminal warnings (walk-local capture) ──input──▶ PR body builder
```

## State Transitions (delivery step)

```
probe repo/branch ─▶ reuse decision (create / fetch+ff-dry-run / refuse) ─▶ delivery commit ─▶ push ─▶ PR create (stdout URL) ─▶ PR view (--json url) fallback
        │                  │                  │             │         │
        └── any step fails: stop, warn (step + reason), keep prior local state,
            run outcome unchanged (completed)
```

- On the base branch or detached state → guarded branch step (AD-007).
- Non-base branch → no branch operation.
- Clean tree → commit skipped, sequence continues.
- Existing open pull request for the branch → report existing URL via the `pr view` fallback; no duplicate.
- Diverged branch → refuse-with-warning; operator resolves manually; no forced update.

## Implementation Shapes `(derived)`

Advisory only — informed by the technical plan, never acceptance criteria:

- `DeliveryOutcome` and step result records aggregating the first failure, the reason, the surviving branch, the PR URL `(derived)`
- Injected executor signature mirroring `spawnProcess` for unit tests `(derived)`
- Pure builder functions for title and body over plain data from the fix plan and the walk's terminal-warning set `(derived)`
- Walk helper that captures the run's terminal warnings before the postHookGateFailed clear and passes them to the delivery step explicitly `(derived)`
