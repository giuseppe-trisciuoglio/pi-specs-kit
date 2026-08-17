/**
 * Run walk: the explicit sequence over the task selection. Picks the next
 * task not already done, hands it to the per-task state machine and closes
 * the range when the selection runs out. The resume anchor, when present, is
 * consumed by the first iteration.
 */

import type { FixPlan, LoopStep } from "../fixplan/fix-plan.ts";
import type { TaskFile } from "../tasks/task-parser.ts";
import { consumeRunNode, type RunNode } from "./graph/run-graph.ts";
import { rangeCloseWarnings, type RangeCloseDeps } from "./range-close.ts";
import type { RunState, TaskRunner } from "./task-runner.ts";

export interface WalkDeps {
  stopping: () => "graceful" | "now" | null;
  notify: (message: string, type: "info" | "warning" | "error") => void;
  persist: (plan: FixPlan) => Promise<void>;
  /**
   * Where the closing checks read the spec's own claims. Absent means the
   * walk was assembled without them and the range closes unchecked, which is
   * how the loop behaved before they existed.
   */
  rangeClose?: RangeCloseDeps;
}

export interface WalkStart {
  pendingStart: { task: TaskFile; step: LoopStep } | null;
  index: number;
  firstPhase: LoopStep | null;
}

export async function walkSelection(
  plan: FixPlan,
  selected: TaskFile[],
  runner: TaskRunner,
  runState: RunState,
  start: WalkStart,
  finalSync: RunNode,
  deps: WalkDeps,
): Promise<{ reason: "completed" | "halted" | "stopped"; error?: string }> {
  let { pendingStart, index, firstPhase } = start;
  // Failures are collected as they happen: the error a failed task leaves in
  // the state is wiped by the next task's entry, so by the end of the range
  // only a failure on the very last task would still be visible there.
  const failures: string[] = [];
  for (;;) {
    if (deps.stopping()) return { reason: "stopped" };
    let taskFile: TaskFile;
    let startStep: LoopStep | null = null;
    let resumed = false;
    if (pendingStart) {
      taskFile = pendingStart.task;
      startStep = pendingStart.step;
      resumed = true;
      pendingStart = null;
      index++;
      // The explicit start phase belongs to the first task of the run, and
      // the resumed task uses its persisted anchor instead: consume it here
      // or it would leak into the next task and skip its implementation.
      if (firstPhase && firstPhase !== startStep) {
        deps.notify(`start phase ${firstPhase} ignored: ${taskFile.frontmatter.id} resumes at ${startStep}`, "info");
      }
      firstPhase = null;
    } else {
      while (index < selected.length && plan.done.includes(selected[index].frontmatter.id)) index++;
      if (index >= selected.length) {
        await consumeRunNode(finalSync, {
          syncRan: runState.syncRan,
          hasLastCompleted: runState.lastCompleted !== null,
          stopping: deps.stopping() !== null,
        });
        // A task that failed while continuing left its message behind: keep
        // it for the operator as a notice, but do not persist it next to a
        // completed step or every later reader would see a halt that the run
        // never ended on.
        plan.state.step = "done";
        plan.state.current_task = null;
        plan.state.current_task_file = null;
        plan.state.current_task_lang = null;
        plan.state.error = null;
        await deps.persist(plan);
        if (failures.length > 0) {
          const count = failures.length === 1 ? "1 task" : `${failures.length} tasks`;
          deps.notify(`range completed with failures (${count}), last: ${failures[failures.length - 1]}`, "warning");
        }
        const p = plan.range_progress;
        deps.notify(`range completed: ${p.done_in_range}/${p.total_in_range} tasks (${p.percent}%)`, "info");
        // The claims the range leaves behind are checked here, once, while the
        // operator is still reading the close: a matrix citing tests that are
        // not there, and review fixes handed to tasks that never ran.
        if (deps.rangeClose) {
          for (const warning of await rangeCloseWarnings(plan, deps.rangeClose)) {
            deps.notify(warning, "warning");
          }
        }
        // A sync that ran without the codebase graph left the run partial:
        // say so once at the end so the operator knows graph-backed
        // validation was skipped and the docs sync may be incomplete.
        if (plan.state.graphPartialSync) {
          deps.notify(
            "range completed with a partial sync: the codebase graph was absent, so graph-backed dependency validation was skipped",
            "warning",
          );
        }
        // A red post-hook gate on a phase with no retry path stays recorded
        // so the run does not declare itself clean when a gate was red. Named
        // once here and cleared, so the next run starts from a blank slate.
        if (plan.state.postHookGateFailed) {
          deps.notify(
            `range completed with a failed post-hook gate: the ${plan.state.postHookGateFailed} phase ended with a red gate`,
            "warning",
          );
          plan.state.postHookGateFailed = null;
          await deps.persist(plan);
        }
        return { reason: "completed" };
      }
      taskFile = selected[index];
      index++;
      startStep = firstPhase;
      firstPhase = null;
    }

    const outcome = await runner.run(plan, taskFile, selected, startStep, resumed, runState);
    if (outcome === "stopped") return { reason: "stopped" };
    if (outcome === "halted") return { reason: "halted", error: plan.state.error ?? undefined };
    // The run carried on past a failed task: record it now, while its message
    // is still there.
    if (plan.state.step === "failed" && plan.state.error) failures.push(plan.state.error);
  }
}
