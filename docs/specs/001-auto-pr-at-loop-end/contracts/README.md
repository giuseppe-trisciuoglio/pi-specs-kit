# Contracts

Interface boundaries extracted from the specification `2026-08-17--auto-pr-at-loop-end.md`.

| Contract | Boundary type | File |
|----------|--------------|------|
| Forge CLI | external CLI subprocess (PR create/view) | [forge-cli.md](./forge-cli.md) |
| Git subprocess | external CLI subprocess (probe/branch/commit/push) | [git-subprocess.md](./git-subprocess.md) |

Implicit boundaries preserved without a standalone contract:

- **Notification channel**: existing `[specs-kit]` info/warning mechanism — delivery outcomes flow through it unchanged.
- **Configuration file**: one new boolean read through the existing tolerant loader; no schema migration.
- **Fix plan**: read-only at delivery time (range summary, outcome); never written by delivery.
