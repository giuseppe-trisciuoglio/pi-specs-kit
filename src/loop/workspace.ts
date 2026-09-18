/**
 * What git says about the working tree at three moments: the content fingerprint
 * that tells a retry which changed something from a retry which changed nothing,
 * the patch between the tree an earlier phase saw and the tree as it is now, and
 * the paths standing on top of the last commit so a gate knows what the attempt
 * touched.
 *
 * All three go through a throwaway git index so the user's staging area is
 * never touched — the tree object git derives from that index is an exact
 * content hash of every tracked and newly added file, and ignored paths
 * (build output) stay out of it for free. The tree objects land in the
 * repository's own object store, which is what makes a fingerprint taken one
 * phase ago still diffable one phase later. Best-effort by design: outside a
 * git repository, or on any git failure, the answer is null and the caller
 * simply loses the signal.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GRAPHIFY_GRAPH_REL } from "../prompt/graphify.ts";
import { spawnProcess } from "../util/process.ts";

/** Ceiling for each git call; a hung git must not stall the phase boundary. */
export const FINGERPRINT_TIMEOUT_MS = 30_000;

/**
 * Pathspecs of what the loop itself generates, relative to the project root.
 *
 * Two callers, one list. The fingerprint leaves them out because the loop
 * writes its state file and phase logs while the phase runs, so counting them
 * as work would make every attempt look productive. The checkpoint leaves them
 * out because they are outputs of the run, not the work the run produced:
 * swept into the commit they end up in whatever the branch is proposed as.
 */
export function loopArtifactExclusions(projectRoot: string, specDir: string): string[] {
  // The codebase graph is re-extracted at every task entry, so it is a build
  // artifact of the run wherever the project keeps it.
  const exclusions = [path.posix.dirname(GRAPHIFY_GRAPH_REL.split(path.sep).join("/"))];
  const rel = path.relative(projectRoot, specDir);
  // A spec folder outside the project root has nothing to exclude: its writes
  // are not part of this tree in the first place.
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return exclusions;
  return [...exclusions, path.posix.join(rel.split(path.sep).join("/"), "_ralph_loop")];
}

/**
 * Pathspecs of the review artifacts, kept out of the patch a re-review reads.
 *
 * Between the two trees the loop archives the rejected verdict and removes the
 * report it replaced, so an unfiltered patch would carry the whole text of the
 * previous review as an added file — the conclusion the review ingress
 * deliberately does not deliver, handed over by accident.
 */
export function reviewArtifactExclusions(projectRoot: string, specDir: string): string[] {
  const rel = path.relative(projectRoot, specDir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return [];
  const tasks = path.posix.join(rel.split(path.sep).join("/"), "tasks");
  return [`${tasks}/*--review.md`, `${tasks}/*--review.attempt-*.md`, `${tasks}/*--review.unreadable.md`];
}

type Git = (args: string[]) => Promise<{ exitCode: number | null; stdout: string }>;

/**
 * Stage the worktree into a throwaway index and hand the caller a git bound
 * to it. Everything the readers need — the temp index, the exclusions, the
 * best-effort contract — happens once here: on any failure the callback is
 * never invoked and the caller gets null, which is how all of them say "the
 * signal is not available".
 */
async function withScratchIndex<T>(
  projectRoot: string,
  excluded: readonly string[],
  read: (git: Git) => Promise<T | null>,
): Promise<T | null> {
  let dir: string;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "specs-kit-fp-"));
  } catch {
    return null;
  }
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, "index") };
  const git: Git = (args) =>
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
    return await read(git);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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
  return withScratchIndex(projectRoot, excluded, async (git) => {
    const tree = await git(["write-tree"]);
    if (tree.exitCode !== 0) return null;
    const sha = tree.stdout.trim();
    return sha === "" ? null : sha;
  });
}

/** A patch between two moments of the worktree, bounded in size. */
export interface WorkspaceDiff {
  /** `--stat` summary of the patch, always complete. */
  stat: string;
  /** The patch itself, cut at the configured ceiling. */
  patch: string;
  /** True when the patch was cut; the stat still describes the whole change. */
  truncated: boolean;
}

/**
 * Patch from `baseTree` to the worktree as it is now, or null when there is
 * nothing to show: no base, no git, an empty change, or a ceiling of zero.
 *
 * The head is what is kept when the patch is too long. Unlike a build log,
 * whose verdict is in the last lines, a patch is read from the top and git
 * orders it by path: a cut tail loses the files a reader would reach last,
 * while the stat above it still names every one of them.
 */
export async function workspaceDiff(
  projectRoot: string,
  baseTree: string | null,
  excluded: readonly string[] = [],
  limitChars = 0,
): Promise<WorkspaceDiff | null> {
  if (!baseTree || limitChars <= 0) return null;
  return withScratchIndex(projectRoot, excluded, async (git) => {
    const tree = await git(["write-tree"]);
    if (tree.exitCode !== 0) return null;
    const current = tree.stdout.trim();
    if (current === "" || current === baseTree) return null;
    const pathspec = ["--", ".", ...excluded.map((p) => `:(exclude)${p}`)];
    const stat = await git(["diff", "--stat", baseTree, current, ...pathspec]);
    if (stat.exitCode !== 0) return null;
    const patch = await git(["diff", "--no-color", baseTree, current, ...pathspec]);
    if (patch.exitCode !== 0) return null;
    const full = patch.stdout.trim();
    if (full === "") return null;
    const truncated = full.length > limitChars;
    return {
      stat: stat.stdout.trim(),
      patch: truncated ? `${full.slice(0, limitChars)}\n…[${full.length - limitChars} characters omitted]…` : full,
      truncated,
    };
  });
}

/**
 * Paths that differ from the last commit, relative to the project root, or
 * null when the tree cannot be read. This is the work standing on top of
 * HEAD: the checkpoint commits at every passed task, so what comes back is
 * what the current task has touched, across all its attempts — a module an
 * earlier attempt wrote and this one did not still belongs to the scope a
 * gate has to cover.
 *
 * NUL-separated on the git side because a path may legitimately contain
 * anything else, newlines included.
 */
export async function changedWorkspaceFiles(
  projectRoot: string,
  excluded: readonly string[] = [],
): Promise<string[] | null> {
  return withScratchIndex(projectRoot, excluded, async (git) => {
    const diff = await git(["diff", "--cached", "--name-only", "-z", "HEAD"]);
    // An unborn HEAD has nothing to diff against: everything staged into the
    // scratch index is new, so the index itself is the list.
    const listed = diff.exitCode === 0 ? diff : await git(["ls-files", "--cached", "-z"]);
    if (listed.exitCode !== 0) return null;
    return listed.stdout.split("\0").filter((entry) => entry !== "");
  });
}