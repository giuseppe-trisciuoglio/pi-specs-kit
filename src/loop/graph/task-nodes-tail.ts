/**
 * Actions of the tail nodes: cleanup, learner, sync, update_done and
 * checkpoint, plus the helpers they share with the rest of the loop. The
 * code moved here verbatim from the per-task runner: persists, notifications
 * and stop checks stay in the exact spots the loop performs them today, and
 * the runner's control flow calls these actions from the same points as
 * before. Non-fatal phase failures stay notifications; they never route.
 */

import { computeRangeProgress, type FixPlan } from "../../fixplan/fix-plan.ts";
import { updateTaskStatus, type TaskFile } from "../../tasks/task-parser.ts";
import { graphifyGraphExists, graphifyGraphMissingWarning } from "../../prompt/graphify.ts";
import { mergeLearnings, parseLearnings, loadProjectLearnings, saveProjectLearnings, MAX_PROJECT_LEARNINGS } from "../learner.ts";
import { parseConfirmations, spawnFailed } from "../phases.ts";
import type { NodeAction, TaskNodeDeps, TaskNodeEnv } from "./types.ts";

/** Collect the public API contracts from the already-completed dependency tasks. */
export function upstreamProvides(taskFile: TaskFile, selected: TaskFile[], done: string[]): string[] {
  const result: string[] = [];
  for (const depId of taskFile.frontmatter.dependencies) {
    if (!done.includes(depId)) continue;
    const depTask = selected.find((t) => t.frontmatter.id === depId);
    if (depTask) result.push(...depTask.frontmatter.provides);
  }
  return result;
}

/**
 * Surface a missing codebase graph before a sync runs: the phase still
 * completes, but graph-backed dependency validation is skipped, so the run
 * is marked partial and the operator is warned at sync time rather than only
 * at loop start. Best-effort: a stat error never blocks the sync.
 */
export async function checkGraphForSync(deps: TaskNodeDeps, plan: FixPlan): Promise<void> {
  try {
    if (await graphifyGraphExists(deps.config.projectRoot)) return;
  } catch {
    return;
  }
  if (!plan.state.graphPartialSync) {
    plan.state.graphPartialSync = true;
    await deps.persist(plan);
  }
  deps.notify(graphifyGraphMissingWarning(), "warning");
}

export interface TailNodeActions {
  cleanup: NodeAction;
  learner: NodeAction;
  sync: NodeAction;
  update_done: NodeAction;
  checkpoint: NodeAction;
}

