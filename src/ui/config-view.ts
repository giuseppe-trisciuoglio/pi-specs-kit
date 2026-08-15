/**
 * Interactive configuration flow: a top-level menu dispatches to the per-role
 * model and thinking pickers, to the review panel editor, to the phase hooks
 * editor or to the run options. Every change is written to the yaml config and
 * reloaded into memory right away, so what the menu shows is always what the
 * next run will use.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { updateRoleConfig, type RoleUpdate } from "../config/config-writer.ts";
import { ROLE_NAMES, type RoleName, type SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { LoopController } from "../loop/loop-controller.ts";
import { openHooksConfig } from "./hooks-view.ts";
import { pickModel, pickThinkingLevel } from "./model-prompt.ts";
import { openPanelConfig } from "./panel-view.ts";
import { openRunConfig } from "./run-view.ts";

const AREA_ROLES = "Role models & thinking";
const AREA_PANEL = "Adversarial review panel";
const AREA_HOOKS = "Phase hooks (pre/post)";
const AREA_RUN = "Run options (retries, timeout, toggles)";

function roleLabel(config: SpecsKitConfig, role: RoleName): string {
  const current = config.roles[role];
  return `${role} — model: ${current.model} · thinking: ${current.thinkingLevel ?? "default"}`;
}

/** Write one role change and reload the config; returns the config in force. */
async function applyRoleUpdate(
  ctx: ExtensionCommandContext,
  controller: LoopController,
  config: SpecsKitConfig,
  role: RoleName,
  update: RoleUpdate,
  summary: string,
): Promise<SpecsKitConfig> {
  try {
    await updateRoleConfig(config.configPath, role, update);
    const reloaded = await controller.loadConfig(config.projectRoot);
    ctx.ui.notify(`[specs-kit] ${role}: ${summary}.`, "info");
    return reloaded;
  } catch (err) {
    ctx.ui.notify(`[specs-kit] Config write failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return config;
  }
}

/**
 * Per-role loop; returns when the operator cancels the role picker. Model and
 * thinking level are picked one at a time and applied as soon as they are
 * chosen: cancelling a picker is how the current value is kept, so changing
 * one of the two never means walking through the other.
 */
async function configureRoles(ctx: ExtensionCommandContext, controller: LoopController): Promise<void> {
  let config = controller.config ?? (await controller.loadConfig(ctx.cwd));

  for (;;) {
    const labels = ROLE_NAMES.map((role) => roleLabel(config, role));
    const picked = await ctx.ui.select("Role to configure", labels);
    if (picked === undefined) return;
    const role = ROLE_NAMES[labels.indexOf(picked)];
    const current = config.roles[role];

    const modelField = `Model: ${current.model}`;
    const thinkingField = `Thinking: ${current.thinkingLevel ?? "default"}`;
    const field = await ctx.ui.select(`Setting to change for ${role}`, [modelField, thinkingField]);
    if (field === undefined) continue;

    if (field === modelField) {
      const model = await pickModel(ctx, role, current.model);
      if (model === null || model === undefined) continue;
      config = await applyRoleUpdate(ctx, controller, config, role, { model }, `model ${model}`);
      continue;
    }

    const thinking = await pickThinkingLevel(ctx, role);
    if (thinking === undefined) continue;
    config = await applyRoleUpdate(
      ctx,
      controller,
      config,
      role,
      { thinkingLevel: thinking },
      `thinking ${thinking ?? "default"}`,
    );
  }
}

/** Run the configuration flow; returns when the operator cancels the area picker. */
export async function openConfigView(ctx: ExtensionCommandContext, controller: LoopController): Promise<void> {
  if (!ctx.hasUI) {
    process.stdout.write("[specs-kit] Interactive configuration requires an available UI.\n");
    return;
  }

  for (;;) {
    const area = await ctx.ui.select("Configuration area", [AREA_ROLES, AREA_PANEL, AREA_HOOKS, AREA_RUN]);
    if (area === undefined) return;
    if (area === AREA_PANEL) {
      await openPanelConfig(ctx, controller);
    } else if (area === AREA_HOOKS) {
      await openHooksConfig(ctx, controller);
    } else if (area === AREA_RUN) {
      await openRunConfig(ctx, controller);
    } else {
      await configureRoles(ctx, controller);
    }
  }
}
