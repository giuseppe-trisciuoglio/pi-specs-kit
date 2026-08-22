/**
 * The review report a review phase must leave behind: where it lives, how it
 * is parsed and how a rejection is turned into feedback for the next
 * implementation attempt. Parsing is strict about the verdict and forgiving
 * about everything else — a report without a usable status is "no report",
 * which the loop already knows how to retry.
 *
 * Forgiving now extends to the shape of the block itself: a heading written
 * above it, or a value carrying an unquoted colon, used to cost a full
 * re-spawn of the phase to recover a verdict that was already on disk. The
 * strict read is tried first and the salvage only runs when it fails, so a
 * well-formed report is parsed exactly as before.
 *
 * A review may also carry routed suggestions: optional fixes a reviewer defers
 * to a later task rather than to the current one. They ride in the same
 * frontmatter so the loop can feed them to that later task's prompt without
 * the agent having to dig through earlier reviews by hand.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { recoverFrontmatter } from "./review-report-recovery.ts";

/** A fix a reviewer wants a later task to own, not the one just reviewed. */
export interface RoutedSuggestion {
  /** Target task id the deferred fix belongs to. */
  to: string;
  /** One-line description of the deferred fix. */
  text: string;
  /**
   * Source task id (the review that routed it), tagged in by the collector so
   * a prompt can attribute the handoff. Absent on suggestions parsed straight
   * from a single report.
   */
  from?: string;
}

export interface ReviewReport {
  status: "PASSED" | "FAILED";
  summary: string;
  issues: string[];
  /** Fixes the reviewer routed to later tasks; empty when there are none. */
  routed: RoutedSuggestion[];
  /**
   * Requirements the reviewer found contradicted by the implementation. The
   * loop, not the reviewer, decides what they cost: a verdict cannot pass over
   * a contradiction it reported itself.
   */
  specConflicts: string[];
  /** Markdown body after the frontmatter. */
  body: string;
  /** True when the verdict was salvaged from a block that is not valid YAML. */
  recovered: boolean;
}

/** Path of the review report the review phase is expected to write. */
export function reviewFilePath(specDir: string, taskId: string): string {
  return path.join(specDir, "tasks", `${taskId}--review.md`);
}

/**
 * Path of an archived earlier verdict. Every attempt before the current one is
 * preserved under this name so a retried review never silently overwrites the
 * reasoning of the verdict it replaced.
 */
export function reviewAttemptArchivePath(specDir: string, taskId: string, attempt: number): string {
  return path.join(specDir, "tasks", `${taskId}--review.attempt-${attempt}.md`);
}

/** Numeric order of an archive name within its task, unreadable names last. */
function archiveAttemptOf(name: string, prefix: string): number {
  const n = Number.parseInt(name.slice(prefix.length, name.length - ".md".length), 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Archived reports of a task's earlier attempts, oldest first, relative to
 * the spec folder. The listing trusts the disk over any counter: an archive
 * a hand removed is simply not there, and one a hand added is listed like
 * any other.
 */
export async function listReviewAttemptArchives(specDir: string, taskId: string): Promise<string[]> {
  const dir = path.join(specDir, "tasks");
  const prefix = `${taskId}--review.attempt-`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".md"))
    .sort((a, b) => archiveAttemptOf(a, prefix) - archiveAttemptOf(b, prefix))
    .map((name) => path.join("tasks", name));
}

/** Render an untrusted value without leaking '[object Object]' into reports. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Coerce a raw frontmatter `issues` value into a list, tolerating junk. */
function issueList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText);
  if (value === null || value === undefined || value === "") return [];
  return [asText(value)];
}

/** Coerce a raw frontmatter `routed` value into a typed list, tolerating junk. */
function parseRouted(value: unknown): RoutedSuggestion[] {
  if (!Array.isArray(value)) return [];
  const result: RoutedSuggestion[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const to = asText(raw.to ?? "").trim();
    const text = asText(raw.text ?? "").trim();
    if (to !== "" && text !== "") result.push({ to, text });
  }
  return result;
}

/** Coerce a raw frontmatter list of strings, tolerating a bare scalar. */
function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter((item) => item !== "");
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return [];
}

/**
 * What to tell a reviewer whose previous report could not be used. The skill
 * carries a much longer report template, so the reminder repeats the one part
 * the loop actually parses and shows it verbatim rather than describing it.
 *
 * The quoting rule is spelled out because it is what actually breaks: the
 * values reviewers write are prose, and prose contains colons. Two very
 * different failures share this reminder, and the message says which one
 * happened: an unreadable report is still on disk (its path is named) and
 * only the block has to be rewritten, while a missing one means the previous
 * spawn created no file at all, so the whole review has to be produced and
 * written to the named path.
 */
