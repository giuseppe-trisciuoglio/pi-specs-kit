import { constants } from "node:fs";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import YAML from "yaml";
import type { HookStage, PanelReviewer, PhaseName, RoleName } from "./specs-kit-config.ts";

/**
 * Paths already backed up in this process: the original file is snapshotted
 * once, before the first rewrite, and never overwritten afterwards.
 */
const backedUp = new Set<string>();

/** Monotonic suffix keeping concurrent temp files distinct within a process. */
let tmpCounter = 0;

/**
 * Tail of the in-flight rewrite chain per config path. Read-modify-write is
 * not atomic, so concurrent mutations of the same file are queued instead of
 * racing: without this the last rename wins and the other edit is lost.
 */
const writeQueues = new Map<string, Promise<unknown>>();

export interface RoleUpdate {
  model?: string;
  /** New thinking level; null removes the field, undefined leaves it alone. */
  thinkingLevel?: string | null;
}

/** Scalar keys under the run: section that the config view can edit. */
export type RunField =
  | "max_attempts"
  | "timeout"
  | "no_commit"
  | "yolo"
  | "debug_stream"
  | "no_log_files"
  | "show_prompt"
  | "skill_content"
  | "verbose"
  | "continue_on_failure"
  | "resume"
  | "review_file_retry"
  | "max_spawns_per_task"
  | "max_spawns_per_run"
  | "max_run_duration"
  | "reconcile_context"
  | "protect_spec_artifacts";

export interface RunFieldUpdate {
  field: RunField;
  /** Value to set, or null to delete the key and revert to the default. */
  value: string | number | boolean | null;
}

/** Load the config file (or start an empty document), apply the mutation,
 * then persist atomically with a one-time `.bak` snapshot of the original. */
async function rewriteConfig(configPath: string, mutate: (doc: YAML.Document) => void): Promise<void> {
  const queued = writeQueues.get(configPath) ?? Promise.resolve();
  const run = queued.then(() => rewriteConfigNow(configPath, mutate));
  // The queue tail never rejects: one failed write must neither break the
  // chain for the next caller nor surface as an unhandled rejection.
  const tail = run.catch(() => {});
  writeQueues.set(configPath, tail);
  try {
    await run;
  } finally {
    if (writeQueues.get(configPath) === tail) writeQueues.delete(configPath);
  }
}

