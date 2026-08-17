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
    "continue_on_failure",
    "enters_at_cleanup_fast_mode",
    "enters_at_cleanup_full_mode",
    "enters_at_implementation",
    "enters_at_learner",
    "enters_at_review",
    "enters_at_sync",
    "enters_at_sync_skipped",
    "enters_at_update_done",
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
    "sync_not_wanted",
    "sync_wanted",
    "verdict_attempt_failed",
    "verdict_failed_new_feedback",
    "verdict_failed_same_feedback",
    "verdict_passed_fast_mode",
    "verdict_passed_full_mode",
    "verdict_report_unusable",
    "verdict_retry_attempts_exhausted",
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
  truth("enters_at_cleanup_full_mode", [
    [{ entry: { resumed: true, startStep: "cleanup" }, mode: "full" }, true],
    [{ entry: { resumed: true, startStep: "cleanup" }, mode: "fast" }, false],
    [{ entry: { resumed: true, startStep: "learner" }, mode: "full" }, false],
  ]);
  truth("enters_at_cleanup_fast_mode", [
    [{ entry: { resumed: true, startStep: "cleanup" }, mode: "fast" }, true],
    [{ entry: { resumed: true, startStep: "cleanup" }, mode: "full" }, false],
    [{ entry: { resumed: true, startStep: "learner" }, mode: "fast" }, false],
  ]);
  truth("enters_at_learner", [
    [{ entry: { resumed: true, startStep: "learner" } }, true],
    [{ entry: { resumed: true, startStep: "sync" } }, false],
    [{}, false],
  ]);
  truth("enters_at_sync", [
    [{ entry: { resumed: true, startStep: "sync" } }, true],
    [{ entry: { resumed: true, startStep: "update_done" } }, false],
    [{}, false],
  ]);
  truth("enters_at_update_done", [
    [{ entry: { resumed: true, startStep: "update_done" } }, true],
    [{ entry: { resumed: true, startStep: "sync" } }, false],
    [{}, false],
  ]);
});

test("implementation predicates read the implementation outcome and the retry budget", () => {
  truth("impl_ok", [
    [{ implStatus: "ok" }, true],
    [{ implStatus: "pre-hook-failed" }, false],
    [{ implStatus: "spawn-failed" }, false],
    [{ implStatus: "no-op-retry" }, false],
  ]);
  truth("impl_no_op_retry", [
    [{ implStatus: "no-op-retry" }, true],
    [{ implStatus: "ok" }, false],
    [{ implStatus: "post-hook-failed" }, false],
  ]);
  truth("impl_environment_failed", [
    [{ implStatus: "environment-failed" }, true],
    [{ implStatus: "spawn-failed" }, false],
    [{ implStatus: "ok" }, false],
  ]);
  truth("impl_pre_hook_failed", [
    [{ implStatus: "pre-hook-failed" }, true],
    [{ implStatus: "spawn-failed" }, false],
    [{ implStatus: "ok" }, false],
  ]);
  truth("impl_spawn_failed", [
    [{ implStatus: "spawn-failed" }, true],
    [{ implStatus: "pre-hook-failed" }, false],
    [{ implStatus: "ok" }, false],
  ]);
  truth("impl_post_hook_failed", [
    [{ implStatus: "post-hook-failed" }, true],
    [{ implStatus: "pre-hook-failed" }, false],
    [{ implStatus: "spawn-failed" }, false],
    [{ implStatus: "ok" }, false],
  ]);
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

test("the end-of-range sync guard requires no earlier sync, a completed task and no stop", () => {
  truth("final_sync_needed", [
    [{ hasLastCompleted: true }, true],
    [{ hasLastCompleted: true, syncRan: true }, false],
    [{ hasLastCompleted: false }, false],
    [{ hasLastCompleted: true, stopping: true }, false],
  ]);
});