export function reviewFormatReminder(
  taskId: string,
  opts: { preservedPath?: string; missing?: boolean } = {},
): string {
  let lines: string[];
  if (opts.preservedPath) {
    lines = [
      `The previous review of ${taskId} wrote a report the loop could not read:`,
      `the file did not start with a usable YAML frontmatter block. The report`,
      `is preserved at ${opts.preservedPath}. Do not review the task again:`,
      "read that file, keep its findings and its verdict exactly as they are,",
      "and write it back to the report path with a frontmatter block in the",
      "shape below.",
    ];
  } else if (opts.missing) {
    lines = [
      `The previous review of ${taskId} produced no file at all:`,
      `tasks/${taskId}--review.md does not exist. Produce the review now and`,
      "write the report to that exact path (relative to the spec folder),",
      "starting with exactly these lines and nothing before them:",
    ];
  } else {
    lines = [
      `The previous review of ${taskId} left no readable verdict: the file`,
      `tasks/${taskId}--review.md was missing, or it did not start with a YAML`,
      "frontmatter block holding review_status. Write it again, starting with",
      "exactly these lines and nothing before them:",
    ];
  }
  lines.push(
    "",
    "---",
    'review_status: "PASSED"',
    'summary: "one line on the outcome"',
    "issues: []",
    "spec_conflicts: []",
    "routed: []",
    "---",
    "",
    'review_status must be "PASSED" or "FAILED", nothing else. Any report body',
    "you want to write goes after the closing ---.",
    "",
    "Quote every value with double quotes: a summary, an issue or a routed fix",
    "that contains a colon followed by a space is what made the previous block",
    "unreadable.",
  );
  return lines.join("\n");
}

/**
 * Isolate the frontmatter block and the body. The block normally opens the
 * file; a short preamble above it (a heading, a sentence of narration) is
 * tolerated rather than treated as a missing report.
 */
function splitFrontmatter(content: string): { block: string; body: string } | null {
  const strict = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (strict) return { block: strict[1], body: strict[2] };
  const opening = /(?:^|\r?\n)---\r?\n/.exec(content);
  if (!opening) return null;
  // A block that starts pages into the file is not a preamble, it is prose
  // that happens to contain a rule: only the head of the document is scanned.
  const preamble = content.slice(0, opening.index);
  if (preamble.split("\n").length > 20) return null;
  const rest = content.slice(opening.index + opening[0].length);
  const closing = /(?:^|\r?\n)---(?:\r?\n|$)/.exec(rest);
  if (!closing) return null;
  return { block: rest.slice(0, closing.index), body: rest.slice(closing.index + closing[0].length) };
}

/** Parse a review report; null when frontmatter or verdict are missing/invalid. */
export function parseReviewReport(content: string): ReviewReport | null {
  const split = splitFrontmatter(content);
  if (!split) return null;
  const body = split.body.trim();

  let data: unknown;
  try {
    data = YAML.parse(split.block);
  } catch {
    data = null;
  }
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const fm = data as Record<string, unknown>;
    const status = asText(fm.review_status ?? "").trim().toUpperCase();
    if (status === "PASSED" || status === "FAILED") {
      const issues = issueList(fm.issues);
      return {
        status,
        summary: typeof fm.summary === "string" ? fm.summary : "",
        issues,
        routed: parseRouted(fm.routed),
        specConflicts: parseStringList(fm.spec_conflicts),
        body,
        recovered: false,
      };
    }
  }

  const salvaged = recoverFrontmatter(split.block);
  if (!salvaged) return null;
  return {
    status: salvaged.status,
    summary: salvaged.summary,
    issues: salvaged.issues,
    routed: salvaged.routed.map((entry) => ({ to: entry.to, text: entry.text })),
    specConflicts: salvaged.specConflicts,
    body,
    recovered: true,
  };
}

/** Read and parse the review report of a task; null when missing or invalid. */
export async function readReviewReport(specDir: string, taskId: string): Promise<ReviewReport | null> {
  try {
    return parseReviewReport(await readFile(reviewFilePath(specDir, taskId), "utf8"));
  } catch {
    return null;
  }
}

/** Routed suggestions aimed at a target task id, gathered from one report. */
export function routedFor(report: ReviewReport, targetTaskId: string): RoutedSuggestion[] {
  return report.routed.filter((r) => r.to === targetTaskId);
}

/** Feedback handed back to the implementation phase after a rejected review. */
export function reviewFeedback(report: ReviewReport): string {
  const parts: string[] = [];
  if (report.summary) parts.push(`Summary: ${report.summary}`);
  if (report.issues.length > 0) {
    const bullets = report.issues.map((issue) => `- ${issue}`).join("\n");
    parts.push(`Issues:\n${bullets}`);
  }
  if (report.specConflicts.length > 0) {
    parts.push(
      "Requirements the review found contradicted by the implementation. Change the code to " +
        "honour them, or stop and report that the requirement itself has to change — never " +
        "reword the requirement or the contract to match the code:\n" +
        report.specConflicts.map((conflict) => `- ${conflict}`).join("\n"),
    );
  }
  if (parts.length === 0 && report.body) parts.push(report.body);
  return parts.join("\n\n");
}
