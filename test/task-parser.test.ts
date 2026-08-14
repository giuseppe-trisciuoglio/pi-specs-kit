import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseTaskFile,
  serializeTaskFile,
  taskIdNumber,
  TaskParseError,
  updateTaskStatus,
  type TaskFile,
} from "../src/tasks/task-parser.ts";
import { dependencyWarnings, filterRange, loadTasks, taskBoundNumber } from "../src/tasks/task-loader.ts";

const VALID = `---
id: TASK-001
title: Project setup
status: implemented
dependencies:
  - TASK-000
ac-mapping: AC-1
imp-requirements:
  - REQ-1
  - REQ-2
implemented_date: 2026-01-15
unknown_field: ignored
---

# Task body

Free text.
`;

test("parseTaskFile parses a complete frontmatter", () => {
  const task = parseTaskFile("/x/TASK-001.md", VALID);
  assert.equal(task.num, 1);
  assert.equal(task.frontmatter.id, "TASK-001");
  assert.equal(task.frontmatter.title, "Project setup");
  assert.equal(task.frontmatter.status, "implemented");
  assert.deepEqual(task.frontmatter.dependencies, ["TASK-000"]);
  assert.deepEqual(task.frontmatter.acMapping, ["AC-1"]);
  assert.deepEqual(task.frontmatter.impRequirements, ["REQ-1", "REQ-2"]);
  assert.equal(task.frontmatter.implementedDate, "2026-01-15");
  assert.equal(task.frontmatter.reviewedDate, undefined);
  assert.equal(task.body, "# Task body\n\nFree text.\n");
});

test("parseTaskFile defaults status and arrays when absent", () => {
  const task = parseTaskFile("/x/TASK-002.md", "---\nid: TASK-002\ntitle: Minimal\n---\nbody\n");
  assert.equal(task.frontmatter.status, "pending");
  assert.deepEqual(task.frontmatter.dependencies, []);
  assert.deepEqual(task.frontmatter.acMapping, []);
  assert.deepEqual(task.frontmatter.impRequirements, []);
  assert.equal(task.body, "body\n");
});

test("parseTaskFile rejects a missing or malformed id", () => {
  for (const yaml of ["title: Title only", "id: foo-bar\ntitle: T", "id: 12\ntitle: T"]) {
    assert.throws(() => parseTaskFile("/x/t.md", `---\n${yaml}\n---\n`), (err: unknown) => {
      assert.ok(err instanceof TaskParseError);
      assert.equal(err.field, "id");
      assert.equal(err.file, "/x/t.md");
      return true;
    });
  }
});

test("parseTaskFile rejects a missing title", () => {
  assert.throws(() => parseTaskFile("/x/t.md", "---\nid: TASK-001\n---\n"), (err: unknown) => {
    assert.ok(err instanceof TaskParseError);
    assert.equal(err.field, "title");
    return true;
  });
});

test("parseTaskFile rejects an invalid status", () => {
  assert.throws(
    () => parseTaskFile("/x/t.md", "---\nid: TASK-001\ntitle: T\nstatus: doing\n---\n"),
    (err: unknown) => {
      assert.ok(err instanceof TaskParseError);
      assert.equal(err.field, "status");
      return true;
    },
  );
});

test("parseTaskFile requires the frontmatter delimiters", () => {
  assert.throws(() => parseTaskFile("/x/t.md", "id: TASK-001\ntitle: T\n"), TaskParseError);
});

test("serializeTaskFile round-trips through parseTaskFile", () => {
  const task = parseTaskFile("/x/TASK-001.md", VALID);
  const again = parseTaskFile("/x/TASK-001.md", serializeTaskFile(task));
  assert.deepEqual(again.frontmatter, task.frontmatter);
  assert.equal(again.body, task.body);
  assert.equal(again.num, task.num);
});

test("serializeTaskFile emits snake_case keys", () => {
  const task: TaskFile = {
    path: "/x/TASK-003.md",
    num: 3,
    frontmatter: {
      id: "TASK-003",
      title: "T",
      status: "reviewed",
      dependencies: [],
      acMapping: ["AC-9"],
      impRequirements: [],
      provides: [],
      implementedDate: "2026-02-01",
      reviewedDate: "2026-02-03",
    },
    body: "body\n",
  };
  const text = serializeTaskFile(task);
  assert.match(text, /ac-mapping:\n {2}- AC-9/);
  assert.match(text, /imp-requirements: \[\]/);
  assert.match(text, /implemented_date: 2026-02-01/);
  assert.match(text, /reviewed_date: 2026-02-03/);
  assert.ok(text.endsWith("body\n"));
});

