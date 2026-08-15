/**
 * The run-level declared node: the end-of-range sync. The walk over the task
 * selection stays explicit orchestration, but the final sync is declared like
 * any other node — a named guard from the closed registry plus an action — so
 * the guarantee "at least one documentation sync per run" is inspectable data
 * rather than a method call buried in the walk. The differences from the
 * per-task sync node are deliberate: no upstream provides, no routed
 * suggestions, no stop check after the spawn, and the project learnings
 * compaction rides along.
 */

import type { FixPlan } from "../../fixplan/fix-plan.ts";
import { loadProjectLearnings, saveProjectLearnings } from "../learner.ts";
import { spawnFailed } from "../phases.ts";
import { CONDITIONS } from "./conditions.ts";
import { checkGraphForSync } from "./task-nodes-tail.ts";
import type { NodeOutcome, RoutingContext, RunState, TaskNodeDeps } from "./types.ts";

export interface RunNode {
  readonly id: "final_sync";
  readonly kind: "agentic";
  /** Named guard from the closed registry; the node fires only when it holds. */
  readonly when: "final_sync_needed";
  readonly action: () => Promise<NodeOutcome>;
}

/** Run-level facts the guard reads; everything per-task is out of scope here. */
export interface RunLevelFacts {
  readonly syncRan: boolean;
  readonly hasLastCompleted: boolean;
  readonly stopping: boolean;
}

/**
 * Declare the end-of-range sync node bound to one run. In fast mode the
 * single sync rides on the last task, so a failing tail would otherwise leave
 * the run with no sync at all; this node closes that gap.
 */
export function declareFinalSyncNode(deps: TaskNodeDeps, plan: FixPlan, runState: RunState): RunNode {
  return {
    id: "final_sync",
    kind: "agentic",
    when: "final_sync_needed",
    action: async () => {
      // Non-null by construction: the guard requires a completed task.
      const task = runState.lastCompleted!;
      runState.syncRan = true;
      plan.state.step = "sync";
      await deps.persist(plan);
      await checkGraphForSync(deps, plan);
      // The end-of-range sync spawns alone: no upstream contracts, no routed
      // fixes and no attempt kind to declare, so a failing pre-hook blocks.
      const sy = await deps.executor.run("sync", {
        task,
        learnings: plan.learnings,
        specId: plan.spec_id,
        attempt: plan.state.retry_count + 1,
        signal: deps.signal(),
      });
      if (!sy.preHooksOk || spawnFailed(sy.outcome)) deps.notify("final sync failed, continuing", "warning");
      // The end-of-range sync shares the tail rule: no retry path, so a red
      // post hook is recorded and named when the run closes.
      if (!sy.postHooksOk) {
        plan.state.postHookGateFailed = "sync";
        await deps.persist(plan);
      }

      // Compact project-level learnings at the end of the range.
      try {
        const config = deps.config;
        const current = await loadProjectLearnings(config.projectRoot, config.specsDir);
        if (current.length > 0) {
          deps.notify("compacting project learnings…", "info");
          const compacted = await deps.executor.compactLearnings(current, { signal: deps.signal() });
          if (compacted.length > 0) {
            await saveProjectLearnings(config.projectRoot, config.specsDir, compacted);
            deps.notify(`project learnings compacted: ${current.length} → ${compacted.length}`, "info");
          }
        }
      } catch {
        // Compaction is best-effort.
      }
      return { kind: "ok" };
    },
  };
}

/**
 * Consume a run-level node: evaluate its guard from the closed registry and
 * run the action only when the guard holds. The guard reads run-level facts
 * alone; the per-task fields of the routing context stay at neutral values.
 */
export async function consumeRunNode(node: RunNode, facts: RunLevelFacts): Promise<void> {
  const guard = CONDITIONS[node.when];
  const ctx: RoutingContext = {
    entry: { resumed: false, startStep: null },
    implStatus: "ok",
    verdict: null,
    feedback: null,
    attemptsLeft: true,
    mode: "full",
    isLastTask: false,
    continueOnFailure: false,
    stopping: facts.stopping,
    syncRan: facts.syncRan,
    hasLastCompleted: facts.hasLastCompleted,
  };
  if (!guard(ctx)) return;
  await node.action();
}
