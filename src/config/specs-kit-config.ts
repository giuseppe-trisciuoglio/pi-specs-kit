/**
 * Typed view over the project's yaml configuration file. Unknown fields are
 * ignored on read (forward compatibility); only the fields modeled here are
 * ever written back.
 */

/** Loop phases that map to an agent role. */
export type PhaseName = "implementation" | "review" | "cleanup" | "sync";

/** Agent roles, one per phase plus the learnings extractor. */
export type RoleName = "agent" | "reviewer" | "cleaner" | "synchronizer" | "learner";

export const ROLE_NAMES: readonly RoleName[] = ["agent", "reviewer", "cleaner", "synchronizer", "learner"];

/** Role responsible for each phase. */
export const PHASE_ROLE: Readonly<Record<PhaseName, RoleName>> = {
  implementation: "agent",
  review: "reviewer",
  cleanup: "cleaner",
  sync: "synchronizer",
};

export interface RoleConfig {
  /** Model pattern/id passed to the agent CLI; "auto" when unset. */
  model: string;
  /** Thinking level flag value; undefined means "agent CLI default". */
  thinkingLevel?: string;
  /**
   * Second model a phase is spawned on, once, when the primary comes back
   * refused or silent. Absent means no escalation: the usual routing applies
   * after the first failure.
   */
  fallbackModel?: string;
}

export interface RunConfig {
  maxAttempts: number;
  /** Wall-clock limit per phase subprocess. */
  timeoutMs: number;
  noCommit: boolean;
  yolo: boolean;
  debugStream: boolean;
  noLogFiles: boolean;
  showPrompt: boolean;
  /**
   * Inline the phase skill content in the prompt instead of only its path.
   * Off by default: the prompt always carries the skill directory, so an agent
   * that needs the procedure reads it once, while inlining pays for the whole
   * file at every turn of every phase.
   */
  skillContent: boolean;
  verbose: boolean;
  continueOnFailure: boolean;
  fromTask?: string;
  toTask?: string;
  resume: boolean;
  /** Max re-spawns when the review file is missing after a review phase. */
  reviewFileRetry: number;
  /** Agent subprocesses a single task may spend, across all its phases. */
  maxSpawnsPerTask: number;
  /** Agent subprocesses the whole run may spend. */
  maxSpawnsPerRun: number;
  /** Wall-clock limit of the whole run. */
  maxRunDurationMs: number;
  /**
   * Let sync correct source-of-truth context documents (AGENTS.md,
   * architecture.md, ontology.md, .pi/rules) when a consolidated learning
   * contradicts them. Editing the project's own instructions is a
   * trust-boundary change, so it stays opt-in.
   */
  reconcileContext: boolean;
  /**
   * Refuse an implementation attempt that rewrote the requirement document or
   * an interface contract of the spec. On by default: an agent allowed to edit
   * what it is measured against can close any mismatch by moving the target.
   * Turn it off only for a run whose job is to revise those documents.
   */
  protectSpecArtifacts: boolean;
}

export type HookStage = "pre" | "post";

export interface PhaseHooks {
  pre: string[];
  post: string[];
}

export interface HooksConfig {
  /** Timeout for each hook command. */
  timeoutMs: number;
  implementation: PhaseHooks;
  review: PhaseHooks;
  cleanup: PhaseHooks;
  sync: PhaseHooks;
}

/**
 * One member of the adversarial review panel. The panel is declared, never
 * inferred from the models the CLI happens to expose: several providers bill
 * per token on every model they list, so picking one automatically would spend
 * on a model the operator never chose.
 */
export interface PanelReviewer {
  /** Model id passed to the agent CLI, as "provider/model". */
  model: string;
  /** Thinking level for this reviewer; undefined means "agent CLI default". */
  thinkingLevel?: string;
}

/**
 * Critique angle of each panel slot, in order. The names are what the review
 * skill assigns to the reviewers and what the configuration menu shows, so the
 * operator sees which angle they are choosing a model for.
 */
export const PANEL_PERSONAS: readonly string[] = ["The Adversary", "The Operator", "The Executor", "The Historian"];

/** Panel slots the configuration accepts; every extra reviewer is another billed run. */
export const MAX_PANEL_REVIEWERS = PANEL_PERSONAS.length;

export interface SystemPromptOverride {
  mode: "append" | "replace";
  source: "file" | "text";
  file?: string;
  text?: string;
}

export interface PromptsConfig {
  /** Behavior when an override cannot be honored: error out or warn and skip. */
  unsupportedPolicy: "error" | "skip";
  /** Per phase overrides for the (only) supported agent. */
  phaseOverrides: Partial<Record<PhaseName, SystemPromptOverride>>;
}

