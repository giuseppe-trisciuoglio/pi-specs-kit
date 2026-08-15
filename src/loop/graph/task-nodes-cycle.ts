/**
 * Actions of the cycle nodes: task entry, the implementation phase, the
 * review macro-step, its gate and the failure funnel. The code moved here
 * verbatim from the per-task runner: persists, notifications and stop checks
 * stay in the exact spots the loop performs them today, and the runner's
 * control flow calls these actions from the same points as before.
 */

import path from "node:path";
import { spawnFailed } from "../phases.ts";
import { runReviewStep } from "../review-runner.ts";
import { collectRoutedSuggestions } from "../routed-suggestions.ts";
import { upstreamProvides } from "./task-nodes-tail.ts";
import type { NodeAction, TaskNodeEnv } from "./types.ts";

export interface CycleNodeActions {
  enter_task: NodeAction;
  implementation: NodeAction;
  review: NodeAction;
  review_gate: NodeAction;
  task_failed: NodeAction;
}

/** Bind the cycle node actions to one task: dependencies, plan and files. */
export function makeCycleNodeActions(env: TaskNodeEnv): CycleNodeActions {
  const { deps, plan, taskFile, selected } = env;
  const { config, specDir, executor, notify } = deps;
  const persist = (): Promise<void> => deps.persist(plan);
  const state = plan.state;
  const id = taskFile.frontmatter.id;
  const maxAttempts = config.run.maxAttempts;

  return {
    enter_task: async (io) => {
      deps.budget.startTask(id);
      const { resumed, startStep } = io.runtime.entry;
      if (!resumed) {
        state.current_task = id;
        state.current_task_file = path.relative(specDir, taskFile.path);
        state.current_task_lang = taskFile.frontmatter.lang ?? null;
        state.step = startStep ?? "implementation";
        state.retry_count = 0;
        state.review_file_retry = 0;
        state.review_file_error = null;
        state.error = null;
        state.iteration++;
        await persist();
        notify(`task ${id}: ${taskFile.frontmatter.title}`, "info");
      }

      // The end-of-range sync keys on whether a sync actually ran in this
      // run, not on where the task resumed: a resume past the sync phase must
      // not claim a sync that never happened, or the run could close without
      // ever syncing once.

      // Fixes earlier reviews routed to this task: collected once, since the
      // completed-task set does not change while this task runs (it grows only
      // at update_done, after every phase that consumes them).
      io.runtime.routedSuggestions = await collectRoutedSuggestions(specDir, id, plan.done);
      return { kind: "ok" };
    },

    implementation: async (io) => {
      if (deps.stopping()) return { kind: "stopped" };
      state.step = "implementation";
      await persist();
      const impl = await executor.run("implementation", {
        task: taskFile,
        learnings: plan.learnings,
        specId: plan.spec_id,
        attempt: state.retry_count + 1,
        reviewFeedback: io.runtime.feedback,
        postHookFailures: io.runtime.postHookFailures,
        upstreamProvides: upstreamProvides(taskFile, selected, plan.done),
        routedSuggestions: io.runtime.routedSuggestions,
        // The node declares how the world is, not what to do; the executor
        // owns the blocking policy. On the first attempt the workspace is
        // expected to be in a clean state, so a failing pre-hook blocks the
        // phase. On retries the agent already ran once and may have left
        // broken tests or a half-built tree behind, so the pre-hook output
        // is fed to it as context instead.
        firstAttempt: state.retry_count === 0,
        signal: deps.signal(),
      });
      // An abort without a stop request (phase interrupt) falls through
      // to the failure path and costs one attempt.
      if (deps.stopping() === "now") return { kind: "stopped" };
      if (!impl.preHooksOk) {
        notify(`pre-implementation hook failed (${id})`, "warning");
        state.retry_count++;
        await persist();
        io.runtime.implStatus = "pre-hook-failed";
        return { kind: "ok" };
      }
      if (spawnFailed(impl.outcome)) {
        notify(`implementation failed for ${id} (attempt ${state.retry_count + 1}/${maxAttempts})`, "warning");
        state.retry_count++;
        await persist();
        io.runtime.implStatus = "spawn-failed";
        return { kind: "ok" };
      }
      // The post hooks are the phase's own gate: the build does not compile
      // or the tests are red, the attempt is spent exactly like a spawn
      // failure, and the next one is told what the gate caught.
      if (!impl.postHooksOk) {
        notify(`post-implementation hook failed (${id})`, "warning");
        state.retry_count++;
        await persist();
        io.runtime.postHookFailures = impl.failedPostHooks;
        io.runtime.implStatus = "post-hook-failed";
        return { kind: "ok" };
      }
      io.runtime.postHookFailures = null;
      io.runtime.implStatus = "ok";
      return { kind: "ok" };
    },

    review: async (io) => {
      if (deps.stopping()) return { kind: "stopped" };
      state.step = "review";
      await persist();
      const verdict = await runReviewStep(deps, plan, taskFile);
      if (verdict.kind === "stopped") return { kind: "stopped" };
      io.runtime.lastVerdict = verdict;
      return { kind: "ok" };
    },

    review_gate: async (io) => {
      const verdict = io.runtime.lastVerdict;
      // The gate runs right after the review action, which always stores a
      // verdict; a pass needs no bookkeeping here.
      if (verdict === null || verdict.kind === "passed") return { kind: "ok" };
      // The reviewer never managed to state a verdict. Nothing the
      // implementation could do differently would change that, so the
      // remaining attempts are not spent re-implementing working code.
      if (verdict.kind === "reportUnusable") {
        state.review_file_error = verdict.detail ?? null;
        return { kind: "ok" };
      }
      if (verdict.kind === "failed") {
        // Twice the same rejection means the implementation phase is not
        // acting on the feedback: another round costs two more agent
        // sessions to arrive at the identical pair of outputs.
        if (io.runtime.feedback !== null && io.runtime.feedback === verdict.feedback) {
          state.review_file_error = "review rejected twice with identical feedback, no progress";
          return { kind: "ok" };
        }
        io.runtime.feedback = verdict.feedback;
      }
      state.retry_count++;
      await persist();
      return { kind: "ok" };
    },

    task_failed: async () => {
      const detail = state.review_file_error ?? `task not completed after ${maxAttempts} attempts`;
      state.error = `${id}: ${detail}`;
      state.step = "failed";
      await persist();
      notify(
        config.run.continueOnFailure ? `${state.error}; continuing with the next task` : `loop stopped: ${state.error}`,
        "error",
      );
      return { kind: "ok" };
    },
  };
}
