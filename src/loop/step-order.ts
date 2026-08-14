/**
 * Per-task steps in execution order, shared by the runner, the engine resume
 * logic and the declared graph's entry predicates. Kept in its own module so
 * the routing layer can read the ordering without importing the runner.
 */

import type { LoopStep } from "../fixplan/fix-plan.ts";

export const STEP_ORDER: readonly LoopStep[] = [
  "implementation",
  "review",
  "cleanup",
  "learner",
  "sync",
  "update_done",
];

/** Position of a step in the order; unknown steps count as the first, so a
 * malformed persisted plan resumes at the start of the cycle. */
export function stepIndex(step: LoopStep): number {
  const index = STEP_ORDER.indexOf(step);
  return index === -1 ? 0 : index;
}
