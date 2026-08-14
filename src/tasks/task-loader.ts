/**
 * Task loader: scans the `tasks/` directory of a spec, orders the task files
 * by number and provides range filtering plus dependency sanity warnings.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isTaskFileName } from "./task-files.ts";
import { parseTaskFile, taskIdNumber, type TaskFile } from "./task-parser.ts";

/**
 * Load every task file in `<specDir>/tasks/` (review reports and any other
 * markdown excluded, see isTaskFileName), sorted ascending by task number.
 * Returns an empty list when the directory does not exist.
 */
export async function loadTasks(specDir: string): Promise<TaskFile[]> {
  const tasksDir = path.join(specDir, "tasks");
  let entries: string[];
  try {
    entries = await readdir(tasksDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const tasks: TaskFile[] = [];
  const byId = new Map<string, string>();
  for (const name of entries) {
    if (!isTaskFileName(name)) continue;
    const filePath = path.join(tasksDir, name);
    const task = parseTaskFile(filePath, await readFile(filePath, "utf8"));
    // Two files declaring the same id are ambiguous for every consumer: the
    // loop would run one and skip the other as already done, while progress
    // counts both. Fail loudly instead of silently dropping a task body.
    const previous = byId.get(task.frontmatter.id);
    if (previous !== undefined) {
      throw new Error(
        `duplicate task id ${task.frontmatter.id} in ${path.join(specDir, "tasks")}: ` +
          `${previous} and ${name} declare the same id`,
      );
    }
    byId.set(task.frontmatter.id, name);
    tasks.push(task);
  }
  return tasks.sort((a, b) => a.num - b.num);
}

/**
 * Numeric value of a range bound. Both the full task id (TASK-NNN) and a
 * bare task number ("2", "02") are accepted, since the configuration file
 * and the start options carry either form. Null for anything else.
 */
export function taskBoundNumber(value: string): number | null {
  const byId = taskIdNumber(value);
  if (byId !== null) return byId;
  const bare = /^(\d+)$/.exec(value.trim());
  return bare ? Number.parseInt(bare[1], 10) : null;
}

function bound(id: string | undefined, fallback: number): number {
  if (id === undefined) return fallback;
  const num = taskBoundNumber(id);
  if (num === null) throw new Error(`invalid task range bound: ${id} (expected TASK-NNN or a task number)`);
  return num;
}

/** Inclusive range filter by task number; open bounds when ids are omitted. */
export function filterRange(tasks: TaskFile[], fromTask?: string, toTask?: string): TaskFile[] {
  const from = bound(fromTask, Number.MIN_SAFE_INTEGER);
  const to = bound(toTask, Number.MAX_SAFE_INTEGER);
  return tasks.filter((task) => task.num >= from && task.num <= to);
}

/**
 * Sanity-check the dependencies of the selected tasks. A dependency is
 * considered satisfied when it is already reviewed, when the loop has already
 * completed it (`done`, the only evidence available in fast mode, which never
 * rewrites task frontmatter), or when it is selected too and scheduled before
 * the dependent task; anything else yields a warning.
 */
export function dependencyWarnings(tasks: TaskFile[], selected: TaskFile[], done: Iterable<string> = []): string[] {
  const completed = new Set(done);
  const byId = new Map(tasks.map((task) => [task.frontmatter.id, task]));
  const selectedNums = new Map(selected.map((task) => [task.frontmatter.id, task.num]));
  const warnings: string[] = [];

  for (const task of selected) {
    for (const depId of task.frontmatter.dependencies) {
      const dep = byId.get(depId);
      if (!dep) {
        warnings.push(`${task.frontmatter.id}: dependency ${depId} not found among the tasks`);
        continue;
      }
      if (dep.frontmatter.status === "reviewed" || completed.has(depId)) continue;
      const selectedNum = selectedNums.get(depId);
      if (selectedNum !== undefined && selectedNum < task.num) continue;
      warnings.push(
        `${task.frontmatter.id}: dependency ${depId} not satisfied ` +
          `(status "${dep.frontmatter.status}", not selected before the task)`,
      );
    }
  }
  return warnings;
}
