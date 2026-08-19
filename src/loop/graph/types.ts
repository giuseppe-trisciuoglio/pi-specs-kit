/**
 * Type vocabulary of the declared task graph: node ids, edge types, the
 * routing context the edge conditions see, and the in-flight task runtime.
 * Pure types only, no runtime dependencies, so tests and the table can import
 * this module freely. The compiler validates the table against these types;
 * there is no runtime schema check on purpose.
 */

import type { SpecsKitConfig } from "../../config/specs-kit-config.ts";
import type { FixPlan, LoopStep } from "../../fixplan/fix-plan.ts";
import type { TaskFile } from "../../tasks/task-parser.ts";
import type { LoopBudget } from "../budget.ts";
import type { commitCheckpoint } from "../checkpoint.ts";
import type { refreshCodebaseGraph } from "../codebase-graph.ts";
import type { HookResult } from "../hooks.ts";
import type {
  captureLearningsGuard,
  enforceLearningsGuard,
} from "../learnings-guard.ts";
import type { PhaseExecutor } from "../phases.ts";
import type { snapshotProtectedPaths } from "../protected-paths.ts";
import type { RoutedSuggestion } from "../review-report.ts";
import type { workspaceFingerprint } from "../workspace.ts";
import type { ConditionName } from "./conditions.ts";

/** Terminal results of one task's walk through the graph. */
export type TaskOutcome = "done" | "stopped" | "halted";

/**
 * Edge classification: a type exists only when a routing decision depends on
 * it. User stops and budget exhaustion are not edge types — the former is an
 * action outcome, the latter an exception that propagates unwrapped.
 */
export type EdgeType =
  | "advance"
  | "passed"
  | "failed"
  | "attempt-failed"
  | "report-unusable"
  | "stall-guard"
  | "attempts-exhausted"
  | "pre-hook-failed"
  | "spawn-failed"
  | "post-hook-failed"
  | "protected-paths"
  | "mode-skip"
  | "continue-on-failure"
  | "halt-on-failure";

/** Every node of the per-task graph, including the start marker and sinks. */
export type TaskNodeId =
  | "task_start"
  | "enter_task"
  | "implementation"
  | "review"
  | "review_gate"
  | "task_failed"
  | "cleanup"
  | "learner"
  | "sync"
  | "update_done"
  | "checkpoint"
  | "task_done"
  | "task_stopped"
  | "task_halted";

/** What the implementation phase produced, as routing sees it. `no-op-retry`
 * is a retry that ran clean and left the workspace byte-identical: the agent
 * re-read the task, re-ran the gate and wrote nothing. */
export type ImplStatus =
  | "ok"
  | "pre-hook-failed"
  | "spawn-failed"
  | "post-hook-failed"
  | "no-op-retry"
  /** The provider refused the spawn: no retry against the same config can succeed. */
  | "environment-failed"
  /** The attempt rewrote a document the implementation is measured against. */
  | "protected-paths-touched";

/** Review verdict shapes that route; a stopped verdict never reaches routing
 * because it propagates as the action outcome. */
export type RoutingVerdict =
  | { kind: "passed" }
  | { kind: "failed"; feedback: string }
  | { kind: "attemptFailed" }
  // The review step always attaches the detail; it is optional only so that
  // routing-only constructions of the verdict need not invent one.
  | { kind: "reportUnusable"; detail?: string };

/** How the task entered this run: fresh, or resumed at a persisted step. */
export interface TaskEntry {
  readonly resumed: boolean;
  readonly startStep: LoopStep | null;
}

/** Cross-task bookkeeping of a single run, kept for the end-of-range sync
 * guarantee. Not part of the persisted plan. */
export interface RunState {
  syncRan: boolean;
  lastCompleted: TaskFile | null;
}

/** In-flight state of one task's cycle. It lives only for the process
 * lifetime and is recomputed on resume; persisting it would change the
 * resume semantics. */
export interface TaskRuntime {
  readonly entry: TaskEntry;
  /** Review feedback held for the next implementation attempt. */
  feedback: string | null;
  /** Verdict produced by the last review, consumed by the gate. */
  lastVerdict: RoutingVerdict | null;
  /** Outcome of the last implementation run, consumed when leaving it. */
  implStatus: ImplStatus;
  /** Failed post hooks of the last implementation attempt, fed to the next
   * one as context; null when the last attempt's post hooks all passed. */
  postHookFailures: HookResult[] | null;
  /** Fixes earlier reviews routed to this task, collected once at entry. */
  routedSuggestions: RoutedSuggestion[];
  runState: RunState;
}

