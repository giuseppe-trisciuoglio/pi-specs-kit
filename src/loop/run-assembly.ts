/**
 * Run assembly: the wiring that has to exist before the first phase can run.
 * Resolves the resume anchor, opens the run budget and meter, builds the
 * phase executor, binds the per-task runner and declares the end-of-range
 * sync node. Nothing here starts the loop: it hands the assembled pieces back
 * to the engine, which walks the selection and owns every state write.
 */

import type { PiStreamEvent } from "../agent/json-stream.ts";
import { toLogLines } from "../agent/stream-format.ts";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../agent/spawner.ts";
import type { PhaseName, SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { FixPlan, LoopStep } from "../fixplan/fix-plan.ts";
import type { TaskFile } from "../tasks/task-parser.ts";
import { ledgerPath } from "../measure/ledger.ts";
import { PhaseMeter } from "../measure/phase-meter.ts";
import { walPath } from "../measure/wal.ts";
import { LoopBudget } from "./budget.ts";
import type { commitCheckpoint } from "./checkpoint.ts";
import type { refreshCodebaseGraph } from "./codebase-graph.ts";
import { ConfigReloader } from "./config-reload.ts";
import type { workspaceFingerprint } from "./workspace.ts";
import { declareFinalSyncNode, type RunNode } from "./graph/run-graph.ts";
import type { TaskNodeDeps } from "./graph/types.ts";
import type { runPhaseHooks } from "./hooks.ts";
import { PhaseExecutor } from "./phases.ts";
import { STEP_ORDER } from "./step-order.ts";
import { TaskRunner, type RunState } from "./task-runner.ts";

export interface RunAssemblyDeps {
  config: SpecsKitConfig;
  specDir: string;
  plan: FixPlan;
  selected: TaskFile[];
  resume: boolean;
  phase?: PhaseName;
  spawnPhase: (opts: PhaseSpawnOptions) => Promise<PhaseRunOutcome>;
  runHooks: typeof runPhaseHooks;
  commitCheckpoint: typeof commitCheckpoint;
  workspaceFingerprint: typeof workspaceFingerprint;
  refreshCodebaseGraph: typeof refreshCodebaseGraph;
  /** Config loader for the per-phase reload, already defaulted by the engine. */
  reloadConfig: (projectRoot: string, configPath?: string) => Promise<SpecsKitConfig | null>;
  /** Phase measurement; null means "build the real one now". */
  meter: PhaseMeter | null;
  now: () => Date;
  notify: (message: string, type: "info" | "warning" | "error") => void;
  persist: (plan: FixPlan) => Promise<void>;
  stopping: () => "graceful" | "now" | null;
  signal: () => AbortSignal | undefined;
  onLogLine: (line: string) => void;
  onStream: (event: PiStreamEvent) => void;
  onPhaseStart: () => void;
  setLastStreamLine: (line: string) => void;
  setLogPath: (logPath: string) => void;
}

export interface AssembledRun {
  pendingStart: { task: TaskFile; step: LoopStep } | null;
  index: number;
  firstPhase: LoopStep | null;
  runner: TaskRunner;
  runState: RunState;
  finalSync: RunNode;
}

/** Build every piece the walk needs, without starting the walk itself. */
export function assembleRun(deps: RunAssemblyDeps): AssembledRun {
  const { config, specDir, plan, selected, resume } = deps;

  // Resume anchor: the persisted per-task step, counters preserved.
  let pendingStart: { task: TaskFile; step: LoopStep } | null = null;
  let index = 0;
  const isPerTaskStep = STEP_ORDER.includes(plan.state.step);
  if (resume && plan.state.current_task && isPerTaskStep) {
    const found = selected.findIndex((t) => t.frontmatter.id === plan.state.current_task && !plan.done.includes(t.frontmatter.id));
    if (found !== -1) {
      pendingStart = { task: selected[found], step: plan.state.step };
      index = found;
      deps.notify(`resuming from ${plan.state.current_task} · phase ${plan.state.step}`, "info");
    }
  }

  const budget = new LoopBudget({
    maxSpawnsPerTask: config.run.maxSpawnsPerTask,
    maxSpawnsPerRun: config.run.maxSpawnsPerRun,
    maxRunDurationMs: config.run.maxRunDurationMs,
  });

  // The reload swaps the run options in place, so the ceilings have to be
  // re-applied explicitly: the budget copied them into its own limits.
  const reloader = new ConfigReloader(config, {
    load: deps.reloadConfig,
    notify: (m, t) => deps.notify(m, t),
    onReloaded: (cfg) =>
      budget.reconfigure({
        maxSpawnsPerTask: cfg.run.maxSpawnsPerTask,
        maxSpawnsPerRun: cfg.run.maxSpawnsPerRun,
        maxRunDurationMs: cfg.run.maxRunDurationMs,
      }),
  });

  const meter =
    deps.meter ??
    new PhaseMeter({
      ledgerFile: ledgerPath(config.projectRoot, config.specsDir),
      walFile: walPath(),
      projectRoot: config.projectRoot,
      onNotify: (message, type) => deps.notify(message, type),
    });

  const executor = new PhaseExecutor({
    config,
    specDir,
    budget,
    spawnPhase: deps.spawnPhase,
    runHooks: deps.runHooks,
    refreshConfig: () => reloader.refresh(),
    meter,
    onNotify: (m, t) => deps.notify(m, t),
    onStream: (event, formatted) => {
      // A completed message arrives as one formatted block; the log channel
      // is laid out one row per line, so it is split before forwarding.
      if (formatted) {
        for (const line of toLogLines(formatted)) {
          deps.setLastStreamLine(line);
          deps.onLogLine(line);
        }
      }
      deps.onStream(event);
    },
    onLogPath: (p) => {
      deps.setLogPath(p);
    },
    onPhaseStart: () => deps.onPhaseStart(),
    onLogLine: (line) => deps.onLogLine(line),
  });

  const runnerDeps: TaskNodeDeps = {
    config,
    specDir,
    executor,
    budget,
    persist: (p) => deps.persist(p),
    notify: (m, t) => deps.notify(m, t),
    stopping: () => deps.stopping(),
    signal: () => deps.signal(),
    commitCheckpoint: deps.commitCheckpoint,
    workspaceFingerprint: deps.workspaceFingerprint,
    refreshCodebaseGraph: deps.refreshCodebaseGraph,
    now: deps.now,
  };
  const runner = new TaskRunner(runnerDeps);

  const firstPhase: LoopStep | null = deps.phase ?? null;
  const runState: RunState = { syncRan: false, lastCompleted: null };
  const finalSync = declareFinalSyncNode(runnerDeps, plan, runState);

  return { pendingStart, index, firstPhase, runner, runState, finalSync };
}
