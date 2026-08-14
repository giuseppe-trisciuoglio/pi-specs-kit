import test from "node:test";
import assert from "node:assert/strict";
import { interpretTaskGraph } from "../src/loop/graph/interpreter.ts";
import { CONDITIONS, type ConditionName } from "../src/loop/graph/conditions.ts";
import type {
  NodeAction,
  NodeOutcome,
  RoutingFacts,
  TaskGraph,
  TaskNodeId,
  TaskNode,
  TaskRuntime,
} from "../src/loop/graph/types.ts";

function makeRuntime(overrides: Partial<TaskRuntime> = {}): TaskRuntime {
  return {
    entry: { resumed: false, startStep: null },
    feedback: null,
    lastVerdict: null,
    implStatus: "ok",
    routedSuggestions: [],
    runState: { syncRan: false, lastCompleted: null },
    ...overrides,
  };
}

function makeFacts(overrides: Partial<RoutingFacts> = {}): RoutingFacts {
  return {
    mode: "full",
    isLastTask: false,
    continueOnFailure: false,
    attemptsLeft: () => true,
    stopping: () => false,
    ...overrides,
  };
}

/** A node action that records its visit under the given label. */
function visit(visited: string[], id: string, effect?: (runtime: TaskRuntime) => void): NodeAction {
  return async (io) => {
    visited.push(id);
    effect?.(io.runtime);
    const outcome: NodeOutcome = { kind: "ok" };
    return outcome;
  };
}

function node(
  id: TaskNode["id"],
  kind: TaskNode["kind"],
  action?: NodeAction,
  outcome?: TaskNode["outcome"],
): TaskNode {
  return { id, kind, action, outcome };
}

function graph(nodes: TaskNode[], edges: TaskGraph["edges"], entry: TaskNodeId = "task_start"): TaskGraph {
  return { entry, nodes, edges };
}

test("linear path walks every node in order and returns the sink outcome", async () => {
  const visited: string[] = [];
  const g = graph(
    [
      node("task_start", "deterministic", visit(visited, "task_start")),
      node("checkpoint", "deterministic", visit(visited, "checkpoint")),
      node("task_done", "sink", undefined, "done"),
    ],
    [
      { from: "task_start", to: "checkpoint", type: "advance", when: "always" },
      { from: "checkpoint", to: "task_done", type: "advance", when: "always" },
    ],
  );
  const outcome = await interpretTaskGraph(g, { runtime: makeRuntime(), facts: makeFacts() });
  assert.equal(outcome, "done");
  assert.deepEqual(visited, ["task_start", "checkpoint"]);
});

test("conditional branch follows the predicate that reads the runtime", async () => {
  const build = () => {
    const visited: string[] = [];
    const g = graph(
      [
        node("review_gate", "deterministic", visit(visited, "review_gate")),
        node("cleanup", "deterministic", visit(visited, "cleanup")),
        node("learner", "deterministic", visit(visited, "learner")),
        node("task_done", "sink", undefined, "done"),
      ],
      [
        { from: "review_gate", to: "cleanup", type: "passed", when: "verdict_passed_full_mode" },
        { from: "review_gate", to: "learner", type: "mode-skip", when: "verdict_passed_fast_mode" },
        { from: "cleanup", to: "task_done", type: "advance", when: "always" },
        { from: "learner", to: "task_done", type: "advance", when: "always" },
      ],
      "review_gate",
    );
    return { g, visited };
  };

  // Full mode: the passed verdict routes through cleanup.
  const full = build();
  assert.equal(
    await interpretTaskGraph(full.g, {
      runtime: makeRuntime({ lastVerdict: { kind: "passed" } }),
      facts: makeFacts({ mode: "full" }),
    }),
    "done",
  );
  assert.deepEqual(full.visited, ["review_gate", "cleanup"]);

  // Fast mode: the same verdict skips cleanup and lands on the learner.
  const fast = build();
  assert.equal(
    await interpretTaskGraph(fast.g, {
      runtime: makeRuntime({ lastVerdict: { kind: "passed" } }),
      facts: makeFacts({ mode: "fast" }),
    }),
    "done",
  );
  assert.deepEqual(fast.visited, ["review_gate", "learner"]);
});