/**
 * Read-only slice the edge conditions evaluate on. Snapshotted at each hop:
 * feedback is the value held when the current node was entered (before its
 * action possibly replaced it) so the stall guard can compare old and new.
 */
export interface RoutingContext {
  readonly entry: TaskEntry;
  readonly implStatus: ImplStatus;
  readonly verdict: RoutingVerdict | null;
  readonly feedback: string | null;
  /** False once retries ran out; evaluated after the node action's own
   * retry increment, like the loop guard did. */
  readonly attemptsLeft: boolean;
  readonly mode: "full" | "fast";
  readonly isLastTask: boolean;
  readonly continueOnFailure: boolean;
  readonly stopping: boolean;
  /** Run-level facts, read by the end-of-range sync condition. */
  readonly syncRan: boolean;
  readonly hasLastCompleted: boolean;
}

/** Facts constant for the whole walk but read fresh at each hop, because the
 * underlying state (retry count, stop request) belongs to the caller. */
export interface RoutingFacts {
  readonly mode: "full" | "fast";
  readonly isLastTask: boolean;
  readonly continueOnFailure: boolean;
  readonly attemptsLeft: () => boolean;
  readonly stopping: () => boolean;
}

/** A node action either proceeds to routing or reports a global stop. */
export type NodeOutcome = { kind: "ok" } | { kind: "stopped" };

/** What a node action receives: the mutable runtime of the task. */
export interface NodeIO {
  runtime: TaskRuntime;
}

export type NodeAction = (io: NodeIO) => Promise<NodeOutcome>;

/** The dependency set every node action is bound to when a task starts: the
 * same wiring the per-task runner is constructed with. */
export interface TaskNodeDeps {
  config: SpecsKitConfig;
  /** Absolute path of the active spec directory. */
  specDir: string;
  executor: PhaseExecutor;
  /** Run ceilings; the per-task allowance is opened for each task here. */
  budget: LoopBudget;
  /** Persist the plan and mirror it into the engine status. */
  persist: (plan: FixPlan) => Promise<void>;
  notify: (message: string, type: "info" | "warning" | "error") => void;
  /** Current stop request, read fresh at every phase boundary. */
  stopping: () => "graceful" | "now" | null;
  /** Abort signal for the next subprocess (loop stop plus phase interrupt). */
  signal: () => AbortSignal | undefined;
  commitCheckpoint: typeof commitCheckpoint;
  /** Content fingerprint of the worktree, read around a retried phase to tell
   * a retry that changed something from one that changed nothing. */
  workspaceFingerprint: typeof workspaceFingerprint;
  /** Re-extract the codebase graph the phases read; best-effort. */
  refreshCodebaseGraph: typeof refreshCodebaseGraph;
  /**
   * Content hashes of the documents a phase must not rewrite, read around the
   * implementation. Absent means the real one: the check is part of the loop,
   * not of a particular wiring.
   */
  snapshotProtectedPaths?: typeof snapshotProtectedPaths;
  /** Snapshot of the project learnings file before the implementation; the
   * default is the real one, the same best-effort contract as above. */
  captureLearningsGuard?: typeof captureLearningsGuard;
  /** Revert of the learnings file when the implementation rewrote it. */
  enforceLearningsGuard?: typeof enforceLearningsGuard;
  now: () => Date;
}

/** What a node action closes over: the dependencies plus the task at hand. */
export interface TaskNodeEnv {
  deps: TaskNodeDeps;
  plan: FixPlan;
  taskFile: TaskFile;
  selected: TaskFile[];
}

/** Agentic nodes spawn a subprocess; deterministic ones are pure loop logic;
 * sinks only terminate the walk. */
export type NodeKind = "agentic" | "deterministic" | "sink";

export interface TaskNode {
  readonly id: TaskNodeId;
  readonly kind: NodeKind;
  /** Required on every non-sink node. */
  readonly action?: NodeAction;
  /** Terminal result, required on sink nodes. */
  readonly outcome?: TaskOutcome;
}

export interface TaskEdge {
  readonly from: TaskNodeId;
  readonly to: TaskNodeId;
  readonly type: EdgeType;
  /** Named predicate resolved from the closed registry at walk time; never
   * an inline closure, so the conditional half of the graph stays
   * inspectable. */
  readonly when: ConditionName;
}

export interface TaskGraph {
  /** Node the walk starts from. */
  readonly entry: TaskNodeId;
  readonly nodes: readonly TaskNode[];
  /** Evaluated per source node in declaration order; first match wins. */
  readonly edges: readonly TaskEdge[];
}
