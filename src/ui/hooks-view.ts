/**
 * Interactive flow for editing the shell hooks of a phase: pick a phase,
 * pick the pre/post stage, then add or remove commands. Every change is
 * written to the yaml config immediately and reloaded into memory, so a
 * running loop picks it up at the next phase boundary without a restart.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { updateHooksTimeout, updatePhaseHooks } from "../config/config-writer.ts";
import { PHASE_NAMES, type HookStage, type PhaseName, type SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { LoopController } from "../loop/loop-controller.ts";
import { formatDurationMs, parseDurationMs } from "../util/duration.ts";

const ADD_COMMAND = "(+) Add command";
const REMOVE_PREFIX = "(x) ";

function phaseLabel(config: SpecsKitConfig, phase: PhaseName): string {
  const hooks = config.hooks[phase];
  return `${phase} — pre: ${hooks.pre.length} · post: ${hooks.post.length}`;
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
  phase: PhaseName,
  stage: HookStage,
): Promise<SpecsKitConfig> {
  for (;;) {
    const commands = config.hooks[phase][stage];
    const options = [ADD_COMMAND, ...commands.map((command) => `${REMOVE_PREFIX}${command}`)];
    const picked = await ctx.ui.select(`${phase} ${stage}-hooks (${commands.length})`, options);
    if (picked === undefined) return config;

    if (picked === ADD_COMMAND) {
      const input = await ctx.ui.input(`New ${stage}-hook command for ${phase}:`, "e.g. npm run lint");
      const command = input?.trim();
      if (!command) continue;
      try {
        await updatePhaseHooks(config.configPath, phase, stage, [...commands, command]);
        config = await reload(controller, config);
        ctx.ui.notify(`[specs-kit] Added ${stage}-hook to ${phase} (${commands.length + 1} total).`, "info");
      } catch (err) {
        reportWriteError(ctx, err);
      }
      continue;
    }

    const index = options.indexOf(picked) - 1;
    const target = commands[index];
    if (!(await ctx.ui.confirm("Remove hook", `Remove "${target}" from ${phase} ${stage}-hooks?`))) continue;
    try {
      await updatePhaseHooks(
        config.configPath,
        phase,
        stage,
        commands.filter((_, i) => i !== index),
      );
      config = await reload(controller, config);
      ctx.ui.notify(`[specs-kit] Removed ${stage}-hook from ${phase} (${commands.length - 1} left).`, "info");
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
    const labels = PHASE_NAMES.map((phase) => phaseLabel(config, phase));
    const timeoutLabel = `timeout (${formatDurationMs(config.hooks.timeoutMs)})`;
    const picked = await ctx.ui.select("Hooks — pick a phase or the timeout", [...labels, timeoutLabel]);
    if (picked === undefined) return;

    if (picked === timeoutLabel) {
      config = await editTimeout(ctx, controller, config);
      continue;
    }

    const phase = PHASE_NAMES[labels.indexOf(picked)];
    for (;;) {
      const stage = await ctx.ui.select(`Hooks for ${phase}:`, [
        `pre (${config.hooks[phase].pre.length})`,
        `post (${config.hooks[phase].post.length})`,
      ]);
      if (stage === undefined) break;
      config = await editStage(ctx, controller, config, phase, stage.startsWith("pre") ? "pre" : "post");
    }
  }
}
