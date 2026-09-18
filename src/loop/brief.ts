/**
 * The reading brief: prompt and file naming for the cheap read-only spawn
 * that reconnoiters a task before its first implementation attempt. The
 * brief it produces is consumed by every attempt of the task, so the
 * reconnaissance is paid for once instead of re-derived at full price by
 * each attempt.
 *
 * Pure module: only the prompt text and the file name live here, so both
 * the loop and the tests can import them without dragging in the spawner.
 */

import type { RoutedSuggestion } from "./review-report.ts";
import { BRIEF_MARKER } from "../tasks/task-files.ts";
import type { TaskFile } from "../tasks/task-parser.ts";

/** File name of the brief of one task, relative to the spec's tasks folder.
 * Built from the marker the loader excludes on, so the name written here and
 * the name kept out of the task set cannot drift apart. */
export function briefFileName(taskId: string): string {
  return `${taskId}${BRIEF_MARKER}.md`;
}

/**
 * The prompt of the brief spawn. It asks for a short, structured brief —
 * files to touch with the signatures already there, patterns the area
 * follows, tests to run, and what earlier tasks left behind — and it names
 * where the answers are cheapest: the codebase graph, the project rules, the
 * spec documents and the memory the loop keeps. Everything else is
 * exploration the implementation would otherwise do blind, once per attempt.
 */
export function buildBriefPrompt(input: {
  task: TaskFile;
  /** Where the brief file must be written, relative to the project root. */
  briefPath: string;
  /** Fixes earlier reviews routed to this task; they are the "left for you" half. */
  routedSuggestions?: readonly RoutedSuggestion[];
  /** Spec learnings injected as task memory. */
  learnings?: readonly string[];
  /** Project-level learnings accumulated across specs. */
  projectLearnings?: readonly string[];
}): string {
  const fm = input.task.frontmatter;
  const lines = [
    `Prepare the implementation of task ${fm.id} "${fm.title}" by writing its reading brief.`,
    "",
    "Read-only reconnaissance: do not modify any code, any test or any document of the",
    `spec. Your only output is the file ${input.briefPath}.`,
    "",
    "Read the task below, then look where the answers are cheapest: the codebase graph",
    "(graphify-out/graph.json) for what the area already contains, the .pi/rules files",
    "for the conventions the project enforces, and the spec documents next to the task",
    "for the contracts the task has to honor.",
    "",
    "The brief must contain, each under its own heading:",
    "- Files to touch, with the existing signatures or exports each one already has.",
    "- Patterns already used in the area, worth imitating (and the file that shows one).",
    "- The tests to run while iterating, and the ones that must pass at the end.",
    "- What previous work left for this task: contracts, routed fixes, recorded insights.",
    "",
    "Keep it short: it is read at the start of every attempt of this task. Facts and",
    "pointers, not prose.",
  ];
  const routed = (input.routedSuggestions ?? []).filter((r) => r.text.trim() !== "");
  if (routed.length > 0) {
    lines.push(
      "",
      "Fixes earlier reviews routed to this task — carry them into the brief verbatim:",
      ...routed.map((r) => `- ${r.text}`),
    );
  }
  const learnings = input.learnings ?? [];
  if (learnings.length > 0) {
    lines.push("", "What the loop has already learned on this spec:", ...learnings.map((l) => `- ${l}`));
  }
  const project = input.projectLearnings ?? [];
  if (project.length > 0) {
    lines.push("", "What the project has recorded across specs:", ...project.map((l) => `- ${l}`));
  }
  lines.push("", `<task id="${fm.id}" title="${fm.title}">\n${input.task.body.trim()}\n</task>`);
  return lines.join("\n") + "\n";
}
