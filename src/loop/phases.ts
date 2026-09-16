/**
 * Phase execution helpers shared by the loop engine: the executor binds the
 * prompt context builder and the spawn/hook runner together into the four
 * executable phases plus the learner subroutines. The engine owns the state
 * machine; the executor only decides how a declared ingress becomes a prompt
 * and a subprocess.
 */

import { PHASE_ROLE, type PhaseName, type SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { TaskFile } from "../tasks/task-parser.ts";
import type { PiStreamEvent } from "../agent/json-stream.ts";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../agent/spawner.ts";
import type { PhaseMeter } from "../measure/phase-meter.ts";
import type { LoopBudget } from "./budget.ts";
import type { ChangedFilesProvider, HookResult } from "./hooks.ts";
import { runPhaseHooks } from "./hooks.ts";
import { changedFilesProvider, runStageHooks } from "./phase-hooks.ts";
import type { changedWorkspaceFiles } from "./workspace.ts";
import { classifyPhaseFailure, DEFAULT_ENVIRONMENT_STREAK, EnvironmentStreakError } from "./phase-failure.ts";
import type { ListedModel } from "./model-check.ts";
import type {
  CleanupPhaseInput,
  ImplementationPhaseInput,
  ReviewPhaseInput,
  SyncPhaseInput,
} from "./phase-inputs.ts";
import { PhaseContext } from "./phase-context.ts";
import { PhaseSpawner, type FailureLearnerInput, type LearnerResult } from "./phase-spawn.ts";

export interface PhaseExecutorDeps {
  config: SpecsKitConfig;
  /** Absolute path of the active spec directory. */
  specDir: string;
  /** Run ceilings, charged once per agent subprocess. */
  budget: LoopBudget;
  spawnPhase: (opts: PhaseSpawnOptions) => Promise<PhaseRunOutcome>;
  runHooks: typeof runPhaseHooks;
  /**
   * Re-read the configuration file before a phase begins, so an operator
   * edit applies from this phase on. Optional: tests that pin the config
   * object directly have nothing to reload.
   */
  refreshConfig?: () => Promise<void>;
  onNotify: (message: string, type: "info" | "warning" | "error") => void;
  /** Forwarded for every stream event, with its formatted log line. */
  onStream: (event: PiStreamEvent, formatted: string | null) => void;
  /** Called with the log file path of each spawned phase. */
  onLogPath: (logPath: string) => void;
  /** Called once per phase subprocess, before it starts. */
  onPhaseStart: () => void;
  /** Called with a formatted log line from hooks or the agent stream. */
  onLogLine: (line: string) => void;
  /**
   * How many consecutive environmental phase failures halt the run.
   * Injectable so tests can pin a small threshold.
   */
  environmentStreakLimit?: number;
  /** Catalogue lookup for the escalation diagnosis; defaults to the real one. */
  listModels?: () => Promise<ListedModel[]>;
  /** Phase measurement; absent in tests that do not care about the ledger. */
  meter?: PhaseMeter;
  /**
   * The files the hooks of this run are told about. Absent means the real
   * reader: what a gate scopes itself to is part of the loop, not of a
   * particular wiring.
   */
  changedWorkspaceFiles?: typeof changedWorkspaceFiles;
}

export interface PhaseStepResult {
  /** False when a pre hook failed: the phase subprocess never started. */
  preHooksOk: boolean;
  hookResults: HookResult[];
  /** False when a post hook failed after the phase subprocess ran. */
  postHooksOk: boolean;
  /** The failed post hooks only; empty when every post hook passed. The
   * caller feeds them to the next attempt instead of re-deriving them from
   * the full result list. */
  failedPostHooks: HookResult[];
  outcome: PhaseRunOutcome | null;
}

export type { SystemPromptOverrideText } from "./phase-context.ts";
export type { FailureLearnerInput, LearnerResult } from "./phase-spawn.ts";
export { buildLearnerPrompt, parseConfirmations, CONFIRMED_PREFIX, MAX_CONFIRMATIONS } from "./phase-spawn.ts";
export { classifyPhaseFailure, environmentFailureMessage, spawnFailed } from "./phase-failure.ts";
export type { PhaseFailure, PhaseFailureKind } from "./phase-failure.ts";

/**
 * Executes the single phases of the loop on behalf of the engine: hooks,
 * prompt, subprocess and per-phase log file. Skills are resolved once per
 * phase (a missing one warns only the first time).
 */
export class PhaseExecutor {
  readonly #deps: PhaseExecutorDeps;
  readonly #context: PhaseContext;
  readonly #spawner: PhaseSpawner;
  /** Consecutive environmental failures seen so far; a delivered phase clears it. */
  #environmentStreak: string[] = [];
  /** What the hooks are told has changed; read lazily, per stage. */
  readonly #changedFiles: ChangedFilesProvider;

  constructor(deps: PhaseExecutorDeps) {
    this.#deps = deps;
    this.#changedFiles = changedFilesProvider(deps.config, deps.specDir, deps.changedWorkspaceFiles);
    this.#context = new PhaseContext({
      config: deps.config,
      specDir: deps.specDir,
      onNotify: deps.onNotify,
      meter: deps.meter,
    });
    this.#spawner = new PhaseSpawner({
      config: deps.config,
      specDir: deps.specDir,
      budget: deps.budget,
      spawnPhase: deps.spawnPhase,
      onNotify: deps.onNotify,
      onStream: deps.onStream,
      onLogPath: deps.onLogPath,
      onPhaseStart: deps.onPhaseStart,
      onLogLine: deps.onLogLine,
      meter: deps.meter,
      warnAutoModel: (role) => this.#context.warnAutoModel(role),
      beginMeter: (spec, task, phase, attempt, role) => this.#context.beginMeter(spec, task, phase, attempt, role),
      listModels: deps.listModels,
    });
  }

  /**
   * Run one of the four executable phases: pre hooks, prompt build, spawn,
   * post hooks. Each phase declares its own ingress type and the overloads
   * tie the phase name to it, so the body can only read what the calling
   * node handed over at the boundary: the fix plan cannot reach the prompt
   * through here. A failed pre hook blocks the phase (the engine counts the
   * attempt); a failed post hook is reported to the caller, which owns what
   * a red gate means for its phase.
   */
  async run(phase: "implementation", input: ImplementationPhaseInput): Promise<PhaseStepResult>;
  async run(phase: "review", input: ReviewPhaseInput): Promise<PhaseStepResult>;
  async run(phase: "cleanup", input: CleanupPhaseInput): Promise<PhaseStepResult>;
  async run(phase: "sync", input: SyncPhaseInput): Promise<PhaseStepResult>;
  async run(
    phase: PhaseName,
    input: ImplementationPhaseInput | ReviewPhaseInput | CleanupPhaseInput | SyncPhaseInput,
  ): Promise<PhaseStepResult> {
    const role = PHASE_ROLE[phase];
    const task = input.task;
    // The reload precedes everything the phase reads — hooks, prompt inputs,
    // role, timeout — so one phase is consistent within a single load. It
    // stays out of the measurement: it is loop housekeeping, not phase work.
    await this.#deps.refreshConfig?.();
    // The node declares how the world is, not what to do: the blocking
    // policy lives here. Inputs that cannot declare an attempt kind (review
    // re-spawns, the end-of-range sync) block on a failing pre-hook, exactly
    // as they did when the flag defaulted on the wide signature.
    const blockOnFailure = "firstAttempt" in input ? input.firstAttempt : true;
    // The handle spans hooks and subprocess alike: the phase duration in the
    // ledger is the whole step, not just the agent session.
    const meterHandle = this.#context.beginMeter(input.specId, task.frontmatter.id, phase, input.attempt, role);
    try {
      const preResults = await this.#runStage(phase, "pre");
      if (preResults.some((r) => !r.ok) && blockOnFailure) {
        return { preHooksOk: false, hookResults: preResults, postHooksOk: true, failedPostHooks: [], outcome: null };
      }
      const { prompt, systemPromptOverride } = await this.#context.buildPrompt(phase, input, preResults);
      const { outcome } = await this.#spawner.spawn(
        { taskId: task.frontmatter.id, label: phase, role, prompt },
        systemPromptOverride,
        input.signal,
        false,
        meterHandle,
      );
      this.#trackEnvironmentStreak(phase, task.frontmatter.id, outcome);
      // The changed files are read again here, after the phase: the point of
      // the post gate is the tree the attempt just left behind, not the one
      // it started from.
      const postResults = await this.#runStage(phase, "post");
      const failedPost = postResults.find((r) => !r.ok);
      if (failedPost) this.#deps.onNotify(`post-${phase} hook failed: ${failedPost.command}`, "warning");
      return {
        preHooksOk: true,
        hookResults: [...preResults, ...postResults],
        postHooksOk: !failedPost,
        failedPostHooks: failedPost ? postResults.filter((r) => !r.ok) : [],
        outcome,
      };
    } finally {
      if (meterHandle) this.#deps.meter?.finishPhase(meterHandle);
    }
  }

  /**
   * Count consecutive environmental failures across phases and tasks. The
   * task-level routing already stops the task that found the outage; this is
   * the run-level answer to the same outage, so the range does not walk on
   * rediscovering it task after task. A delivered phase resets the count: a
   * flaky minute never stops a healthy run.
   */
  #trackEnvironmentStreak(phase: string, taskId: string, outcome: PhaseRunOutcome | null): void {
    const failure = classifyPhaseFailure(outcome);
    if (!failure || (!failure.environment && failure.kind !== "no-output")) {
      this.#environmentStreak = [];
      return;
    }
    this.#environmentStreak.push(`${phase} for ${taskId}: ${failure.kind} — ${failure.detail}`);
    const limit = this.#deps.environmentStreakLimit ?? DEFAULT_ENVIRONMENT_STREAK;
    if (this.#environmentStreak.length >= limit) {
      throw new EnvironmentStreakError([...this.#environmentStreak]);
    }
  }

  /** Run the learner role and capture its textual output. */
  async runLearner(
    task: TaskFile,
    known: readonly string[] = [],
    opts?: { signal?: AbortSignal; candidates?: readonly string[] },
  ): Promise<LearnerResult> {
    return this.#spawner.runLearner(task, known, opts);
  }

  /** Run the failure learner on a dead attempt and capture its output. */
  async runFailureLearner(task: TaskFile, input: FailureLearnerInput): Promise<LearnerResult> {
    return this.#spawner.runFailureLearner(task, input);
  }

  /**
   * Spawn the learner to compact the project-level learnings: deduplicate,
   * merge related entries, and drop outdated insights. Returns the cleaned list.
   */
  async compactLearnings(learnings: string[], opts?: { signal?: AbortSignal }): Promise<string[]> {
    return this.#spawner.compactLearnings(learnings, opts);
  }

  /**
   * Run the hooks of a passed task's checkpoint: the second level of the
   * gate, where the suite the phases cannot afford per attempt belongs. The
   * changed files are handed in rather than read here, because the caller
   * takes them before the checkpoint commit — afterwards nothing differs
   * from HEAD any more.
   */
  async runCheckpointHooks(changedFiles: readonly string[] | null): Promise<HookResult[]> {
    const { config, runHooks, onLogLine } = this.#deps;
    return runStageHooks(runHooks, config, "checkpoint", "post", onLogLine, async () => changedFiles);
  }

  /** One stage of the phase being run, with the log labels it streams under. */
  #runStage(phase: PhaseName, stage: "pre" | "post"): Promise<HookResult[]> {
    const { config, runHooks } = this.#deps;
    return runStageHooks(runHooks, config, phase, stage, (line) => this.#deps.onLogLine(line), this.#changedFiles);
  }

  /** Run a hook command and stream its output through the log channel. */
  async runHook(
    command: string,
    label: string,
    opts?: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<HookResult> {
    return this.#spawner.runHook(command, label, opts);
  }
}
