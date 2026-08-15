/**
 * Run setup: everything that has to be true before the first phase spawns.
 * Loads the task files, applies the range, reconciles the persisted fix plan
 * with what is on disk and decides what a resume or a forced restart means.
 * Nothing here writes: the engine persists the prepared plan itself, so the
 * first snapshot on disk already describes the run about to start.
 */

import path from "node:path";
import type { SpecsKitConfig } from "../config/specs-kit-config.ts";
import { computeRangeProgress, emptyFixPlan, loadFixPlan, type FixPlan } from "../fixplan/fix-plan.ts";
import { refreshFixPlan, toFixPlanTask } from "../fixplan/refresh.ts";
import { dependencyWarnings, filterRange, loadTasks, taskBoundNumber } from "../tasks/task-loader.ts";
import type { TaskFile } from "../tasks/task-parser.ts";

export interface RunSetupOptions {
  /** Absolute path of the spec directory. */
  specDir: string;
  /** Spec path as the operator wrote it, for error messages. */
  specLabel: string;
  fromTask?: string;
  toTask?: string;
  resume?: boolean;
  force?: boolean;
}

export interface PreparedRun {
  tasks: TaskFile[];
  selected: TaskFile[];
  plan: FixPlan;
  /** True when the persisted per-task anchor should be honored. */
  resume: boolean;
  /** Messages for the operator, in the order they should be surfaced. */
  notices: { message: string; type: "info" | "warning" | "error" }[];
}

/**
 * Prepare a run over a spec. Throws when the selection is empty: that is
 * always an operator error (typo in --from-task, an inverted range, a spec
 * whose tasks/ holds no task file), and letting it through would report a
 * 0/0 range as a successful run.
 */
export async function prepareRun(config: SpecsKitConfig, opts: RunSetupOptions): Promise<PreparedRun> {
  const { specDir } = opts;
  const tasks = await loadTasks(specDir);
  const from = opts.fromTask ?? config.run.fromTask;
  const to = opts.toTask ?? config.run.toTask;
  const selected = filterRange(tasks, from, to);

  if (tasks.length === 0) {
    throw new Error(`no task files under ${path.join(opts.specLabel, "tasks")}`);
  }
  if (selected.length === 0) {
    const ids = tasks.map((task) => task.frontmatter.id);
    const range = [from ? `from ${from}` : null, to ? `to ${to}` : null].filter(Boolean).join(" ");
    throw new Error(
      `the task range (${range || "open"}) selects no task: ` +
        `${ids.length} tasks available, ${ids[0]}..${ids[ids.length - 1]}`,
    );
  }

  let plan = await loadFixPlan(specDir);
  if (!plan) {
    await refreshFixPlan(specDir, path.relative(config.projectRoot, specDir));
    plan = await loadFixPlan(specDir);
  }
  if (!plan) throw new Error("fix plan not available after the refresh");

  // An existing plan may lag behind the task files on disk (tasks added,
  // renamed or removed since it was written): realign its task list so the
  // progress metadata below describes this run's selection rather than a
  // stale snapshot. The done set and the loop state are left untouched.
  plan.tasks = tasks.map(toFixPlanTask);

  // Align the plan range with the effective selection for this run.
  plan.task_range = {
    from: from ?? null,
    from_num: from ? (taskBoundNumber(from) ?? 0) : 0,
    to: to ?? null,
    to_num: to ? (taskBoundNumber(to) ?? 999) : 999,
    total_in_range: selected.length,
  };
  plan.range_progress = computeRangeProgress(plan);

  const notices: PreparedRun["notices"] = [];
  const resume = (opts.resume ?? config.run.resume) && !opts.force;
  if (!resume) {
    plan.state = { ...emptyFixPlan(plan.spec_id, plan.spec_folder).state };
  }
  // A red gate belongs to the run that reported it: the closing notice reads
  // this field, and a resume must not re-report a failure of the previous run.
  plan.state.postHookGateFailed = null;
  if (opts.force) {
    // "Start over" means the whole persisted state, not just the step pointer:
    // with the done set intact every task in range would be skipped and the
    // run would report a completion it never performed.
    const inRange = new Set(selected.map((task) => task.frontmatter.id));
    plan.done = plan.done.filter((id) => !inRange.has(id));
    plan.pending = plan.tasks.filter((task) => inRange.has(task.id)).map((task) => task.id);
    plan.range_progress = computeRangeProgress(plan);
    notices.push({ message: `force: persisted state cleared for ${inRange.size} tasks in range`, type: "info" });
  }

  for (const warning of dependencyWarnings(tasks, selected, plan.done)) {
    notices.push({ message: warning, type: "warning" });
  }

  return { tasks, selected, plan, resume, notices };
}
