/**
 * Editor for the adversarial review panel: an ordered list of reviewers, each
 * a model plus an optional thinking level. Order is meaningful — it decides
 * which reviewer gets which critique angle — so the menu shows the angle next
 * to every slot and lets the operator move a reviewer up or down.
 *
 * The panel is edited by hand and never filled in automatically: several
 * providers bill per token on every model they expose, so which models the
 * review may spend on stays a decision the operator makes explicitly.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { updateReviewPanel } from "../config/config-writer.ts";
import { MAX_PANEL_REVIEWERS, PANEL_PERSONAS, type PanelReviewer, type SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { LoopController } from "../loop/loop-controller.ts";
import { pickModel, pickThinkingLevel } from "./model-prompt.ts";

const ADD = "Add a reviewer…";
const DONE = "Done";

/** Two reviewers is the smallest panel that can tell consensus from opinion. */
const MIN_USEFUL_PANEL = 2;

function personaOf(index: number): string {
  return PANEL_PERSONAS[index] ?? `reviewer ${index + 1}`;
}

function reviewerLabel(reviewer: PanelReviewer, index: number): string {
  const thinking = reviewer.thinkingLevel ?? "default";
  return `${index + 1}. ${personaOf(index)} — ${reviewer.model} · thinking: ${thinking}`;
}

/** Write the panel and reload; returns the config in force afterwards. */
async function applyPanel(
  ctx: ExtensionCommandContext,
  controller: LoopController,
  config: SpecsKitConfig,
  panel: PanelReviewer[],
  summary: string,
): Promise<SpecsKitConfig> {
  try {
    await updateReviewPanel(config.configPath, panel);
    const reloaded = await controller.loadConfig(config.projectRoot);
    ctx.ui.notify(`[specs-kit] Review panel: ${summary}.`, "info");
    return reloaded;
  } catch (err) {
    ctx.ui.notify(`[specs-kit] Config write failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return config;
  }
}

/** Per-reviewer menu: change the model, change thinking, reorder, remove. */
async function editReviewer(
  ctx: ExtensionCommandContext,
  controller: LoopController,
  config: SpecsKitConfig,
  index: number,
): Promise<SpecsKitConfig> {
  const panel = [...config.reviewPanel];
  const reviewer = panel[index];
  const persona = personaOf(index);

  const modelField = `Model: ${reviewer.model}`;
  const thinkingField = `Thinking: ${reviewer.thinkingLevel ?? "default"}`;
  const moveUp = "Move up (takes the angle above)";
  const moveDown = "Move down (takes the angle below)";
  const remove = "Remove from the panel";
  const options = [modelField, thinkingField];
  if (index > 0) options.push(moveUp);
  if (index < panel.length - 1) options.push(moveDown);
  options.push(remove);

  const field = await ctx.ui.select(`${persona} — ${reviewer.model}`, options);
  if (field === undefined) return config;

  if (field === modelField) {
    const model = await pickModel(ctx, persona, reviewer.model);
    if (model === null || model === undefined) return config;
    panel[index] = { ...reviewer, model };
    return applyPanel(ctx, controller, config, panel, `${persona} runs ${model}`);
  }

  if (field === thinkingField) {
    const thinking = await pickThinkingLevel(ctx, persona);
    if (thinking === undefined) return config;
    panel[index] = thinking === null ? { model: reviewer.model } : { model: reviewer.model, thinkingLevel: thinking };
    return applyPanel(ctx, controller, config, panel, `${persona} thinking ${thinking ?? "default"}`);
  }

  if (field === remove) {
    panel.splice(index, 1);
    return applyPanel(ctx, controller, config, panel, `${reviewer.model} removed`);
  }

  const target = field === moveUp ? index - 1 : index + 1;
  [panel[index], panel[target]] = [panel[target], panel[index]];
  return applyPanel(ctx, controller, config, panel, `${reviewer.model} now reviews as ${personaOf(target)}`);
}

/** Append a reviewer, up to the supported number of slots. */
async function addReviewer(
  ctx: ExtensionCommandContext,
  controller: LoopController,
  config: SpecsKitConfig,
): Promise<SpecsKitConfig> {
  const panel = [...config.reviewPanel];
  if (panel.length >= MAX_PANEL_REVIEWERS) {
    ctx.ui.notify(`[specs-kit] The panel already has ${MAX_PANEL_REVIEWERS} reviewers, the supported maximum.`, "warning");
    return config;
  }
  const persona = personaOf(panel.length);
  const model = await pickModel(ctx, persona, "auto");
  if (model === null || model === undefined) return config;
  panel.push({ model });
  return applyPanel(ctx, controller, config, panel, `${model} added as ${persona}`);
}

/**
 * Panel editing loop; returns when the operator leaves the menu. A panel of
 * fewer than two reviewers is reported on the way out: one model reviewing
 * alone is a single opinion, which is the thing the panel exists to avoid.
 */
export async function openPanelConfig(ctx: ExtensionCommandContext, controller: LoopController): Promise<void> {
  let config = controller.config ?? (await controller.loadConfig(ctx.cwd));

  for (;;) {
    const panel = config.reviewPanel;
    const labels = panel.map((reviewer, index) => reviewerLabel(reviewer, index));
    const options = [...labels];
    if (panel.length < MAX_PANEL_REVIEWERS) options.push(ADD);
    options.push(DONE);

    const title =
      panel.length === 0
        ? "Adversarial review panel — no reviewer declared"
        : `Adversarial review panel (${panel.length} reviewers)`;
    const picked = await ctx.ui.select(title, options);
    if (picked === undefined || picked === DONE) {
      if (config.reviewPanel.length > 0 && config.reviewPanel.length < MIN_USEFUL_PANEL) {
        ctx.ui.notify("[specs-kit] A panel of one model is a single opinion: add a second provider.", "warning");
      }
      return;
    }

    if (picked === ADD) {
      config = await addReviewer(ctx, controller, config);
      continue;
    }
    config = await editReviewer(ctx, controller, config, labels.indexOf(picked));
  }
}
