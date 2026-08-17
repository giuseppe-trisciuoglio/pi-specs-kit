import { spawnProcess } from "../util/process.ts";

export interface CheckpointResult {
  committed: boolean;
  /** Why no commit was made: "no changes", "not a git repo", or the git error. */
  reason?: string;
}

/**
 * Commit the current workspace state as a loop checkpoint. Best-effort: a
 * non-git directory, a clean tree or a git failure never throw, they just
 * report `committed: false`.
 */
export async function commitCheckpoint(
  projectRoot: string,
  message: string,
  excluded: readonly string[] = [],
): Promise<CheckpointResult> {
  // The commit takes the whole tree minus what the loop itself generated: a
  // checkpoint is meant to capture the work, and an unignored state file or
  // graph output would otherwise ride along into whatever the branch becomes.
  const pathspec = ["--", ".", ...excluded.map((p) => `:(exclude)${p}`)];
  const add = await spawnProcess("git", ["add", "-A", ...pathspec], { cwd: projectRoot, timeoutMs: 30_000 });
  if (add.exitCode !== 0) {
    return { committed: false, reason: add.stderr.trim() || "not a git repo" };
  }
  const commit = await spawnProcess("git", ["commit", "-m", message], {
    cwd: projectRoot,
    timeoutMs: 30_000,
  });
  if (commit.exitCode !== 0) {
    const output = `${commit.stdout}\n${commit.stderr}`;
    return { committed: false, reason: /nothing to commit/i.test(output) ? "no changes" : output.trim() };
  }
  return { committed: true };
}
