/**
 * Interactive pickers used by the slash commands when an argument is missing
 * and a dialog-capable UI is available. Every picker returns undefined when
 * the operator cancels.
 */

import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PhaseName } from "../config/specs-kit-config.ts";
import type { LoopController } from "../loop/loop-controller.ts";
import { loadTasks } from "../tasks/task-loader.ts";

export const PHASE_CHOICES: readonly PhaseName[] = ["implementation", "review", "cleanup", "sync"];

/** Task range chosen through the picker; absent bounds mean open ends. */
export interface TaskRangePick {
  fromTask?: string;
  toTask?: string;
}

const FULL_RANGE = "Whole range";
const CUSTOM_RANGE = "Choose from and to…";
const FROM_START = "(from the start)";
const TO_END = "(to the end)";

/** Options shaping the spec picker list. */
export interface PickSpecOptions {
  /** Keep only specs that already have a task list (the loop needs them). */
  onlyWithTasks?: boolean;
  /** Spec to mark as the current selection. */
  active?: string;
  /** Dialog title. */
  title?: string;
  /** Notification shown when the list is empty. */
  emptyMessage?: string;
}

/** Pick a spec among those discovered under the specs root. */
export async function pickSpec(
  controller: LoopController,
  ctx: ExtensionCommandContext,
  opts: PickSpecOptions = {},
): Promise<string | undefined> {
  let specs = await controller.listSpecs();
  if (opts.onlyWithTasks) specs = specs.filter((spec) => spec.hasTasks);
  if (specs.length === 0) {
    ctx.ui.notify(opts.emptyMessage ?? "No spec with tasks found.", "warning");
    return undefined;
  }
  const labels = new Map(
    specs.map((spec) => [spec.dir === opts.active ? `${spec.dir} (active)` : spec.dir, spec.dir]),
  );
  const picked = await ctx.ui.select(opts.title ?? "Spec to run", [...labels.keys()]);
  return picked === undefined ? undefined : labels.get(picked);
}

/** Pick an optional from/to range over the task ids of a spec. */
export async function pickTaskRange(
  controller: LoopController,
  specDir: string,
  ctx: ExtensionCommandContext,
): Promise<TaskRangePick | undefined> {
  const config = controller.config;
  if (!config) return undefined;

  let ids: string[];
  try {
    const tasks = await loadTasks(path.resolve(config.projectRoot, specDir));
    ids = tasks.map((task) => task.frontmatter.id);
  } catch {
    ctx.ui.notify(`Unable to read the tasks of ${specDir}.`, "error");
    return undefined;
  }
  if (ids.length === 0) {
    ctx.ui.notify(`No tasks in ${specDir}.`, "warning");
    return undefined;
  }

  const choice = await ctx.ui.select("Task range", [FULL_RANGE, CUSTOM_RANGE]);
  if (choice === undefined) return undefined;
  if (choice === FULL_RANGE) return {};

  const from = await ctx.ui.select("First task", [FROM_START, ...ids]);
  if (from === undefined) return undefined;
  // Offer only the tasks at or after the first one: an inverted range selects
  // nothing, and the loop can only report that as an error.
  const fromIndex = from === FROM_START ? 0 : ids.indexOf(from);
  const to = await ctx.ui.select("Last task", [TO_END, ...ids.slice(fromIndex)]);
  if (to === undefined) return undefined;
  return {
    fromTask: from === FROM_START ? undefined : from,
    toTask: to === TO_END ? undefined : to,
  };
}

/** Pick the phase the loop should start from. */
export async function pickPhase(ctx: ExtensionCommandContext): Promise<PhaseName | undefined> {
  const choice = await ctx.ui.select("Phase to start from", [...PHASE_CHOICES]);
  return choice as PhaseName | undefined;
}
