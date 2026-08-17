# Contract: Forge CLI (pull request creation/view)

**Boundary**: Consegna context ⇄ GitHub-style forge via its command-line interface
**Spec source**: REQ-014, REQ-021, Integration Requirements table
**Version**: gh ≥ 2.40 assumed; machine channel is `--json` on read commands only
**Reference plan**: [2026-08-17--technical-plan.md](../2026-08-17--technical-plan.md) §AD-006

## Purpose

The delivery step creates a pull request (or reports the existing one) after a completed loop run. Authentication is never handled here: it comes from the operator's existing authenticated CLI session.

## Inputs

| Input | Source | Constraint |
|-------|--------|------------|
| Base branch | configuration (`git.base_branch`, default `main`) | must exist on the forge |
| Head branch | working branch or spec branch (`specs/<spec-id>`) | pushed before PR creation |
| Title | derived from the spec document's first H1; spec identifier is the fallback | non-empty |
| Description | spec id + completed range summary + loop outcome incl. terminal warnings | non-empty; English |

## Operations

### Create pull request

- Command: `pr create --base <cfg> --head <branch> --title … --body …`
- **The CLI does not accept `--json` on `pr create`** — that flag is reserved for read commands. The successful URL is printed to stdout.
- **Success**: exit 0; URL captured from stdout (a line matching `https?://…/pull/\d+`). One forge call. The closing notice carries the URL.
- **Already exists**: non-zero exit whose combined output matches an already-exists signature (locale-tolerant: the signature is matched after ANSI stripping and case normalization on the failure code, not on free text). The fallback runs `gh pr view <head> --json url` and reports the existing URL.
- **Any other failure** (CLI missing/unauthenticated, base branch missing on remote, no commits between head and base, network, push rejected earlier): non-zero exit not matching the signature → warning naming the step and reason; loop result unchanged; local commits retained.

### View existing pull request

- Command: `pr view <head> --json url`
- **Success**: exit 0; URL extracted from JSON.
- **Failure**: warning naming the step; delivery ends; commits stay local on the named branch.

## Parser test contract

To keep the happy-path acquisition stable across gh versions, the parser test asserts:

- a stdout line that looks like a pull-request URL (`https?://` host, path ending in `/pull/<n>`) is captured as the PR URL.
- non-URL stdout (unusual configurations, custom forks) does not cause a hard failure; the test pins the regex to the documented shape used in gh 2.x.

A change to gh's stdout shape that breaks the parser makes the test fail closed; the system then surfaces a delivery warning rather than producing a phantom URL.

## Error cases (from spec Error Scenarios)

| Condition | Reported as |
|-----------|-------------|
| CLI not installed / not authenticated | delivery warning: pull request creation failed + reason |
| Base branch missing on forge | delivery warning naming the base branch |
| Completed run with no new commits between head and base | delivery warning: no commits between branch and base |
| Create fails for other reasons | delivery warning: step + reason; single attempt, no retry |
| Already exists | existing URL reported as a notice; no duplicate created |

## Invariants

- Machine channel is `--json url` for read commands (`pr view`); the create command is invoked without `--json` and the URL is captured from stdout.
- Single attempt per operation; no automatic retry.
- No credentials stored; no tokens requested; operator session only.
- Outcome never persisted in loop state — notifications only.
