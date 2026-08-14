import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PhaseName } from "./config/specs-kit-config.ts";
import type { LoopStartOptions, LoopStatus } from "./loop/engine.ts";
import { registerAuthoringCommands } from "./authoring/authoring-commands.ts";
import { ledgerPath } from "./measure/ledger.ts";
import { AuthoringWindowTracker } from "./measure/authoring-window.ts";
import { walPath } from "./measure/wal.ts";
import { BUNDLED_SKILLS_DIR } from "./prompt/skill-resolver.ts";
import { LoopController } from "./loop/loop-controller.ts";
import { registerAuthoringTools } from "./tools/authoring-tools.ts";
import { registerLoopTools } from "./tools/loop-tools.ts";
import { openAttachView } from "./ui/attach-view.ts";
import { openConfigView } from "./ui/config-view.ts";
import { PHASE_CHOICES, pickPhase, pickSpec, pickTaskRange } from "./ui/pickers.ts";
import { report } from "./ui/report.ts";
import { parseRunArgs } from "./ui/run-args.ts";
import { updateLoopWidget, type WidgetStatus } from "./ui/widget.ts";

/** Multi-line status report for /specs-kit-status. */
function formatStatus(st: LoopStatus, maxAttempts: number): string {
  if (!st.running && !st.specId) return "[specs-kit] Status: idle (no active loop).";
  const lines = [`[specs-kit] ${st.running ? "Loop running" : "Loop finished"}`];
  if (st.specId) lines.push(`spec: ${st.specId}`);
  if (st.currentTask) lines.push(`task: ${st.currentTask} · phase ${st.step ?? "—"} · attempt ${st.retryCount + 1}/${maxAttempts}`);
  lines.push(`progress: ${st.doneInRange}/${st.totalInRange} (${st.percent}%)`);
  if (st.stopping) lines.push(`stop requested: ${st.stopping === "now" ? "immediate" : "at end of phase"}`);
  if (st.error) lines.push(`last error: ${st.error}`);
  if (st.logPath) lines.push(`log: ${st.logPath}`);
  return lines.join("\n");
}

/**
 * Extension factory. Registers the specs-kit command surface only; no
 * background resources are started here and the config is loaded lazily at
 * the first command, so the factory stays safe under hot reload. Engine
 * events reach the UI through the most recent command context.
 */
