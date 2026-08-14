import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeRangeProgress,
  emptyFixPlan,
  FIX_PLAN_FILE,
  loadFixPlan,
  LOOP_STATE_DIR,
  saveFixPlan,
  type FixPlan,
} from "../src/fixplan/fix-plan.ts";

async function withSpec(fn: (specDir: string) => Promise<void>): Promise<void> {
  const specDir = await mkdtemp(path.join(tmpdir(), "fixplan-"));
  try {
    await fn(specDir);
  } finally {
    await rm(specDir, { recursive: true, force: true });
  }
}

test("emptyFixPlan has the expected initial shape", () => {
  const plan = emptyFixPlan("001-spec", "docs/specs/001-spec");
  assert.equal(plan.spec_id, "001-spec");
  assert.equal(plan.spec_folder, "docs/specs/001-spec");
  assert.equal(plan.default_agent, "pi");
  assert.equal(plan.state.step, "choose_task");
  assert.equal(plan.state.iteration, 0);
  assert.equal(plan.state.retry_count, 0);
  assert.equal(plan.state.current_task, null);
  assert.deepEqual(plan.tasks, []);
  assert.deepEqual(plan.done, []);
  assert.deepEqual(plan.pending, []);
  assert.equal(plan.superseded, null);
  assert.equal(plan.optional, null);
  assert.deepEqual(plan.task_range, { from: null, from_num: 0, to: null, to_num: 999, total_in_range: 0 });
  assert.deepEqual(plan.range_progress, { done_in_range: 0, percent: 0, total_in_range: 0 });
});

test("loadFixPlan returns null when the file is missing", async () => {
  await withSpec(async (specDir) => {
    assert.equal(await loadFixPlan(specDir), null);
  });
});

test("loadFixPlan tolerates missing fields with defaults", async () => {
  await withSpec(async (specDir) => {
    const file = path.join(specDir, LOOP_STATE_DIR, FIX_PLAN_FILE);
    await saveFixPlan(specDir, emptyFixPlan("x", "y")); // creates the directory
    await writeFile(file, JSON.stringify({ spec_id: "001-spec", done: ["TASK-001"] }), "utf8");
    const plan = await loadFixPlan(specDir);
    assert.ok(plan);
    assert.equal(plan.spec_id, "001-spec");
    assert.deepEqual(plan.done, ["TASK-001"]);
    assert.equal(plan.default_agent, "pi");
    assert.equal(plan.state.step, "choose_task");
    assert.deepEqual(plan.tasks, []);
    assert.equal(plan.task_range.to_num, 999);
  });
});

test("saveFixPlan writes atomically and the plan round-trips", async () => {
  await withSpec(async (specDir) => {
    const plan = emptyFixPlan("001-spec", "docs/specs/001-spec");
    plan.done = ["TASK-001", "TASK-002"];
    plan.learnings = ["always use migrations"];
    plan.superseded = ["TASK-009"];
    plan.state.step = "implementation";
    plan.state.current_task = "TASK-003";
    const before = plan.last_updated;
    await saveFixPlan(specDir, plan);

    const file = path.join(specDir, LOOP_STATE_DIR, FIX_PLAN_FILE);
    const onDisk = JSON.parse(await readFile(file, "utf8")) as FixPlan;
    assert.equal(onDisk.spec_id, "001-spec");
    assert.deepEqual(onDisk.done, ["TASK-001", "TASK-002"]);
    assert.deepEqual(onDisk.learnings, ["always use migrations"]);
    assert.deepEqual(onDisk.superseded, ["TASK-009"]);
    assert.equal(onDisk.state.step, "implementation");
    assert.ok(onDisk.last_updated >= before, "last_updated stamped at save time");

    const reloaded = await loadFixPlan(specDir);
    assert.deepEqual(reloaded, plan);
  });
});

test("computeRangeProgress counts done tasks inside the range", () => {
  const plan = emptyFixPlan("s", "f");
  plan.tasks = [
    { id: "TASK-001", file: "tasks/TASK-001.md", title: "a", lang: null, status: "reviewed" },
    { id: "TASK-002", file: "tasks/TASK-002.md", title: "b", lang: null, status: "pending" },
    { id: "TASK-003", file: "tasks/TASK-003.md", title: "c", lang: null, status: "reviewed" },
    { id: "TASK-010", file: "tasks/TASK-010.md", title: "d", lang: null, status: "reviewed" },
  ];
  plan.done = ["TASK-001", "TASK-003", "TASK-010"];
  plan.task_range = { from: "TASK-001", from_num: 1, to: "TASK-003", to_num: 3, total_in_range: 3 };
  assert.deepEqual(computeRangeProgress(plan), { done_in_range: 2, percent: 67, total_in_range: 3 });

  plan.task_range = { from: null, from_num: 0, to: null, to_num: 999, total_in_range: 4 };
  assert.deepEqual(computeRangeProgress(plan), { done_in_range: 3, percent: 75, total_in_range: 4 });

  plan.tasks = [];
  assert.deepEqual(computeRangeProgress(plan), { done_in_range: 0, percent: 0, total_in_range: 0 });
});
