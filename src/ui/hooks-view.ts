/**
 * Interactive flow for editing the shell hooks of a target: pick a phase (or
 * the checkpoint of a passed task), pick the stage, then add or remove
 * commands. Every change is written to the yaml config immediately and
 * reloaded into memory, so a running loop picks it up at the next phase
 * boundary without a restart.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { updateHooksTimeout, updatePhaseHooks } from "../config/config-writer.ts";
import { PHASE_NAMES, type HookStage, type HookTarget, type SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { LoopController } from "../loop/loop-controller.ts";
import { formatDurationMs, parseDurationMs } from "../util/duration.ts";

const ADD_COMMAND = "(+) Add command";
const REMOVE_PREFIX = "(x) ";

/** The four phases plus the checkpoint, in the order the loop reaches them. */
const HOOK_TARGETS: readonly HookTarget[] = [...PHASE_NAMES, "checkpoint"];

/** The checkpoint has no pre stage: there is nothing for a hook to precede. */
function stagesOf(target: HookTarget): readonly HookStage[] {
  return target === "checkpoint" ? ["post"] : ["pre", "post"];
}

function targetLabel(config: SpecsKitConfig, target: HookTarget): string {
  const hooks = config.hooks[target];
  const counts = stagesOf(target).map((stage) => `${stage}: ${hooks[stage].length}`);
  return `${target} — ${counts.join(" · ")}`;
}

/** Reload the config from disk so labels and further edits see fresh state. */
async function reload(controller: LoopController, config: SpecsKitConfig): Promise<SpecsKitConfig> {
  return controller.loadConfig(config.projectRoot);
}

function reportWriteError(ctx: ExtensionCommandContext, err: unknown): void {
  ctx.ui.notify(`[specs-kit] Config write failed: ${err instanceof Error ? err.message : String(err)}`, "error");
}

/** Add/remove loop for a single stage; returns the freshest config. */
async function editStage(
  ctx: ExtensionCommandContext,
  controller: LoopController,
  config: SpecsKitConfig,
  target: HookTarget,
  stage: HookStage,
): Promise<SpecsKitConfig> {
  for (;;) {
    const commands = config.hooks[target][stage];
    const options = [ADD_COMMAND, ...commands.map((command) => `${REMOVE_PREFIX}${command}`)];
    const picked = await ctx.ui.select(`${target} ${stage}-hooks (${commands.length})`, options);
    if (picked === undefined) return config;

    if (picked === ADD_COMMAND) {
      const input = await ctx.ui.input(`New ${stage}-hook command for ${target}:`, "e.g. npm run lint");
      const command = input?.trim();
      if (!command) continue;
      try {
        await updatePhaseHooks(config.configPath, target, stage, [...commands, command]);
        config = await reload(controller, config);
        ctx.ui.notify(`[specs-kit] Added ${stage}-hook to ${target} (${commands.length + 1} total).`, "info");
      } catch (err) {
        reportWriteError(ctx, err);
      }
      continue;
    }

    const index = options.indexOf(picked) - 1;
    const command = commands[index];
    if (!(await ctx.ui.confirm("Remove hook", `Remove "${command}" from ${target} ${stage}-hooks?`))) continue;
    try {
      await updatePhaseHooks(
        config.configPath,
        target,
        stage,
        commands.filter((_, i) => i !== index),
      );
      config = await reload(controller, config);
      ctx.ui.notify(`[specs-kit] Removed ${stage}-hook from ${target} (${commands.length - 1} left).`, "info");
    } catch (err) {
      reportWriteError(ctx, err);
    }
  }
}

/** Edit the shared hook timeout, validating the duration before writing. */
async function editTimeout(
  ctx: ExtensionCommandContext,
  controller: LoopController,
  config: SpecsKitConfig,
): Promise<SpecsKitConfig> {
  const current = formatDurationMs(config.hooks.timeoutMs);
  const input = await ctx.ui.input("Hooks timeout:", `current ${current} — e.g. 240s, 5m, 1h`);
  if (input === undefined) return config;
  const trimmed = input.trim();
  if (parseDurationMs(trimmed) === undefined) {
    ctx.ui.notify(`[specs-kit] Invalid duration "${trimmed}"; use forms like 240s, 5m, 1h.`, "error");
    return config;
  }
  try {
    await updateHooksTimeout(config.configPath, trimmed);
    config = await reload(controller, config);
    ctx.ui.notify(`[specs-kit] Hooks timeout set to ${trimmed}.`, "info");
  } catch (err) {
    reportWriteError(ctx, err);
  }
  return config;
}

/** Run the hooks configuration flow; returns when the operator cancels the phase picker. */
export async function openHooksConfig(ctx: ExtensionCommandContext, controller: LoopController): Promise<void> {
  let config = controller.config ?? (await controller.loadConfig(ctx.cwd));

  for (;;) {
    const labels = HOOK_TARGETS.map((target) => targetLabel(config, target));
    const timeoutLabel = `timeout (${formatDurationMs(config.hooks.timeoutMs)})`;
    const picked = await ctx.ui.select("Hooks — pick a target or the timeout", [...labels, timeoutLabel]);
    if (picked === undefined) return;

    if (picked === timeoutLabel) {
      config = await editTimeout(ctx, controller, config);
      continue;
    }

    const target = HOOK_TARGETS[labels.indexOf(picked)];
    const stages = stagesOf(target);
    // A target with a single stage has nothing to pick: the second menu would
    // ask a question with one answer.
    if (stages.length === 1) {
      config = await editStage(ctx, controller, config, target, stages[0]);
      continue;
    }
    for (;;) {
      const stage = await ctx.ui.select(`Hooks for ${target}:`, stages.map((s) => `${s} (${config.hooks[target][s].length})`));
      if (stage === undefined) break;
      config = await editStage(ctx, controller, config, target, stage.startsWith("pre") ? "pre" : "post");
    }
  }
}
