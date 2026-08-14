/**
 * Interactive flow for editing the run: scalars that shape each phase
 * subprocess: the retry budget, the wall-clock timeout and the boolean
 * toggles. Each confirmed change is written to the yaml config immediately
 * and reloaded into memory, so a running loop picks it up at the next phase
 * boundary without a restart.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { updateRunConfig, type RunField } from "../config/config-writer.ts";
import type { RunConfig, SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { LoopController } from "../loop/loop-controller.ts";
import { formatDurationMs, parseDurationMs } from "../util/duration.ts";

type FieldKind = "boolean" | "duration" | "number";

interface RunFieldDef {
  field: RunField;
  kind: FieldKind;
  label: string;
  /** Human-readable current value for the menu entry. */
  display: (run: RunConfig) => string;
}

/** The settings surfaced to the operator, matching the run: scalars in the config file. */
const FIELDS: readonly RunFieldDef[] = [
  { field: "max_attempts", kind: "number", label: "max attempts", display: (r) => String(r.maxAttempts) },
  { field: "timeout", kind: "duration", label: "phase timeout", display: (r) => formatDurationMs(r.timeoutMs) },
  { field: "no_commit", kind: "boolean", label: "skip git commit", display: (r) => String(r.noCommit) },
  { field: "yolo", kind: "boolean", label: "auto-approve tools (yolo)", display: (r) => String(r.yolo) },
  { field: "debug_stream", kind: "boolean", label: "stream subprocess output", display: (r) => String(r.debugStream) },
  { field: "no_log_files", kind: "boolean", label: "disable log files", display: (r) => String(r.noLogFiles) },
  { field: "show_prompt", kind: "boolean", label: "show phase prompt", display: (r) => String(r.showPrompt) },
  { field: "skill_content", kind: "boolean", label: "inline skill content", display: (r) => String(r.skillContent) },
  { field: "max_spawns_per_task", kind: "number", label: "max agent sessions per task", display: (r) => String(r.maxSpawnsPerTask) },
  { field: "max_spawns_per_run", kind: "number", label: "max agent sessions per run", display: (r) => String(r.maxSpawnsPerRun) },
  { field: "max_run_duration", kind: "duration", label: "max run duration", display: (r) => formatDurationMs(r.maxRunDurationMs) },
];

/** Persist a single field after confirmation; returns the freshest config. */
async function writeField(
  ctx: ExtensionCommandContext,
  controller: LoopController,
  config: SpecsKitConfig,
  def: RunFieldDef,
  value: string | number | boolean,
  display: string,
): Promise<SpecsKitConfig> {
  if (!(await ctx.ui.confirm("Confirm change", `${def.label} → ${display}`))) return config;
  try {
    await updateRunConfig(config.configPath, [{ field: def.field, value }]);
    const refreshed = await controller.loadConfig(config.projectRoot);
    ctx.ui.notify(`[specs-kit] Configuration updated (${def.label} → ${display}).`, "info");
    return refreshed;
  } catch (err) {
    ctx.ui.notify(`[specs-kit] Config write failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return config;
  }
}

/** Capture a new value for one field according to its kind; returns the freshest config. */
async function editField(
  ctx: ExtensionCommandContext,
  controller: LoopController,
  config: SpecsKitConfig,
  def: RunFieldDef,
): Promise<SpecsKitConfig> {
  const current = def.display(config.run);

  if (def.kind === "boolean") {
    const choice = await ctx.ui.select(`${def.label} (current ${current})`, ["true", "false"]);
    if (choice === undefined) return config;
    const value = choice === "true";
    return writeField(ctx, controller, config, def, value, String(value));
  }

  const placeholder =
    def.kind === "duration"
      ? `current ${current} — e.g. 40m, 1h, 240s`
      : `current ${current} — e.g. 5`;
  const input = await ctx.ui.input(`${def.label}:`, placeholder);
  if (input === undefined) return config;
  const trimmed = input.trim();
  if (trimmed === "") return config;

  if (def.kind === "duration") {
    if (parseDurationMs(trimmed) === undefined) {
      ctx.ui.notify(`[specs-kit] Invalid duration "${trimmed}"; use forms like 240s, 40m, 1h.`, "error");
      return config;
    }
    return writeField(ctx, controller, config, def, trimmed, trimmed);
  }

  // Non-negative integer.
  if (!/^\d+$/.test(trimmed)) {
    ctx.ui.notify(`[specs-kit] Invalid number "${trimmed}"; use a non-negative integer.`, "error");
    return config;
  }
  const num = Number.parseInt(trimmed, 10);
  return writeField(ctx, controller, config, def, num, String(num));
}

/** Run the run-options configuration flow; returns when the operator cancels the picker. */
export async function openRunConfig(ctx: ExtensionCommandContext, controller: LoopController): Promise<void> {
  let config = controller.config ?? (await controller.loadConfig(ctx.cwd));

  for (;;) {
    const labels = FIELDS.map((def) => `${def.label} — ${def.display(config.run)}`);
    const picked = await ctx.ui.select("Run options — pick a setting", labels);
    if (picked === undefined) return;
    const def = FIELDS[labels.indexOf(picked)];
    config = await editField(ctx, controller, config, def);
  }
}
