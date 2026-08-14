/**
 * Spec discovery over the specs root. Every direct child directory except the
 * hidden ones counts as a spec — the specs root is dedicated — flagged with
 * whether it already has a task list the loader would actually run, so the
 * loop picker (which needs tasks) and the authoring commands (any state)
 * share one listing. Pure filesystem read: no pi wiring.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { isTaskFileName } from "../tasks/task-files.ts";

export interface SpecInfo {
  /** Spec directory relative to the project root. */
  dir: string;
  /** True when tasks/ holds at least one file the loader will run. */
  hasTasks: boolean;
}

/** List the specs under the specs root, sorted by directory. */
export async function discoverSpecs(projectRoot: string, specsDir: string): Promise<SpecInfo[]> {
  const root = path.resolve(projectRoot, specsDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const specs: SpecInfo[] = [];
  for (const entry of entries) {
    // Hidden directories are never specs: a specs root tracked as its own
    // repository, or an editor scratch dir, must not show up in the pickers.
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    let hasTasks = false;
    try {
      // Same predicate the loader uses, so "has tasks" and "the loop finds
      // tasks" cannot disagree: a lone review report or a .gitkeep is not one.
      hasTasks = (await readdir(path.join(root, entry.name, "tasks"))).some(isTaskFileName);
    } catch {
      // No tasks directory yet.
    }
    specs.push({ dir: path.join(specsDir, entry.name), hasTasks });
  }
  return specs.sort((a, b) => a.dir.localeCompare(b.dir));
}
