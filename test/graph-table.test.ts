import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskGraph } from "../src/loop/graph/task-graph.ts";
import { CONDITIONS, type ConditionName } from "../src/loop/graph/conditions.ts";
import type { EdgeType, NodeAction, TaskGraph, TaskNodeId } from "../src/loop/graph/types.ts";

// Structural invariants of the declared task graph. These prove the table is
// a well-formed graph (declared endpoints, closed vocabulary, guard order,
// sink reachability); the behavior itself is pinned by the loop suite.

const noop: NodeAction = async () => ({ kind: "ok" });

function graph(): TaskGraph {
  const actions = new Proxy({} as Record<TaskNodeId, NodeAction>, {
    get: (target, prop) => (prop in target ? target[prop as TaskNodeId] : noop),
  });
  return buildTaskGraph(actions);
}

/** The edge type vocabulary: a type exists only when routing depends on it. */
const EDGE_TYPE_VOCABULARY: readonly EdgeType[] = [
  "advance",
  "passed",
  "failed",
  "attempt-failed",
  "report-unusable",
  "stall-guard",
  "attempts-exhausted",
  "pre-hook-failed",
  "spawn-failed",
  "post-hook-failed",
  "mode-skip",
  "continue-on-failure",
  "halt-on-failure",
];

test("every edge endpoint is a declared node", () => {
  const g = graph();
  const ids = new Set(g.nodes.map((n) => n.id));
  assert.equal(ids.size, g.nodes.length, "node ids are unique");
  for (const edge of g.edges) {
    assert.ok(ids.has(edge.from), `edge from unknown node "${edge.from}"`);
    assert.ok(ids.has(edge.to), `edge to unknown node "${edge.to}"`);
  }
});

test("every non-sink node has at least one outgoing edge, sinks have none", () => {
  const g = graph();
  for (const node of g.nodes) {
    const outgoing = g.edges.filter((e) => e.from === node.id);
    if (node.kind === "sink") {
      assert.equal(outgoing.length, 0, `sink "${node.id}" must not route anywhere`);
      assert.ok(node.outcome !== undefined, `sink "${node.id}" declares its outcome`);
    } else {
      assert.ok(outgoing.length > 0, `non-sink node "${node.id}" has no outgoing edge`);
      assert.ok(node.action !== undefined, `non-sink node "${node.id}" has an action bound`);
    }
  }
});

test("every edge condition names a registered predicate", () => {
  const g = graph();
  for (const edge of g.edges) {
    assert.ok(
      Object.hasOwn(CONDITIONS, edge.when),
      `edge ${edge.from} → ${edge.to} names unregistered condition "${edge.when}"`,
    );
  }
  // And the other way around: no predicate in the registry is left unused,
  // except the run-level guard of the end-of-range sync, which belongs to a
  // different table.
  const used = new Set<ConditionName>(g.edges.map((e) => e.when));
  for (const name of Object.keys(CONDITIONS) as ConditionName[]) {
    if (name === "final_sync_needed") continue;
    assert.ok(used.has(name), `registered condition "${name}" is never used by the table`);
  }
});

test("every edge type belongs to the declared vocabulary", () => {
  const g = graph();
  for (const edge of g.edges) {
    assert.ok(
      (EDGE_TYPE_VOCABULARY as readonly string[]).includes(edge.type),
      `edge ${edge.from} → ${edge.to} uses undeclared type "${edge.type}"`,
    );
  }
});

test("all three sinks are reachable from enter_task", () => {
  const g = graph();
  // Stops propagate from every node action without an edge, so the stopped
  // sink is reachable by convention from any reachable non-sink node.
  const reachable = new Set<TaskNodeId>(["enter_task"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of g.edges) {
      if (reachable.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        grew = true;
      }
    }
  }
  assert.ok(reachable.has("task_done"), "task_done is reachable");
  assert.ok(reachable.has("task_halted"), "task_halted is reachable");
  assert.ok(reachable.size > 1, "the walk can leave enter_task");
  const stoppedSink = g.nodes.find((n) => n.id === "task_stopped");
  assert.equal(stoppedSink?.kind, "sink");
  assert.equal(stoppedSink?.outcome, "stopped");
});

test("exhaustion guards are evaluated before the back-edges", () => {
  const g = graph();
  const order = (from: TaskNodeId, type: EdgeType): number => {
    const index = g.edges.filter((e) => e.from === from).findIndex((e) => e.type === type);
    assert.notEqual(index, -1, `${from} has an edge of type ${type}`);
    return index;
  };

  // Implementation: once attempts are gone, pre-hook, spawn and post-hook
  // failures go to the funnel instead of looping back.
  assert.ok(order("implementation", "attempts-exhausted") < order("implementation", "pre-hook-failed"));
  assert.ok(order("implementation", "attempts-exhausted") < order("implementation", "spawn-failed"));
  assert.ok(order("implementation", "attempts-exhausted") < order("implementation", "post-hook-failed"));

  // Review gate: the retry verdicts loop back only while attempts remain.
  assert.ok(order("review_gate", "attempts-exhausted") < order("review_gate", "failed"));
  assert.ok(order("review_gate", "attempts-exhausted") < order("review_gate", "attempt-failed"));
});

test("the walk starts at the start marker, which forwards to the task entry", () => {
  const g = graph();
  assert.equal(g.entry, "task_start");
  assert.deepEqual(
    g.edges.filter((e) => e.from === "task_start"),
    [{ from: "task_start", to: "enter_task", type: "advance", when: "always" }],
  );
});
