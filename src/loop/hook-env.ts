/**
 * What a hook command is told about the attempt it gates. A gate that has to
 * run the whole suite on every attempt is the most expensive thing in a loop
 * that spends most of its time on retries; handed the files the work stands
 * on, the same command can compile and test the modules those files belong to
 * and leave the suite to the checkpoint.
 *
 * Two variables, one list: the value inline for the common case, and a file
 * for the case where the list is longer than an environment block can carry.
 * Both are always set, empty when the list could not be read (outside a git
 * repository, or on a git failure), so a hook can tell "nothing changed" from
 * "I was not told" only by what it does with an empty value — and the honest
 * default for a hook that reads an empty list is the full scope.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Newline-separated paths, relative to the project root. */
export const CHANGED_FILES_VAR = "SPECS_KIT_CHANGED_FILES";
/** File holding the same list, one path per line; empty when there is none. */
export const CHANGED_FILES_PATH_VAR = "SPECS_KIT_CHANGED_FILES_PATH";

/** Anything that is not printable text has no business in a path we export. */
const NON_PRINTABLE = /[\x00-\x1F\x7F]/g;

export interface HookEnv {
  /** The variables to add to the hook's environment. */
  vars: Record<string, string>;
  /** Drop the temp file, if one was written. Never throws. */
  release: () => Promise<void>;
}

/**
 * The exported form of the list: control characters stripped (the list is
 * newline-separated, so a path carrying one would invent an entry), blanks
 * and duplicates dropped. Order is preserved: it is the order git listed the
 * paths in, and a hook building a module list reads it as given.
 */
export function exportablePaths(files: readonly string[] | null): string[] {
  if (files === null) return [];
  const seen = new Set<string>();
  for (const file of files) {
    const clean = file.replace(NON_PRINTABLE, "").trim();
    if (clean !== "") seen.add(clean);
  }
  return [...seen];
}

/**
 * Open the environment for one run of hook commands. Best-effort throughout:
 * a temp file that cannot be written leaves the path variable empty rather
 * than failing the gate, which would turn a logging problem into a failed
 * attempt.
 */
export async function openHookEnv(files: readonly string[] | null): Promise<HookEnv> {
  const paths = exportablePaths(files);
  const list = paths.join("\n");
  if (paths.length === 0) {
    return { vars: { [CHANGED_FILES_VAR]: "", [CHANGED_FILES_PATH_VAR]: "" }, release: async () => {} };
  }
  let dir: string | null = null;
  let listFile = "";
  try {
    dir = await mkdtemp(path.join(tmpdir(), "specs-kit-hook-"));
    listFile = path.join(dir, "changed-files.txt");
    await writeFile(listFile, `${list}\n`, "utf8");
  } catch {
    listFile = "";
  }
  const scratch = dir;
  return {
    vars: { [CHANGED_FILES_VAR]: list, [CHANGED_FILES_PATH_VAR]: listFile },
    release: async () => {
      if (scratch !== null) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    },
  };
}
