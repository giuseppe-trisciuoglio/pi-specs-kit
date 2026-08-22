/**
 * The single definition of "this file is a task". Discovery, the authoring
 * state machine and the loader all used to answer that question differently,
 * so a spec could be advertised as runnable while the loader found nothing
 * (or choked on a stray markdown file). They now share this predicate.
 */

/** Suffix of per-task review reports, which are not tasks themselves. */
export const REVIEW_FILE_SUFFIX = "--review.md";

/**
 * Marker shared by the canonical review report and its per-attempt archives:
 * a review report and every archived earlier verdict are kept out of the
 * task set so the loader never tries to parse them as tasks.
 */
export const REVIEW_MARKER = "--review";

/** True for a `tasks/` entry the loader will parse as a task. */
export function isTaskFileName(name: string): boolean {
  if (name.includes(REVIEW_MARKER)) return false;
  const lower = name.toLowerCase();
  return /^task-\d+/.test(lower) && lower.endsWith(".md");
}
