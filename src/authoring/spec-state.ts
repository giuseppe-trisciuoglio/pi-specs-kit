/**
 * Derive the next authoring step of a spec from the artifacts already on
 * disk. Pure filesystem inspection: no skill resolution, no pi wiring, so it
 * unit-tests with a throwaway directory. The pipeline is
 * brainstorm -> spec-check -> technical-plan -> spec-to-tasks -> ready.
 *
 * Stage is inferred from what each authoring skill leaves behind:
 *  - a functional spec is a top-level date-prefixed markdown file (the
 *    brainstorm step also writes aux files that must not be mistaken for it);
 *  - open questions are inline markers the spec-check step resolves in place;
 *  - the technical plan is a dedicated date-prefixed file;
 *  - the task list lives under tasks/ as TASK-*.md.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isTaskFileName } from "../tasks/task-files.ts";

export type AuthoringStage = "brainstorm" | "spec-check" | "technical-plan" | "spec-to-tasks" | "ready";

export interface AuthoringStep {
  stage: AuthoringStage;
  /** Bundled skill to inline for this step (empty for "ready"). */
  skillName: string;
  /** Instruction appended after the skill content; paths already resolved. */
  directive: string;
  /** One-line human summary for notifications. */
  summary: string;
}

const TECHNICAL_PLAN = /^\d{4}-\d{2}-\d{2}--technical-plan\.md$/;
const NEEDS_CLARIFICATION = /\[NEEDS CLARIFICATION/i;

/**
 * Markdown written at the spec root that is *not* a functional spec: the
 * brainstorm side artifacts plus the downstream files spec-to-tasks emits
 * (see specs-kit-spec-to-tasks/SKILL.md). Without these, a half-finished
 * spec-to-tasks run leaves generated artifacts that get scanned as specs.
 */
const AUX_FILES = new Set([
  "user-request.md",
  "brainstorming-notes.md",
  "decision-log.md",
  "data-model.md",
  "traceability-matrix.md",
]);

/** The `YYYY-MM-DD--name--tasks.md` index, also a spec-to-tasks artifact. */
const TASKS_INDEX = /--tasks\.md$/i;

interface SpecScan {
  specFiles: string[];
  hasTechnicalPlan: boolean;
  hasTasks: boolean;
  /** The spec file carrying open questions, when any. */
  clarificationFile: string | null;
}

/** True when the spec's tasks/ holds at least one file the loader parses. */
async function hasTaskFiles(specDirAbs: string): Promise<boolean> {
  try {
    const sub = await readdir(path.join(specDirAbs, "tasks"));
    return sub.some(isTaskFileName);
  } catch {
    // No tasks directory or unreadable.
    return false;
  }
}

/** The first spec file, in the deterministic order of the scan, that carries
 * open questions. A file that cannot be read is assumed to carry none. */
async function findClarificationFile(
  specDirAbs: string,
  specFiles: readonly string[],
): Promise<string | null> {
  for (const name of specFiles) {
    try {
      const text = await readFile(path.join(specDirAbs, name), "utf8");
      if (NEEDS_CLARIFICATION.test(text)) return name;
    } catch {
      // Unreadable file: assume it carries no open questions.
    }
  }
  return null;
}

async function scanSpec(specDirAbs: string): Promise<SpecScan | null> {
  let entries: string[];
  try {
    entries = await readdir(specDirAbs);
  } catch {
    return null;
  }
  const specFiles: string[] = [];
  let hasTechnicalPlan = false;
  let hasTasks = false;
  for (const name of entries) {
    if (name === "tasks") {
      if (!hasTasks) hasTasks = await hasTaskFiles(specDirAbs);
      continue;
    }
    if (!name.endsWith(".md") || AUX_FILES.has(name) || TASKS_INDEX.test(name)) continue;
    if (TECHNICAL_PLAN.test(name)) hasTechnicalPlan = true;
    else specFiles.push(name);
  }
  // Deterministic order: the directive below names one of these files, and
  // readdir order is not guaranteed.
  specFiles.sort((a, b) => a.localeCompare(b));
  const clarificationFile = await findClarificationFile(specDirAbs, specFiles);
  return { specFiles, hasTechnicalPlan, hasTasks, clarificationFile };
}

/**
 * Decide what the next authoring step is for a spec directory (relative to
 * the project root). The returned directive names the spec by that same
 * relative path so the agent writes into the right place.
 */
export async function deriveAuthoringStep(projectRoot: string, specDirRel: string): Promise<AuthoringStep> {
  const abs = path.resolve(projectRoot, specDirRel);
  const scan = await scanSpec(abs);
  if (!scan || scan.specFiles.length === 0) {
    return {
      stage: "brainstorm",
      skillName: "specs-kit-brainstorm",
      directive:
        `Author a new functional specification for the active spec at ${specDirRel}/. ` +
        "Read the skill's templates from its directory when needed. " +
        `When you have written the spec, call the specs_kit_set_active_spec tool with ${specDirRel} so it stays the active spec.`,
      summary: "no functional spec yet — brainstorm the feature",
    };
  }
  if (scan.hasTasks) {
    return {
      stage: "ready",
      skillName: "",
      directive: "",
      summary: "tasks exist — the spec is ready for /specs-kit-run",
    };
  }
  if (scan.clarificationFile) {
    const file = scan.clarificationFile;
    return {
      stage: "spec-check",
      skillName: "specs-kit-spec-check",
      directive:
        `Apply this spec-check skill to the functional specification at ${specDirRel}/${file}. ` +
        "Resolve every open question directly in that file.",
      summary: "open questions remain — run the spec-check",
    };
  }
  if (!scan.hasTechnicalPlan) {
    return {
      stage: "technical-plan",
      skillName: "specs-kit-technical-plan",
      directive: `Generate the technical plan for the active spec at ${specDirRel}/.`,
      summary: "functional spec ready — produce the technical plan",
    };
  }
  return {
    stage: "spec-to-tasks",
    skillName: "specs-kit-spec-to-tasks",
    directive: `Generate the task list for the active spec at ${specDirRel}/.`,
    summary: "technical plan ready — generate the tasks",
  };
}
