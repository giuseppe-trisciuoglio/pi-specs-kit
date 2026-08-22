/**
 * The documents a task's phases must not rewrite: the requirement document of
 * the spec and the interface contracts under it.
 *
 * Those files are what the implementation is judged against. When an agent may
 * edit them, the cheapest way out of a mismatch between code and requirement
 * is to reword the requirement, and the mismatch disappears from every later
 * reading — the code passes review, the contract agrees with it, and the
 * decision that changed the target is a line in a log nobody diffs. So the
 * loop watches them: a phase that alters one is asked to restore it and to
 * report the conflict instead, which is the channel that leads to a decision
 * taken outside the session that wanted it.
 *
 * Content hashes, not timestamps: an agent that rewrites a file with identical
 * bytes changed nothing, and a formatter run must not read as a violation.
 * Best-effort throughout — an unreadable directory yields a smaller snapshot,
 * never an exception.
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Directory of interface contracts inside a spec folder. */
const CONTRACTS_DIR = "contracts";

/** Snapshot of the protected files: absolute path to content hash. */
export type ProtectedSnapshot = Map<string, string>;

/**
 * Is this the requirement document of the spec? The date-prefixed markdown at
 * the spec root, minus the derived documents that live beside it under the
 * same naming convention.
 */
function isRequirementDocument(name: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}--.+\.md$/.test(name)) return false;
  return !name.endsWith("--tasks.md") && !name.endsWith("--technical-plan.md");
}

async function hashFile(file: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

/** Every file under a directory, recursively; empty when it cannot be read. */
async function filesUnder(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** The protected files of a spec, as absolute paths. */
export async function protectedSpecFiles(specDir: string): Promise<string[]> {
  const files = await filesUnder(path.join(specDir, CONTRACTS_DIR));
  try {
    for (const name of await readdir(specDir)) {
      if (isRequirementDocument(name)) files.push(path.join(specDir, name));
    }
  } catch {
    // A spec directory that cannot be listed protects only what was found.
  }
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Hash every protected file of a spec. A file that cannot be read is recorded
 * as absent, so a phase that deletes one still shows up as a change.
 */
export async function snapshotProtectedPaths(specDir: string): Promise<ProtectedSnapshot> {
  const snapshot: ProtectedSnapshot = new Map();
  for (const file of await protectedSpecFiles(specDir)) {
    const hash = await hashFile(file);
    if (hash !== null) snapshot.set(file, hash);
  }
  return snapshot;
}

/**
 * Files that differ between two snapshots — changed, added or removed —
 * relative to the spec directory, in a stable order.
 */
export function changedProtectedPaths(
  before: ProtectedSnapshot,
  after: ProtectedSnapshot,
  specDir: string,
): string[] {
  const changed = new Set<string>();
  for (const [file, hash] of before) {
    if (after.get(file) !== hash) changed.add(file);
  }
  for (const [file, hash] of after) {
    if (before.get(file) !== hash) changed.add(file);
  }
  return [...changed].map((file) => path.relative(specDir, file)).sort((a, b) => a.localeCompare(b));
}

/**
 * What the next attempt is told when the previous one rewrote a protected
 * document. It names the files and the two ways out, because the way an agent
 * usually resolves this — editing the document until it agrees with the code —
 * is exactly the one that must not be taken.
 */
export function protectedPathsFeedback(changed: readonly string[]): string {
  return [
    "The previous attempt modified files this task must not change:",
    ...changed.map((file) => `- ${file}`),
    "",
    "These documents state what the implementation is measured against, so they",
    "cannot be edited by the work being measured. Restore them exactly as they",
    "were (`git checkout -- <path>` when they are tracked) and then take one of",
    "the two ways out: change the code so it honours them, or stop and state",
    "the conflict in the implementation summary so it can be decided outside",
    "this session. Rewording them to match the code is never one of the two.",
  ].join("\n");
}

/** Operator-facing warning naming what a phase touched. */
export function protectedPathsWarning(taskId: string, changed: readonly string[]): string {
  return `${taskId} modified protected spec documents (${changed.join(", ")}): attempt rejected, restore them and report the conflict`;
}
