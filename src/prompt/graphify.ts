/**
 * Graphify availability check. The sync phase projects the codebase graph
 * built by the external graphify skill onto the spec's Knowledge Graph, so
 * graphify is the mandatory source of that projection — it is never shipped
 * with this package. This module locates graphify among the well-known skill
 * directories and produces the operator warning, without importing anything
 * from pi so it stays unit-testable in isolation.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveSkill, type ResolvedSkill } from "./skill-resolver.ts";

/** Name of the external skill that builds the codebase graph. */
export const GRAPHIFY_SKILL_NAME = "graphify";

/** Directory graphify writes its codebase graph into, relative to a project root. */
export const GRAPHIFY_GRAPH_REL = path.join("graphify-out", "graph.json");

export interface FindGraphifyOptions {
  /** Home directory override; defaults to os.homedir(). */
  homeDir?: string;
  /** Extra skill directories searched before the well-known ones (mainly tests). */
  extraDirs?: string[];
}

/**
 * Locate the graphify skill in the user's skill directories. Returns null
 * when it is not installed. The bundled fork is deliberately excluded:
 * graphify is an external tool, never shipped with this package, so only the
 * shared skill locations are searched.
 */
export async function findGraphifySkill(opts: FindGraphifyOptions = {}): Promise<ResolvedSkill | null> {
  return resolveSkill(GRAPHIFY_SKILL_NAME, {
    bundledDir: null,
    homeDir: opts.homeDir,
    extraDirs: opts.extraDirs,
  });
}

/**
 * Absolute path of the codebase graph graphify produces for a project root.
 * Sync projects this file onto the spec's Knowledge Graph, so its presence is
 * what makes the graph-backed validation real rather than a fallback.
 */
export function graphifyGraphPath(projectRoot: string): string {
  return path.join(projectRoot, GRAPHIFY_GRAPH_REL);
}

/** True when the codebase graph exists on disk for a project root. */
export async function graphifyGraphExists(projectRoot: string): Promise<boolean> {
  try {
    await stat(graphifyGraphPath(projectRoot));
    return true;
  } catch {
    return false;
  }
}

/**
 * Warning shown when a sync runs without the codebase graph: the phase still
 * runs (its other duties do not depend on the graph), but graph-backed
 * dependency validation is skipped, so the result is partial. Phrased to be
 * surfaced at sync time, not just at loop start, so the gap cannot hide.
 */
export function graphifyGraphMissingWarning(): string {
  return (
    "[specs-kit] Knowledge Graph not found at graphify-out/graph.json: the sync " +
    "phase will run, but graph-backed dependency validation is skipped, so the " +
    "result is partial. Run /graphify <project-root> before the next sync to " +
    "rebuild it."
  );
}

/**
 * Operator warning shown when a loop starts without the graphify skill
 * installed: the sync phase cannot build the codebase graph without it, so
 * graph-backed validation degrades to its fallback path. The loop keeps
 * running, this is a heads-up, not a blocker.
 */
export function graphifyMissingWarning(): string {
  return (
    "[specs-kit] graphify skill not found: the sync phase needs it to build the " +
    "Knowledge Graph from the codebase. Install it under ~/.agents/skills/graphify " +
    "or ~/.pi/agent/skills/graphify, then run /graphify <project-root>. The loop " +
    "keeps running, but the Knowledge Graph will be unavailable."
  );
}