export interface SpecsKitConfig {
  version: string;
  /** Absolute path of the project root (directory holding the config file). */
  projectRoot: string;
  /** Absolute path of the config file that was loaded. */
  configPath: string;
  /** Directory containing the specs, relative to projectRoot as configured. */
  specsDir: string;
  /** Active spec path (relative to projectRoot), when set. */
  spec?: string;
  mode: "fast" | "full";
  pollIntervalMs: number;
  roles: Record<RoleName, RoleConfig>;
  /** Declared adversarial review panel, in persona order; empty when unset. */
  reviewPanel: PanelReviewer[];
  run: RunConfig;
  git: { baseBranch: string };
  hooks: HooksConfig;
  knowledgeBase: { files: string[] };
  prompts: PromptsConfig;
}

/** Defaults shared by the loader and by the file created for a new project. */
export const CONFIG_VERSION = "1";
export const DEFAULT_SPECS_DIR = "docs/specs";
export const DEFAULT_BASE_BRANCH = "main";

export const DEFAULT_RUN_CONFIG: RunConfig = {
  maxAttempts: 5,
  timeoutMs: 60 * 60 * 1000,
  noCommit: true,
  yolo: true,
  debugStream: true,
  noLogFiles: false,
  showPrompt: true,
  skillContent: false,
  verbose: false,
  continueOnFailure: false,
  resume: false,
  reviewFileRetry: 3,
  maxSpawnsPerTask: 8,
  maxSpawnsPerRun: 60,
  maxRunDurationMs: 6 * 60 * 60 * 1000,
  reconcileContext: false,
  protectSpecArtifacts: true,
};

export function defaultRoles(): Record<RoleName, RoleConfig> {
  const roles = {} as Record<RoleName, RoleConfig>;
  for (const role of ROLE_NAMES) roles[role] = { model: "auto" };
  return roles;
}

