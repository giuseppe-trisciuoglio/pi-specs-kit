/**
 * The failure-learner routing decision: when a failed attempt is recorded by
 * spawning the learner and when the review report on disk already is that
 * memory. Every failure shape the loop can reach the learner with has a
 * verdict here, so a new failure kind cannot silently fall into the spawn
 * path (or the skip path) without the table saying so.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  blockersFromReport,
  decideFailureLearner,
  parseFailureLearnerMode,
} from "../src/loop/failure-learner-routing.ts";
import type { ReviewReport } from "../src/loop/review-report.ts";

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    status: "FAILED",
    summary: "Found problems",
    issues: ["Missing input validation"],
    routed: [],
    specConflicts: [],
    escalation: [],
    body: "",
    recovered: false,
    ...overrides,
  };
}

const base = {
  mode: "when_needed" as const,
  implStatus: "ok" as const,
  verdictKind: "failed" as const,
  report: report(),
};

test("a readable FAILED report is the memory: no spawn, the entries are derived", () => {
  const decision = decideFailureLearner(base);
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "report-derived");
});

test("the operator can always buy the spawn", () => {
  const decision = decideFailureLearner({ ...base, mode: "always" });
  assert.equal(decision.run, true);
  assert.equal(decision.reason, "always");
});

test("a red gate runs the learner: the report never judged what the gate rejected", () => {
  for (const implStatus of ["post-hook-failed"] as const) {
    const decision = decideFailureLearner({ ...base, implStatus });
    assert.equal(decision.run, true);
    assert.equal(decision.reason, "gate-failed");
  }
});

test("a silent, refused or timed-out spawn runs the learner", () => {
  for (const implStatus of ["spawn-failed", "environment-failed"] as const) {
    const decision = decideFailureLearner({ ...base, implStatus });
    assert.equal(decision.run, true);
    assert.equal(decision.reason, "spawn-failed");
  }
});

test("a missing or unusable report runs the learner", () => {
  const decision = decideFailureLearner({ ...base, report: null });
  assert.equal(decision.run, true);
  assert.equal(decision.reason, "report-missing");
});

test("a verdict the review never stated runs the learner", () => {
  const decision = decideFailureLearner({ ...base, verdictKind: "attemptFailed" });
  assert.equal(decision.run, true);
  assert.equal(decision.reason, "verdict-not-stated");
});

test("a report that is not a FAILED verdict runs the learner", () => {
  const decision = decideFailureLearner({ ...base, report: report({ status: "PASSED" }) });
  assert.equal(decision.run, true);
  assert.equal(decision.reason, "report-not-failed");
});

test("a report carrying wall-kind findings runs the learner", () => {
  const conflicts = decideFailureLearner({
    ...base,
    report: report({ specConflicts: ["the spec asks for X, the code does Y"] }),
  });
  assert.equal(conflicts.run, true);
  assert.equal(conflicts.reason, "wall-kind");

  const escalations = decideFailureLearner({
    ...base,
    report: report({ escalation: ["needs vault access"] }),
  });
  assert.equal(escalations.run, true);
  assert.equal(escalations.reason, "wall-kind");
});

test("derived entries keep the kind that routes: conflicts escalate, issues stay inert", () => {
  const found = blockersFromReport(
    report({
      issues: ["Missing input validation", "  ", "No regression test"],
      specConflicts: ["the spec asks for X, the code does Y"],
      escalation: ["needs vault access"],
    }),
    "TASK-001",
    2,
  );
  assert.deepEqual(
    found.map((b) => [b.kind, b.text]),
    [
      ["spec_contradiction", "the spec asks for X, the code does Y"],
      ["operator_action", "needs vault access"],
      ["env", "Missing input validation"],
      ["env", "No regression test"],
    ],
  );
  assert.ok(found.every((b) => b.task === "TASK-001" && b.attempt === 2 && b.resolved === false));
});

test("the mode field reads only the two values it names", () => {
  assert.equal(parseFailureLearnerMode("always"), "always");
  assert.equal(parseFailureLearnerMode("when_needed"), "when_needed");
  assert.equal(parseFailureLearnerMode("sometimes"), undefined);
  assert.equal(parseFailureLearnerMode(undefined), undefined);
  assert.equal(parseFailureLearnerMode(42), undefined);
});
