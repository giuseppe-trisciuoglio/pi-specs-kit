/**
 * Asking the operator for a model and a thinking level. Both the loop roles
 * and the review panel need the same two prompts, so they live here rather
 * than in either menu: the only thing that changes between callers is the
 * label the prompt is titled with.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModelEntry } from "./model-list.ts";
import { AUTO, CLEAR_FILTER, KEEP, buildModelPickList, filterEntry, moreEntry } from "./model-picker.ts";
import { openModelSelector } from "./model-selector.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Drop the thinking level and let the agent CLI use its own default. */
export const THINKING_DEFAULT = "(agent default)";

/** Models selectable here: the scoped set when present, else the catalogue. */
export function modelCandidates(ctx: ExtensionCommandContext): ModelEntry[] {
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

/**
 * Ask for a model with the dialog based picker: the list stays short and is
 * narrowed by typing a filter term, because scrolling the whole catalogue in a
 * selection dialog is impractical. Undefined on cancel, null to keep.
 */
async function pickModelFromDialog(
  ctx: ExtensionCommandContext,
  label: string,
  current: string,
): Promise<string | null | undefined> {
  const models = modelCandidates(ctx);
  let query = "";
  let showAll = false;

  for (;;) {
    const list = buildModelPickList(models, { query, current, showAll });
    const title =
      list.matchCount === 0
        ? `Model for ${label} — no match for "${query}"`
        : `Model for ${label} (${list.matchCount} available)`;
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
      const input = await ctx.ui.input(`Filter models for ${label}:`, "e.g. sonnet, gpt, anthropic haiku");
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
export async function pickModel(
  ctx: ExtensionCommandContext,
  label: string,
  current: string,
): Promise<string | null | undefined> {
  const choice = await openModelSelector(ctx, { role: label, models: modelCandidates(ctx), current });
  if (choice.kind === "picked") return choice.value;
  if (choice.kind === "cancelled") return undefined;
  return pickModelFromDialog(ctx, label, current);
}

/**
 * Ask for a thinking level; undefined on cancel (the current one is kept),
 * null to drop the setting and leave the choice to the agent CLI.
 */
export async function pickThinkingLevel(
  ctx: ExtensionCommandContext,
  label: string,
): Promise<string | null | undefined> {
  const choice = await ctx.ui.select(`Thinking level for ${label}`, [THINKING_DEFAULT, ...THINKING_LEVELS]);
  if (choice === undefined) return undefined;
  return choice === THINKING_DEFAULT ? null : choice;
}
