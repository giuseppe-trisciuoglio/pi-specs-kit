import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyFixPlan, type FixPlan } from "../src/fixplan/fix-plan.ts";
import { rangeCloseWarnings } from "../src/loop/range-close.ts";
import { openRoutedSuggestions, openRoutedWarning, routedWithoutOwner } from "../src/loop/routed-suggestions.ts";
import { reviewFilePath } from "../src/loop/review-report.ts";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

async function createSpec(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "range-close-"));
  tmpDirs.push(root);
  const specDir = path.join(root, "docs/specs/001-spec");
  await mkdir(path.join(specDir, "tasks"), { recursive: true });
  return specDir;
}

function planWith(tasks: string[], done: string[]): FixPlan {
  const plan = emptyFixPlan("001-spec", "docs/specs/001-spec");
  plan.tasks = tasks.map((id) => ({ id, file: `tasks/${id}.md`, title: id, lang: null, status: "pending" as const }));
  plan.done = done;
  return plan;
}

test("a fix routed to a task nobody will run has no owner", () => {
  const plan = planWith(["TASK-001", "TASK-002"], ["TASK-001"]);

  const unowned = routedWithoutOwner(
    [
      { to: "TASK-002", text: "still pending, legitimate" },
      { to: "TASK-001", text: "already closed" },
      { to: "TASK-404", text: "never existed" },
    ],
    plan,
    "TASK-003",
  );

  assert.deepEqual(unowned.map((s) => s.to), ["TASK-001", "TASK-404"]);
});

test("a task cannot defer a fix to itself", () => {
  const plan = planWith(["TASK-001"], []);

  const unowned = routedWithoutOwner([{ to: "TASK-001", text: "do it later" }], plan, "TASK-001");

  assert.equal(unowned.length, 1, "deferring to yourself is the same as not doing it");
});

test("a target outside the range is not an owner either", () => {
  const plan = planWith(["TASK-001", "TASK-009"], []);
  plan.task_range = { from: "TASK-001", from_num: 1, to: "TASK-002", to_num: 2, total_in_range: 2 };

  assert.deepEqual(routedWithoutOwner([{ to: "TASK-009", text: "out of range" }], plan, "TASK-001").length, 1);
});

test("handoffs whose target never completed are reported when the range closes", async () => {
  const specDir = await createSpec();
  const plan = planWith(["TASK-001", "TASK-002"], ["TASK-001"]);
  await writeFile(
    reviewFilePath(specDir, "TASK-001"),
    '---\nreview_status: PASSED\nsummary: ok\nissues: []\nrouted:\n  - to: TASK-002\n    text: "align the contract"\n---\n\nbody\n',
    "utf8",
  );

  const open = await openRoutedSuggestions(specDir, plan);

  assert.deepEqual(open, [{ to: "TASK-002", text: "align the contract", from: "TASK-001" }]);
  assert.match(openRoutedWarning(open) ?? "", /TASK-001 → TASK-002/);
});

test("a handoff the target actually completed is not reported", async () => {
  const specDir = await createSpec();
  const plan = planWith(["TASK-001", "TASK-002"], ["TASK-001", "TASK-002"]);
  await writeFile(
    reviewFilePath(specDir, "TASK-001"),
    '---\nreview_status: PASSED\nsummary: ok\nissues: []\nrouted:\n  - to: TASK-002\n    text: "align the contract"\n---\n\nbody\n',
    "utf8",
  );

  assert.deepEqual(await openRoutedSuggestions(specDir, plan), []);
  assert.equal(openRoutedWarning([]), null);
});

test("the closing checks report both kinds of unbacked claim, in reading order", async () => {
  const specDir = await createSpec();
  const plan = planWith(["TASK-001"], ["TASK-001"]);

  const warnings = await rangeCloseWarnings(plan, {
    projectRoot: path.dirname(specDir),
    specDir,
    checkTraceability: async () => [{ id: "AC-009", problem: "cites e2e/x.test.ts, which does not exist" }],
    openRouted: async () => [{ to: "TASK-007", text: "align the contract", from: "TASK-002" }],
  });

  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /coverage matrix/);
  assert.match(warnings[1], /routed to tasks that never completed/);
});

test("a check that throws leaves the range closed without warnings", async () => {
  const specDir = await createSpec();
  const plan = planWith(["TASK-001"], ["TASK-001"]);

  const warnings = await rangeCloseWarnings(plan, {
    projectRoot: path.dirname(specDir),
    specDir,
    checkTraceability: async () => {
      throw new Error("unreadable");
    },
    openRouted: async () => {
      throw new Error("unreadable");
    },
  });

  assert.deepEqual(warnings, []);
});
