/**
 * Keeping the codebase graph current while the loop runs. Not to be confused
 * with the task graph under `graph/`: this one is the map of the project that
 * graphify builds and the phases read.
 *
 * The sync phase refreshes it, but sync is an agent session and in fast mode it
 * runs once per range — so a long run spends most of its tasks reading a map of
 * a codebase that no longer exists, with nothing to signal the gap. graphify's
 * own `update` re-extracts the code with no model call behind it, which makes a
 * refresh cheap enough to run once per task instead.
 *
 * Only the code half is refreshed this way; doc, paper and image nodes still
 * need the agent-driven pass the sync phase performs. That is the half that
 * actually decays here, because the loop's own tasks are what change the code.
 */

import { spawnProcess } from "../util/process.ts";

/** Ceiling for one refresh. Generous: a cold cache on a large repo is slower
 * than the seconds a warm one takes, and the loop would rather wait than skip. */
export const GRAPH_REFRESH_TIMEOUT_MS = 120_000;

export type GraphRefreshStatus =
  /** The graph was re-extracted. */
  | "refreshed"
  /** graphify is not installed; the loop already warned about that at start. */
  | "unavailable"
  /** It ran and failed, or outlived its ceiling. */
  | "failed";

export interface GraphRefreshResult {
  status: GraphRefreshStatus;
  /** graphify's own last line, kept for the operator when it has something to say. */
  detail: string;
}

/** The summary line graphify prints, e.g. "Rebuilt: 1577 nodes, 6886 edges". */
function summarize(stdout: string): string {
  const rebuilt = /Rebuilt:[^\n]*/.exec(stdout);
  if (rebuilt) return rebuilt[0].trim();
  const lines = stdout.trim().split("\n").filter((l) => l.trim() !== "");
  return lines.at(-1)?.trim() ?? "";
}

/**
 * Re-extract the code files into the codebase graph. Best-effort throughout: a
 * missing binary, a non-zero exit or a timeout all leave the existing graph
 * alone and report back, because a stale map is still better than a halted run.
 *
 * `--force` is deliberately not passed. graphify refuses to overwrite a graph
 * with a smaller one unless told to, which is its guard against a half-read
 * tree; a task that legitimately deletes code will have its shrink applied by
 * the sync phase, where a human-reviewed pass can vouch for it.
 */
export async function refreshCodebaseGraph(projectRoot: string): Promise<GraphRefreshResult> {
  let res;
  try {
    res = await spawnProcess("graphify", ["update", projectRoot], {
      cwd: projectRoot,
      timeoutMs: GRAPH_REFRESH_TIMEOUT_MS,
    });
  } catch {
    // Nothing to spawn: graphify is not on PATH.
    return { status: "unavailable", detail: "" };
  }
  if (res.timedOut) return { status: "failed", detail: "graphify update timed out" };
  if (res.exitCode !== 0) {
    // A missing binary surfaces as a shell failure rather than a throw on some
    // platforms; it is the one non-zero exit that is not worth a warning,
    // because loop start already said graphify is absent.
    const output = `${res.stderr}\n${res.stdout}`;
    if (/command not found|not found|ENOENT|No such file/i.test(output) && res.stdout.trim() === "") {
      return { status: "unavailable", detail: "" };
    }
    return { status: "failed", detail: summarize(output) || `graphify update exited ${res.exitCode}` };
  }
  return { status: "refreshed", detail: summarize(res.stdout) };
}

/**
 * Warning shown when a refresh could not run. The loop keeps going on the graph
 * it already has, so this says what the phases are now reading rather than
 * treating the failure as fatal.
 */
export function graphRefreshFailedWarning(detail: string): string {
  return (
    `[specs-kit] could not refresh the codebase graph (${detail || "graphify update failed"}): ` +
    "the phases read the graph as it was, which may predate the tasks already completed in this run."
  );
}
