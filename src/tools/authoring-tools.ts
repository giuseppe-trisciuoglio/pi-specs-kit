/**
 * LLM-callable tools for the authoring chain. Kept separate from the loop
 * tools so each stays focused; like them, these never touch the interactive
 * UI: a bad input comes back as plain error text in the tool result.
 */

import { Type } from "typebox";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopController } from "../loop/loop-controller.ts";

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

/** Bring an agent-provided path to the shape discovery reports (no "./", no trailing separator). */
function normalizeSpecDir(value: string): string {
  const normalized = path.normalize(value.trim().replace(/[\\/]+$/, ""));
  return normalized === "." ? "" : normalized;
}

/**
 * Register the authoring tools. Registration only: nothing is started here,
 * so this stays safe under hot reload.
 */
export function registerAuthoringTools(pi: ExtensionAPI, controller: LoopController): void {
  pi.registerTool({
    name: "specs_kit_set_active_spec",
    label: "Set active spec",
    description:
      "Persist the active spec in the project configuration so the authoring and loop commands default to it. " +
      "Call this once a new spec has been written under the specs directory.",
    parameters: Type.Object({
      spec_dir: Type.String({
        description: "Spec directory relative to the project root, e.g. docs/specs/001-feature.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const config = controller.config ?? (await controller.loadConfig(ctx.cwd));
      const specDir = normalizeSpecDir(String(params.spec_dir ?? ""));
      if (!specDir) return textResult("error: spec_dir is required");
      // Validate against discovery, exactly like /specs-kit-spec does: mere
      // existence would accept the specs root itself, a file inside a spec, or
      // a path outside the project, and persist it as the active spec.
      try {
        const specs = await controller.listSpecs();
        if (!specs.some((spec) => spec.dir === specDir)) {
          return textResult(
            `error: not a spec directory under ${config.specsDir}: ${specDir}. ` +
              `Known specs: ${specs.length ? specs.map((s) => s.dir).join(", ") : "(none)"}`,
          );
        }
        await controller.setActiveSpec(specDir);
      } catch (err) {
        return textResult(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return textResult(JSON.stringify({ ok: true, spec: specDir }));
    },
  });
}
