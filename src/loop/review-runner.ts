/**
 * The review sub-loop of a task: spawn the reviewer until a valid report
 * appears. A missing or invalid report costs a bounded review-file retry;
 * exhausting those costs a full attempt of the task. Kept apart from the
 * task state machine because it has its own retry budget and its own
 * failure vocabulary.
 *
 * Two things the sub-loop deliberately does not spend a task attempt on: a
 * report whose block came out malformed (the reviewer's findings are on disk
 * and only the block has to be rewritten) and a phase the operator or the
 * environment interrupted (nothing was learned about the implementation, so
 * re-implementing working code buys nothing). Both re-spawn the reviewer
 * inside the same bounded budget.
 */

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FixPlan } from "../fixplan/fix-plan.ts";
import type { TaskFile } from "../tasks/task-parser.ts";
import { classifyPhaseFailure, environmentFailureMessage } from "./phases.ts";
import { routedWithoutOwner, unownedRoutedFeedback } from "./routed-suggestions.ts";
import {
  listReviewAttemptArchives,
  parseReviewReport,
  readReviewReport,
  reviewAttemptArchivePath,
  reviewFeedback,
  reviewFilePath,
  reviewFormatReminder,
} from "./review-report.ts";
import type { TaskRunnerDeps } from "./task-runner.ts";

/**
 * What the review step reports back to the task state machine.
 * `attemptFailed` is a lost attempt worth repeating from the implementation;
 * `reportUnusable` is a reviewer that cannot state a verdict at all, which
 * repeating the implementation would not fix.
 */
export type ReviewVerdict =
  | { kind: "passed" }
  | { kind: "failed"; feedback: string }
  | { kind: "attemptFailed" }
  | { kind: "reportUnusable"; detail: string }
  | { kind: "stopped" };

/** The slice of the task runner dependencies the review step needs. */
export type ReviewStepDeps = Pick<
  TaskRunnerDeps,
  "config" | "specDir" | "executor" | "persist" | "notify" | "stopping" | "signal"
>;

/** Where an unreadable report is kept so the next spawn can repair it. */
export function reviewUnreadablePath(specDir: string, taskId: string): string {
  return path.join(specDir, "tasks", `${taskId}--review.unreadable.md`);
}

/**
 * Rotate whatever the previous spawn left at the report path.
 *
 * A readable verdict is archived per attempt, so a retried review never
 * silently discards the reasoning it replaces, and then removed so the next
 * evaluation only sees fresh output. An unreadable one is moved aside instead
 * of deleted: its findings are the expensive part of a review and the next
 * spawn is asked to repair the block rather than to review the task again.
 * Every step is best-effort — rotation must never gate the review itself.
 */
async function rotatePriorReview(specDir: string, taskId: string, retryCount: number): Promise<string | null> {
  const target = reviewFilePath(specDir, taskId);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    return null;
  }
  if (parseReviewReport(raw)) {
    try {
      await writeFile(reviewAttemptArchivePath(specDir, taskId, retryCount), raw, "utf8");
    } catch {
      // Archiving is advisory: a failed write must not block the review.
    }
    await rm(target, { force: true }).catch(() => {});
    return null;
  }
  const preserved = reviewUnreadablePath(specDir, taskId);
  try {
    await rename(target, preserved);
    return preserved;
  } catch {
    await rm(target, { force: true }).catch(() => {});
    return null;
  }
}

/**
 * Review step: spawn the reviewer until a valid report appears. A missing
 * or invalid report costs a review file retry (bounded); exhausting those
 * costs a full attempt. The stale report is rotated before every spawn so
 * each evaluation only sees fresh output.
 */
