/**
 * Loop engine: run-level orchestration of a spec. Loads the tasks, applies the
 * range, reconciles and persists the fix plan, resolves the resume anchor and
 * walks the selection, handing each task to the per-task state machine. Every
 * state mutation is persisted before moving on, so a kill at any point leaves
 * a resumable snapshot; deps are injectable for tests.
 */

import path from "node:path";
import type { PhaseName, SpecsKitConfig } from "../config/specs-kit-config.ts";
import { saveFixPlan, type FixPlan, type LoopStep } from "../fixplan/fix-plan.ts";
import type { TaskFile } from "../tasks/task-parser.ts";
import { runAgentPhase, type PhaseRunOutcome, type PhaseSpawnOptions } from "../agent/spawner.ts";
import type { PiStreamEvent } from "../agent/json-stream.ts";
import { toLogLines } from "../agent/stream-format.ts";
import { ledgerPath } from "../measure/ledger.ts";
import { PhaseMeter } from "../measure/phase-meter.ts";
import { walPath } from "../measure/wal.ts";
import { runPhaseHooks } from "./hooks.ts";
import { BudgetExceededError, LoopBudget } from "./budget.ts";
import { commitCheckpoint } from "./checkpoint.ts";
import { LoopStatusTracker, type LoopStatus } from "./loop-status.ts";
import { PhaseExecutor } from "./phases.ts";
import { prepareRun } from "./run-setup.ts";
import { STEP_ORDER } from "./step-order.ts";
import { consumeRunNode, declareFinalSyncNode, type RunNode } from "./graph/run-graph.ts";
import type { TaskNodeDeps } from "./graph/types.ts";
import { TaskRunner, type RunState } from "./task-runner.ts";

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
  /** Null means "build the real one at run start", keeping the constructor inert. */
  meter: PhaseMeter | null;
  now: () => Date;
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
      meter: deps.meter ?? null,
      now: deps.now ?? (() => new Date()),
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

    // Resume anchor: the persisted per-task step, counters preserved.
    let pendingStart: { task: TaskFile; step: LoopStep } | null = null;
    let index = 0;
    const isPerTaskStep = STEP_ORDER.includes(plan.state.step);
    if (resume && plan.state.current_task && isPerTaskStep) {
      const found = selected.findIndex((t) => t.frontmatter.id === plan.state.current_task && !plan.done.includes(t.frontmatter.id));
      if (found !== -1) {
        pendingStart = { task: selected[found], step: plan.state.step };
        index = found;
        this.#notify(`resuming from ${plan.state.current_task} · phase ${plan.state.step}`, "info");
      }
    }

    const budget = new LoopBudget({
      maxSpawnsPerTask: config.run.maxSpawnsPerTask,
      maxSpawnsPerRun: config.run.maxSpawnsPerRun,
      maxRunDurationMs: config.run.maxRunDurationMs,
    });

    const meter =
      this.#deps.meter ??
      new PhaseMeter({
        ledgerFile: ledgerPath(config.projectRoot, config.specsDir),
        walFile: walPath(),
        projectRoot: config.projectRoot,
        onNotify: (message, type) => this.#notify(message, type),
      });

    const executor = new PhaseExecutor({
      config,
      specDir,
      budget,
      spawnPhase: this.#deps.spawnPhase,
      runHooks: this.#deps.runHooks,
      meter,
      onNotify: (m, t) => this.#notify(m, t),
      onStream: (event, formatted) => {
        // A completed message arrives as one formatted block; the log channel
        // is laid out one row per line, so it is split before forwarding.
        if (formatted) {
          for (const line of toLogLines(formatted)) {
            this.#status.lastStreamLine = line;
            this.#events.onLogLine?.(line);
          }
        }
        this.#events.onStream?.(event);
      },
      onLogPath: (p) => {
        this.#status.logPath = p;
      },
      onPhaseStart: () => this.#events.onPhaseStart?.(),
      onLogLine: (line) => this.#events.onLogLine?.(line),
    });

    const runnerDeps: TaskNodeDeps = {
      config,
      specDir,
      executor,
      budget,
      persist: (p) => this.#persist(specDir, p),
      notify: (m, t) => this.#notify(m, t),
      stopping: () => this.#stopping,
      signal: () => this.#signal,
      commitCheckpoint: this.#deps.commitCheckpoint,
      now: this.#deps.now,
    };
    const runner = new TaskRunner(runnerDeps);

    const firstPhase: LoopStep | null = opts.phase ?? null;
    const runState: RunState = { syncRan: false, lastCompleted: null };
    const finalSync = declareFinalSyncNode(runnerDeps, plan, runState);
    try {
      return await this.#walk(plan, selected, runner, specDir, runState, { pendingStart, index, firstPhase }, finalSync);
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      // A ceiling is not a task failure: continue-on-failure would carry the
      // exhausted budget straight into the next task, which cannot afford a
      // single phase either, and the run would walk the whole range spending
      // nothing but notifications.
      plan.state.error = err.message;
      plan.state.step = "failed";
      await this.#persist(specDir, plan);
      this.#notify(`loop stopped: ${err.message}`, "error");
      return { reason: "halted", error: err.message };
    }
  }

  /**
   * Walk the selection: pick the next task not already done, hand it to the
   * per-task state machine and close the range when the selection runs out.
   * The resume anchor, when present, is consumed by the first iteration.
   */
  async #walk(
    plan: FixPlan,
    selected: TaskFile[],
    runner: TaskRunner,
    specDir: string,
    runState: RunState,
    start: { pendingStart: { task: TaskFile; step: LoopStep } | null; index: number; firstPhase: LoopStep | null },
    finalSync: RunNode,
  ): Promise<{ reason: LoopEndReason; error?: string }> {
    let { pendingStart, index, firstPhase } = start;
    for (;;) {
      if (this.#stopping) return { reason: "stopped" };
      let taskFile: TaskFile;
      let startStep: LoopStep | null = null;
      let resumed = false;
      if (pendingStart) {
        taskFile = pendingStart.task;
        startStep = pendingStart.step;
        resumed = true;
        pendingStart = null;
        index++;
        // The explicit start phase belongs to the first task of the run, and
        // the resumed task uses its persisted anchor instead: consume it here
        // or it would leak into the next task and skip its implementation.
        if (firstPhase && firstPhase !== startStep) {
          this.#notify(`start phase ${firstPhase} ignored: ${taskFile.frontmatter.id} resumes at ${startStep}`, "info");
        }
        firstPhase = null;
      } else {
        while (index < selected.length && plan.done.includes(selected[index].frontmatter.id)) index++;
        if (index >= selected.length) {
          await consumeRunNode(finalSync, {
            syncRan: runState.syncRan,
            hasLastCompleted: runState.lastCompleted !== null,
            stopping: this.#stopping !== null,
          });
          // A task that failed while continuing left its message behind: keep
          // it for the operator as a notice, but do not persist it next to a
          // completed step or every later reader would see a halt that the run
          // never ended on.
          const lastFailure = plan.state.error;
          plan.state.step = "done";
          plan.state.current_task = null;
          plan.state.current_task_file = null;
          plan.state.current_task_lang = null;
          plan.state.error = null;
          await this.#persist(specDir, plan);
          if (lastFailure) this.#notify(`range completed with failures, last: ${lastFailure}`, "warning");
          const p = plan.range_progress;
          this.#notify(`range completed: ${p.done_in_range}/${p.total_in_range} tasks (${p.percent}%)`, "info");
          // A sync that ran without the codebase graph left the run partial:
          // say so once at the end so the operator knows graph-backed
          // validation was skipped and the docs sync may be incomplete.
          if (plan.state.graphPartialSync) {
            this.#notify(
              "range completed with a partial sync: the codebase graph was absent, so graph-backed dependency validation was skipped",
              "warning",
            );
          }
          return { reason: "completed" };
        }
        taskFile = selected[index];
        index++;
        startStep = firstPhase;
        firstPhase = null;
      }

      const outcome = await runner.run(plan, taskFile, selected, startStep, resumed, runState);
      if (outcome === "stopped") return { reason: "stopped" };
      if (outcome === "halted") return { reason: "halted", error: plan.state.error ?? undefined };
    }
  }

}
