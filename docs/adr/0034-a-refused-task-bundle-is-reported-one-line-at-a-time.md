# A refused task bundle is reported one line at a time

Loading a spec's tasks collects every invalid file instead of stopping at the
first one — that part was right and stays. What it did with the collection was
not: `loadTasks` joined the messages with newlines into a single `Error`,
`prepareRun` let it propagate, and the loop's start handler passed the blob to
one `notify` call. The channel that shows it renders one line, so an operator
whose bundle had three problems got one truncated line and no way from the
notification to *which file, which field, what is wrong* — the information the
individual messages already carried, lost between the loader and the screen.

## The shape

A list survives as a list. `TaskValidationError` (`src/tasks/task-validation.ts`,
pure) carries `entries`: one complete, self-contained message per thing the
operator has to fix. The rendering lives with it, in `taskValidationLines` — a
header counting the entries, then one bullet per entry with an entry's own
continuation lines indented under it — so every reporting boundary shows the
same block, and a boundary that emits one message at a time (the loop's start
handler, the range picker) emits these lines one by one.

The duplicate-id refusal, which used to throw on the spot, joins the same list.
Two files declaring the same id are still a refusal; they are simply no longer a
reason to hide the invalid file that comes after them in the directory. The
operator-only refusal was already in the list and needed no change beyond the
shared rendering.

File paths in an entry are relative to the spec (`tasks/TASK-004.md`): the
absolute path of a temp-rooted spec is most of a notification line and none of
the answer.

## What a run reports when it did not start

`LoopEngine.start` keeps only the count for the run's `error` field —
`3 task file(s) failed validation, run not started` — since that field appears
where a single line fits, and the detail has already gone out as its own
notifications. The other refusals `prepareRun` raises by design (`no task files
under ...`, `the task range ... selects no task`) are single-line and reach the
operator intact through the existing path; they were left alone.
