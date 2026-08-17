/**
 * Content fingerprint of the working tree: the signal that tells a retry which
 * changed something from a retry which changed nothing at all.
 *
 * Computed through a throwaway git index so the user's staging area is never
 * touched — the tree object git derives from that index is an exact content
 * hash of every tracked and newly added file, and ignored paths (build output)
 * stay out of it for free. Best-effort by design: outside a git repository, or
 * on any git failure, the answer is null and the caller simply loses the
 * signal.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnProcess } from "../util/process.ts";

/** Ceiling for each git call; a hung git must not stall the phase boundary. */
export const FINGERPRINT_TIMEOUT_MS = 30_000;

/**
 * Pathspecs excluded from the fingerprint, relative to the project root. The
 * loop writes its own state file and phase logs while the phase runs, so
 * counting them as work would make every attempt look productive.
 */
export function loopArtifactExclusions(projectRoot: string, specDir: string): string[] {
  const rel = path.relative(projectRoot, specDir);
  // A spec folder outside the project root has nothing to exclude: its writes
  // are not part of this tree in the first place.
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return [];
  return [path.posix.join(rel.split(path.sep).join("/"), "_ralph_loop")];
}

/**
 * Tree object id of the current worktree, or null when it cannot be computed.
 * Equal ids mean the two moments are byte-identical over everything git would
 * track; a different id means at least one file changed.
 */
export async function workspaceFingerprint(
  projectRoot: string,
  excluded: readonly string[] = [],
): Promise<string | null> {
  let dir: string;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "specs-kit-fp-"));
  } catch {
    return null;
  }
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, "index") };
  const git = (args: string[]): Promise<{ exitCode: number | null; stdout: string }> =>
    spawnProcess("git", args, { cwd: projectRoot, env, timeoutMs: FINGERPRINT_TIMEOUT_MS });
  try {
    // Seeding the scratch index from HEAD keeps the staging step to the files
    // that actually differ; without it every blob in the repository would be
    // re-hashed and written. An unborn HEAD simply leaves the index empty,
    // which still fingerprints correctly, so the exit code is not checked.
    await git(["read-tree", "HEAD"]);
    const pathspec = [".", ...excluded.map((p) => `:(exclude)${p}`)];
    const add = await git(["add", "-A", "--", ...pathspec]);
    if (add.exitCode !== 0) return null;
    const tree = await git(["write-tree"]);
    if (tree.exitCode !== 0) return null;
    const sha = tree.stdout.trim();
    return sha === "" ? null : sha;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