export function defaultHooks(): HooksConfig {
  const empty = (): PhaseHooks => ({ pre: [], post: [] });
  return {
    timeoutMs: 240_000,
    implementation: empty(),
    review: empty(),
    cleanup: empty(),
    sync: empty(),
  };
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { parseDurationMs } from "../util/duration.ts";

/** Default config file name, looked up directly under the project root. */
export const CONFIG_FILE_NAME = "specs-kit.yaml";

export const PHASE_NAMES = Object.keys(PHASE_ROLE) as PhaseName[];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Coerce scalars to string; anything else is treated as absent. */
function text(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A counter from the config file. Values below `min` are treated as absent:
 * `max_attempts: 0` would otherwise make every task fail without running a
 * single phase, and the run would still look like a success.
 */
function count(value: unknown, min = 0): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored < min ? undefined : floored;
}

/**
 * A duration that has to actually bound something. Zero is rejected instead of
 * being read as "no limit": a phase subprocess without a wall-clock limit is
 * how an agent that never returns keeps spending tokens until somebody
 * notices. Absent or unparseable values fall back to the default.
 */
function positiveDuration(value: unknown, file: string, field: string): number | undefined {
  const ms = parseDurationMs(value);
  if (ms === undefined) return undefined;
  if (ms <= 0) {
    throw new Error(`cannot load config file ${file}: ${field} must be greater than zero (write a unit, e.g. "1h")`);
  }
  return ms;
}

/**
 * Read the declared review panel. An entry is either a bare model string or a
 * map with a model and an optional thinking level; entries naming no model are
 * dropped, since there is nothing to spawn for them. Extra reviewers beyond the
 * supported slots are cut: each one is another billed run.
 */
function panelReviewers(value: unknown): PanelReviewer[] {
  if (!Array.isArray(value)) return [];
  const reviewers: PanelReviewer[] = [];
  for (const entry of value) {
    const model = typeof entry === "string" ? text(entry) : text(record(entry).model);
    if (model === undefined) continue;
    const thinkingLevel = typeof entry === "string" ? undefined : text(record(entry).thinking);
    reviewers.push(thinkingLevel === undefined ? { model } : { model, thinkingLevel });
    if (reviewers.length === MAX_PANEL_REVIEWERS) break;
  }
  return reviewers;
}

/** Normalize a single command string or a list of command strings to a list. */
function commandList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * Load the yaml config into its typed view, filling defaults for anything
 * absent. A missing file yields an all-default config; malformed yaml raises
 * an error naming the offending file.
 */
export async function loadSpecsKitConfig(projectRoot: string, configPath?: string): Promise<SpecsKitConfig> {
  const file = path.resolve(projectRoot, configPath ?? CONFIG_FILE_NAME);
  const config: SpecsKitConfig = {
    version: CONFIG_VERSION,
    projectRoot: path.resolve(projectRoot),
    configPath: file,
    specsDir: DEFAULT_SPECS_DIR,
    mode: "fast",
    pollIntervalMs: 100,
    roles: defaultRoles(),
    reviewPanel: [],
    run: { ...DEFAULT_RUN_CONFIG },
    git: { baseBranch: DEFAULT_BASE_BRANCH },
    hooks: defaultHooks(),
    knowledgeBase: { files: [] },
    prompts: { unsupportedPolicy: "error", phaseOverrides: {} },
  };

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return config;
    throw err;
  }

  let doc: Record<string, unknown>;
  try {
    doc = record(YAML.parse(raw));
  } catch (err: unknown) {
    throw new Error(`cannot parse config file ${file}: ${(err as Error).message}`);
  }

  config.version = text(doc.version) ?? config.version;
  config.specsDir = text(doc.specs_dir) ?? config.specsDir;
  config.spec = text(doc.spec);
  config.mode = doc.mode === "full" ? "full" : "fast";
  config.pollIntervalMs = parseDurationMs(doc.poll_interval) ?? config.pollIntervalMs;

  const agents = record(doc.agents);
  for (const role of ROLE_NAMES) {
    config.roles[role] = {
      model: text(agents[`${role}_model`]) ?? "auto",
      thinkingLevel: text(agents[`${role}_thinking_level`]),
      fallbackModel: text(agents[`${role}_fallback_model`]),
    };
  }

  config.reviewPanel = panelReviewers(record(doc.adversarial_review).panel);

  const src = record(doc.run);
  const run = config.run;
  run.maxAttempts = count(src.max_attempts, 1) ?? run.maxAttempts;
  run.timeoutMs = positiveDuration(src.timeout, file, "run.timeout") ?? run.timeoutMs;
  run.noCommit = flag(src.no_commit) ?? run.noCommit;
  run.yolo = flag(src.yolo) ?? run.yolo;
  run.debugStream = flag(src.debug_stream) ?? run.debugStream;
  run.noLogFiles = flag(src.no_log_files) ?? run.noLogFiles;
  run.showPrompt = flag(src.show_prompt) ?? run.showPrompt;
  run.skillContent = flag(src.skill_content) ?? run.skillContent;
  run.verbose = flag(src.verbose) ?? run.verbose;
  run.continueOnFailure = flag(src.continue_on_failure) ?? run.continueOnFailure;
  run.resume = flag(src.resume) ?? run.resume;
  run.reviewFileRetry = count(src.review_file_retry) ?? run.reviewFileRetry;
  run.maxSpawnsPerTask = count(src.max_spawns_per_task, 1) ?? run.maxSpawnsPerTask;
  run.maxSpawnsPerRun = count(src.max_spawns_per_run, 1) ?? run.maxSpawnsPerRun;
  run.maxRunDurationMs = positiveDuration(src.max_run_duration, file, "run.max_run_duration") ?? run.maxRunDurationMs;
  run.reconcileContext = flag(src.reconcile_context) ?? run.reconcileContext;
  run.protectSpecArtifacts = flag(src.protect_spec_artifacts) ?? run.protectSpecArtifacts;
  const fromTask = text(src.from_task);
  if (fromTask !== undefined) run.fromTask = fromTask;
  const toTask = text(src.to_task);
  if (toTask !== undefined) run.toTask = toTask;

  config.git.baseBranch = text(record(doc.git).baseBranch) ?? config.git.baseBranch;

  const hooks = record(doc.hooks);
  config.hooks.timeoutMs = positiveDuration(hooks.timeout, file, "hooks.timeout") ?? config.hooks.timeoutMs;
  for (const phase of PHASE_NAMES) {
    const ph = record(hooks[phase]);
    config.hooks[phase] = { pre: commandList(ph.pre), post: commandList(ph.post) };
  }

  config.knowledgeBase.files = commandList(record(doc.knowledge_base).files);

  const overrides = record(record(doc.prompts).system_overrides);
  config.prompts.unsupportedPolicy = overrides.unsupported_policy === "skip" ? "skip" : "error";
  const pi = record(record(overrides.agent_phase).pi);
  for (const phase of PHASE_NAMES) {
    const o = record(pi[phase]);
    const mode = o.mode === "append" || o.mode === "replace" ? o.mode : undefined;
    const source = o.source === "file" || o.source === "text" ? o.source : undefined;
    if (!mode || !source) continue;
    config.prompts.phaseOverrides[phase] = { mode, source, file: text(o.file), text: text(o.text) };
  }

  return config;
}
