/**
 * Fix plan refresh: reconciles the persisted fix plan with the task files on
 * disk. Creates the plan from scratch when missing, otherwise rebuilds the
 * task list and the pending queue from the frontmatter, following the done set
 * in both directions (a task turned reviewed enters it, one sent back leaves
 * it) while preserving learnings, superseded/optional, loop state and the
 * configured task range.
 */

import path from "node:path";
import { loadTasks } from "../tasks/task-loader.ts";
import { taskIdNumber, type TaskFile } from "../tasks/task-parser.ts";
import {
  computeRangeProgress,
  emptyFixPlan,
  loadFixPlan,
  saveFixPlan,
  type FixPlan,
  type FixPlanTask,
  type RefreshOutcome,
} from "./fix-plan.ts";

/** Map a task file to its fix plan entry. */
export function toFixPlanTask(task: TaskFile): FixPlanTask {
  return {
    id: task.frontmatter.id,
    file: `tasks/${path.basename(task.path)}`,
    title: task.frontmatter.title,
    lang: task.frontmatter.lang ?? null,
    status: task.frontmatter.status,
  };
}

function inRange(task: FixPlanTask, plan: FixPlan): boolean {
  const num = taskIdNumber(task.id) ?? 0;
  return num >= plan.task_range.from_num && num <= plan.task_range.to_num;
}

function pendingIds(plan: FixPlan): string[] {
  const done = new Set(plan.done);
  return plan.tasks.filter((task) => inRange(task, plan) && !done.has(task.id)).map((task) => task.id);
}

function finalize(plan: FixPlan): FixPlan {
  plan.pending = pendingIds(plan);
  plan.range_progress = computeRangeProgress(plan);
  plan.task_range.total_in_range = plan.range_progress.total_in_range;
  return plan;
}

/** Structural comparison ignoring the volatile timestamp. */
function samePlan(a: FixPlan, b: FixPlan): boolean {
  return JSON.stringify({ ...a, last_updated: "" }) === JSON.stringify({ ...b, last_updated: "" });
}

/**
 * Reconcile the fix plan of a spec with its task files. Returns the exact
 * outcome string: "Created", "Updated" or "Nothing to refresh".
 */
export async function refreshFixPlan(specDir: string, specFolder: string): Promise<RefreshOutcome> {
  const taskFiles = await loadTasks(specDir);
  const tasks = taskFiles.map(toFixPlanTask);
  const reviewed = tasks.filter((task) => task.status === "reviewed").map((task) => task.id);

  const existing = await loadFixPlan(specDir);

  if (!existing) {
    const plan = emptyFixPlan(path.basename(specDir), specFolder);
    plan.tasks = tasks;
    plan.done = reviewed;
    await saveFixPlan(specDir, finalize(plan));
    return "Created";
  }

  // Tasks that turned reviewed join the done set; tasks the operator sent back
  // from reviewed to any other status leave it, so re-running a section on disk
  // is enough to make the loop pick it up again. The previous status recorded
  // in the plan is what tells a revert from a task completed without ever being
  // marked reviewed on disk: only the former loses its done entry, and entries
  // whose task file disappeared are left alone.
  const previousStatus = new Map(existing.tasks.map((task) => [task.id, task.status]));
  const reverted = new Set(
    tasks.filter((task) => task.status !== "reviewed" && previousStatus.get(task.id) === "reviewed").map((task) => task.id),
  );

  const kept = existing.done.filter((id) => !reverted.has(id));
  const done = new Set(kept);
  for (const id of reviewed) {
    if (!done.has(id)) {
      kept.push(id);
      done.add(id);
    }
  }

  const plan = finalize({ ...existing, tasks, done: kept });

  if (!samePlan(plan, existing)) {
    await saveFixPlan(specDir, plan);
    return "Updated";
  }
  return "Nothing to refresh";
}