test("taskIdNumber extracts the numeric part", () => {
  assert.equal(taskIdNumber("TASK-012"), 12);
  assert.equal(taskIdNumber("TASK-1"), 1);
  assert.equal(taskIdNumber("nope"), null);
});

test("taskBoundNumber accepts full ids and bare numbers", () => {
  assert.equal(taskBoundNumber("TASK-012"), 12);
  assert.equal(taskBoundNumber("12"), 12);
  assert.equal(taskBoundNumber(" 07 "), 7);
  assert.equal(taskBoundNumber("nope"), null);
  assert.equal(taskBoundNumber("TASK-1x"), null);
  assert.equal(taskBoundNumber("1.5"), null);
});

async function withSpec(fn: (specDir: string) => Promise<void>): Promise<void> {
  const specDir = await mkdtemp(path.join(tmpdir(), "tasks-"));
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

test("updateTaskStatus rewrites status and dates, preserving the body", async () => {
  await withSpec(async (specDir) => {
    const file = path.join(specDir, "tasks", "TASK-001.md");
    await writeFile(file, taskFile("TASK-001", "One"), "utf8");
    await updateTaskStatus(file, "reviewed", { implementedDate: "2026-03-01", reviewedDate: "2026-03-02" });
    const task = parseTaskFile(file, await readFile(file, "utf8"));
    assert.equal(task.frontmatter.status, "reviewed");
    assert.equal(task.frontmatter.implementedDate, "2026-03-01");
    assert.equal(task.frontmatter.reviewedDate, "2026-03-02");
    assert.equal(task.body, "body of TASK-001\n");
  });
});

test("updateTaskStatus preserves unmodeled frontmatter keys", async () => {
  await withSpec(async (specDir) => {
    const file = path.join(specDir, "tasks", "TASK-001.md");
    await writeFile(file, taskFile("TASK-001", "One", "owner: alice\npriority: high\n"), "utf8");
    await updateTaskStatus(file, "reviewed", { reviewedDate: "2026-03-02" });
    const text = await readFile(file, "utf8");
    assert.match(text, /owner: alice/);
    assert.match(text, /priority: high/);
    const task = parseTaskFile(file, text);
    assert.equal(task.frontmatter.status, "reviewed");
    assert.equal(task.frontmatter.reviewedDate, "2026-03-02");
    assert.equal(task.body, "body of TASK-001\n");
  });
});

test("loadTasks orders by number and skips review files", async () => {
  await withSpec(async (specDir) => {
    const dir = path.join(specDir, "tasks");
    await writeFile(path.join(dir, "TASK-010.md"), taskFile("TASK-010", "Ten"), "utf8");
    await writeFile(path.join(dir, "TASK-002.md"), taskFile("TASK-002", "Two"), "utf8");
    await writeFile(path.join(dir, "TASK-002--review.md"), "---\nreview_status: PASSED\n---\n", "utf8");
    await writeFile(path.join(dir, "not-a-task.txt"), "ignored", "utf8");
    const tasks = await loadTasks(specDir);
    assert.deepEqual(tasks.map((t) => t.frontmatter.id), ["TASK-002", "TASK-010"]);
    assert.deepEqual(tasks.map((t) => t.num), [2, 10]);
  });
});

test("loadTasks returns an empty list when the tasks dir is missing", async () => {
  const specDir = await mkdtemp(path.join(tmpdir(), "tasks-"));
  try {
    assert.deepEqual(await loadTasks(specDir), []);
  } finally {
    await rm(specDir, { recursive: true, force: true });
  }
});

test("filterRange applies inclusive numeric bounds", async () => {
  await withSpec(async (specDir) => {
    const dir = path.join(specDir, "tasks");
    for (const n of [1, 2, 3, 4]) {
      await writeFile(path.join(dir, `TASK-00${n}.md`), taskFile(`TASK-00${n}`, `T${n}`), "utf8");
    }
    const tasks = await loadTasks(specDir);
    assert.deepEqual(filterRange(tasks, "TASK-002", "TASK-003").map((t) => t.num), [2, 3]);
    assert.deepEqual(filterRange(tasks, "02", "03").map((t) => t.num), [2, 3]);
    assert.deepEqual(filterRange(tasks, "2").map((t) => t.num), [2, 3, 4]);
    assert.deepEqual(filterRange(tasks, "TASK-003").map((t) => t.num), [3, 4]);
    assert.deepEqual(filterRange(tasks, undefined, "TASK-002").map((t) => t.num), [1, 2]);
    assert.deepEqual(filterRange(tasks).map((t) => t.num), [1, 2, 3, 4]);
    assert.throws(() => filterRange(tasks, "bogus"), /invalid task range bound/);
  });
});

test("dependencyWarnings flags unsatisfied dependencies only", async () => {
  await withSpec(async (specDir) => {
    const dir = path.join(specDir, "tasks");
    await writeFile(path.join(dir, "TASK-001.md"), taskFile("TASK-001", "One", "status: reviewed\n"), "utf8");
    await writeFile(path.join(dir, "TASK-002.md"), taskFile("TASK-002", "Two"), "utf8");
    await writeFile(
      path.join(dir, "TASK-003.md"),
      taskFile("TASK-003", "Three", "dependencies:\n  - TASK-001\n  - TASK-002\n  - TASK-009\n"),
      "utf8",
    );
    await writeFile(path.join(dir, "TASK-004.md"), taskFile("TASK-004", "Four", "dependencies:\n  - TASK-005\n"), "utf8");
    await writeFile(path.join(dir, "TASK-005.md"), taskFile("TASK-005", "Five"), "utf8");

    const tasks = await loadTasks(specDir);
    // First task already reviewed, second selected before the third: ok; ninth missing: warn.
    const selected = [tasks[0], tasks[1], tasks[2]];
    const warnings = dependencyWarnings(tasks, selected);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /TASK-009/);
    assert.match(warnings[0], /not found/);

    // Fifth comes after fourth in the selection and is not reviewed: warn.
    const later = dependencyWarnings(tasks, [tasks[3], tasks[4]]);
    assert.equal(later.length, 1);
    assert.match(later[0], /TASK-005/);
    assert.match(later[0], /not satisfied/);

    // Selecting everything still warns: the ninth is missing and the fifth has a
    // higher number than its dependent fourth (scheduled after, not before).
    assert.deepEqual(dependencyWarnings(tasks, tasks), [
      "TASK-003: dependency TASK-009 not found among the tasks",
      'TASK-004: dependency TASK-005 not satisfied (status "pending", not selected before the task)',
    ]);
  });
});

