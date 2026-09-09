/**
 * The refusal a spec's task bundle produces when it cannot be loaded.
 *
 * Loading collects every invalid file instead of stopping at the first, and
 * that list is what the operator has to act on: one entry per thing to fix.
 * Flattening it into a single message loses it, because the channel that
 * shows it renders one line. So the entries travel as a list all the way to
 * the boundary that reports them, and only there are they rendered.
 *
 * Pure module: no imports beyond the standard library, so tests and the
 * reporting boundary can both use it.
 */

/** Task bundle that cannot be loaded, one entry per thing the operator must fix. */
export class TaskValidationError extends Error {
  /** Complete, self-contained messages; an entry may span several lines. */
  public readonly entries: readonly string[];

  constructor(entries: readonly string[]) {
    super(taskValidationLines(entries).join("\n"));
    this.name = "TaskValidationError";
    this.entries = entries;
  }
}

/** The refusal in one line, for a status field or a log that has room for one. */
export function taskValidationSummary(entries: readonly string[]): string {
  return `${entries.length} task file(s) failed validation, run not started`;
}

/**
 * The refusal as lines: a header counting the entries, then one bullet per
 * entry with its continuation lines kept under the bullet. A channel that
 * shows one message at a time emits these one by one; one that renders a
 * block joins them.
 */
export function taskValidationLines(entries: readonly string[]): string[] {
  const lines = [`[specs-kit] ${taskValidationSummary(entries)}:`];
  for (const entry of entries) {
    const [first, ...rest] = entry.split("\n");
    lines.push(`  - ${first}`);
    for (const line of rest) lines.push(`    ${line.trim()}`);
  }
  return lines;
}
