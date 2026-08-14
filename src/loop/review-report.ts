/**
 * The review report a review phase must leave behind: where it lives, how it
 * is parsed and how a rejection is turned into feedback for the next
 * implementation attempt. Parsing is strict about the verdict and forgiving
 * about everything else — a report without a usable status is "no report",
 * which the loop already knows how to retry.
 *
 * A review may also carry routed suggestions: optional fixes a reviewer defers
 * to a later task rather than to the current one. They ride in the same
 * frontmatter so the loop can feed them to that later task's prompt without
 * the agent having to dig through earlier reviews by hand.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

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
  /** Markdown body after the frontmatter. */
  body: string;
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

/** Coerce a raw frontmatter `routed` value into a typed list, tolerating junk. */
function parseRouted(value: unknown): RoutedSuggestion[] {
  if (!Array.isArray(value)) return [];
  const result: RoutedSuggestion[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const to = String((entry as Record<string, unknown>).to ?? "").trim();
    const text = String((entry as Record<string, unknown>).text ?? "").trim();
    if (to !== "" && text !== "") result.push({ to, text });
  }
  return result;
}

/**
 * What to tell a reviewer whose previous report could not be read. The skill
 * carries a much longer report template, so the reminder repeats the one part
 * the loop actually parses and shows it verbatim rather than describing it.
 */
export function reviewFormatReminder(taskId: string): string {
  return [
    `The previous review of ${taskId} left no readable verdict: the file`,
    `tasks/${taskId}--review.md was missing, or it did not start with a YAML`,
    "frontmatter block holding review_status. Write it again, starting with",
    "exactly these lines and nothing before them:",
    "",
    "---",
    "review_status: PASSED",
    "summary: one line on the outcome",
    "issues: []",
    "---",
    "",
    "review_status must be PASSED or FAILED, nothing else. Any report body you",
    "want to write goes after the closing ---.",
  ].join("\n");
}

/** Parse a review report; null when frontmatter or verdict are missing/invalid. */
export function parseReviewReport(content: string): ReviewReport | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) return null;
  let data: unknown;
  try {
    data = YAML.parse(match[1]);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const fm = data as Record<string, unknown>;
  const status = String(fm.review_status ?? "").trim().toUpperCase();
  if (status !== "PASSED" && status !== "FAILED") return null;
  const issues = Array.isArray(fm.issues) ? fm.issues.map(String) : fm.issues ? [String(fm.issues)] : [];
  return {
    status,
    summary: typeof fm.summary === "string" ? fm.summary : "",
    issues,
    routed: parseRouted(fm.routed),
    body: match[2].trim(),
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
  if (report.issues.length > 0) parts.push(`Issues:\n${report.issues.map((issue) => `- ${issue}`).join("\n")}`);
  if (parts.length === 0 && report.body) parts.push(report.body);
  return parts.join("\n\n");
}
