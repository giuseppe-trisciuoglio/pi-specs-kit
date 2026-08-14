/**
 * Collects review suggestions a reviewer routed to a later task. Without this,
 * such handoffs live only as prose inside earlier review reports, so the task
 * that should act on them has no reliable way to learn they exist: it would
 * have to grep earlier reviews by hand and can easily miss one. The collector
 * reads every completed task's review report and keeps the fixes routed to the
 * task about to run, turning a free-text handoff into something the loop can
 * hand to the implementation prompt directly.
 *
 * Every read is best-effort: a missing, moved or unreadable review never
 * stops the loop, it just yields fewer suggestions.
 */

import type { RoutedSuggestion } from "./review-report.ts";
import { readReviewReport, routedFor } from "./review-report.ts";

/**
 * Fixes reviewers routed to a target task, gathered from the review reports of
 * tasks already completed. Returns them in the order their source tasks
 * completed, so the prompt reads earliest handoff first.
 */
export async function collectRoutedSuggestions(
  specDir: string,
  targetTaskId: string,
  doneTaskIds: readonly string[],
): Promise<RoutedSuggestion[]> {
  const collected: RoutedSuggestion[] = [];
  for (const doneId of doneTaskIds) {
    if (doneId === targetTaskId) continue;
    const report = await readReviewReport(specDir, doneId);
    if (!report) continue;
    for (const suggestion of routedFor(report, targetTaskId)) {
      collected.push({ ...suggestion, from: doneId });
    }
  }
  return collected;
}
