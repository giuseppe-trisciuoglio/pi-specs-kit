# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A build tool printing binary no longer kills the run.** The output of a
  failed hook is stripped of NUL bytes and the other non-printable control
  characters before it enters the next attempt's prompt, and the prompt is
  sanitized again right before the phase spawns. A spawn that is still refused
  fails the single phase — attempt spent, retry logic in charge — instead of
  aborting the whole loop.

### Changed

- **A refused task bundle is readable.** When a spec's task files fail
  validation, the loop no longer reports one joined blob the notification
  channel truncates: the individual entries travel as a list and are shown one
  line at a time, each naming its file (relative to the spec) and its reason.
  Duplicate ids and operator-only tasks use the same path, and a duplicate id
  no longer hides the files loaded after it. The run itself reports the count.

### Added

- **Failure memory.** A failed implementation attempt now goes through a
  `failure_learner` node that records what stopped it as *blockers* in
  `fix_plan.state.blockers`, per task and classified. The next attempt of the
  same task receives them in its own prompt block, separate from the
  learnings, so it does not re-derive a fact the previous one already
  established. Blockers are bounded like the learnings and pruned when the
  task passes review; a verified fact is offered to the learner as a candidate
  before it goes. The same `spec_contradiction` or `unowned_decision` in two
  consecutive attempts ends the task and names the wall to the operator
  instead of spending the next spawn.

- **A task no agent can finish never reaches the loop.** The spec-to-tasks
  skill gained an agent-executability gate: an acceptance criterion or a DoD
  item that needs an account, a credential, a signature, a purchase or human
  access does not become a task — it goes to a `## Preconditions (operator)`
  section of the tasks document, while its agent-executable residue (an ADR, a
  matrix row) stays an ordinary task. A task file that carries such work anyway
  is refused at load, naming the line, before a single agent session is spent.
  The review report gained an `escalation` list for the case discovered
  mid-review, and the failure learner an `operator_action` blocker kind, which
  is a wall: hitting it twice ends the task before the spawn budget does. Such
  a task ends, the run continues whatever `continue_on_failure` says, and the
  message names the missing operator action instead of an exhausted budget.

- **Escalation model per role.** `agents.<role>_fallback_model` names a
  second model the phase is spawned on, once, when the primary comes back
  refused (quota, auth, unknown model) or silent. One attempt, not a ladder:
  a fallback that fails the same way stops the task with both diagnoses.
  The pre-flight warns about a fallback the CLI catalogue does not know.
- **Spawn-outcome rows in the measurement ledger.** Every agent subprocess
  now leaves one row recording exit code, termination signal, stop reason,
  error message, duration and completed-assistant-message count — the raw
  evidence a post-mortem needs, since phases run sessionless by design.
- **Run-level circuit breaker.** Consecutive environmental phase failures
  (refused or silent, across tasks) halt the whole run with every reason
  accumulated; any delivered phase resets the count. A provider outage
  stops being rediscovered task after task at full spawn price.

### Changed

- **A silent spawn is classified as a failure.** A clean exit with an empty
  stream used to read as "delivered", so the loop retried the review as if
  the reviewer had merely forgotten to write the report; eight blind spawns
  were possible against a provider that never answered. Classification is
  now evidence-based: a termination signal, an error message without an
  error stop reason, or zero completed assistant messages each fail the
  phase on their own. An empty-output review ends the review sub-loop with
  a named reason instead of entering the missing-report retry path.
- **The review-format reminder distinguishes a missing report from an
  unreadable one.** A missing report states plainly that the previous spawn
  created no file and where the file must appear; an unreadable one keeps
  pointing at the preserved copy for repair. The skeleton shown in the
  reminder quotes every value, status literal included.

## [1.0.0] - TBD

### Changed

- Pre-hook output in the phase prompt is now shown only for hooks that
  failed; passing hooks contribute their command and status but not their
  stdout. The output of a passing build or test suite was repeating verbatim
  in every spawn of every phase, so the prompt carried the same green
  context as many times as the loop re-entered the phase. Failed-hook
  output — the bounded context the next spawn needs to act on — is
  preserved unchanged, including the existing 6000/4500 character
  truncation. This is a deliberate change in what the agent reads, pinned
  by dedicated tests rather than hidden inside a cleanup pass.

### Added

- Native TypeScript reimplementation of the spec task loop for
  [pi](https://github.com/earendil-works/pi), orchestrating
  `pi` subprocesses for each phase.
- Phase pipeline **implementation → review → cleanup → learner → sync** with
  configurable retry budgets and spending ceilings (`max_attempts`,
  `max_spawns_per_task`, `max_spawns_per_run`, `max_run_duration`).
- Atomic, kill-safe state persistence in `<spec>/_ralph_loop/fix_plan.json`
  with `--resume` and `--force` semantics.
- Interactive commands (`/specs-kit-run`, `/specs-kit-stop`, `/specs-kit-status`,
  `/specs-kit-refresh`, `/specs-kit-attach`, `/specs-kit-config`,
  `/specs-kit-new`, `/specs-kit-spec`, `/specs-kit-continue`) and matching LLM
  tools.
- Live widget, streaming transcript view, and searchable model/thinking
  configuration editor.
- Authoring chain with persistent active spec, plus a bundled pi-native fork of
  the phase skills exposed through `resources_discover`.
- Best-effort measurement ledger (`measurements.jsonl`) with write-ahead buffer,
  decoupled from the loop state.
- Full unit and end-to-end test suite using `node:test` with a fake agent
  binary on `PATH`.
- Production release scaffolding: MIT `LICENSE`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, ESLint flat config, GitHub Actions for
  CI and npm publishing, and Dependabot configuration.
- Publishable `package.json` metadata (`pi-package` keyword, `files`, npm
  `peerDependencies` for the pi runtime packages, `repository`/`bugs`/`homepage`).

### Changed

- `tsconfig.json` no longer pins machine-specific absolute `paths`; type
  resolution uses `node_modules` via declared dev dependencies so typecheck is
  reproducible on any machine and in CI.

### Fixed

- Corrected the repository URL in `README.md`, `CONTRIBUTING.md`,
  `CHANGELOG.md`, and `package.json`: metadata and install instructions
  pointed at the `pi-rules` repository instead of `pi-specs-kit`.

[Unreleased]: https://github.com/giuseppe-trisciuoglio/pi-specs-kit/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/giuseppe-trisciuoglio/pi-specs-kit/releases/tag/v1.0.0
