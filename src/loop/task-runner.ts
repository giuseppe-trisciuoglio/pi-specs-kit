/**
 * Per-task state machine: implementation, review, cleanup, learner, sync and
 * update_done for a single task (the review retry sub-loop lives next door). The engine owns
 * the run-level orchestration (selection, resume anchor, stop handling) and
 * hands each task over here. The control flow is the declared graph under
 * graph/: this class builds the task runtime, binds the node actions to the
 * table and lets the interpreter walk it. Every state mutation is persisted
 * by the node actions themselves, exactly where the loop performs it today.
 */

import type { FixPlan, LoopStep } from "../fixplan/fix-plan.ts";
import type { TaskFile } from "../tasks/task-parser.ts";
import { makeCycleNodeActions } from "./graph/task-nodes-cycle.ts";
import { makeTailNodeActions } from "./graph/task-nodes-tail.ts";
import { buildTaskGraph } from "./graph/task-graph.ts";
import { interpretTaskGraph } from "./graph/interpreter.ts";
import type {
  NodeAction,
  RoutingFacts,
  RunState,
  TaskNodeDeps,
  TaskNodeEnv,
  TaskNodeId,
  TaskOutcome,
  TaskRuntime,
} from "./graph/types.ts";

export type { RunState, TaskOutcome } from "./graph/types.ts";

/** The wiring of a task runner: the dependency set every node action binds to. */
export type TaskRunnerDeps = TaskNodeDeps;

export class TaskRunner {
  readonly #deps: TaskRunnerDeps;

  constructor(deps: TaskRunnerDeps) {
    this.#deps = deps;
  }

  async run(
    plan: FixPlan,
    taskFile: TaskFile,
    selected: TaskFile[],
    startStep: LoopStep | null,
    resumed: boolean,
    runState: RunState,
  ): Promise<TaskOutcome> {
    const { config } = this.#deps;
    const state = plan.state;

    const runtime: TaskRuntime = {
      entry: { resumed, startStep },
      feedback: null,
      lastVerdict: null,
      implStatus: "ok",
      postHookFailures: null,
      routedSuggestions: [],
      runState,
    };
    const env: TaskNodeEnv = { deps: this.#deps, plan, taskFile, selected };
    const cycle = makeCycleNodeActions(env);
    const tail = makeTailNodeActions(env);
    // Sinks and the start marker never execute an action: the start marker
    // only forwards to the task entry, and the interpreter returns at sinks.
    const noop: NodeAction = async () => ({ kind: "ok" });
    const actions: Record<TaskNodeId, NodeAction> = {
      task_start: noop,
      ...cycle,
      ...tail,
      task_done: noop,
      task_stopped: noop,
      task_halted: noop,
    };
    const facts: RoutingFacts = {
      mode: config.mode,
      // Fast mode syncs once, on the last task of the selection. "Last" is
      // positional: keying it on the done set would skip the sync of every
      // earlier task as soon as a later one fails, and the failed task
      // returns before its own sync — leaving the run with no sync at all.
      isLastTask: !selected.some((t) => t.num > taskFile.num),
      continueOnFailure: config.run.continueOnFailure,
      attemptsLeft: () => state.retry_count < config.run.maxAttempts,
      stopping: () => this.#deps.stopping() !== null,
    };
    return interpretTaskGraph(buildTaskGraph(actions), {
      runtime,
      facts,
      // Safety net against a sinkless cycle; the retry budget bounds real
      // walks: each attempt costs at most four hops (the spawn-failure
      // self-loop, the review pair and the gate), so the attempt ceiling
      // times four plus a fixed slack for the entry and the tail stays a
      // bound no legitimate walk reaches.
      maxHops: config.run.maxAttempts * 4 + 16,
    });
  }
}
