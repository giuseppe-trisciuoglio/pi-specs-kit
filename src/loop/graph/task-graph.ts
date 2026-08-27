/**
 * The declared task graph: the topology of the per-task loop as data — nodes,
 * edges and named conditions — in evaluation order (first match wins). The
 * bound node actions are injected; the table itself computes nothing. Nothing
 * executes it yet: the compiler and the structural tests keep it honest until
 * the interpreter is wired into the runner.
 */

import type { NodeAction, TaskEdge, TaskGraph, TaskNode, TaskNodeId } from "./types.ts";

/** Node kinds, in declaration order. The start marker only forwards to the
 * task entry; sinks terminate the walk with the task outcome. */
const NODE_DECLARATIONS: readonly Pick<TaskNode, "id" | "kind" | "outcome">[] = [
  { id: "task_start", kind: "deterministic" },
  { id: "enter_task", kind: "deterministic" },
  { id: "implementation", kind: "agentic" },
  { id: "review", kind: "agentic" },
  { id: "review_gate", kind: "deterministic" },
  { id: "task_failed", kind: "deterministic" },
  { id: "cleanup", kind: "agentic" },
  { id: "learner", kind: "agentic" },
  { id: "sync", kind: "agentic" },
  { id: "update_done", kind: "deterministic" },
  { id: "checkpoint", kind: "deterministic" },
  { id: "task_done", kind: "sink", outcome: "done" },
  { id: "task_stopped", kind: "sink", outcome: "stopped" },
  { id: "task_halted", kind: "sink", outcome: "halted" },
];

/** Edges grouped by source node, in evaluation order within each group. The
 * exhaustion guards deliberately precede the back-edges: once attempts are
 * gone, the failure kind no longer matters to routing. */
const EDGE_DECLARATIONS: readonly TaskEdge[] = [
  { from: "task_start", to: "enter_task", type: "advance", when: "always" },

  // Entry routing: fresh starts and resumes enter through the same node and
  // fan out on the persisted starting step.
  { from: "enter_task", to: "implementation", type: "advance", when: "enters_at_implementation" },
  { from: "enter_task", to: "review", type: "advance", when: "enters_at_review" },
  { from: "enter_task", to: "cleanup", type: "advance", when: "enters_at_cleanup_full_mode" },
  { from: "enter_task", to: "learner", type: "mode-skip", when: "enters_at_cleanup_fast_mode" },
  { from: "enter_task", to: "learner", type: "advance", when: "enters_at_learner" },
  { from: "enter_task", to: "sync", type: "advance", when: "enters_at_sync" },
  { from: "enter_task", to: "update_done", type: "advance", when: "enters_at_update_done" },
  // Fast mode syncs once, on the last task of the selection: entering at the
  // sync phase on an earlier task must skip the phase, without marking it as
  // run, and close the task through update_done — the end-of-range sync still
  // covers the range when no task synced.
  { from: "enter_task", to: "update_done", type: "advance", when: "enters_at_sync_skipped" },
  // The retry guard used to sit at the top of the cycle: entering it with the
  // attempts already spent (only possible on a resume whose counters were
  // persisted exhausted) never ran a phase and fell straight into the funnel.
  // Every other entry names its starting step, so this catch-all fires exactly
  // for that case.
  { from: "enter_task", to: "task_failed", type: "attempts-exhausted", when: "always" },

  // Ahead of the exhaustion guard: a refused spawn is worth naming as such
  // even on the last attempt, where "attempts exhausted" would hide the cause.
  { from: "implementation", to: "task_failed", type: "report-unusable", when: "impl_environment_failed" },
  { from: "implementation", to: "task_failed", type: "attempts-exhausted", when: "impl_failed_attempts_exhausted" },
  // Sits next to the exhaustion guard for the same reason: both say another
  // round cannot help. A retry that produced no change would hand the reviewer
  // the tree it has already rejected.
  { from: "implementation", to: "task_failed", type: "stall-guard", when: "impl_no_op_retry" },
  { from: "implementation", to: "implementation", type: "pre-hook-failed", when: "impl_pre_hook_failed" },
  { from: "implementation", to: "implementation", type: "spawn-failed", when: "impl_spawn_failed" },
  { from: "implementation", to: "implementation", type: "post-hook-failed", when: "impl_post_hook_failed" },
  { from: "implementation", to: "implementation", type: "protected-paths", when: "impl_protected_paths_touched" },
  { from: "implementation", to: "review", type: "advance", when: "impl_ok" },

  { from: "review", to: "review_gate", type: "advance", when: "always" },

  { from: "review_gate", to: "task_failed", type: "report-unusable", when: "verdict_report_unusable" },
  { from: "review_gate", to: "task_failed", type: "stall-guard", when: "verdict_failed_same_feedback" },
  { from: "review_gate", to: "task_failed", type: "attempts-exhausted", when: "verdict_retry_attempts_exhausted" },
  { from: "review_gate", to: "implementation", type: "failed", when: "verdict_failed_new_feedback" },
  { from: "review_gate", to: "implementation", type: "attempt-failed", when: "verdict_attempt_failed" },
  { from: "review_gate", to: "cleanup", type: "passed", when: "verdict_passed_full_mode" },
  { from: "review_gate", to: "learner", type: "mode-skip", when: "verdict_passed_fast_mode" },

  { from: "cleanup", to: "learner", type: "advance", when: "always" },
  { from: "learner", to: "sync", type: "advance", when: "sync_wanted" },
  { from: "learner", to: "update_done", type: "mode-skip", when: "sync_not_wanted" },
  { from: "sync", to: "update_done", type: "advance", when: "always" },
  { from: "update_done", to: "checkpoint", type: "advance", when: "always" },
  { from: "checkpoint", to: "task_done", type: "advance", when: "always" },

  { from: "task_failed", to: "task_done", type: "continue-on-failure", when: "continue_on_failure" },
  { from: "task_failed", to: "task_halted", type: "halt-on-failure", when: "halt_on_failure" },
];

/**
 * Assemble the table from the bound node actions. Every node id gets an
 * action, including sinks and the start marker: sinks never run theirs, and
 * the start marker's is a no-op by construction.
 */
export function buildTaskGraph(actions: Record<TaskNodeId, NodeAction>): TaskGraph {
  const nodes: TaskNode[] = NODE_DECLARATIONS.map((decl) =>
    decl.kind === "sink"
      ? { id: decl.id, kind: decl.kind, outcome: decl.outcome }
      : { id: decl.id, kind: decl.kind, action: actions[decl.id] },
  );
  return { entry: "task_start", nodes, edges: EDGE_DECLARATIONS };
}
