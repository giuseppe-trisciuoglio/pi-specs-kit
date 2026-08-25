# A labeled issue asks for a run

Starting a run meant being at the keyboard: someone had to type
`/specs-kit-run`, pick a spec, pick a range, pick a phase. The intent, though,
is usually recorded well before that, in a GitHub issue that already says what
should be built and points at the spec that says how. Applying a label to that
issue is the moment the work is declared ready; making the loop start there
removes the transcription step between the decision and the run.

## Considered options

- **A GitHub webhook.** Rejected. A webhook needs an endpoint it can reach, and
  the loop runs on the operator's machine. `gh webhook forward` avoids exposing
  one, but it still requires a long-lived local process, an admin-level webhook
  on the repository and a beta CLI extension — while the binding constraint is
  identical in both designs: the session has to be alive for a run to happen.
  What the webhook actually buys is latency, against three new dependencies.
- **A webhook behind a public endpoint.** Rejected: a tunnel or a hosted
  service, plus a shared secret to keep, to reach a loop that still has to be
  running.
- **Polling the issue list (chosen).** One authenticated `gh issue list` per
  minute, against a budget of five thousand an hour. No endpoint, no tunnel, no
  HTTP server inside the extension, and no permission the operator does not
  already have.

The watcher is started by `/specs-kit-watch`, never at load time: the factory
stays a list of registrations and `/reload` remains safe.

## The label is the interlock

An issue that has been picked up loses the ready label and gains the running
one, so the next poll cannot see it a second time. The ending swaps in the done
or the failed label and comments the outcome. This is what keeps the poll
idempotent — not a list of issue numbers held in memory, which a reload would
forget.

An issue nobody can resolve is the one case where the label is deliberately
left alone: the operator's intent is still on record, and moving the label
would erase it. The watcher instead comments once, remembers the number for the
rest of the session, and moves on to the next issue — a poll every minute must
not become a comment every minute.

## Consequences

`gh` becomes an external dependency of this feature alone. A project without
it, unauthenticated, or without a GitHub remote gets a message and no watcher;
every other command keeps working.

Nothing here is specific to one repository or one layout: `gh` resolves the
repository from the working directory's git remote, and the spec reference is
read against the configured specs root. The labels and the interval live in the
project's own configuration file and follow the same mid-run reload as the rest
of the behavioral values.

The watcher starts a run only when the session is idle, so one loop per session
holds whether the run was asked for by an issue or by a command.
