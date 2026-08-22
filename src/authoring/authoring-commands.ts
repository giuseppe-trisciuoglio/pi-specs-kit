/**
 * The authoring slash commands. Both hand off to the agent by injecting a
 * user message that carries the relevant skill content inline — the same
 * approach the loop uses for phase skills — so the agent follows the pi-native
 * skill regardless of /skill: discovery quirks.
 *
 * - /specs-kit-new: inline the brainstorm skill; on completion the agent
 *   persists the new spec as active through the specs_kit_set_active_spec tool.
 * - /specs-kit-continue: derive the next step from the active spec's
 *   artifacts and inline the matching skill, or report when the spec is ready.
 */

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureConfigFile } from "../config/config-init.ts";
import { CONFIG_FILE_NAME } from "../config/specs-kit-config.ts";
import type { LoopController } from "../loop/loop-controller.ts";
import type { AuthoringWindowTracker } from "../measure/authoring-window.ts";
import { resolveSkill } from "../prompt/skill-resolver.ts";
import { pickSpec } from "../ui/pickers.ts";
import { report } from "../ui/report.ts";
import { parseRunArgs } from "../ui/run-args.ts";
import { deriveAuthoringStep } from "./spec-state.ts";

/** Wrap skill content in a clear delimiter and append the per-step directive. */
function buildSkillMessage(name: string, content: string, dir: string, directive: string): string {
  return (
    `<specs-kit-skill name="${name}" dir="${dir}">\n${content}\n</specs-kit-skill>\n\n` +
    `Read any templates the skill references from its directory (${dir}).\n\n${directive}`
  );
}

/**
 * Register the two authoring commands. Registration only, safe under reload.
 * The tracker measures the authoring windows: every specs-kit command closes
 * the current window on entry, and a command that hands off to the agent opens
 * a fresh one just before doing so.
 */
export function registerAuthoringCommands(
  pi: ExtensionAPI,
  controller: LoopController,
  tracker?: AuthoringWindowTracker,
): void {
  pi.registerCommand("specs-kit-new", {
    description: "Brainstorm a new functional specification and set it active on completion",
    handler: async (args, ctx) => {
      tracker?.close();
      // A project without a config file gets one before anything else: the
      // spec is about to be written under the configured specs directory, and
      // the tool that marks it active writes back into this same file.
      let created = false;
      try {
        created = await ensureConfigFile(path.resolve(ctx.cwd, CONFIG_FILE_NAME));
      } catch (err: unknown) {
        report(ctx, `[specs-kit] ${(err as Error).message}`);
        return;
      }
      const config = created || !controller.config
        ? await controller.loadConfig(ctx.cwd)
        : controller.config;
      if (created) report(ctx, `[specs-kit] Created ${CONFIG_FILE_NAME} with default values.`);
      if (!ctx.isIdle()) {
        report(ctx, "[specs-kit] Agent is busy. Finish the current turn before starting a new spec.");
        return;
      }
      const skill = await resolveSkill("specs-kit-brainstorm");
      if (!skill) {
        report(ctx, "[specs-kit] Brainstorm skill not found in the bundle.");
        return;
      }
      const idea = args.trim();
      const head = idea
        ? `Author a new functional specification from this idea:\n\n${idea}`
        : "Author a new functional specification";
      const directive =
        `${head}. When you have written it under ${config.specsDir}/, call the specs_kit_set_active_spec tool ` +
        `When you have written it under ${config.specsDir}/, call the specs_kit_set_active_spec tool ` +
        "with the new spec directory (relative to the project root) so it becomes the active spec.";
      pi.sendUserMessage(buildSkillMessage(skill.name, skill.content, skill.dir, directive));
      tracker?.begin();
      report(ctx, "[specs-kit] Brainstorm started; the spec will be marked active when it finishes.");
    },
  });

  pi.registerCommand("specs-kit-spec", {
    description: "Show or set the active spec",
    handler: async (args, ctx) => {
      tracker?.close();
      const config = controller.config ?? (await controller.loadConfig(ctx.cwd));
      const direct = parseRunArgs(args).spec ?? args.trim();
      if (direct) {
        const specs = await controller.listSpecs();
        if (!specs.some((spec) => spec.dir === direct)) {
          report(ctx, `[specs-kit] Spec not found under ${config.specsDir}: ${direct}`);
          return;
        }
        await controller.setActiveSpec(direct);
        report(ctx, `[specs-kit] Active spec: ${direct}`);
        return;
      }
      const specs = await controller.listSpecs();
      if (specs.length === 0) {
        report(ctx, `[specs-kit] No specs under ${config.specsDir}. Run /specs-kit-new to create one.`);
        return;
      }
      if (!ctx.hasUI) {
        const lines = specs.map(
          (spec) => `${spec.dir === config.spec ? "*" : "-"} ${spec.dir}${spec.hasTasks ? "" : " (no tasks yet)"}`,
        );
        report(
          ctx,
          `[specs-kit] Active spec: ${config.spec ?? "(none)"}\n${lines.join("\n")}\nSet with: /specs-kit-spec <dir>`,
        );
        return;
      }
      const picked = await pickSpec(controller, ctx, {
        active: config.spec,
        title: "Active spec",
        emptyMessage: "No specs found.",
      });
      if (!picked) return;
      await controller.setActiveSpec(picked);
      report(ctx, `[specs-kit] Active spec: ${picked}`);
    },
  });

  pi.registerCommand("specs-kit-continue", {
    description: "Advance the active spec to its next authoring step",
    handler: async (_args, ctx) => {
      tracker?.close();
      const config = controller.config ?? (await controller.loadConfig(ctx.cwd));
      const spec = config.spec;
      if (!spec) {
        report(ctx, "[specs-kit] No active spec. Run /specs-kit-new to create one.");
        return;
      }
      const step = await deriveAuthoringStep(config.projectRoot, spec);
      if (step.stage === "ready") {
        report(ctx, `[specs-kit] ${spec}: ${step.summary}`);
        return;
      }
      if (!ctx.isIdle()) {
        report(ctx, "[specs-kit] Agent is busy. Finish the current turn before continuing.");
        return;
      }
      const skill = await resolveSkill(step.skillName);
      if (!skill) {
        report(ctx, `[specs-kit] ${step.skillName} skill not found in the bundle.`);
        return;
      }
      pi.sendUserMessage(buildSkillMessage(skill.name, skill.content, skill.dir, step.directive));
      tracker?.begin();
      report(ctx, `[specs-kit] ${spec}: ${step.summary}.`);
    },
  });
}
