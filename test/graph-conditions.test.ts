import test from "node:test";
import assert from "node:assert/strict";
import { CONDITIONS, type ConditionName } from "../src/loop/graph/conditions.ts";
import type { RoutingContext } from "../src/loop/graph/types.ts";

function makeCtx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    entry: { resumed: false, startStep: null },
    implStatus: "ok",
    verdict: null,
    feedback: null,
    attemptsLeft: true,
    mode: "full",
    isLastTask: false,
    continueOnFailure: false,
    briefWanted: false,
    blockerWall: false,
    operatorWall: false,
    stopping: false,
    syncRan: false,
    hasLastCompleted: false,
    ...overrides,
  };
}

/** Assert a predicate's truth value for each context variant in the table. */
function truth(name: ConditionName, cases: [Partial<RoutingContext>, boolean][]): void {
  for (const [overrides, expected] of cases) {
    const label = `${name} · ${JSON.stringify(overrides)}`;
    assert.equal(CONDITIONS[name](makeCtx(overrides)), expected, label);
  }
}

test("the registry contains exactly the declared routing predicates", () => {
  assert.deepEqual(Object.keys(CONDITIONS).sort(), [
    "always",
    "blocker_wall_repeated",
    "brief_wanted",
    "continue_on_failure",
    "enters_at_cleanup_fast_mode",
    "enters_at_cleanup_full_mode",
    "enters_at_implementation",
    "enters_at_learner",
    "enters_at_review",
    "enters_at_sync",
    "enters_at_sync_skipped",
    "enters_at_update_done",
    "failure_terminal",
    "final_sync_needed",
    "halt_on_failure",
    "impl_environment_failed",
    "impl_failed_attempts_exhausted",
    "impl_no_op_retry",
    "impl_ok",
    "impl_post_hook_failed",
    "impl_pre_hook_failed",
    "impl_protected_paths_touched",
    "impl_spawn_failed",
    "operator_wall",
    "sync_not_wanted",
    "sync_wanted",
    "verdict_attempt_failed",
    "verdict_escalated",
    "verdict_failed_new_feedback",
    "verdict_failed_same_feedback",
    "verdict_passed_fast_mode",
    "verdict_passed_full_mode",
    "verdict_report_unusable",
    "verdict_retry_attempts_exhausted",
  ]);
});

test("the wall guard fires only once the failure learner found a repeat", () => {
  truth("blocker_wall_repeated", [
    [{}, false],
    [{ blockerWall: true }, true],
    // Attempts left do not matter: no further attempt can clear this kind.
    [{ blockerWall: true, attemptsLeft: true }, true],
  ]);
});

test("a failure with no attempts left leaves the cycle for the funnel", () => {
  truth("failure_terminal", [
    [{ attemptsLeft: true }, false],
    [{ attemptsLeft: false }, true],
  ]);
});

test("always holds for any context", () => {
  assert.equal(CONDITIONS.always(makeCtx()), true);
});

test("entry predicates discriminate on the persisted starting step", () => {
  truth("enters_at_implementation", [
    [{}, true], // fresh start
    [{ entry: { resumed: true, startStep: "implementation" } }, true],
    [{ entry: { resumed: true, startStep: "review" } }, false],
    [{ entry: { resumed: true, startStep: "cleanup" } }, false],
  ]);
  truth("enters_at_review", [
    [{ entry: { resumed: true, startStep: "review" } }, true],
    [{}, false],
    [{ entry: { resumed: true, startStep: "implementation" } }, false],
  ]);
  // The cleanup gateways differ only in the mode they open on: one table
  // per mode, generated from the same rows.
  for (const mode of ["full", "fast"] as const) {
    truth(`enters_at_cleanup_${mode}_mode`, [
      [{ entry: { resumed: true, startStep: "cleanup" }, mode }, true],
      [{ entry: { resumed: true, startStep: "cleanup" }, mode: mode === "full" ? "fast" : "full" }, false],
      [{ entry: { resumed: true, startStep: "learner" }, mode }, false],
    ]);
  }
  truth("enters_at_learner", [
    [{ entry: { resumed: true, startStep: "learner" } }, true],
    [{ entry: { resumed: true, startStep: "sync" } }, false],
    [{}, false],
  ]);
  // The remaining steps discriminate only on which step they name.
  for (const [name, step, other] of [
    ["enters_at_sync", "sync", "update_done"],
    ["enters_at_update_done", "update_done", "sync"],
  ] as const) {
    truth(name, [
      [{ entry: { resumed: true, startStep: step } }, true],
      [{ entry: { resumed: true, startStep: other } }, false],
      [{}, false],
    ]);
  }
});