async function rewriteConfigNow(configPath: string, mutate: (doc: YAML.Document) => void): Promise<void> {
  let previous: string | undefined;
  let doc: YAML.Document;
  try {
    previous = await readFile(configPath, "utf8");
    doc = YAML.parseDocument(previous);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`cannot load config file ${configPath}: ${(err as Error).message}`);
    }
    doc = new YAML.Document({});
  }

  // parseDocument collects syntax errors instead of throwing and hands back
  // whatever it managed to parse. Rewriting that partial document would
  // silently drop the unparseable sections, so refuse the write and let the
  // operator fix the file — the loader rejects it just the same.
  if (doc.errors.length > 0) {
    throw new Error(`cannot rewrite ${configPath}: invalid YAML (${doc.errors[0].message})`);
  }

  if (!YAML.isMap(doc.contents)) {
    doc.contents = doc.createNode({});
  }
  mutate(doc);

  if (previous !== undefined && !backedUp.has(configPath)) {
    backedUp.add(configPath);
    try {
      await copyFile(configPath, `${configPath}.bak`, constants.COPYFILE_EXCL);
    } catch (err: unknown) {
      // A leftover backup from an earlier run must not be overwritten.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  // Unique per write, not just per process: two concurrent rewrites (a tool
  // call while a config dialog confirms) must not share one temp path, or the
  // second rename drops the first mutation.
  const tmp = `${configPath}.tmp-${process.pid}-${tmpCounter++}`;
  await writeFile(tmp, String(doc));
  await rename(tmp, configPath);
}

/** Return the top-level map entry as a map, replacing whatever was there. */
function ensureMap(doc: YAML.Document, key: string): YAML.YAMLMap {
  if (!YAML.isMap(doc.get(key, true))) {
    doc.set(key, doc.createNode({}));
  }
  // Guaranteed a map by the normalization just above.
  return doc.get(key, true) as YAML.YAMLMap;
}

/** Same as ensureMap, one level down inside a parent map. */
function ensureChildMap(doc: YAML.Document, parent: YAML.YAMLMap, key: string): YAML.YAMLMap {
  if (!YAML.isMap(parent.get(key, true))) {
    parent.set(key, doc.createNode({}));
  }
  return parent.get(key, true) as unknown as YAML.YAMLMap;
}

/**
 * Surgically update `agents.<role>_model` / `agents.<role>_thinking_level` in
 * the config file, leaving every other field untouched. A missing file is
 * created with a minimal agents section.
 */
export async function updateRoleConfig(
  configPath: string,
  role: RoleName,
  update: RoleUpdate,
): Promise<void> {
  await rewriteConfig(configPath, (doc) => {
    const agents = ensureMap(doc, "agents");
    if (update.model !== undefined) agents.set(`${role}_model`, update.model);
    if (update.thinkingLevel === null) {
      agents.delete(`${role}_thinking_level`);
    } else if (update.thinkingLevel !== undefined) {
      agents.set(`${role}_thinking_level`, update.thinkingLevel);
    }
  });
}

/**
 * Replace the declared adversarial review panel
 * (`adversarial_review.panel`), leaving every other field untouched. The list
 * is written whole rather than merged: a reviewer removed from the panel has to
 * disappear from the file, or the next review still spends on a model the
 * operator just took out. An empty list clears the panel.
 */
export async function updateReviewPanel(configPath: string, reviewers: PanelReviewer[]): Promise<void> {
  await rewriteConfig(configPath, (doc) => {
    const entries = reviewers.map((reviewer) =>
      reviewer.thinkingLevel === undefined
        ? { model: reviewer.model }
        : { model: reviewer.model, thinking: reviewer.thinkingLevel },
    );
    ensureMap(doc, "adversarial_review").set("panel", doc.createNode(entries));
  });
}

/**
 * Replace the command list of one hook stage (`hooks.<phase>.<stage>`),
 * creating the hooks section when absent and leaving sibling stages, phases
 * and the timeout untouched. An empty list clears the stage.
 */
export async function updatePhaseHooks(
  configPath: string,
  phase: PhaseName,
  stage: HookStage,
  commands: string[],
): Promise<void> {
  await rewriteConfig(configPath, (doc) => {
    const hooks = ensureMap(doc, "hooks");
    const phaseMap = ensureChildMap(doc, hooks, phase);
    phaseMap.set(stage, doc.createNode(commands));
  });
}

/**
 * Update the shared hook timeout (`hooks.timeout`), keeping the per-phase
 * command lists as they are. The value is stored verbatim (e.g. "240s").
 */
export async function updateHooksTimeout(configPath: string, timeout: string): Promise<void> {
  await rewriteConfig(configPath, (doc) => {
    ensureMap(doc, "hooks").set("timeout", timeout);
  });
}

/**
 * Surgically update one or more scalars under run:, leaving every other field
 * (and the rest of the config) untouched. A null value removes the key so the
 * loader falls back to its default; durations are stored verbatim as written
 * (e.g. "40m"), like the hooks timeout.
 */
export async function updateRunConfig(
  configPath: string,
  updates: RunFieldUpdate[],
): Promise<void> {
  await rewriteConfig(configPath, (doc) => {
    const run = ensureMap(doc, "run");
    for (const { field, value } of updates) {
      if (value === null) run.delete(field);
      else run.set(field, value);
    }
  });
}

/**
 * Set the active spec (`spec:`), the single spec the loop and authoring
 * commands default to when `--spec` is absent. Stored verbatim as a path
 * relative to the project root; created at the top level when missing.
 */
export async function updateActiveSpec(configPath: string, specDir: string): Promise<void> {
  await rewriteConfig(configPath, (doc) => {
    doc.set("spec", specDir);
  });
}