export default function specsKitExtension(pi: ExtensionAPI): void {
  // Surface the bundled skill fork so pi loads it as discoverable skills. The
  // loop also reads the phase skills directly through the resolver, but
  // exposing them here makes the whole authoring chain available as /skill:.
  pi.on("resources_discover", () => ({ skillPaths: [BUNDLED_SKILLS_DIR] }));

  let lastCtx: ExtensionCommandContext | null = null;

  // Authoring window measurement: tracks the interactive-session tokens spent
  // on a spec. The closures read the controller's lazily loaded config, so the
  // tracker itself holds no project state and stays reload-safe.
  const tracker = new AuthoringWindowTracker({
    ledgerFile: () => {
      const config = controller.config;
      return config ? ledgerPath(config.projectRoot, config.specsDir) : null;
    },
    walFile: walPath(),
    projectRoot: () => controller.config?.projectRoot ?? null,
    activeSpec: () => controller.config?.spec ?? null,
    onNotify: (message, type) => {
      if (lastCtx?.hasUI) lastCtx.ui.notify(message, type);
    },
  });

  // A window closes at the next specs-kit command, whatever it is, and when
  // the session goes away; assistant messages of the interactive session are
  // accounted to the window currently open.
  pi.on("message_end", (event) => {
    tracker.recordMessage(event.message);
  });
  pi.on("session_shutdown", () => tracker.close());

  const widgetStatus = (): WidgetStatus | null => {
    const engine = controller.engine;
    const config = controller.config;
    if (!engine || !config) return null;
    return { ...engine.status(), maxAttempts: config.run.maxAttempts };
  };

  const syncWidget = (): void => {
    if (!lastCtx?.hasUI) return;
    const st = widgetStatus();
    if (st) updateLoopWidget(lastCtx.ui, st, true);
  };

  const controller = new LoopController({
    onNotify: (message, type) => {
      if (lastCtx?.hasUI) lastCtx.ui.notify(message, type);
    },
    onUpdate: () => syncWidget(),
    onActiveSpecChanged: (specDir) => tracker.attributePending(specDir),
    onFinished: (reason, error) => {
      const ctx = lastCtx;
      if (!ctx) return;
      syncWidget(); // engine is idle now: hides the widget
      if (!ctx.hasUI) return;
      if (reason === "completed") ctx.ui.notify("[specs-kit] Loop completed.", "info");
      else if (reason === "stopped") ctx.ui.notify("[specs-kit] Loop stopped.", "info");
      else ctx.ui.notify(`[specs-kit] Loop aborted: ${error ?? "unknown error"}`, "error");
    },
  });

  const ensureConfig = async (ctx: ExtensionCommandContext) => {
    return controller.config ?? controller.loadConfig(ctx.cwd);
  };

  pi.registerCommand("specs-kit-run", {
    description: "Start the loop over the tasks of a spec",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      tracker.close();
      const config = await ensureConfig(ctx);
      if (controller.isRunning()) {
        report(ctx, "[specs-kit] A loop is already running; use /specs-kit-stop to stop it.");
        return;
      }

      const opts = parseRunArgs(args);
      let spec = opts.spec ?? config.spec;
      if (!spec) {
        if (!ctx.hasUI) {
          report(ctx, "[specs-kit] Specify the spec: /specs-kit-run --spec <path>");
          return;
        }
        spec = await pickSpec(controller, ctx, { onlyWithTasks: true, active: config.spec });
        if (!spec) {
          report(ctx, "[specs-kit] Start cancelled.");
          return;
        }
      }

      let fromTask = opts.fromTask;
      let toTask = opts.toTask;
      if (ctx.hasUI && !fromTask && !toTask) {
        const range = await pickTaskRange(controller, spec, ctx);
        if (!range) {
          report(ctx, "[specs-kit] Start cancelled.");
          return;
        }
        fromTask = range.fromTask;
        toTask = range.toTask;
      }

      let phase: PhaseName | undefined;
      if (opts.phase) {
        if (!(PHASE_CHOICES as readonly string[]).includes(opts.phase)) {
          report(ctx, `[specs-kit] Invalid phase "${opts.phase}"; allowed values: ${PHASE_CHOICES.join(", ")}.`);
          return;
        }
        phase = opts.phase as PhaseName;
      } else if (ctx.hasUI) {
        phase = await pickPhase(ctx);
        if (!phase) {
          report(ctx, "[specs-kit] Start cancelled.");
          return;
        }
      }

      const startOpts: LoopStartOptions = { specDir: spec };
      if (fromTask) startOpts.fromTask = fromTask;
      if (toTask) startOpts.toTask = toTask;
      if (phase) startOpts.phase = phase;
      if (opts.resume) startOpts.resume = true;
      if (opts.force) startOpts.force = true;

      try {
        const st = await controller.start(startOpts);
        syncWidget();
        const from = fromTask ?? "start";
        const to = toTask ?? "end";
        report(
          ctx,
          `[specs-kit] Loop started: ${st.specId ?? spec} · range ${from}→${to} · ${st.totalInRange} tasks` +
            ` · phase ${phase ?? "implementation"}${opts.resume ? " · resume" : ""}`,
        );
      } catch (err) {
        report(ctx, `[specs-kit] ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  pi.registerCommand("specs-kit-stop", {
    description: "Stop the loop (graceful at end of phase, or immediate with --now)",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      tracker.close();
      const now = args.split(/\s+/).includes("--now");
      if (!controller.stop(now)) {
        report(ctx, "[specs-kit] No active loop.");
        return;
      }
      report(
        ctx,
        now
          ? "[specs-kit] Immediate stop requested: the current subprocess will be terminated."
          : "[specs-kit] Stop requested: the loop will halt at the end of the current phase.",
      );
    },
  });

  pi.registerCommand("specs-kit-status", {
    description: "Show the specs-kit loop status",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      tracker.close();
      const maxAttempts = controller.config?.run.maxAttempts ?? 0;
      report(ctx, formatStatus(controller.status(), maxAttempts));
    },
  });

  pi.registerCommand("specs-kit-refresh", {
    description: "Regenerate the fix plan from the task files",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      tracker.close();
      const config = await ensureConfig(ctx);
      let spec = parseRunArgs(args).spec ?? config.spec;
      if (!spec) {
        if (!ctx.hasUI) {
          report(ctx, "[specs-kit] Specify the spec: /specs-kit-refresh --spec <path>");
          return;
        }
        spec = await pickSpec(controller, ctx, { onlyWithTasks: true, active: config.spec });
        if (!spec) return;
      }
      try {
        const outcome = await controller.refreshFixPlan(spec);
        report(ctx, `[specs-kit] ${outcome}`);
      } catch (err) {
        report(ctx, `[specs-kit] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  pi.registerCommand("specs-kit-attach", {
    description: "Open the streaming view of the current subprocess",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      tracker.close();
      await openAttachView(ctx, controller);
    },
  });
  pi.registerCommand("specs-kit-config", {
    description: "Configure models, thinking, phase hooks and run options",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      tracker.close();
      await openConfigView(ctx, controller);
    },
  });

  registerLoopTools(pi, controller, { onLoopStart: () => tracker.close() });
  registerAuthoringTools(pi, controller);
  registerAuthoringCommands(pi, controller, tracker);
}
