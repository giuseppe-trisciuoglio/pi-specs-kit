/**
 * LLM-callable tools mirroring the slash commands: start/stop/status of the
 * task loop and fix plan refresh. Tools never touch the interactive UI: a
 * missing spec falls back to the configured one instead of opening a picker,
 * and guard failures (a loop already running, no spec configured) come back
 * as plain error text in the tool result rather than thrown exceptions.
 */

import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { LoopStartOptions } from "../loop/engine.ts";
import type { LoopController } from "../loop/loop-controller.ts";

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Config of the session, loading it lazily from the tool's working directory. */
async function ensureConfig(controller: LoopController, ctx: ExtensionContext): Promise<SpecsKitConfig> {
  return controller.config ?? controller.loadConfig(ctx.cwd);
}

const PHASE_PARAM = Type.Union([
  Type.Literal("implementation"),
  Type.Literal("review"),
  Type.Literal("cleanup"),
  Type.Literal("sync"),
]);

export interface LoopToolHooks {
  /** Fired when the loop is started through the tool, to close any authoring window. */
  onLoopStart?: () => void;
}

/**
 * Register the loop tools on the extension API. Registration only: nothing
 * is started here, so this stays safe under hot reload.
 */
export function registerLoopTools(pi: ExtensionAPI, controller: LoopController, hooks: LoopToolHooks = {}): void {
  pi.registerTool({
    name: "specs_kit_loop_start",
    label: "Start specs-kit loop",
    description:
      "Start the specs-kit task loop in the background over the tasks of a spec. " +
      "Returns immediately with the initial state; progress surfaces through the widget and notifications. " +
      "Only one loop may run per session: starting a second one returns an error.",
    parameters: Type.Object({
      spec: Type.Optional(Type.String({ description: "Spec directory relative to the project root; defaults to the configured active spec." })),
      from_task: Type.Optional(Type.String({ description: "First task id of the range (inclusive)." })),
      to_task: Type.Optional(Type.String({ description: "Last task id of the range (inclusive)." })),
      phase: Type.Optional(Type.Union([PHASE_PARAM], { description: "Phase to start from; defaults to implementation." })),
      resume: Type.Optional(Type.Boolean({ description: "Resume from the persisted loop state." })),
      force: Type.Optional(Type.Boolean({ description: "Reset the persisted state and start over." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      hooks.onLoopStart?.();
      const config = await ensureConfig(controller, ctx);
      const spec = params.spec ?? config.spec;
      if (!spec) {
        return textResult("error: no spec given and no active spec in the configuration");
      }
      const opts: LoopStartOptions = { specDir: spec };
      if (params.from_task) opts.fromTask = params.from_task;
      if (params.to_task) opts.toTask = params.to_task;
      if (params.phase) opts.phase = params.phase;
      if (params.resume) opts.resume = true;
      if (params.force) opts.force = true;
      try {
        const status = await controller.start(opts);
        return textResult(
          JSON.stringify({
            started: true,
            running: status.running,
            spec: status.specId ?? spec,
            total_tasks: status.totalInRange,
            initial_phase: params.phase ?? "implementation",
          }),
        );
      } catch (err) {
        return textResult(`error: ${errorText(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "specs_kit_loop_stop",
    label: "Stop specs-kit loop",
    description:
      "Ask the running specs-kit loop to stop. Default is graceful: the current phase finishes and the loop " +
      "exits at the next boundary. With now=true the current subprocess is killed and the loop unwinds immediately.",
    parameters: Type.Object({
      now: Type.Optional(Type.Boolean({ description: "Kill the in-flight phase subprocess instead of waiting for it." })),
    }),
    execute: async (_toolCallId, params) => {
      if (!controller.stop(params.now ?? false)) return textResult("no active loop");
      return textResult(
        params.now
          ? "immediate stop requested: the current subprocess will be terminated"
          : "stop requested: the loop will halt at the end of the current phase",
      );
    },
  });

  pi.registerTool({
    name: "specs_kit_loop_status",
    label: "Specs-kit loop status",
    description: "Return the current specs-kit loop status as JSON: spec, task, phase, retry count, progress and last error.",
    parameters: Type.Object({}),
    execute: async () => textResult(JSON.stringify(controller.status())),
  });

  pi.registerTool({
    name: "specs_kit_refresh",
    label: "Refresh specs-kit fix plan",
    description:
      "Reconcile the fix plan of a spec with its task files on disk. " +
      'Returns the exact outcome: "Created", "Updated" or "Nothing to refresh".',
    parameters: Type.Object({
      spec: Type.Optional(Type.String({ description: "Spec directory relative to the project root; defaults to the configured active spec." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const config = await ensureConfig(controller, ctx);
      const spec = params.spec ?? config.spec;
      if (!spec) {
        return textResult("error: no spec given and no active spec in the configuration");
      }
      try {
        return textResult(await controller.refreshFixPlan(spec));
      } catch (err) {
        return textResult(`error: ${errorText(err)}`);
      }
    },
  });
}