/** Bind the tail node actions to one task: dependencies, plan and files. */
export function makeTailNodeActions(env: TaskNodeEnv): TailNodeActions {
  const { deps, plan, taskFile, selected } = env;
  const { config, executor, notify } = deps;
  const persist = (): Promise<void> => deps.persist(plan);
  const state = plan.state;
  const id = taskFile.frontmatter.id;

  return {
    cleanup: async (io) => {
      if (deps.stopping()) return { kind: "stopped" };
      state.step = "cleanup";
      await persist();
      const cl = await executor.run("cleanup", {
        task: taskFile,
        learnings: plan.learnings,
        specId: plan.spec_id,
        attempt: state.retry_count + 1,
        upstreamProvides: upstreamProvides(taskFile, selected, plan.done),
        routedSuggestions: io.runtime.routedSuggestions,
        firstAttempt: state.retry_count === 0,
        signal: deps.signal(),
      });
      if (deps.stopping() === "now") return { kind: "stopped" };
      if (!cl.preHooksOk || spawnFailed(cl.outcome)) notify(`cleanup failed for ${id}, continuing`, "warning");
      // A red post hook does not fail the phase — cleanup has no retry path —
      // but it must not vanish into a transient warning either: record it so
      // the run close names the gate instead of declaring the task clean.
      if (!cl.postHooksOk) {
        plan.state.postHookGateFailed = "cleanup";
        await persist();
      }
      return { kind: "ok" };
    },

    learner: async () => {
      if (deps.stopping()) return { kind: "stopped" };
      state.step = "learner";
      await persist();
      // The learner is shown what the project already knows so it can add
      // instead of re-deriving; the same list is what its citations point into.
      const known = [...plan.learnings];
      const lr = await executor.runLearner(taskFile, known, { signal: deps.signal() });
      if (deps.stopping() === "now") return { kind: "stopped" };
      if (spawnFailed(lr.outcome)) {
        notify(`learner failed for ${id}, continuing`, "warning");
      } else {
        const found = parseLearnings(lr.text);
        const confirmed = parseConfirmations(lr.text, known);
        if (found.length > 0 || confirmed.length > 0) {
          // A task the review had to reject paid for its insights: whatever it
          // learned encodes a rule the project actually enforces, so it starts
          // warmer than a note from a task that passed first time.
          const merged = mergeLearnings({
            existing: plan.learnings,
            stats: plan.learning_stats,
            incoming: found,
            confirmed,
            iteration: state.iteration,
            fromRejection: state.retry_count > 0,
          });
          plan.learnings = merged.learnings;
          plan.learning_stats = merged.stats;
          await persist();
          // Persist to the project-level file so future specs benefit.
          try {
            const existing = await loadProjectLearnings(config.projectRoot, config.specsDir);
            const project = mergeLearnings({
              existing,
              incoming: found,
              confirmed,
              iteration: state.iteration,
              fromRejection: state.retry_count > 0,
              max: MAX_PROJECT_LEARNINGS,
            });
            await saveProjectLearnings(config.projectRoot, config.specsDir, project.learnings);
          } catch {
            // Project learnings are best-effort.
          }
        }
      }
      return { kind: "ok" };
    },

    sync: async (io) => {
      if (deps.stopping()) return { kind: "stopped" };
      state.step = "sync";
      await persist();
      await checkGraphForSync(deps, plan);
      const sy = await executor.run("sync", {
        task: taskFile,
        learnings: plan.learnings,
        specId: plan.spec_id,
        attempt: state.retry_count + 1,
        upstreamProvides: upstreamProvides(taskFile, selected, plan.done),
        routedSuggestions: io.runtime.routedSuggestions,
        firstAttempt: state.retry_count === 0,
        signal: deps.signal(),
      });
      io.runtime.runState.syncRan = true;
      if (deps.stopping() === "now") return { kind: "stopped" };
      if (!sy.preHooksOk || spawnFailed(sy.outcome)) notify(`sync failed for ${id}, continuing`, "warning");
      // Same rule as cleanup: the phase completes and never retries, so a red
      // post hook is recorded for the run close rather than dropped.
      if (!sy.postHooksOk) {
        plan.state.postHookGateFailed = "sync";
        await persist();
      }
      return { kind: "ok" };
    },

    // Unlike the phase nodes above, this one intentionally has no entry stop
    // check. By the time the walk reaches it the task's work has already been
    // completed in full, so refusing to record the completion would not spare
    // any work: a resume would simply redo the whole task and throw away the
    // sessions already spent. Completion is therefore deliberately
    // non-interruptible — a stop requested during the previous phase takes
    // effect only at the next task boundary, never here.
    update_done: async (io) => {
      state.step = "update_done";
      if (!plan.done.includes(id)) plan.done.push(id);
      plan.pending = plan.pending.filter((p) => p !== id);
      plan.range_progress = computeRangeProgress(plan);
      if (config.mode === "full") {
        const date = deps.now().toISOString().slice(0, 10);
        try {
          await updateTaskStatus(taskFile.path, "reviewed", { implementedDate: date, reviewedDate: date });
          const entry = plan.tasks.find((t) => t.id === id);
          if (entry) entry.status = "reviewed";
        } catch (err) {
          // The task file may have been moved or deleted by the agents. The work
          // is done either way: letting the error escape would abort the loop
          // before the done set is persisted, and every resume would halt again
          // at the same point.
          const reason = err instanceof Error ? err.message : String(err);
          notify(`cannot update the frontmatter of ${id}: ${reason}`, "warning");
        }
      }
      io.runtime.runState.lastCompleted = taskFile;
      await persist();
      return { kind: "ok" };
    },

    checkpoint: async () => {
      if (!config.run.noCommit) {
        const cp = await deps.commitCheckpoint(
          config.projectRoot,
          `checkpoint: ${id} attempt ${state.retry_count + 1}`,
        );
        notify(
          cp.committed ? `checkpoint committed for ${id}` : `checkpoint skipped for ${id}: ${cp.reason ?? "git error"}`,
          cp.committed ? "info" : "warning",
        );
      }
      notify(`task ${id} completed`, "info");
      return { kind: "ok" };
    },
  };
}
