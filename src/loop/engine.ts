/**
 * Loop engine: run-level orchestration of a spec. Loads the tasks, applies the
 * range, reconciles and persists the fix plan, assembles the run and walks the
 * selection, handing each task to the per-task state machine. Every state
 * mutation is persisted before moving on, so a kill at any point leaves a
 * resumable snapshot; deps are injectable for tests.
 */

import path from "node:path";
import type { PhaseName, SpecsKitConfig } from "../config/specs-kit-config.ts";
import { loadConfigIfPresent } from "./config-reload.ts";
import { saveFixPlan, type FixPlan } from "../fixplan/fix-plan.ts";
import { runAgentPhase, type PhaseRunOutcome, type PhaseSpawnOptions } from "../agent/spawner.ts";
import type { PiStreamEvent } from "../agent/json-stream.ts";
import type { PhaseMeter } from "../measure/phase-meter.ts";
import { runPhaseHooks } from "./hooks.ts";
import { BudgetExceededError } from "./budget.ts";
import { DEFAULT_ENVIRONMENT_STREAK, EnvironmentStreakError } from "./phase-failure.ts";
import { commitCheckpoint } from "./checkpoint.ts";
import { refreshCodebaseGraph } from "./codebase-graph.ts";
import { workspaceFingerprint } from "./workspace.ts";
import { LoopStatusTracker, type LoopStatus } from "./loop-status.ts";
import { listModels, type ListedModel } from "./model-check.ts";
import { prepareRun } from "./run-setup.ts";
import { assembleRun } from "./run-assembly.ts";
import { walkSelection } from "./run-walk.ts";

export interface LoopStartOptions {
  specDir: string;
  fromTask?: string;
  toTask?: string;
  phase?: PhaseName;
  resume?: boolean;
  force?: boolean;
}

export interface EngineEvents {
  onStateChange?(plan: FixPlan): void;
  onStream?(e: PiStreamEvent): void;
  /** Fired before each phase subprocess starts: a fresh agent session begins. */
  onPhaseStart?(): void;
  onNotify?(message: string, type: "info" | "warning" | "error"): void;
  /** Called with a formatted log line from hooks or the agent stream. */
  onLogLine?(line: string): void;
}

export interface EngineDeps {
  config: SpecsKitConfig;
  spawnPhase?: (opts: PhaseSpawnOptions) => Promise<PhaseRunOutcome>;
  runHooks?: typeof runPhaseHooks;
  commitCheckpoint?: typeof commitCheckpoint;
  workspaceFingerprint?: typeof workspaceFingerprint;
  refreshCodebaseGraph?: typeof refreshCodebaseGraph;
  /** Config loader for the per-phase reload; defaults to the real loader. */
  reloadConfig?: (projectRoot: string, configPath?: string) => Promise<SpecsKitConfig | null>;
  /** Catalogue lookup for the escalation diagnosis; defaults to the real one. */
  listModels?: () => Promise<ListedModel[]>;
  /**
   * How many consecutive environmental phase failures halt the run.
   * Injectable so tests can pin a small threshold.
   */
  environmentStreakLimit?: number;
  /** Phase measurement; defaults to the real ledger/write-ahead writer. */
  meter?: PhaseMeter;
  now?: () => Date;
}

export type LoopEndReason = "completed" | "halted" | "stopped";

export type { LoopStatus } from "./loop-status.ts";

interface ResolvedDeps {
  config: SpecsKitConfig;
  spawnPhase: (opts: PhaseSpawnOptions) => Promise<PhaseRunOutcome>;
  runHooks: typeof runPhaseHooks;
  commitCheckpoint: typeof commitCheckpoint;
  workspaceFingerprint: typeof workspaceFingerprint;
  refreshCodebaseGraph: typeof refreshCodebaseGraph;
  reloadConfig: (projectRoot: string, configPath?: string) => Promise<SpecsKitConfig | null>;
  /** Null means "build the real one at run start", keeping the constructor inert. */
  meter: PhaseMeter | null;
  now: () => Date;
  environmentStreakLimit: number;
  /** Catalogue lookup used by the escalation diagnosis. */
  listModels: () => Promise<ListedModel[]>;
}

export class LoopEngine {
  readonly #deps: ResolvedDeps;
  readonly #events: EngineEvents;
  readonly #status = new LoopStatusTracker();
  #abort: AbortController | null = null;
  /** Per-phase interrupt: aborted without touching the loop stop flag. */
  #interrupt: AbortController | null = null;

