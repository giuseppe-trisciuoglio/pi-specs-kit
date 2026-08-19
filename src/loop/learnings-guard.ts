/**
 * Guard for the project learnings file around a phase spawn.
 *
 * The executor rereads that file at every spawn and injects it into the
 * prompts of every role, so an agent that appends to it mid-task publishes to
 * the phases that follow — measured on a real run, a retried implementation
 * wrote its own failure note there and the re-review received it as a prompt
 * line the loop never chose to deliver. The note also entered without the
 * warmth bookkeeping the sanctioned merge path maintains.
 *
 * The guard captures the file before the spawn and reverts it after when a
 * phase changed it. The sanctioned channel for new learnings is the learner
 * that runs once the task passes review.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { projectLearningsPath } from "./learner.ts";

/** What the learnings file looked like before the guarded phase ran. */
export interface LearningsGuard {
  /** Absolute path of the project learnings file. */
  file: string;
  /** Bytes at capture time; null when the file did not exist. */
  before: string | null;
}

/** Read the learnings file as it stands, best-effort. */
async function currentContent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Snapshot the learnings file before a phase spawn. */
export async function captureLearningsGuard(projectRoot: string, specsDir: string): Promise<LearningsGuard> {
  const file = projectLearningsPath(projectRoot, specsDir);
  return { file, before: await currentContent(file) };
}

/**
 * Revert the learnings file to the captured bytes when a phase rewrote it.
 * Returns true when a change was found — even a failed revert, which stays
 * visible to the operator instead of failing silently the other way.
 */
export async function enforceLearningsGuard(guard: LearningsGuard): Promise<boolean> {
  if ((await currentContent(guard.file)) === guard.before) return false;
  try {
    if (guard.before === null) await rm(guard.file, { force: true });
    else await writeFile(guard.file, guard.before, "utf8");
  } catch {
    // The revert failed: the mismatch is still reported, the file is not.
  }
  return true;
}

/** What the operator is told when a phase wrote where only the loop writes. */
export function learningsGuardWarning(taskId: string): string {
  return `implementation of ${taskId} wrote to the project learnings file and it was reverted: learnings are collected by the loop after the task passes review`;
}
