/**
 * Action of the reading-brief node: one cheap, read-only spawn before the
 * first implementation attempt, writing the brief file every attempt of the
 * task then receives. The node is deliberately a pass-through for failures:
 * a brief that came back empty or refused is a lost optimization, not a
 * failed attempt — the implementation falls back to doing its own
 * reconnaissance, exactly as it did before the node existed.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectLearnings } from "../learner.ts";
import { briefFileName } from "../brief.ts";
import type { NodeAction, TaskNodeEnv } from "./types.ts";

export interface BriefNodeActions {
  brief: NodeAction;
}

/** Relative path of the brief of one task, from the spec folder. */
export function briefRelPath(taskId: string): string {
  return path.posix.join("tasks", briefFileName(taskId));
}

/**
 * Read the brief of a task back, best-effort: every implementation attempt
 * calls this, so a missing or unreadable file simply leaves the attempt
 * without the block instead of failing the phase.
 */
export async function readBrief(specDir: string, taskId: string): Promise<string | null> {
  try {
    const text = await readFile(path.join(specDir, briefRelPath(taskId)), "utf8");
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}

/** Bind the brief node action to one task: dependencies, plan and files. */
export function makeBriefNodeActions(env: TaskNodeEnv): BriefNodeActions {
  const { deps, plan, taskFile } = env;
  const { config, specDir, executor, notify } = deps;
  const id = taskFile.frontmatter.id;

  return {
    brief: async (io) => {
      if (deps.stopping()) return { kind: "stopped" };
      // The step stays "implementation": the brief is part of entering the
      // first attempt, not a resume point of its own — a run killed here
      // resumes at the attempt, which regenerates nothing and simply does
      // without the brief when the file never landed.
      await deps.persist(plan);
      const briefPath = briefRelPath(id);
      let projectLearnings: string[] | undefined;
      try {
        projectLearnings = await loadProjectLearnings(config.projectRoot, config.specsDir);
      } catch {
        // Project learnings are optional.
      }
      const br = await executor.runBrief(taskFile, {
        signal: deps.signal(),
        briefPath,
        routedSuggestions: io.runtime.routedSuggestions,
        learnings: plan.learnings,
        projectLearnings,
      });
      if (deps.stopping() === "now") return { kind: "stopped" };
      const text = br.text.trim();
      // The brief agent owns the file, but an answer that stayed in the
      // transcript is still worth keeping: the attempt reads the file, not
      // the log. Persisting the captured text here keeps the two equivalent.
      if (!(await readBrief(specDir, id)) && text !== "") {
        try {
          await mkdir(path.dirname(path.join(specDir, briefPath)), { recursive: true });
          await writeFile(path.join(specDir, briefPath), text, "utf8");
        } catch {
          notify(`cannot write the brief of ${id}, continuing without it`, "warning");
          return { kind: "ok" };
        }
      }
      if (!(await readBrief(specDir, id))) {
        notify(`brief produced nothing for ${id}, continuing without it`, "warning");
        return { kind: "ok" };
      }
      io.runtime.briefPath = briefPath;
      return { kind: "ok" };
    },
  };
}