test("dependencyWarnings accepts a dependency completed by the loop", async () => {
  await withSpec(async (specDir) => {
    const dir = path.join(specDir, "tasks");
    await writeFile(path.join(dir, "TASK-001.md"), taskFile("TASK-001", "One"), "utf8");
    await writeFile(path.join(dir, "TASK-002.md"), taskFile("TASK-002", "Two", "dependencies:\n  - TASK-001\n"), "utf8");
    const tasks = await loadTasks(specDir);
    const selected = [tasks[1]];

    // Fast mode never rewrites the frontmatter, so "pending" is all the file
    // says about a task the loop already completed: the done set decides.
    assert.equal(dependencyWarnings(tasks, selected).length, 1);
    assert.deepEqual(dependencyWarnings(tasks, selected, ["TASK-001"]), []);
  });
});

test("loadTasks rejects two files declaring the same task id", async () => {
  await withSpec(async (specDir) => {
    const dir = path.join(specDir, "tasks");
    await writeFile(path.join(dir, "TASK-001.md"), taskFile("TASK-001", "One"), "utf8");
    await writeFile(path.join(dir, "TASK-001--copy.md"), taskFile("TASK-001", "One again"), "utf8");
    await assert.rejects(() => loadTasks(specDir), /duplicate task id TASK-001/);
  });
});

test("parseTaskFile admits the cleanup stamp and reads it back as reviewed", () => {
  // A cleanup hook may stamp a terminal value the loop did not write itself.
  // The parser treats it as the canonical terminal so a fix-plan refresh never
  // rejects a file the loop's own phases produced.
  const task = parseTaskFile(
    "/x/TASK-002.md",
    "---\nid: TASK-002\ntitle: Done\nstatus: completed\n---\n\nbody\n",
  );
  assert.equal(task.frontmatter.status, "reviewed");
});

test("parseTaskFile still rejects an unknown status", () => {
  assert.throws(
    () => parseTaskFile("/x/TASK-003.md", "---\nid: TASK-003\ntitle: X\nstatus: draft\n---\n\nb\n"),
    /invalid value: draft/,
  );
});

test("loadTasks skips review reports and their per-attempt archives", async () => {
  await withSpec(async (specDir) => {
    const dir = path.join(specDir, "tasks");
    await writeFile(path.join(dir, "TASK-001.md"), taskFile("TASK-001", "One"), "utf8");
    // The canonical review report and an archived earlier verdict must not be
    // mistaken for tasks, or the loader would try to parse them and choke.
    await writeFile(path.join(dir, "TASK-001--review.md"), "review body", "utf8");
    await writeFile(path.join(dir, "TASK-001--review.attempt-1.md"), "prior verdict", "utf8");
    const tasks = await loadTasks(specDir);
    assert.deepEqual(tasks.map((t) => t.frontmatter.id), ["TASK-001"]);
  });
});
