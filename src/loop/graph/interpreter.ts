/**
 * First-match-wins interpreter for the declared task graph. It runs the
 * current node's action, snapshots the routing context, evaluates the node's
 * outgoing edges in declaration order and moves to the first true one, until
 * a sink yields the task outcome. Node actions own their side effects: the
 * interpreter adds none, so persists and notifications stay exactly where the
 * loop performs them today.
 *
 * A `stopped` outcome propagates immediately without routing, and an exhausted
 * budget escapes as the exception it is: neither is an edge, because neither
 * is a per-node routing decision.
 */

import { CONDITIONS } from "./conditions.ts";
import type {
  NodeIO,
  NodeOutcome,
  RoutingContext,
  RoutingFacts,
  TaskGraph,
  TaskNodeId,
  TaskOutcome,
  TaskRuntime,
} from "./types.ts";

/** Fallback walk ceiling for callers that pass none; the runner derives the
 * real ceiling from the configured attempt budget. */
const MAX_HOPS = 1000;

/** Everything the walk needs besides the table itself. */
export interface InterpretInput {
  runtime: TaskRuntime;
  facts: RoutingFacts;
  /** Walk ceiling, derived from the retry budget of the run; still a safety
   * net against a sinkless cycle, sized so a legitimate walk never hits it. */
  maxHops?: number;
}

/** Snapshot of the routing-relevant state, taken after the node action ran
 * but with the feedback held on entry, so the stall guard compares old and
 * new rejection feedback. */
function buildRoutingContext(runtime: TaskRuntime, facts: RoutingFacts, feedbackOnEntry: string | null): RoutingContext {
  return {
    entry: runtime.entry,
    implStatus: runtime.implStatus,
    verdict: runtime.lastVerdict,
    feedback: feedbackOnEntry,
    attemptsLeft: facts.attemptsLeft(),
    mode: facts.mode,
    isLastTask: facts.isLastTask,
    continueOnFailure: facts.continueOnFailure,
    stopping: facts.stopping(),
    syncRan: runtime.runState.syncRan,
    hasLastCompleted: runtime.runState.lastCompleted !== null,
  };
}

/** The first outgoing edge of `current` whose condition holds, or null when
 * none does: an unmatched node is a graph defect, not a routing choice. */
function matchEdge(graph: TaskGraph, current: TaskNodeId, ctx: RoutingContext): TaskNodeId | null {
  for (const edge of graph.edges) {
    if (edge.from !== current) continue;
    const predicate = CONDITIONS[edge.when];
    if (!predicate) throw new Error(`edge ${edge.from} → ${edge.to} names unregistered condition "${edge.when}"`);
    if (predicate(ctx)) return edge.to;
  }
  return null;
}

export async function interpretTaskGraph(graph: TaskGraph, input: InterpretInput): Promise<TaskOutcome> {
  const { runtime, facts } = input;
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  let current: TaskNodeId = graph.entry;
  const maxHops = input.maxHops ?? MAX_HOPS;
  for (let hop = 0; hop < maxHops; hop++) {
    const node = nodesById.get(current);
    if (!node) throw new Error(`task graph references unknown node "${current}"`);
    if (node.kind === "sink") {
      if (node.outcome === undefined) throw new Error(`sink node "${current}" declares no outcome`);
      return node.outcome;
    }
    if (!node.action) throw new Error(`node "${current}" has no action`);

    const feedbackOnEntry = runtime.feedback;
    const io: NodeIO = { runtime };
    const outcome: NodeOutcome = await node.action(io);
    if (outcome.kind === "stopped") return "stopped";

    const ctx = buildRoutingContext(runtime, facts, feedbackOnEntry);
    const next = matchEdge(graph, current, ctx);
    if (next === null) throw new Error(`no outgoing edge of "${current}" matched`);
    current = next;
  }
  throw new Error("task graph walk exceeded the hop limit without reaching a sink");
}
