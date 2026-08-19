# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
