/**
 * Learnings extraction and persistence helpers. The learner role produces a
 * textual bullet list at the end of a task; bullets are merged into the fix
 * plan so later tasks receive them as memory, and persisted to a project-level
 * file under the specs directory so future specs benefit from them.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Upper bound of learnings kept in the fix plan; oldest entries rotate out. */
export const MAX_LEARNINGS = 50;

/** Maximum learnings kept in the project-level file (compacted by the learner). */
export const MAX_PROJECT_LEARNINGS = 30;

/** File name relative to the specs directory. */
const LEARNINGS_FILE = "learnings.md";

export function projectLearningsPath(projectRoot: string, specsDir: string): string {
  return path.join(projectRoot, specsDir, LEARNINGS_FILE);
}

/**
 * Parse bullet lines from free-form learner output. Accepts "-", "*", "•"
 * and numbered bullets; ignores headings, blank lines and prose.
 */
export function parseLearnings(text: string): string[] {
  const learnings: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1];
    if (value && !learnings.includes(value)) learnings.push(value);
  }
  return learnings;
}

/**
 * Merge new learnings into the existing list: entries already present
 * (case-insensitive) are skipped, the list is capped at MAX_LEARNINGS by
 * dropping the oldest entries.
 */
export function mergeLearnings(existing: string[], incoming: string[], max = MAX_LEARNINGS): string[] {
  const merged = [...existing];
  const seen = new Set(existing.map((l) => l.toLowerCase()));
  for (const learning of incoming) {
    if (seen.has(learning.toLowerCase())) continue;
    seen.add(learning.toLowerCase());
    merged.push(learning);
  }
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/**
 * Load learnings from the project-level file, returning an empty list when
 * the file is absent or unreadable.
 */
export async function loadProjectLearnings(projectRoot: string, specsDir: string): Promise<string[]> {
  try {
    const content = await readFile(projectLearningsPath(projectRoot, specsDir), "utf8");
    return parseLearnings(content);
  } catch {
    return [];
  }
}

/**
 * Persist learnings to the project-level file. The directory is created when
 * it does not exist, and the list is capped at MAX_PROJECT_LEARNINGS.
 */
export async function saveProjectLearnings(
  projectRoot: string,
  specsDir: string,
  learnings: string[],
): Promise<void> {
  const filePath = projectLearningsPath(projectRoot, specsDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  const capped = learnings.length > MAX_PROJECT_LEARNINGS ? learnings.slice(-MAX_PROJECT_LEARNINGS) : learnings;
  const body = capped.map((l) => `- ${l}`).join("\n");
  await writeFile(filePath, `# Project Learnings\n\n${body}\n`, "utf8");
}