export async function runReviewStep(
  deps: ReviewStepDeps,
  plan: FixPlan,
  taskFile: TaskFile,
): Promise<ReviewVerdict> {
  const { config, specDir, executor, notify } = deps;
  const persist = (): Promise<void> => deps.persist(plan);
  const state = plan.state;
  const id = taskFile.frontmatter.id;

  // Set after a report the loop could not read, so the next spawn is told what
  // was wrong with the previous one instead of repeating it verbatim.
  let formatError: string | null = null;

  for (;;) {
    const preserved = await rotatePriorReview(specDir, id, state.retry_count);
    if (preserved !== null && formatError !== null) {
      formatError = reviewFormatReminder(id, {
        preservedPath: path.relative(config.projectRoot, preserved),
      });
    }
    if (deps.stopping()) return { kind: "stopped" };
    // The plan still flows in for the state counters (persist writes the
    // whole document), but the prompt channel is the declared input only.
    // The archives of earlier attempts are listed after the rotation above
    // made room for the one it just wrote, so the freshest disk state is
    // what the reviewer is told about.
    const rev = await executor.run("review", {
      task: taskFile,
      learnings: plan.learnings,
      reviewFormatError: formatError,
      priorAttemptArchives: await listReviewAttemptArchives(specDir, id),
      specId: plan.spec_id,
      attempt: state.retry_count + 1,
      signal: deps.signal(),
    });
    if (deps.stopping() === "now") return { kind: "stopped" };
    // The review file budget belongs to the attempt: whenever the attempt ends
    // here the counter goes back to zero, or the next one would start
    // mid-budget and get fewer spawns than configured.
    if (!rev.preHooksOk) {
      state.review_file_retry = 0;
      notify(`pre-review hook failed (${id})`, "warning");
      await persist();
      return { kind: "attemptFailed" };
    }
    if (rev.outcome?.aborted) {
      // A phase interrupt says nothing about the implementation: it was never
      // judged. Re-implementing working code to reach a second opinion costs
      // two agent sessions to get back where the loop already was, so the
      // reviewer is spawned again inside the same bounded budget instead.
      state.review_file_retry++;
      if (state.review_file_retry > config.run.reviewFileRetry) {
        state.review_file_retry = 0;
        notify(`review interrupted for ${id} beyond its retries, attempt failed`, "warning");
        await persist();
        return { kind: "attemptFailed" };
      }
      await persist();
      notify(
        `review interrupted for ${id}, new spawn ${state.review_file_retry}/${config.run.reviewFileRetry}`,
        "warning",
      );
      continue;
    }
    // A subprocess that failed left no verdict to read, and reading the absent
    // report as "the reviewer forgot to write it" would spend the whole review
    // budget re-spawning an agent that cannot even start. This is an
    // environment failure — a rejected model, an expired key or a rate limit
    // fails identically on every spawn — so no re-implementation can fix it:
    // the only useful answer is to stop the task and say so, without spending
    // an attempt on it.
    const failure = classifyPhaseFailure(rev.outcome);
    if (failure) {
      state.review_file_retry = 0;
      await persist();
      // A refused spawn is reported as an error, not a warning: it names a
      // provider or a configuration the operator has to change, and it read as
      // one more failed attempt when it shared the severity of a lost round.
      if (failure.environment) {
        notify(environmentFailureMessage("review", id, failure), "error");
      } else {
        notify(`review did not run for ${id} (${failure.detail}), task abandoned`, "warning");
      }
      return { kind: "reportUnusable", detail: `review ${failure.kind}: ${failure.detail}` };
    }
    // The reviewer does not write code, so a red gate after it is nothing the
    // review itself can act on and there is no retry path here to spend. It is
    // recorded like the gates of the other phases that cannot react, so the
    // range does not close clean over it.
    if (!rev.postHooksOk) state.postHookGateFailed = "review";

    const report = await readReviewReport(specDir, id);
    if (!report) {
      state.review_file_retry++;
      if (state.review_file_retry > config.run.reviewFileRetry) {
        const detail = `review file missing or invalid after ${config.run.reviewFileRetry} new attempts`;
        state.review_file_error = detail;
        state.review_file_retry = 0;
        notify(`review file absent for ${id}, task abandoned`, "warning");
        await persist();
        return { kind: "reportUnusable", detail };
      }
      formatError = reviewFormatReminder(id, { missing: true });
      await persist();
      notify(`review file missing for ${id}, new spawn ${state.review_file_retry}/${config.run.reviewFileRetry}`, "warning");
      continue;
    }

    state.review_file_retry = 0;
    state.review_file_error = null;
    await persist();
    // The report the loop read is the one that counts: nothing is left behind
    // to make a later reader think the salvaged copy is still pending.
    await rm(reviewUnreadablePath(specDir, id), { force: true }).catch(() => {});
    if (report.recovered) {
      notify(`review report of ${id} had a malformed frontmatter block, verdict read line by line`, "warning");
    }
    // A review that reports a requirement contradicted by the implementation
    // cannot also wave it through: the reviewer describes the conflict, the
    // loop decides what it costs. Without this the same session both raises
    // the contradiction and absolves it, which is how one leaves a run as a
    // note in a report nobody acts on.
    if (report.specConflicts.length > 0) {
      const first = report.specConflicts[0];
      notify(
        `review of ${id} reports ${report.specConflicts.length} requirement conflict(s): ${first}`,
        "warning",
      );
      return { kind: "failed", feedback: reviewFeedback(report) };
    }
    // A deferral to a task that will not run is not a deferral: the fix would
    // be recorded and never made. The implementation is asked to do it now,
    // which is the only owner still available.
    const unowned = routedWithoutOwner(report.routed, plan, id);
    if (unowned.length > 0) {
      notify(`review of ${id} routed ${unowned.length} fix(es) to a task that will not run`, "warning");
      return { kind: "failed", feedback: unownedRoutedFeedback(unowned) };
    }
    if (report.status === "PASSED") return { kind: "passed" };
    notify(`review rejected for ${id}: ${report.summary || "see the report"}`, "warning");
    return { kind: "failed", feedback: reviewFeedback(report) };
  }
}
