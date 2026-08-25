/**
 * Reads, from the body of a GitHub issue, which spec a run should cover. Pure
 * text work: the caller decides whether the directory it names exists and has
 * tasks. The specs root is always the configured one — an extension installed
 * once and used across projects cannot assume the default layout.
 *
 * An explicit key wins over anything inferred: an issue that discusses several
 * specs must still be able to say which one it is asking to run.
 */

import path from "node:path";
import { PHASE_NAMES, type PhaseName } from "../config/specs-kit-config.ts";

export interface IssueRunRequest {
  /** Spec directory, relative to the project root, in posix form. */
  specDir: string;
  fromTask?: string;
  toTask?: string;
  phase?: PhaseName;
}

export type IssueSpecResult =
  | { ok: true; request: IssueRunRequest }
  | { ok: false; reason: "no-spec-reference" | "invalid-phase"; detail: string };

/** Escape a configured path so it can be embedded in a regular expression. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Value of a `key: value` line, tolerating the decoration an issue body
 * usually carries: a list bullet, bold markers, and a trailing period.
 */
function keyValue(body: string, key: string): string | undefined {
  // Both spellings, because an operator writing "from-task" and one writing
  // "from_task" are asking for the same thing.
  const spellings = key.includes("-") ? [key, key.replace(/-/g, "_")] : [key];
  for (const spelling of spellings) {
    const pattern = new RegExp(`^[ \\t]*(?:[-*+][ \\t]+)?\\*{0,2}${escapeForRegExp(spelling)}\\*{0,2}[ \\t]*:[ \\t]*(.+)$`, "im");
    const match = pattern.exec(body);
    if (match) {
      const value = match[1].trim().replace(/[.,;]+$/, "");
      if (value !== "") return value;
    }
  }
  return undefined;
}

/**
 * Reduce a written reference to a bare path. Handles the three shapes a path
 * takes in an issue: inline code, a markdown link, and a GitHub blob URL.
 */
function bareReference(value: string): string {
  let text = value.trim();
  const link = /\[[^\]]*\]\(([^)]+)\)/.exec(text);
  if (link) text = link[1].trim();
  text = text.replace(/^[`<'"]+|[`>'"]+$/g, "").trim();
  // github.com/<owner>/<repo>/blob|tree/<ref>/<path>: only the path matters,
  // and the ref may itself contain slashes only before the path we want, so
  // the specs-root scan below is what actually locates it.
  const blob = /https?:\/\/[^\s)]*?\/(?:blob|tree)\/(.+)$/.exec(text);
  if (blob) text = blob[1];
  return text.replace(/^\/+/, "");
}

/**
 * First spec directory named inside a piece of text: the configured specs root
 * followed by one path segment. Anything deeper (a file inside the spec) is
 * cut, since the loop is started on the directory. Scanning the raw text
 * covers every shape at once — a bare path, a markdown link target, and a
 * GitHub blob URL all contain the path verbatim.
 */
function findSpecDir(text: string, specsDir: string): string | undefined {
  const root = specsDir.replace(/\/+$/, "");
  const pattern = new RegExp(`${escapeForRegExp(root)}/([A-Za-z0-9._-]+)`, "g");
  for (const match of text.matchAll(pattern)) {
    // A path ending a sentence swallows the full stop, which is a dot the
    // directory name does not have.
    const segment = match[1].replace(/\.+$/, "");
    if (segment === "") continue;
    // "docs/specs/architecture.md" is a document of the specs root, not a
    // spec: a spec is a directory, so a segment with an extension is skipped
    // and the scan continues — an issue may well cite both.
    if (/\.[A-Za-z0-9]+$/.test(segment)) continue;
    return path.posix.join(root, segment);
  }
  return undefined;
}

/**
 * Resolve what an issue is asking to run. `specsDir` is the project's
 * configured specs root, relative to the project root.
 */
export function resolveIssueRequest(body: string, specsDir: string): IssueSpecResult {
  const text = body ?? "";

  const explicit = keyValue(text, "spec");
  const specDir = findSpecDir(explicit ? bareReference(explicit) : text, specsDir);

  if (!specDir) {
    return {
      ok: false,
      reason: "no-spec-reference",
      detail: explicit
        ? `the spec line does not name a directory under ${specsDir}`
        : `no ${specsDir}/<spec> reference found in the issue body`,
    };
  }

  const request: IssueRunRequest = { specDir };
  const fromTask = keyValue(text, "from-task");
  if (fromTask) request.fromTask = bareReference(fromTask);
  const toTask = keyValue(text, "to-task");
  if (toTask) request.toTask = bareReference(toTask);

  const phase = keyValue(text, "phase");
  if (phase) {
    const name = bareReference(phase).toLowerCase();
    if (!(PHASE_NAMES as readonly string[]).includes(name)) {
      return {
        ok: false,
        reason: "invalid-phase",
        detail: `unknown phase "${name}"; allowed values: ${PHASE_NAMES.join(", ")}`,
      };
    }
    request.phase = name as PhaseName;
  }

  return { ok: true, request };
}
