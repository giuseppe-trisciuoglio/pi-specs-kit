import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadFixPlan, saveFixPlan, emptyFixPlan } from "../src/fixplan/fix-plan.ts";
import { refreshFixPlan } from "../src/fixplan/refresh.ts";
import { updateTaskStatus } from "../src/tasks/task-parser.ts";

async function withSpec(fn: (specDir: string) => Promise<void>): Promise<void> {
  const specDir = await mkdtemp(path.join(tmpdir(), "refresh-"));
  try {
    await mkdir(path.join(specDir, "tasks"), { recursive: true });
    await fn(specDir);
  } finally {
    await rm(specDir, { recursive: true, force: true });
  }
}

function taskFile(id: string, title: string, extra = ""): string {
  return `---\nid: ${id}\ntitle: ${title}\n${extra}---\n\nbody of ${id}\n`;
}

async function writeTasks(specDir: string): Promise<void> {
  const dir = path.join(specDir, "tasks");
  await writeFile(path.join(dir, "TASK-001.md"), taskFile("TASK-001", "One", "status: reviewed\n"), "utf8");
  await writeFile(path.join(dir, "TASK-002.md"), taskFile("TASK-002", "Two", "lang: go\n"), "utf8");
  await writeFile(path.join(dir, "TASK-003.md"), taskFile("TASK-003", "Three"), "utf8");
}

test("refreshFixPlan creates the plan from the task files", async () => {
  await withSpec(async (specDir) => {
    await writeTasks(specDir);
    const outcome = await refreshFixPlan(specDir, "docs/specs/001-spec");
    assert.equal(outcome, "Created");

    const plan = await loadFixPlan(specDir);
    assert.ok(plan);
    assert.equal(plan.spec_folder, "docs/specs/001-spec");
    assert.deepEqual(plan.tasks.map((t) => t.id), ["TASK-001", "TASK-002", "TASK-003"]);
    assert.equal(plan.tasks[0].file, "tasks/TASK-001.md");
    assert.equal(plan.tasks[1].lang, "go");
    assert.equal(plan.tasks[0].status, "reviewed");
    assert.deepEqual(plan.done, ["TASK-001"]);
    assert.deepEqual(plan.pending, ["TASK-002", "TASK-003"]);
    assert.equal(plan.task_range.from_num, 0);
    assert.equal(plan.task_range.to_num, 999);
    assert.equal(plan.task_range.total_in_range, 3);
    assert.deepEqual(plan.range_progress, { done_in_range: 1, percent: 33, total_in_range: 3 });
    assert.equal(plan.state.step, "choose_task");
    assert.equal(plan.default_agent, "pi");
  });
});

test("refreshFixPlan reports Nothing to refresh when nothing changed", async () => {
  await withSpec(async (specDir) => {
    await writeTasks(specDir);
    assert.equal(await refreshFixPlan(specDir, "f"), "Created");
    assert.equal(await refreshFixPlan(specDir, "f"), "Nothing to refresh");
  });
});

test("refreshFixPlan updates when a task turns reviewed, preserving state", async () => {
  await withSpec(async (specDir) => {
    await writeTasks(specDir);
    assert.equal(await refreshFixPlan(specDir, "f"), "Created");

    // Simulate loop progress, then mark the second task as reviewed on disk.
    const plan = await loadFixPlan(specDir);
    assert.ok(plan);
    plan.learnings = ["important note"];
    plan.superseded = ["TASK-099"];
    plan.state.step = "review";
    plan.state.current_task = "TASK-002";
    plan.state.iteration = 4;
    await saveFixPlan(specDir, plan);
    await updateTaskStatus(path.join(specDir, "tasks", "TASK-002.md"), "reviewed", { reviewedDate: "2026-03-02" });

    assert.equal(await refreshFixPlan(specDir, "f"), "Updated");

    const updated = await loadFixPlan(specDir);
    assert.ok(updated);
    assert.deepEqual(updated.done, ["TASK-001", "TASK-002"]);
    assert.deepEqual(updated.pending, ["TASK-003"]);
    assert.deepEqual(updated.learnings, ["important note"]);
    assert.deepEqual(updated.superseded, ["TASK-099"]);
    assert.equal(updated.state.step, "review");
    assert.equal(updated.state.current_task, "TASK-002");
    assert.equal(updated.state.iteration, 4);
    assert.deepEqual(updated.range_progress, { done_in_range: 2, percent: 67, total_in_range: 3 });
    // And a second run is a no-op again.
    assert.equal(await refreshFixPlan(specDir, "f"), "Nothing to refresh");
  });
});

