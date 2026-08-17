/**
 * Pre-flight on what the loop generates: is any of it under version control?
 *
 * The loop keeps its state file, its phase logs and the codebase graph inside
 * the project tree, and it leaves the commits it creates for the operator to
 * push. Its own checkpoints exclude those paths, but nothing stops the agents —
 * which run git themselves — from committing a tracked one, and once tracked
 * they follow every later commit into whatever gets proposed for review. Said
 * at start time, the operator can ignore them before the run instead of
 * discovering them in a diff afterwards.
 *
 * Best-effort like the other pre-flights: outside a repository, or on any git
 * failure, there is nothing to report.
 */

import { spawnProcess } from "../util/process.ts";
import { loopArtifactExclusions } from "./workspace.ts";

const GIT_TIMEOUT_MS = 15_000;

/** The loop's own artifacts that git already tracks, as repository paths. */
export async function trackedLoopArtifacts(
  projectRoot: string,
  specDir: string,
  run: typeof spawnProcess = spawnProcess,
): Promise<string[]> {
  const paths = loopArtifactExclusions(projectRoot, specDir);
  if (paths.length === 0) return [];
  try {
    const result = await run("git", ["ls-files", "--", ...paths], { cwd: projectRoot, timeoutMs: GIT_TIMEOUT_MS });
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}

/** Operator-facing warning naming what the run will keep committing. */
export function trackedArtifactsWarning(files: readonly string[]): string {
  const shown = files.slice(0, 3);
  const rest = files.length > shown.length ? ` (+${files.length - shown.length} more)` : "";
  return (
    `[specs-kit] the loop's own artifacts are tracked by git (${shown.join(", ")}${rest}): ` +
    "they will travel with every commit of this run — add them to .gitignore and untrack them"
  );
}
