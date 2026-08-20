/**
 * Actions of the cycle nodes: task entry, the implementation phase, the
 * review macro-step, its gate and the failure funnel. The code moved here
 * verbatim from the per-task runner: persists, notifications and stop checks
 * stay in the exact spots the loop performs them today, and the runner's
 * control flow calls these actions from the same points as before.
 */

import path from "node:path";
import { graphRefreshFailedWarning } from "../codebase-graph.ts";
import {
  captureLearningsGuard,
  enforceLearningsGuard,
  learningsGuardWarning,
} from "../learnings-guard.ts";
import { classifyPhaseFailure, environmentFailureMessage } from "../phases.ts";
import {
  changedProtectedPaths,
  protectedPathsFeedback,
  protectedPathsWarning,
  snapshotProtectedPaths,
} from "../protected-paths.ts";
import { runReviewStep } from "../review-runner.ts";
import { collectRoutedSuggestions } from "../routed-suggestions.ts";
import { loopArtifactExclusions } from "../workspace.ts";
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
  // The loop's own state file and phase logs are written while the phase runs;
  // counting them would make every attempt look productive.
  const fingerprintExclusions = loopArtifactExclusions(config.projectRoot, specDir);
  const protect = config.run.protectSpecArtifacts;
  const snapshot = deps.snapshotProtectedPaths ?? snapshotProtectedPaths;
  const captureLearnings = deps.captureLearningsGuard ?? captureLearningsGuard;
  const enforceLearnings = deps.enforceLearningsGuard ?? enforceLearningsGuard;

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

      // Every phase of this task reads the codebase graph, and everything the
      // tasks before it landed is missing from the copy on disk: the sync
      // phase is what rebuilds it, and in fast mode sync runs once per range.
      // Re-extracting the code costs seconds and no model call, so it happens
      // here, once per task, rather than leaving the map a range behind.
      const refresh = await deps.refreshCodebaseGraph(config.projectRoot);
      if (refresh.status === "refreshed" && refresh.detail) {
        notify(`codebase graph refreshed: ${refresh.detail}`, "info");
      } else if (refresh.status === "failed") {
        notify(graphRefreshFailedWarning(refresh.detail), "warning");
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
      // Only retries are fingerprinted. A first attempt has no rejection to
      // act on, so writing nothing is a verdict for the reviewer to reach, not
      // a stall; and skipping the measurement keeps the happy path free of it.
      const isRetry = state.retry_count > 0;
      const before = isRetry ? await deps.workspaceFingerprint(config.projectRoot, fingerprintExclusions) : null;
      // Read on every attempt, not only on retries: the first one is exactly
      // where a mismatch between code and requirement is most tempting to
      // resolve by editing the requirement.
      const protectedBefore = protect ? await snapshot(specDir) : null;
      // The learnings file feeds every prompt the loop builds; capturing it
      // here costs one read and lets the phase boundary below discard what an
      // agent appended mid-task instead of publishing it to the next spawns.
      const learningsBefore = await captureLearnings(config.projectRoot, config.specsDir);
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
      // Checked before every other outcome: whichever way this attempt ends,
      // the next spawn must not be handed a memory the agent wrote itself.
      // A phase whose pre-hooks failed never reached the agent, so it is
      // skipped above and cannot have written anything.
      if (await enforceLearnings(learningsBefore)) {
        notify(learningsGuardWarning(id), "warning");
      }
      const failure = classifyPhaseFailure(impl.outcome);
      if (failure?.environment) {
        // The review step has always treated a refused spawn as an environment
        // failure worth stopping on; the implementation used to spend an
        // attempt on it, so a rate limit or a mistyped model id read exactly
        // like code the agent got wrong and bought a re-implementation of
        // working code for every attempt the task had left.
        state.review_file_error = `implementation ${failure.kind}: ${failure.detail}`;
        await persist();
        notify(environmentFailureMessage("implementation", id, failure), "error");
        io.runtime.implStatus = "environment-failed";
        return { kind: "ok" };
      }
      if (failure) {
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
      // Checked before the no-op guard: an attempt that only rewrote a
      // protected document did change the tree, so the fingerprint would
      // happily call it progress and send it to review.
      if (protectedBefore !== null) {
        const changed = changedProtectedPaths(protectedBefore, await snapshot(specDir), specDir);
        if (changed.length > 0) {
          io.runtime.feedback = protectedPathsFeedback(changed);
          state.retry_count++;
          await persist();
          notify(protectedPathsWarning(id, changed), "warning");
          io.runtime.implStatus = "protected-paths-touched";
          return { kind: "ok" };
        }
      }
      // The attempt ran clean end to end. If it also left the tree exactly as
      // it found it, the agent re-read the task, re-ran the gate and wrote
      // nothing — the review would receive the same tree it rejected and
      // reject it again, one agent session per round. A null fingerprint means
      // the tree could not be read (no git, or a git failure): the signal is
      // absent, so the attempt is taken at face value.
      if (before !== null) {
        const after = await deps.workspaceFingerprint(config.projectRoot, fingerprintExclusions);
        if (after === before) {
          state.review_file_error = "implementation retry left the workspace unchanged, no progress";
          await persist();
          notify(`implementation retry for ${id} changed nothing, task abandoned`, "warning");
          io.runtime.implStatus = "no-op-retry";
          return { kind: "ok" };
        }
      }
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