  constructor(deps: EngineDeps, events: EngineEvents = {}) {
    this.#events = events;
    this.#deps = {
      config: deps.config,
      spawnPhase: deps.spawnPhase ?? runAgentPhase,
      runHooks: deps.runHooks ?? runPhaseHooks,
      commitCheckpoint: deps.commitCheckpoint ?? commitCheckpoint,
      workspaceFingerprint: deps.workspaceFingerprint ?? workspaceFingerprint,
      refreshCodebaseGraph: deps.refreshCodebaseGraph ?? refreshCodebaseGraph,
      reloadConfig: deps.reloadConfig ?? loadConfigIfPresent,
      meter: deps.meter ?? null,
      now: deps.now ?? (() => new Date()),
      environmentStreakLimit: deps.environmentStreakLimit ?? DEFAULT_ENVIRONMENT_STREAK,
      listModels: deps.listModels ?? listModels,
    };
  }

  get running(): boolean {
    return this.#status.running;
  }

  status(): LoopStatus {
    return this.#status.snapshot();
  }

  get #stopping(): "graceful" | "now" | null {
    return this.#status.stopping;
  }

  /**
   * Start the loop. A second start while running is a gentle failure
   * ({ reason: "halted", error }) rather than an exception.
   */
  async start(opts: LoopStartOptions): Promise<{ reason: LoopEndReason; error?: string }> {
    if (this.#status.running) return { reason: "halted", error: "loop already running" };
    this.#status.beginRun(Date.now());
    this.#abort = new AbortController();
    this.#interrupt = new AbortController();
    try {
      const result = await this.#run(opts);
      this.#status.error = result.error ?? null;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#status.error = message;
      this.#notify(`loop aborted: ${message}`, "error");
      return { reason: "halted", error: message };
    } finally {
      this.#status.endRun();
      this.#abort = null;
      this.#interrupt = null;
    }
  }

  /**
   * Ask the loop to stop. Default is graceful: the current phase finishes
   * and the loop exits at the next boundary. With `now` the current
   * subprocess is killed and the loop exits as soon as it unwinds.
   */
  stop(now = false): void {
    if (!this.#status.running) return;
    this.#status.stopping = now ? "now" : (this.#status.stopping ?? "graceful");
    if (now) this.#abort?.abort();
  }

  /**
   * Abort the subprocess of the current phase without stopping the loop:
   * the aborted outcome counts as a failed attempt and the usual retry
   * logic decides what happens next. No-op when no loop is running.
   */
  interruptPhase(): void {
    if (!this.#status.running || !this.#interrupt) return;
    this.#interrupt.abort();
    // Rearm for the next phase: signals already handed out stay aborted.
    this.#interrupt = new AbortController();
  }

  #notify(message: string, type: "info" | "warning" | "error"): void {
    this.#events.onNotify?.(message, type);
  }

  get #signal(): AbortSignal | undefined {
    if (!this.#abort) return undefined;
    const interrupt = this.#interrupt?.signal;
    return interrupt ? AbortSignal.any([this.#abort.signal, interrupt]) : this.#abort.signal;
  }

  /** Persist the plan, mirror it into the status fields and emit the change. */
  async #persist(specDir: string, plan: FixPlan): Promise<void> {
    await saveFixPlan(specDir, plan);
    this.#status.applyPlan(plan);
    this.#events.onStateChange?.(plan);
  }

  async #run(opts: LoopStartOptions): Promise<{ reason: LoopEndReason; error?: string }> {
    const config = this.#deps.config;
    const specDir = path.resolve(config.projectRoot, opts.specDir);
    this.#status.specDir = specDir;

    const { selected, plan, resume, notices } = await prepareRun(config, {
      specDir,
      specLabel: opts.specDir,
      fromTask: opts.fromTask,
      toTask: opts.toTask,
      resume: opts.resume,
      force: opts.force,
    });
    this.#status.specId = plan.spec_id;
    await this.#persist(specDir, plan);
    for (const notice of notices) this.#notify(notice.message, notice.type);

    const run = assembleRun({
      config,
      specDir,
      plan,
      selected,
      resume,
      phase: opts.phase,
      spawnPhase: this.#deps.spawnPhase,
      runHooks: this.#deps.runHooks,
      commitCheckpoint: this.#deps.commitCheckpoint,
      workspaceFingerprint: this.#deps.workspaceFingerprint,
      refreshCodebaseGraph: this.#deps.refreshCodebaseGraph,
      reloadConfig: this.#deps.reloadConfig,
      meter: this.#deps.meter,
      listModels: () => this.#deps.listModels(),
      now: this.#deps.now,
      notify: (m, t) => this.#notify(m, t),
      persist: (p) => this.#persist(specDir, p),
      stopping: () => this.#stopping,
      signal: () => this.#signal,
      onLogLine: (line) => this.#events.onLogLine?.(line),
      onStream: (event) => this.#events.onStream?.(event),
      onPhaseStart: () => this.#events.onPhaseStart?.(),
      setLastStreamLine: (line) => {
        this.#status.lastStreamLine = line;
      },
      setLogPath: (p) => {
        this.#status.logPath = p;
      },
    });

    try {
      return await walkSelection(
        plan,
        selected,
        run.runner,
        run.runState,
        { pendingStart: run.pendingStart, index: run.index, firstPhase: run.firstPhase },
        run.finalSync,
        {
          stopping: () => this.#stopping,
          notify: (m, t) => this.#notify(m, t),
          persist: (p) => this.#persist(specDir, p),
          rangeClose: { projectRoot: config.projectRoot, specDir },
        },
      );
    } catch (err) {
      if (err instanceof BudgetExceededError || err instanceof EnvironmentStreakError) {
        // A ceiling — or an environment broken past its escalation — is not a
        // task failure: continue-on-failure would carry the exhausted budget
        // (or the sick provider) straight into the next task, which cannot
        // afford a single phase either, and the run would walk the whole
        // range spending nothing but notifications.
        const detail =
          err instanceof EnvironmentStreakError ? `${err.message}: ${err.reasons.join(" | ")}` : err.message;
        plan.state.error = detail;
        plan.state.step = "failed";
        await this.#persist(specDir, plan);
        this.#notify(`loop stopped: ${detail}`, "error");
        return { reason: "halted", error: detail };
      }
      throw err;
    }
  }
}