test("edge order is first-match-wins: the exhaustion guard wins over the failure kinds", async () => {
  // Attempts exhausted: a spawn failure routes to the funnel, not to a retry.
  const exhausted: string[] = [];
  const gExhausted = graph(
    [
      node("implementation", "agentic", visit(exhausted, "implementation", (rt) => {
        rt.implStatus = "spawn-failed";
      })),
      node("task_failed", "deterministic", visit(exhausted, "task_failed")),
      node("review", "agentic", visit(exhausted, "review")),
      node("task_halted", "sink", undefined, "halted"),
    ],
    [
      // Exhaustion declared before the back-edges, like the loop guard did.
      { from: "implementation", to: "task_failed", type: "attempts-exhausted", when: "impl_failed_attempts_exhausted" },
      { from: "implementation", to: "implementation", type: "spawn-failed", when: "impl_spawn_failed" },
      { from: "implementation", to: "review", type: "advance", when: "impl_ok" },
      { from: "task_failed", to: "task_halted", type: "halt-on-failure", when: "halt_on_failure" },
    ],
    "implementation",
  );
  assert.equal(
    await interpretTaskGraph(gExhausted, {
      runtime: makeRuntime(),
      facts: makeFacts({ attemptsLeft: () => false }),
    }),
    "halted",
  );
  assert.deepEqual(exhausted, ["implementation", "task_failed"]);

  // Attempts still left: the same spawn failure takes the back-edge and the
  // walk retries, until the allowance runs out and the funnel takes over.
  const retrying: string[] = [];
  const gRetry = graph(
    [
      node("implementation", "agentic", visit(retrying, "implementation", (rt) => {
        rt.implStatus = "spawn-failed";
      })),
      node("task_failed", "deterministic", visit(retrying, "task_failed")),
      node("review", "agentic", visit(retrying, "review")),
      node("task_done", "sink", undefined, "done"),
    ],
    [
      { from: "implementation", to: "task_failed", type: "attempts-exhausted", when: "impl_failed_attempts_exhausted" },
      { from: "implementation", to: "implementation", type: "spawn-failed", when: "impl_spawn_failed" },
      { from: "implementation", to: "review", type: "advance", when: "impl_ok" },
      { from: "review", to: "task_done", type: "advance", when: "always" },
      { from: "task_failed", to: "task_done", type: "continue-on-failure", when: "continue_on_failure" },
    ],
    "implementation",
  );
  let evaluations = 0;
  assert.equal(
    await interpretTaskGraph(gRetry, {
      runtime: makeRuntime(),
      facts: makeFacts({
        continueOnFailure: true,
        attemptsLeft: () => {
          evaluations += 1;
          return evaluations <= 2;
        },
      }),
    }),
    "done",
  );
  assert.deepEqual(retrying, ["implementation", "implementation", "implementation", "task_failed"]);
});

test("sinks are terminal: no action runs on them and their outcome is returned", async () => {
  let sinkActionRan = false;
  const g = graph(
    [
      node("task_start", "deterministic", visit([], "task_start")),
      node("task_stopped", "sink", async () => {
        sinkActionRan = true;
        return { kind: "ok" };
      }, "stopped"),
    ],
    [{ from: "task_start", to: "task_stopped", type: "advance", when: "always" }],
  );
  const outcome = await interpretTaskGraph(g, { runtime: makeRuntime(), facts: makeFacts() });
  assert.equal(outcome, "stopped");
  assert.equal(sinkActionRan, false);
});

test("a sink without a declared outcome is an explicit error", async () => {
  const g = graph(
    [
      node("task_start", "deterministic", visit([], "task_start")),
      node("task_done", "sink"),
    ],
    [{ from: "task_start", to: "task_done", type: "advance", when: "always" }],
  );
  await assert.rejects(
    interpretTaskGraph(g, { runtime: makeRuntime(), facts: makeFacts() }),
    /sink node "task_done" declares no outcome/,
  );
});

test("an unregistered condition name is an explicit error", async () => {
  assert.equal(CONDITIONS["no_such_condition" as ConditionName], undefined);
  const g = graph(
    [
      node("task_start", "deterministic", visit([], "task_start")),
      node("task_done", "sink", undefined, "done"),
    ],
    [
      {
        from: "task_start",
        to: "task_done",
        type: "advance",
        when: "no_such_condition" as ConditionName,
      },
    ],
  );
  await assert.rejects(
    interpretTaskGraph(g, { runtime: makeRuntime(), facts: makeFacts() }),
    /unregistered condition "no_such_condition"/,
  );
});

test("no matching edge is an explicit error", async () => {
  const g = graph(
    [
      node("task_start", "deterministic", visit([], "task_start")),
      node("task_done", "sink", undefined, "done"),
    ],
    // The passed verdict never holds with an empty runtime.
    [{ from: "task_start", to: "task_done", type: "passed", when: "verdict_passed_full_mode" }],
  );
  await assert.rejects(
    interpretTaskGraph(g, { runtime: makeRuntime(), facts: makeFacts() }),
    /no outgoing edge of "task_start" matched/,
  );
});

test("an action returning stopped ends the walk without routing", async () => {
  const visited: string[] = [];
  const g = graph(
    [
      node("implementation", "agentic", async () => {
        visited.push("implementation");
        return { kind: "stopped" };
      }),
      node("review", "agentic", visit(visited, "review")),
      node("task_done", "sink", undefined, "done"),
    ],
    [
      { from: "implementation", to: "review", type: "advance", when: "impl_ok" },
      { from: "review", to: "task_done", type: "advance", when: "always" },
    ],
    "implementation",
  );
  const outcome = await interpretTaskGraph(g, { runtime: makeRuntime(), facts: makeFacts() });
  assert.equal(outcome, "stopped");
  assert.deepEqual(visited, ["implementation"]);
});

test("errors thrown by an action propagate unwrapped to the caller", async () => {
  const boom = new Error("budget exhausted");
  const g = graph(
    [
      node("implementation", "agentic", async () => {
        throw boom;
      }),
    ],
    [],
    "implementation",
  );
  await assert.rejects(
    interpretTaskGraph(g, { runtime: makeRuntime(), facts: makeFacts() }),
    (err: unknown) => err === boom,
  );
});

test("the hop limit turns a sinkless cycle into an explicit error", async () => {
  const g = graph(
    [node("implementation", "agentic", visit([], "implementation"))],
    [{ from: "implementation", to: "implementation", type: "advance", when: "always" }],
    "implementation",
  );
  await assert.rejects(
    interpretTaskGraph(g, { runtime: makeRuntime(), facts: makeFacts() }),
    /hop limit/,
  );
});