test("refreshFixPlan drops a task sent back from reviewed out of done", async () => {
  await withSpec(async (specDir) => {
    await writeTasks(specDir);
    assert.equal(await refreshFixPlan(specDir, "f"), "Created");
    await updateTaskStatus(path.join(specDir, "tasks", "TASK-002.md"), "reviewed", { reviewedDate: "2026-03-02" });
    assert.equal(await refreshFixPlan(specDir, "f"), "Updated");

    // The operator sends the second task back to re-run it: done follows the file.
    await updateTaskStatus(path.join(specDir, "tasks", "TASK-002.md"), "pending");
    assert.equal(await refreshFixPlan(specDir, "f"), "Updated");

    const updated = await loadFixPlan(specDir);
    assert.ok(updated);
    assert.deepEqual(updated.done, ["TASK-001"]);
    assert.deepEqual(updated.pending, ["TASK-002", "TASK-003"]);
    assert.deepEqual(updated.range_progress, { done_in_range: 1, percent: 33, total_in_range: 3 });
    assert.equal(await refreshFixPlan(specDir, "f"), "Nothing to refresh");
  });
});

test("refreshFixPlan keeps done entries never marked reviewed on disk", async () => {
  await withSpec(async (specDir) => {
    await writeTasks(specDir);
    assert.equal(await refreshFixPlan(specDir, "f"), "Created");

    // Fast mode completes tasks without rewriting the frontmatter: a status
    // that was never reviewed is not a revert and must not clear done.
    const plan = await loadFixPlan(specDir);
    assert.ok(plan);
    plan.done.push("TASK-002");
    await saveFixPlan(specDir, plan);

    // Only pending shrinks: the done entry survives the reconciliation.
    assert.equal(await refreshFixPlan(specDir, "f"), "Updated");
    const updated = await loadFixPlan(specDir);
    assert.ok(updated);
    assert.deepEqual(updated.done, ["TASK-001", "TASK-002"]);
    assert.deepEqual(updated.pending, ["TASK-003"]);
  });
});

test("refreshFixPlan respects the configured task range for pending", async () => {
  await withSpec(async (specDir) => {
    await writeTasks(specDir);
    const plan = emptyFixPlan("s", "f");
    plan.task_range = { from: "TASK-002", from_num: 2, to: "TASK-002", to_num: 2, total_in_range: 1 };
    plan.done = ["TASK-001"]; // done outside the range is preserved as-is
    await saveFixPlan(specDir, plan);

    assert.equal(await refreshFixPlan(specDir, "f"), "Updated");
    const updated = await loadFixPlan(specDir);
    assert.ok(updated);
    assert.deepEqual(updated.pending, ["TASK-002"]);
    assert.deepEqual(updated.done, ["TASK-001"]);
    assert.equal(updated.task_range.total_in_range, 1);
    assert.deepEqual(updated.range_progress, { done_in_range: 0, percent: 0, total_in_range: 1 });
  });
});

test("refreshFixPlan keeps done entries whose files disappeared", async () => {
  await withSpec(async (specDir) => {
    await writeTasks(specDir);
    assert.equal(await refreshFixPlan(specDir, "f"), "Created");
    const plan = await loadFixPlan(specDir);
    assert.ok(plan);
    plan.done.push("TASK-042"); // stale entry, no file anymore
    await saveFixPlan(specDir, plan);

    // A stale done entry alone changes nothing in the rebuilt plan.
    assert.equal(await refreshFixPlan(specDir, "f"), "Nothing to refresh");
    const updated = await loadFixPlan(specDir);
    assert.ok(updated);
    assert.deepEqual(updated.done, ["TASK-001", "TASK-042"]);
  });
});
