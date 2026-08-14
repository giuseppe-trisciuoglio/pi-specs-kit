/**
 * Interactive configuration flow: a top-level menu dispatches to the per-role
 * model and thinking pickers, to the phase hooks editor or to the run options.
 * Every change is written to the yaml config and reloaded into memory right
 * away, so what the menu shows is always what the next run will use.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { updateRoleConfig, type RoleUpdate } from "../config/config-writer.ts";
import { ROLE_NAMES, type RoleName, type SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { LoopController } from "../loop/loop-controller.ts";
import { openHooksConfig } from "./hooks-view.ts";
import type { ModelEntry } from "./model-list.ts";
import { AUTO, CLEAR_FILTER, KEEP, buildModelPickList, filterEntry, moreEntry } from "./model-picker.ts";
import { openModelSelector } from "./model-selector.ts";
import { openRunConfig } from "./run-view.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Drop the thinking level and let the agent CLI use its own default. */
const THINKING_DEFAULT = "(agent default)";

const AREA_ROLES = "Role models & thinking";
const AREA_HOOKS = "Phase hooks (pre/post)";
const AREA_RUN = "Run options (retries, timeout, toggles)";

/** Models selectable for a role: scoped set when present, else the catalogue. */
function modelCandidates(ctx: ExtensionCommandContext): ModelEntry[] {
  const models =
    ctx.scopedModels.length > 0 ? ctx.scopedModels.map((scoped) => scoped.model) : ctx.modelRegistry.getAvailable();
  return models.map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
  }));
}

function roleLabel(config: SpecsKitConfig, role: RoleName): string {
  const current = config.roles[role];
  return `${role} — model: ${current.model} · thinking: ${current.thinkingLevel ?? "default"}`;
}

/**
 * Ask for a model with the dialog based picker: the list stays short and is
 * narrowed by typing a filter term, because scrolling the whole catalogue in a
 * selection dialog is impractical. Undefined on cancel, null to keep.
 */
async function pickModelFromDialog(
  ctx: ExtensionCommandContext,
  role: RoleName,
  current: string,
): Promise<string | null | undefined> {
  const models = modelCandidates(ctx);
  let query = "";
  let showAll = false;

  for (;;) {
    const list = buildModelPickList(models, { query, current, showAll });
    const title =
      list.matchCount === 0
        ? `Model for ${role} — no match for "${query}"`
        : `Model for ${role} (${list.matchCount} available)`;
    const choice = await ctx.ui.select(title, list.options);
    if (choice === undefined) return undefined;
    if (choice === KEEP) return null;
    if (choice === AUTO) return AUTO;

    if (choice === CLEAR_FILTER) {
      query = "";
      showAll = false;
      continue;
    }
    if (choice === filterEntry(query)) {
      const input = await ctx.ui.input(`Filter models for ${role}:`, "e.g. sonnet, gpt, anthropic haiku");
      if (input === undefined) continue;
      query = input.trim();
      // A new filter starts from a short list again: showing everything only
      // makes sense for the list the operator just asked to expand.
      showAll = false;
      continue;
    }
    if (choice === moreEntry(list.hiddenCount)) {
      showAll = true;
      continue;
    }

    const value = list.values.get(choice);
    if (value !== undefined) return value;
  }
}

/**
 * Ask for a model: the searchable selector where a terminal can draw it, the
 * selection dialog everywhere else. Undefined on cancel, null to keep.
 */
async function pickModel(
  ctx: ExtensionCommandContext,
  role: RoleName,
  current: string,
): Promise<string | null | undefined> {
  const choice = await openModelSelector(ctx, { role, models: modelCandidates(ctx), current });
  if (choice.kind === "picked") return choice.value;
  if (choice.kind === "cancelled") return undefined;
  return pickModelFromDialog(ctx, role, current);
}

/**
 * Ask for a thinking level; undefined on cancel (the current one is kept),
 * null to drop the setting and leave the choice to the agent CLI.
 */
async function pickThinkingLevel(
  ctx: ExtensionCommandContext,
  role: RoleName,
): Promise<string | null | undefined> {
  const choice = await ctx.ui.select(`Thinking level for ${role}`, [THINKING_DEFAULT, ...THINKING_LEVELS]);
  if (choice === undefined) return undefined;
  return choice === THINKING_DEFAULT ? null : choice;
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
    const area = await ctx.ui.select("Configuration area", [AREA_ROLES, AREA_HOOKS, AREA_RUN]);
    if (area === undefined) return;
    if (area === AREA_HOOKS) {
      await openHooksConfig(ctx, controller);
    } else if (area === AREA_RUN) {
      await openRunConfig(ctx, controller);
    } else {
      await configureRoles(ctx, controller);
    }
  }
}
