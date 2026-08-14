/**
 * Fix plan model: the single source of truth for loop state, persisted as
 * `_ralph_loop/fix_plan.json` inside the spec folder. Field names mirror the
 * on-disk JSON shape exactly (compatible with the existing format); loads are
 * tolerant of missing fields, saves are atomic (tmp file + rename).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PhaseName } from "../config/specs-kit-config.ts";
import { taskIdNumber, type TaskStatus } from "../tasks/task-parser.ts";

export interface FixPlanTask {
  id: string;
  /** Path of the task file, relative to the spec folder. */
  file: string;
  title: string;
  lang: string | null;
  status: TaskStatus;
}

export interface TaskRange {
  from: string | null;
  from_num: number;
  to: string | null;
  to_num: number;
  total_in_range: number;
}

export interface RangeProgress {
  done_in_range: number;
  percent: number;
  total_in_range: number;
}

export type LoopStep = PhaseName | "learner" | "update_done" | "choose_task" | "done" | "failed";

export interface LoopState {
  step: LoopStep;
  current_task: string | null;
  current_task_file: string | null;
  current_task_lang: string | null;
  iteration: number;
  retry_count: number;
  review_file_error: string | null;
  review_file_retry: number;
  error: string | null;
  /**
   * Set when a sync ran without the codebase graph: the phase completed, but
   * graph-backed dependency validation was skipped, so the result is partial.
   * Advisory only — tolerated as missing on older fix plans.
   */
  graphPartialSync?: boolean;
  last_updated: string;
}

export interface FixPlan {
  spec_id: string;
  spec_folder: string;
  default_agent: string;
  tasks: FixPlanTask[];
  done: string[];
  pending: string[];
  superseded: string[] | null;
  optional: string[] | null;
  learnings: string[];
  task_range: TaskRange;
  range_progress: RangeProgress;
  state: LoopState;
  last_updated: string;
}

/** Outcome of a refresh, reported verbatim to the user. */
export type RefreshOutcome = "Created" | "Updated" | "Nothing to refresh";

/** Name of the state directory inside a spec folder. */
export const LOOP_STATE_DIR = "_ralph_loop";
/** Name of the fix plan file inside the state directory. */
export const FIX_PLAN_FILE = "fix_plan.json";

function fixPlanPath(specDir: string): string {
  return path.join(specDir, LOOP_STATE_DIR, FIX_PLAN_FILE);
}

/** Initial, all-defaults fix plan for a spec that never ran the loop. */
export function emptyFixPlan(specId: string, specFolder: string): FixPlan {
  const now = new Date().toISOString();
  return {
    spec_id: specId,
    spec_folder: specFolder,
    default_agent: "pi",
    tasks: [],
    done: [],
    pending: [],
    superseded: null,
    optional: null,
    learnings: [],
    task_range: { from: null, from_num: 0, to: null, to_num: 999, total_in_range: 0 },
    range_progress: { done_in_range: 0, percent: 0, total_in_range: 0 },
    state: {
      step: "choose_task",
      current_task: null,
      current_task_file: null,
      current_task_lang: null,
      iteration: 0,
      retry_count: 0,
      review_file_error: null,
      review_file_retry: 0,
      error: null,
      last_updated: now,
    },
    last_updated: now,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/**
 * Load the fix plan of a spec, tolerating missing fields (each one falls back
 * to the empty-plan default). Returns null when the file does not exist.
 */
export async function loadFixPlan(specDir: string): Promise<FixPlan | null> {
  let raw: string;
  try {
    raw = await readFile(fixPlanPath(specDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const data = JSON.parse(raw) as Partial<FixPlan>;
  const base = emptyFixPlan(String(data.spec_id ?? ""), String(data.spec_folder ?? ""));
  return {
    ...base,
    ...data,
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    done: stringArray(data.done),
    pending: stringArray(data.pending),
    superseded: data.superseded === null || data.superseded === undefined ? null : stringArray(data.superseded),
    optional: data.optional === null || data.optional === undefined ? null : stringArray(data.optional),
    learnings: stringArray(data.learnings),
    task_range: { ...base.task_range, ...(data.task_range ?? {}) },
    range_progress: { ...base.range_progress, ...(data.range_progress ?? {}) },
    state: { ...base.state, ...(data.state ?? {}) },
  };
}

/**
 * Persist the fix plan atomically (tmp file + rename), creating the state
 * directory when missing. `last_updated` is stamped with the current time.
 */
export async function saveFixPlan(specDir: string, plan: FixPlan): Promise<void> {
  const dir = path.join(specDir, LOOP_STATE_DIR);
  await mkdir(dir, { recursive: true });
  plan.last_updated = new Date().toISOString();
  const target = fixPlanPath(specDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

/** Recompute the progress counters over the tasks falling inside the range. */
export function computeRangeProgress(plan: FixPlan): RangeProgress {
  const { from_num, to_num } = plan.task_range;
  const done = new Set(plan.done);
  let total = 0;
  let doneInRange = 0;
  for (const task of plan.tasks) {
    const num = taskIdNumber(task.id) ?? 0;
    if (num < from_num || num > to_num) continue;
    total += 1;
    if (done.has(task.id)) doneInRange += 1;
  }
  return {
    done_in_range: doneInRange,
    percent: total === 0 ? 0 : Math.round((doneInRange / total) * 100),
    total_in_range: total,
  };
}
