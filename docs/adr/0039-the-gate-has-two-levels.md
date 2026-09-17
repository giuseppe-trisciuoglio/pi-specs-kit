# The gate has two levels: the phase runs the attempt's scope, the checkpoint runs the suite

A spec measured over fifteen tasks spent about two hours inside the
post-implementation hook alone: forty-five runs of a full build with
containerized integration tests, a median of two and a half minutes each and a
worst case of twenty-one. The same command ran on every attempt of every task,
and most attempts are retries. What it verified was almost always the same
thing twice: the modules the attempt had not touched.

A red gate still costs the attempt — that decision does not move (ADR-0014).
What moves is what the gate executes.

## The phase gate is told what the attempt stands on

Two variables reach every hook command, pre and post, of every phase:

- `SPECS_KIT_CHANGED_FILES` — the paths, newline-separated, relative to the
  project root;
- `SPECS_KIT_CHANGED_FILES_PATH` — a file holding the same list, one path per
  line, for a list longer than an environment block can carry.

The list is everything that differs from `HEAD`, read through the same
throwaway git index the worktree fingerprint already uses (`src/loop/workspace.ts`),
minus what the loop itself writes. Not the delta of this single attempt: the
checkpoint commits at every passed task, so `HEAD` is the last task that
passed, and what comes back is the work of the *current task*, across all its
attempts. A module an earlier attempt wrote and this one did not still belongs
to the scope a gate has to cover — a retry that fixes one test must not narrow
the gate to that test.

Both variables are always set, and both are empty when the list cannot be read:
outside a git repository, on a git failure, or when the tree is clean. A hook
that reads an empty list has been told nothing, and the honest default for a
command that knows nothing is the full scope. The paths are stripped of control
characters before they are exported, for the same reason external text is
stripped before it becomes argv (ADR-0035) — and because a newline inside a
path would invent an entry in a newline-separated list.

The post gate reads the list again after the phase: what it gates is the tree
the attempt left behind, not the one it started from.

## The suite belongs to the checkpoint

`hooks.checkpoint.post` runs after the checkpoint of a task that passed its
review — the second level. It is not a phase: no agent runs there, no prompt is
built, and it has no `pre` stage, because there is nothing before a checkpoint
for a hook to precede. A `pre` written anyway is read as absent rather than
configured and never run. A bare command list (`checkpoint: ["mvnw verify"]`)
is accepted as the post stage, since that is the only stage there is.

The changed files are read *before* the commit and handed to the hooks
afterwards: the commit is what folds the task's work into `HEAD`, and a list
taken after it would report that the task changed nothing.

A red checkpoint gate is recorded, not retried: the task passed its review and
its work is committed, so there is no attempt left to spend on it. It takes the
channel every phase without a retry path already uses — `state.postHookGateFailed`,
named once at the range close (ADR-0014). The full suite therefore still runs
at least once per passed task and once per range (`sync.post`), which is what
the phase gate stopped paying for on every attempt.

## What this asks of the project

The two variables are a capability, not a policy: the loop does not know what a
module is in the project's build tool, and does not try to. A Maven project
turns the list into `-pl` and `-Dtest=`; a monorepo turns it into a workspace
filter. The loop's part is to say which files the work stands on, once per
stage, without ever letting a reading failure cost an attempt.
