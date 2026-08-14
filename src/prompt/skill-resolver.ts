/**
 * Phase skill resolution: each loop phase is backed by a skill directory on
 * disk. Resolution searches a short list of well-known locations in order and
 * returns null when the skill is missing; the caller warns and proceeds
 * without a skill block in the prompt.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PhaseName } from "../config/specs-kit-config.ts";

/**
 * Absolute path of the bundled skill fork shipped inside this package. Resolved
 * from this module's location so it holds both under `pi -e` from the repo and
 * from an installed package. The loop reads phase skills from here first, so it
 * uses the pi-native fork regardless of any same-named skills installed globally.
 */
export const BUNDLED_SKILLS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
);

/** Skill backing each phase. */
export const PHASE_SKILL: Readonly<Record<PhaseName, string>> = {
  implementation: "specs-kit-task-implementation",
  review: "specs-kit-task-review",
  cleanup: "specs-kit-code-cleanup",
  sync: "specs-kit-sync",
};

export interface ResolvedSkill {
  /** Skill name as configured for the phase. */
  name: string;
  /** Absolute path of the skill directory. */
  dir: string;
  /** Absolute path of the SKILL.md file. */
  skillPath: string;
  /** Full content of SKILL.md. */
  content: string;
}

export interface ResolveSkillOptions {
  /** Home directory override; defaults to os.homedir(). */
  homeDir?: string;
  /** Extra skill directories searched first (mainly for tests). */
  extraDirs?: string[];
  /** Override the bundled fork dir; null disables it. Defaults to the packaged fork. */
  bundledDir?: string | null;
}

/**
 * Find and read a skill by name. Search order: the bundled fork, then
 * extraDirs as given, then <home>/.agents/skills/<name>/SKILL.md, then
 * <home>/.pi/agent/skills/<name>/SKILL.md. Returns null when not found.
 * Reading the fork directly here — rather than relying on pi's /skill:
 * discovery — means every consumer (loop phase prompts and authoring
 * commands) uses the pi-native version regardless of name collisions.
 */
export async function resolveSkill(
  name: string,
  opts: ResolveSkillOptions = {},
): Promise<ResolvedSkill | null> {
  const home = opts.homeDir ?? os.homedir();
  const bundled = opts.bundledDir === undefined ? BUNDLED_SKILLS_DIR : opts.bundledDir;
  const dirs = [
    ...(bundled ? [path.join(bundled, name)] : []),
    ...(opts.extraDirs ?? []),
    path.join(home, ".agents", "skills", name),
    path.join(home, ".pi", "agent", "skills", name),
  ];
  for (const dir of dirs) {
    const skillPath = path.join(dir, "SKILL.md");
    try {
      const content = await readFile(skillPath, "utf8");
      return { name, dir, skillPath, content };
    } catch {
      // Not in this location; keep searching.
    }
  }
  return null;
}

/** Resolve the skill backing a loop phase. */
export async function resolvePhaseSkill(
  phase: PhaseName,
  opts: ResolveSkillOptions = {},
): Promise<ResolvedSkill | null> {
  return resolveSkill(PHASE_SKILL[phase], opts);
}
