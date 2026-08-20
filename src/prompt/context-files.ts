/**
 * Documents of the active spec, read once and inlined in the prompt of the
 * phases that are going to open them anyway.
 *
 * Review and sync work against a predictable surface: the spec folder's own
 * markdown. Left to discover it, a phase spends one turn per file, and a turn
 * costs the whole conversation prefix — so twelve documents cost twelve
 * prefixes on top of the twelve documents. Inlined, the prompt grows once and
 * the context stops growing per file. The two budgets keep that trade honest:
 * a document nobody opens is paid for, so the block is bounded and says what
 * it left out instead of silently swallowing a folder.
 *
 * Implementation is deliberately not covered: it reads source files chosen by
 * the task, which no rule here can predict.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Characters kept from a single document; the head, where the intent lives. */
export const CONTEXT_FILE_LIMIT = 8000;

/** Characters the whole block may spend, across all documents. */
export const CONTEXT_FILES_BUDGET = 40000;

export interface ContextFile {
  /** Absolute path, so the agent can open the file for what was elided. */
  path: string;
  content: string;
  /** True when only the head of the document is here. */
  truncated: boolean;
}

export interface ContextFileSet {
  files: ContextFile[];
  /** Documents the budget could not fit, as paths: named, never dropped. */
  omitted: string[];
}

export const EMPTY_CONTEXT_FILES: ContextFileSet = { files: [], omitted: [] };

/** Phases whose reading surface is the spec folder rather than the code. */
export function inlinesSpecDocs(phase: string): boolean {
  return phase === "review" || phase === "sync";
}

export interface LoadContextFilesOptions {
  fileLimit?: number;
  budget?: number;
}

/**
 * Read the markdown at the top level of the spec directory. Subdirectories are
 * left out: `tasks/` is one file per task and the phase already receives the
 * one it is about, and the loop's own folder is bookkeeping. Order is by name
 * so the same spec produces the same block on every phase of every task, which
 * is what lets the prompt prefix stay cacheable across the run.
 */
export async function loadSpecDocs(
  specDir: string,
  options: LoadContextFilesOptions = {},
): Promise<ContextFileSet> {
  const fileLimit = options.fileLimit ?? CONTEXT_FILE_LIMIT;
  const budget = options.budget ?? CONTEXT_FILES_BUDGET;

  let names: string[];
  try {
    const entries = await readdir(specDir, { withFileTypes: true });
    names = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    // A spec without a readable folder simply contributes no documents.
    return EMPTY_CONTEXT_FILES;
  }

  const files: ContextFile[] = [];
  const omitted: string[] = [];
  let spent = 0;
  for (const name of names) {
    const full = path.join(specDir, name);
    let raw: string;
    try {
      const info = await stat(full);
      // Reading a document larger than the per-file limit only to cut it back
      // is wasted I/O; the head is enough and the path carries the rest.
      if (info.size > fileLimit * 4) {
        omitted.push(full);
        continue;
      }
      raw = await readFile(full, "utf8");
    } catch {
      omitted.push(full);
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const truncated = trimmed.length > fileLimit;
    const content = truncated ? trimmed.slice(0, fileLimit) : trimmed;
    if (spent + content.length > budget) {
      omitted.push(full);
      continue;
    }
    spent += content.length;
    files.push({ path: full, content, truncated });
  }
  return { files, omitted };
}
