/**
 * Action of the failure learner: the memory channel of a dead attempt. The
 * learner harvests a task that passed review, so nothing survives an attempt
 * that failed and every retry re-derives the same wall from scratch. This node
 * runs on the failure instead, writes what stopped the attempt into the fix
 * plan as blockers, and lets the routing decide whether the next attempt gets
 * them or the operator does.
 */

import {
  addBlockers,
  blockerLabel,
  blockersForTask,
  parseBlockers,
  repeatedWall,
  type Blocker,
} from "../blockers.ts";
import { decideFailureLearner, blockersFromReport } from "../failure-learner-routing.ts";
import { spawnFailed } from "../phases.ts";
import { readReviewReport } from "../review-report.ts";
import type { NodeAction, TaskNodeEnv } from "./types.ts";

export interface FailureNodeActions {
  failure_learner: NodeAction;
}

/** Operator-facing message for a wall the task hit twice in a row. */
export function repeatedWallMessage(taskId: string, blocker: Blocker): string {
  return (
    `task ${taskId} blocked twice on the same ${blockerLabel(blocker.kind)}, ` +
    `no further attempt: ${blocker.text}`
  );
}

/**
 * Operator-facing message for a task that turned out to need a person: a
 * credential, an account, a signature, access no agent has. It names the
 * missing action rather than the budget the retries would have eaten, and
 * says the run is not stopping on it.
 */
export function operatorWallMessage(taskId: string, detail: string): string {
  return `${taskId} stopped: it needs an operator action, no implementation pass can close it: ${detail}`;
}

/** Bind the failure learner to one task: dependencies, plan and files. */
export function makeFailureNodeActions(env: TaskNodeEnv): FailureNodeActions {
  const { deps, plan, taskFile } = env;
  const { executor, notify } = deps;
  const persist = (): Promise<void> => deps.persist(plan);
  const state = plan.state;
  const id = taskFile.frontmatter.id;

  return {
    failure_learner: async (io) => {
      if (deps.stopping()) return { kind: "stopped" };
      // The attempt that just failed: the implementation node has already
      // counted it, so the retry counter names it.
      const attempt = Math.max(state.retry_count, 1);
      const detail = io.runtime.failureDetail ?? state.review_file_error ?? "the implementation phase did not complete";

      // The report of the attempt just judged, when the failure came through
      // the review: it is the memory the learner would otherwise pay a spawn
      // to rediscover.
      const report = await readReviewReport(deps.specDir, id);
      const decision = decideFailureLearner({
        mode: deps.config.run.failureLearner,
        implStatus: io.runtime.implStatus,
        verdictKind: io.runtime.lastVerdict?.kind ?? null,
        report,
      });

      // Record what the attempt found and run the same wall bookkeeping
      // every path shares, whoever wrote the entries down.
      const record = async (found: Blocker[], traceDetail: string = detail): Promise<{ kind: "ok" }> => {
        // A task that ran out of attempts must leave a trace whatever the
        // memory of it managed to say: silence here is indistinguishable
        // from a task that failed for no reason at all, which is the state
        // this node exists to end.
        if (found.length === 0) {
          found = [{ task: id, attempt, kind: "env", text: traceDetail, resolved: false }];
        }
        state.blockers = addBlockers(state.blockers ?? [], found);

        const wall = repeatedWall(state.blockers, id, attempt);
        if (wall) {
          io.runtime.blockerWall = wall.text;
          // An action only a person can perform is the one wall that says
          // nothing about the tasks after it: it ends this task, and the run
          // walks on rather than halting on a missing credential.
          const operator = wall.kind === "operator_action";
          if (operator) io.runtime.operatorWall = wall.text;
          state.review_file_error = operator
            ? operatorWallMessage(id, wall.text)
            : repeatedWallMessage(id, wall);
        }
        await persist();
        if (wall) {
          notify(
            state.review_file_error ?? repeatedWallMessage(id, wall),
            wall.kind === "operator_action" ? "warning" : "error",
          );
        }
        return { kind: "ok" };
      };

      // The common case: a readable FAILED report already says what stopped
      // the attempt, and the next attempt is handed its findings as feedback
      // anyway. The entries are derived from it and no spawn is spent; the
      // ledger row keeps the skip measurable.
      if (!decision.run) {
        deps.recordLearnerSkip?.(id, attempt, decision.reason);
        const trace =
          report !== null && report.summary !== "" ? `review rejected the attempt: ${report.summary}` : detail;
        return record(blockersFromReport(report!, id, attempt), trace);
      }

      const known = blockersForTask(state.blockers, id).map((b) => `${blockerLabel(b.kind)}: ${b.text}`);
      const result = await executor.runFailureLearner(taskFile, {
        attempt,
        detail,
        known,
        signal: deps.signal(),
      });
      if (deps.stopping() === "now") return { kind: "stopped" };

      let found: Blocker[] = [];
      if (spawnFailed(result.outcome)) {
        notify(`failure learner failed for ${id}, continuing`, "warning");
      } else {
        found = parseBlockers(result.text, id, attempt);
      }
      return record(found);
    },
  };
}
