import test from "node:test";
import assert from "node:assert/strict";
import { BudgetExceededError, LoopBudget } from "../src/loop/budget.ts";

const WIDE = { maxSpawnsPerTask: 100, maxSpawnsPerRun: 100, maxRunDurationMs: 60_000 };

/** The BudgetExceededError a call raises, failing the test when it does not. */
function refusal(fn: () => void): BudgetExceededError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof BudgetExceededError, `expected a budget refusal, got ${String(err)}`);
    return err;
  }
  assert.fail("the call was allowed through the budget");
}

/** A clock the test drives by hand, so no assertion depends on real time. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("spawns are charged to the task and to the run at the same time", () => {
  const budget = new LoopBudget(WIDE, clock().now);
  budget.startTask("TASK-001");
  budget.consume();
  budget.consume();
  budget.startTask("TASK-002");
  budget.consume();

  const snapshot = budget.snapshot();
  assert.equal(snapshot.taskSpawns, 1, "a new task opens a fresh allowance");
  assert.equal(snapshot.runSpawns, 3, "the run counter keeps accumulating across tasks");
});

test("the per-task ceiling stops the task that crossed it and names it", () => {
  const budget = new LoopBudget({ ...WIDE, maxSpawnsPerTask: 2 }, clock().now);
  budget.startTask("TASK-007");
  budget.consume();
  budget.consume();

  const err = refusal(() => budget.consume());
  assert.equal(err.scope, "task");
  assert.match(err.message, /TASK-007/);

  // The next task starts over: one task burning its allowance does not close
  // the run while the run-level budget still has room.
  budget.startTask("TASK-008");
  budget.consume();
});

test("the per-run ceiling stops the run whatever the per-task counters say", () => {
  const budget = new LoopBudget({ ...WIDE, maxSpawnsPerRun: 3 }, clock().now);
  for (const id of ["TASK-001", "TASK-002", "TASK-003"]) {
    budget.startTask(id);
    budget.consume();
  }

  budget.startTask("TASK-004");
  const err = refusal(() => budget.consume());
  assert.equal(err.scope, "run");
});

test("the wall-clock ceiling is checked before a spawn, not after", () => {
  const c = clock();
  const budget = new LoopBudget({ ...WIDE, maxRunDurationMs: 10_000 }, c.now);
  budget.startTask("TASK-001");
  budget.consume();

  c.advance(9_999);
  budget.consume();

  c.advance(1);
  const err = refusal(() => budget.consume());
  assert.equal(err.scope, "duration");
  assert.equal(budget.snapshot().runSpawns, 2, "the refused spawn is not charged");
});
