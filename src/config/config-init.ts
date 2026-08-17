/**
 * Bootstrap of the project configuration file. A project that has never used
 * the extension has no yaml at all: the loader copes (every field falls back to
 * its default), but the operator then has nothing to edit and no idea which
 * knobs exist. Authoring a new spec is the first command such a project runs,
 * so that is where the file is materialized, with the defaults written out
 * explicitly.
 */

import { writeFile } from "node:fs/promises";
import YAML from "yaml";
import { formatDurationMs } from "../util/duration.ts";
import {
  CONFIG_VERSION,
  DEFAULT_BASE_BRANCH,
  DEFAULT_RUN_CONFIG,
  DEFAULT_SPECS_DIR,
  PHASE_NAMES,
  ROLE_NAMES,
  defaultHooks,
} from "./specs-kit-config.ts";

/**
 * Render the default configuration as yaml. Values come from the same
 * constants the loader falls back to, so the generated file describes the
 * behavior the project would have had without it.
 */
export function defaultConfigYaml(): string {
  const run = DEFAULT_RUN_CONFIG;
  const hooks = defaultHooks();
  const doc = new YAML.Document({
    version: CONFIG_VERSION,
    specs_dir: DEFAULT_SPECS_DIR,
    mode: "fast",
    // "auto" leaves the model choice to the agent CLI; replace with a model id
    // per role to pin it.
    agents: Object.fromEntries(ROLE_NAMES.map((role) => [`${role}_model`, "auto"])),
    run: {
      max_attempts: run.maxAttempts,
      // Durations always take a unit: a bare number is read as milliseconds.
      timeout: formatDurationMs(run.timeoutMs),
      no_commit: run.noCommit,
      yolo: run.yolo,
      debug_stream: run.debugStream,
      no_log_files: run.noLogFiles,
      show_prompt: run.showPrompt,
      skill_content: run.skillContent,
      verbose: run.verbose,
      continue_on_failure: run.continueOnFailure,
      resume: run.resume,
      review_file_retry: run.reviewFileRetry,
      max_spawns_per_task: run.maxSpawnsPerTask,
      max_spawns_per_run: run.maxSpawnsPerRun,
      max_run_duration: formatDurationMs(run.maxRunDurationMs),
      // Refuses an attempt that rewrote the spec's requirement document or one
      // of its contracts: what the work is measured against is not the work's
      // to edit.
      protect_spec_artifacts: run.protectSpecArtifacts,
    },
    // Empty on purpose: the review panel is declared model by model, because
    // reviewing spends on every model listed here.
    adversarial_review: { panel: [] },
    git: { baseBranch: DEFAULT_BASE_BRANCH },
    hooks: {
      timeout: formatDurationMs(hooks.timeoutMs),
      ...Object.fromEntries(PHASE_NAMES.map((phase) => [phase, { pre: [], post: [] }])),
    },
    knowledge_base: { files: [] },
  });
  doc.commentBefore =
    " specs-kit configuration. Every value below is the default;" +
    "\n edit what you need, unknown fields are ignored." +
    "\n The active spec is written here as `spec:` when one is selected.";
  return String(doc);
}

/**
 * Create the configuration file with the default values when it is missing.
 * Returns whether the file was created. Never touches an existing file, not
 * even an unreadable or malformed one: the exclusive write is what makes the
 * check-and-create a single step, so two commands racing cannot overwrite a
 * config the operator has already edited.
 */
export async function ensureConfigFile(configPath: string): Promise<boolean> {
  try {
    await writeFile(configPath, defaultConfigYaml(), { flag: "wx" });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new Error(`cannot create config file ${configPath}: ${(err as Error).message}`);
  }
}