test("implementation predicates read the implementation outcome and the retry budget", () => {
  truth("impl_ok", [
    [{ implStatus: "ok" }, true],
    [{ implStatus: "pre-hook-failed" }, false],
    [{ implStatus: "spawn-failed" }, false],
    [{ implStatus: "no-op-retry" }, false],
  ]);
  // Each failure kind is its own predicate, true on itself and false on the
  // neighbouring kinds and on the ok status.
  const failureStatuses = ["no-op-retry", "environment-failed", "pre-hook-failed", "spawn-failed", "post-hook-failed"] as const;
  for (const status of failureStatuses) {
    truth(`impl_${status.replaceAll("-", "_")}` as ConditionName, [
      [{ implStatus: status }, true],
      ...failureStatuses
        .filter((other) => other !== status)
        .slice(0, 2)
        .map((other): [Partial<RoutingContext>, boolean] => [{ implStatus: other }, false]),
      [{ implStatus: "ok" }, false],
    ]);
  }
  truth("impl_failed_attempts_exhausted", [
    [{ implStatus: "pre-hook-failed", attemptsLeft: false }, true],
    [{ implStatus: "spawn-failed", attemptsLeft: false }, true],
    [{ implStatus: "post-hook-failed", attemptsLeft: false }, true],
    [{ implStatus: "no-op-retry", attemptsLeft: false }, true],
    [{ implStatus: "pre-hook-failed", attemptsLeft: true }, false],
    [{ implStatus: "ok", attemptsLeft: false }, false],
  ]);
});

test("gate predicates dispatch on the verdict kind, the held feedback and the retry budget", () => {
  truth("verdict_report_unusable", [
    [{ verdict: { kind: "reportUnusable" } }, true],
    [{ verdict: { kind: "passed" } }, false],
    [{ verdict: null }, false],
  ]);
  truth("verdict_failed_same_feedback", [
    [{ verdict: { kind: "failed", feedback: "fix X" }, feedback: "fix X" }, true],
    [{ verdict: { kind: "failed", feedback: "fix X" }, feedback: "fix Y" }, false],
    [{ verdict: { kind: "failed", feedback: "fix X" }, feedback: null }, false],
    [{ verdict: { kind: "passed" }, feedback: "fix X" }, false],
  ]);
  truth("verdict_failed_new_feedback", [
    [{ verdict: { kind: "failed", feedback: "fix X" }, feedback: null }, true],
    [{ verdict: { kind: "failed", feedback: "fix X" }, feedback: "fix Y" }, true],
    [{ verdict: { kind: "failed", feedback: "fix X" }, feedback: "fix X" }, false],
    [{ verdict: { kind: "attemptFailed" }, feedback: null }, false],
  ]);
  truth("verdict_attempt_failed", [
    [{ verdict: { kind: "attemptFailed" } }, true],
    [{ verdict: { kind: "failed", feedback: "fix X" } }, false],
    [{ verdict: null }, false],
  ]);
  truth("verdict_retry_attempts_exhausted", [
    [{ verdict: { kind: "failed", feedback: "fix X" }, attemptsLeft: false }, true],
    [{ verdict: { kind: "attemptFailed" }, attemptsLeft: false }, true],
    [{ verdict: { kind: "failed", feedback: "fix X" }, attemptsLeft: true }, false],
    [{ verdict: { kind: "passed" }, attemptsLeft: false }, false],
    [{ verdict: { kind: "reportUnusable" }, attemptsLeft: false }, false],
  ]);
  truth("verdict_passed_full_mode", [
    [{ verdict: { kind: "passed" }, mode: "full" }, true],
    [{ verdict: { kind: "passed" }, mode: "fast" }, false],
    [{ verdict: { kind: "attemptFailed" }, mode: "full" }, false],
  ]);
  truth("verdict_passed_fast_mode", [
    [{ verdict: { kind: "passed" }, mode: "fast" }, true],
    [{ verdict: { kind: "passed" }, mode: "full" }, false],
    [{ verdict: { kind: "failed", feedback: "fix X" }, mode: "fast" }, false],
  ]);
});

test("tail predicates decide whether the sync phase runs", () => {
  truth("sync_wanted", [
    [{ mode: "full", isLastTask: false }, true],
    [{ mode: "full", isLastTask: true }, true],
    [{ mode: "fast", isLastTask: true }, true],
    [{ mode: "fast", isLastTask: false }, false],
  ]);
  truth("sync_not_wanted", [
    [{ mode: "fast", isLastTask: false }, true],
    [{ mode: "fast", isLastTask: true }, false],
    [{ mode: "full", isLastTask: false }, false],
  ]);
});

test("funnel predicates are mutually exclusive on continue-on-failure", () => {
  truth("continue_on_failure", [
    [{ continueOnFailure: true }, true],
    [{ continueOnFailure: false }, false],
  ]);
  truth("halt_on_failure", [
    [{ continueOnFailure: false }, true],
    [{ continueOnFailure: true }, false],
  ]);
});

test("an operator wall ends the task and leaves the run walking", () => {
  // The task needs a person; the tasks after it do not. Halting the run on it
  // costs every one of them, so this predicate answers ahead of the setting.
  truth("operator_wall", [
    [{ operatorWall: true }, true],
    [{ operatorWall: true, continueOnFailure: false }, true],
    [{ operatorWall: false }, false],
  ]);
  truth("verdict_escalated", [
    [{ verdict: { kind: "escalated", detail: "the vault write is an operator step" } }, true],
    [{ verdict: { kind: "failed", feedback: "fix it" } }, false],
    [{ verdict: null }, false],
  ]);
});

test("the end-of-range sync guard requires no earlier sync, a completed task and no stop", () => {
  truth("final_sync_needed", [
    [{ hasLastCompleted: true }, true],
    [{ hasLastCompleted: true, syncRan: true }, false],
    [{ hasLastCompleted: false }, false],
    [{ hasLastCompleted: true, stopping: true }, false],
  ]);
});
