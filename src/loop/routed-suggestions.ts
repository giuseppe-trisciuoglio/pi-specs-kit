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

import type { FixPlan } from "../fixplan/fix-plan.ts";
import { taskIdNumber } from "../tasks/task-parser.ts";
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

/**
 * Will this task still run in this range? A deferred fix is only deferred if
 * somebody is left to do it: an unknown id, a task already closed and a task
 * outside the range all mean the fix has no owner at all.
 */
function willRun(taskId: string, plan: FixPlan): boolean {
  const known = plan.tasks.some((t) => t.id === taskId);
  if (!known || plan.done.includes(taskId)) return false;
  const num = taskIdNumber(taskId);
  if (num === null) return true;
  return num >= plan.task_range.from_num && num <= plan.task_range.to_num;
}

/**
 * Routed fixes nobody will pick up. Deferring a finding is legitimate, and
 * naming a target that never runs is how a finding stops being a finding: the
 * review passes, the handoff is recorded, and the fix is never made. Reported
 * to the caller so it can refuse the deferral instead of trusting the label.
 */
export function routedWithoutOwner(
  routed: readonly RoutedSuggestion[],
  plan: FixPlan,
  currentTaskId: string,
): RoutedSuggestion[] {
  return routed.filter((s) => s.to === currentTaskId || !willRun(s.to, plan));
}

/** What a review is told when it deferred fixes to a task that never runs. */
export function unownedRoutedFeedback(unowned: readonly RoutedSuggestion[]): string {
  return [
    "These fixes were deferred to a task that will not run in this range, so nobody",
    "would ever make them:",
    ...unowned.map((s) => `- to ${s.to}: ${s.text}`),
    "",
    "Make them now as part of this task, or route them to a task that is still",
    "pending inside the range.",
  ].join("\n");
}

/**
 * Fixes still waiting for an owner when the range closes: every routed entry
 * of the completed tasks whose target never completed. The handoff channel is
 * only as good as the last look at it.
 */
export async function openRoutedSuggestions(specDir: string, plan: FixPlan): Promise<RoutedSuggestion[]> {
  const open: RoutedSuggestion[] = [];
  for (const doneId of plan.done) {
    const report = await readReviewReport(specDir, doneId);
    if (!report) continue;
    for (const suggestion of report.routed) {
      if (!plan.done.includes(suggestion.to)) open.push({ ...suggestion, from: doneId });
    }
  }
  return open;
}

/** The open handoffs as one operator-facing warning, or null when there are none. */
export function openRoutedWarning(open: readonly RoutedSuggestion[]): string | null {
  if (open.length === 0) return null;
  const shown = open.slice(0, 3).map((s) => `${s.from ?? "?"} → ${s.to}: ${s.text}`);
  const rest = open.length > shown.length ? ` (+${open.length - shown.length} more)` : "";
  return `range closed with ${open.length} review fix(es) routed to tasks that never completed: ${shown.join("; ")}${rest}`;
}
