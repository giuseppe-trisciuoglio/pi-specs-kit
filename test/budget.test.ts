import test from "node:test";
import assert from "node:assert/strict";
import {
  BudgetExceededError,
  HARD_RUN_DURATION_MULTIPLE,
  LoopBudget,
  hardRunDurationMs,
} from "../src/loop/budget.ts";

const WIDE = {
  maxSpawnsPerTask: 100,
  maxSpawnsPerRun: 100,
  maxRunDurationMs: 60_000,
  maxRunDurationHardMs: null,
};

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
  const budget = new LoopBudget({ ...WIDE, maxRunDurationMs: 10_000, maxRunDurationHardMs: 10_000 }, c.now);
  budget.startTask("TASK-001");
  budget.consume();

  c.advance(9_999);
  budget.consume();

  c.advance(1);
  const err = refusal(() => budget.consume());
  assert.equal(err.scope, "duration");
  assert.equal(budget.snapshot().runSpawns, 2, "the refused spawn is not charged");
});

test("reconfigure applies new ceilings while what the run spent carries over", () => {
  const time = clock();
  const budget = new LoopBudget({ maxSpawnsPerTask: 5, maxSpawnsPerRun: 5, maxRunDurationMs: 60_000, maxRunDurationHardMs: null }, time.now);
  budget.startTask("TASK-001");
  budget.consume();
  budget.consume();

  // Tightening mid-run: the spawns already charged count against the new
  // ceiling, so a limit below the current consumption refuses at once.
  budget.reconfigure({ maxSpawnsPerTask: 5, maxSpawnsPerRun: 2, maxRunDurationMs: 60_000, maxRunDurationHardMs: null });
  const err = refusal(() => budget.consume());
  assert.equal(err.scope, "run");

  // Loosening mid-run: a ceiling the operator raises lets the run continue.
  budget.reconfigure({ maxSpawnsPerTask: 5, maxSpawnsPerRun: 10, maxRunDurationMs: 60_000, maxRunDurationHardMs: null });
  budget.consume();
  assert.equal(budget.snapshot().runSpawns, 3, "the counter was never reset by the reconfigure");

  // The duration ceiling too follows the new limits, measured from the
  // original start, not from the reconfigure.
  budget.reconfigure({ maxSpawnsPerTask: 5, maxSpawnsPerRun: 10, maxRunDurationMs: 5_000, maxRunDurationHardMs: 5_000 });
  time.advance(6_000);
  assert.equal(refusal(() => budget.consume()).scope, "duration");
});

test("the expected duration only warns, and warns once", () => {
  const c = clock();
  const warnings: string[] = [];
  const budget = new LoopBudget(
    { ...WIDE, maxRunDurationMs: 10_000, maxRunDurationHardMs: 60_000 },
    { now: c.now, notify: (m) => warnings.push(m) },
  );
  budget.startTask("TASK-001");
  budget.consume();
  assert.deepEqual(warnings, [], "a run inside its expected duration says nothing");

  c.advance(10_000);
  budget.consume();
  assert.equal(warnings.length, 1, "crossing the soft ceiling warns");
  assert.match(warnings[0], /past its expected duration/);

  // Every later spawn is allowed through and stays silent: a run merely slower
  // than planned is ordinary work, not a reason to stop or to keep nagging.
  c.advance(20_000);
  budget.consume();
  budget.consume();
  assert.equal(warnings.length, 1, "the warning is one per soft ceiling, not one per spawn");
  assert.equal(budget.snapshot().runSpawns, 4);
});

test("the hard duration ceiling is the one that ends the run", () => {
  const c = clock();
  const budget = new LoopBudget(
    { ...WIDE, maxRunDurationMs: 10_000, maxRunDurationHardMs: 30_000 },
    { now: c.now },
  );
  budget.startTask("TASK-001");
  budget.consume();

  c.advance(29_999);
  budget.consume();

  c.advance(1);
  const err = refusal(() => budget.consume());
  assert.equal(err.scope, "duration");
  assert.match(err.message, /hard limit/);
  assert.equal(budget.snapshot().runSpawns, 2, "the refused spawn is not charged");
});

test("an unset hard ceiling is a multiple of the expected duration", () => {
  assert.equal(hardRunDurationMs(10_000, null), 10_000 * HARD_RUN_DURATION_MULTIPLE);
  assert.equal(hardRunDurationMs(10_000, 90_000), 90_000);
  // A hard ceiling below the expected duration would make the warning
  // unreachable: the two coincide instead.
  assert.equal(hardRunDurationMs(10_000, 5_000), 10_000);
});

test("raising the expected duration mid-run arms the warning again", () => {
  const c = clock();
  const warnings: string[] = [];
  const budget = new LoopBudget(
    { ...WIDE, maxRunDurationMs: 10_000, maxRunDurationHardMs: 600_000 },
    { now: c.now, notify: (m) => warnings.push(m) },
  );
  budget.startTask("TASK-001");
  c.advance(10_000);
  budget.consume();
  assert.equal(warnings.length, 1);

  // The operator edits the file to say the run is expected to take longer; the
  // next crossing is news again.
  budget.reconfigure({ ...WIDE, maxRunDurationMs: 20_000, maxRunDurationHardMs: 600_000 });
  budget.consume();
  assert.equal(warnings.length, 1, "below the new expectation there is nothing to say");

  c.advance(10_000);
  budget.consume();
  assert.equal(warnings.length, 2, "the raised expectation earns its own warning");
});

test("lowering the hard ceiling mid-run ends the run at the next spawn", () => {
  const c = clock();
  const budget = new LoopBudget(
    { ...WIDE, maxRunDurationMs: 10_000, maxRunDurationHardMs: 600_000 },
    { now: c.now },
  );
  budget.startTask("TASK-001");
  c.advance(60_000);
  budget.consume();

  budget.reconfigure({ ...WIDE, maxRunDurationMs: 10_000, maxRunDurationHardMs: 30_000 });
  assert.equal(refusal(() => budget.consume()).scope, "duration");
});
