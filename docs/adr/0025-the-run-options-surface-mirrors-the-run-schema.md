# The run-options surface mirrors the run schema

The run configuration has one typed schema (`RunConfig` in the config module) but
three hand-maintained lists that project it: the `RunField` union the writer
accepts, the field list the interactive run-options menu shows, and the keys the
generated default file writes out. They drifted. Two fields were added to the
schema behind a documented decision — the sync context reconciliation and the
spec-artifact guard — yet the menu showed neither, and it was also missing
`verbose`, `continue_on_failure`, `resume` and `review_file_retry`; the default
file omitted the reconciliation flag. An operator editing the menu saw a subset
of what the file could hold, and a fresh project got a default file that did not
describe one knob the loader reads.

## Considered options

- **Curate a "safe" subset in the menu.** Rejected: the menu already describes
  itself as the operator-facing projection of the run scalars, and hiding a
  field there does not disable it — it only makes the menu disagree with the
  file and the defaults, which is the drift that produced the bug.
- **Mirror the schema in all three places (chosen).** Every run scalar modeled
  in `RunConfig` is surfaced in the `RunField` union, in the menu field list, and
  in the generated default file. The menu is the projection of the schema, not a
  hand-picked subset.

## Consequences

Adding a run option is three coordinated edits — the writer union, the menu
field list, and the default file — plus the loader and default that already
carry it. A field that appears in one projection but not the others is now a
defect, not a choice.

The range bounds `from_task` and `to_task` stay out: they are read from the file
as a fallback for range selection, but they are chosen per run by command or
picker, not an operator knob the menu or the default file should own.
