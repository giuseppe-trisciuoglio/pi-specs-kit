/**
 * When a failed attempt earns a failure-learner spawn. The learner is an
 * agent session spent on the memory of a dead attempt, and a session is the
 * most expensive thing the loop buys. When the failure is an ordinary review
 * rejection, the report on disk already names what stopped the attempt — the
 * loop read it, turned it into feedback and handed it to the next attempt.
 * Spawning a second agent to restate it buys little; the entries can be
 * derived from the report directly, at zero cost.
 *
 * The spawn is kept for the failures the report cannot speak for: a red gate
 * (the report never judged what the gate rejected), a silent or refused
 * spawn, and a report that is missing or unreadable. It is also kept when the
 * report carries a finding of the kinds that escalate — the consecutive-kind
 * rule that ends a task on a repeated wall must keep firing on words an agent
 * wrote, not only on entries this module derives.
 *
 * Pure module: the decision and the derivation only, so the loop and the
 * tests can import it without dragging in the agent CLI.
 */

import type { Blocker } from "./blockers.ts";
import type { ImplStatus } from "./graph/types.ts";
import type { ReviewReport } from "./review-report.ts";

/** Operator choice: spawn the learner on every failed attempt, or only when
 * the report cannot stand in for it. */
export type FailureLearnerMode = "always" | "when_needed";

export const FAILURE_LEARNER_MODES: readonly FailureLearnerMode[] = ["when_needed", "always"];

/** Validate a value read from the configuration file; anything else keeps
 * the default. */
export function parseFailureLearnerMode(value: unknown): FailureLearnerMode | undefined {
  return FAILURE_LEARNER_MODES.find((mode) => mode === value);
}

/** What the learner decision saw. */
export interface LearnerRoutingInput {
  mode: FailureLearnerMode;
  /** Outcome of the implementation attempt that just failed. */
  implStatus: ImplStatus;
  /** Kind of the last review verdict, when the failure came through the
   * review; null when it did not reach the review at all. */
  verdictKind: "passed" | "failed" | "attemptFailed" | "reportUnusable" | "escalated" | null;
  /** The review report of this task, as the loop parses it; null when
   * missing or unusable. */
  report: ReviewReport | null;
}

/** Why the learner runs or is skipped; the reason lands in the ledger so the
 * saving stays measurable. */
export interface LearnerRoutingDecision {
  run: boolean;
  reason:
    | "always"
    | "gate-failed"
    | "spawn-failed"
    | "report-missing"
    | "report-not-failed"
    | "verdict-not-stated"
    | "wall-kind"
    | "report-derived";
}

/** Failures the report never saw: the gate rejected the tree after the fact,
 * or the spawn never produced anything to review. */
const SPAWN_OR_GATE: readonly ImplStatus[] = ["post-hook-failed", "spawn-failed", "environment-failed"];

/**
 * Decide whether the failure learner runs for this attempt. A readable FAILED
 * report whose rejection is what stopped the attempt skips the spawn;
 * everything the report cannot stand in for runs it.
 */
export function decideFailureLearner(input: LearnerRoutingInput): LearnerRoutingDecision {
  if (input.mode === "always") return { run: true, reason: "always" };
  if (input.implStatus === "post-hook-failed") return { run: true, reason: "gate-failed" };
  if (SPAWN_OR_GATE.includes(input.implStatus)) return { run: true, reason: "spawn-failed" };
  if (input.report === null) return { run: true, reason: "report-missing" };
  // The review machinery itself broke — a red gate before the reviewer, an
  // interrupted spawn beyond its budget — so whatever is on disk does not
  // describe this attempt's failure.
  if (input.verdictKind === "attemptFailed") return { run: true, reason: "verdict-not-stated" };
  if (input.report.status !== "FAILED") return { run: true, reason: "report-not-failed" };
  // A conflict or an escalation names a wall no retry clears by itself: the
  // consecutive-kind rule has to judge it on the reviewer's own words, so the
  // learner runs even though the report is readable.
  if (input.report.specConflicts.length > 0 || input.report.escalation.length > 0) {
    return { run: true, reason: "wall-kind" };
  }
  return { run: false, reason: "report-derived" };
}

/**
 * Derive the attempt's blockers from a readable FAILED report. Each finding
 * becomes one entry: a requirement conflict is a contradiction, an escalation
 * needs a person, and an ordinary issue — a defect the next attempt is
 * already handed as feedback — takes the inert catch-all kind, which is
 * recorded for the trace but never trips the escalation on its own.
 */
export function blockersFromReport(report: ReviewReport, task: string, attempt: number): Blocker[] {
  const found: Blocker[] = [];
  const entry = (kind: Blocker["kind"], text: string): void => {
    const trimmed = text.trim();
    if (trimmed !== "") found.push({ task, attempt, kind, text: trimmed, resolved: false });
  };
  for (const conflict of report.specConflicts) entry("spec_contradiction", conflict);
  for (const escalation of report.escalation) entry("operator_action", escalation);
  for (const issue of report.issues) entry("env", issue);
  return found;
}
