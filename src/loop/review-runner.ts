/**
 * The review sub-loop of a task: spawn the reviewer until a valid report
 * appears. A missing or invalid report costs a bounded review-file retry;
 * exhausting those costs a full attempt of the task. Kept apart from the
 * task state machine because it has its own retry budget and its own
 * failure vocabulary.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import type { FixPlan } from "../fixplan/fix-plan.ts";
import type { TaskFile } from "../tasks/task-parser.ts";
import { spawnFailed } from "./phases.ts";
import {
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

/**
 * Copy the current review report to a per-attempt archive when it holds a
 * readable verdict, so a retry never silently discards the reasoning of the
 * verdict it replaces. Unreadable files are skipped (archiving junk helps no
 * one); any I/O error is swallowed because archiving is best-effort and must
 * never gate the review itself.
 */
async function archivePriorReview(specDir: string, taskId: string, retryCount: number): Promise<void> {
  const target = reviewFilePath(specDir, taskId);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    return;
  }
  if (!parseReviewReport(raw)) return;
  try {
    await writeFile(reviewAttemptArchivePath(specDir, taskId, retryCount), raw, "utf8");
  } catch {
    // Archiving is advisory: a failed write must not block the review.
  }
}

/**
 * Review step: spawn the reviewer until a valid report appears. A missing
 * or invalid report costs a review file retry (bounded); exhausting those
 * costs a full attempt. The stale report is deleted before every spawn so
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
    // Preserve any verdict the previous attempt left behind before wiping the
    // canonical report: a retried review used to silently overwrite the
    // reasoning of the verdict it replaced. Only a readable verdict is worth
    // keeping; an unparseable file is dropped, not archived. Best-effort: a
    // failing archive never blocks the review.
    await archivePriorReview(specDir, id, state.retry_count);
    await rm(reviewFilePath(specDir, id), { force: true });
    if (deps.stopping()) return { kind: "stopped" };
    // The plan still flows in for the state counters (persist writes the
    // whole document), but the prompt channel is the declared input only.
    const rev = await executor.run("review", {
      task: taskFile,
      learnings: plan.learnings,
      reviewFormatError: formatError,
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
      // Phase interrupt: the attempt is lost, a fresh one starts over.
      state.review_file_retry = 0;
      notify(`review interrupted for ${id}, attempt failed`, "warning");
      await persist();
      return { kind: "attemptFailed" };
    }
    // A subprocess that failed left no verdict to read, and reading the absent
    // report as "the reviewer forgot to write it" would spend the whole review
    // budget re-spawning an agent that cannot even start. This is an
    // environment failure — a rejected model, an expired key or a rate limit
    // fails identically on every spawn — so no re-implementation can fix it:
    // the only useful answer is to stop the task and say so, without spending
    // an attempt on it.
    if (spawnFailed(rev.outcome)) {
      state.review_file_retry = 0;
      const reason = rev.outcome?.timedOut ? "timed out" : (rev.outcome?.errorMessage ?? "agent error");
      notify(`review did not run for ${id} (${reason}), task abandoned`, "warning");
      await persist();
      return { kind: "reportUnusable", detail: `review subprocess failed (${reason})` };
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
      formatError = reviewFormatReminder(id);
      await persist();
      notify(`review file missing for ${id}, new spawn ${state.review_file_retry}/${config.run.reviewFileRetry}`, "warning");
      continue;
    }

    state.review_file_retry = 0;
    state.review_file_error = null;
    await persist();
    if (report.status === "PASSED") return { kind: "passed" };
    notify(`review rejected for ${id}: ${report.summary || "see the report"}`, "warning");
    return { kind: "failed", feedback: reviewFeedback(report) };
  }
}
