import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseReviewReport,
  reviewAttemptArchivePath,
  reviewFilePath,
  routedFor,
  type ReviewReport,
} from "../src/loop/review-report.ts";
import { collectRoutedSuggestions } from "../src/loop/routed-suggestions.ts";

/** Build a review file body. `routedBlock` is the raw YAML placed under `routed:`. */
function report(status: string, routedBlock: string): string {
  return `---\nreview_status: ${status}\nsummary: s\nissues: []\nrouted:\n${routedBlock}\n---\n\nbody`;
}

test("parseReviewReport reads the routed list and drops malformed entries", () => {
  const routedBlock = [
    "  - to: TASK-004",
    "    text: codify the DTO styles in architecture",
    "  - to: TASK-005",
    "    text: record the eviction deviation",
    "  - text: missing the target task id",
    "  - to: TASK-006",
  ].join("\n");
  const parsed = parseReviewReport(report("FAILED", routedBlock));
  assert.ok(parsed, "the frontmatter must parse");
  const r = parsed as ReviewReport;
  assert.equal(r.routed.length, 2, "only complete {to,text} entries survive");
  assert.deepEqual(r.routed[0], { to: "TASK-004", text: "codify the DTO styles in architecture" });
});

test("parseReviewReport yields an empty routed list when the field is absent", () => {
  const parsed = parseReviewReport("---\nreview_status: PASSED\nsummary: s\nissues: []\n---\n\nbody");
  assert.ok(parsed);
  assert.deepEqual((parsed as ReviewReport).routed, []);
});

test("routedFor keeps only the suggestions aimed at a given task", () => {
  const routedBlock = ["  - to: TASK-004", "    text: a", "  - to: TASK-005", "    text: b"].join("\n");
  const r = parseReviewReport(report("FAILED", routedBlock)) as ReviewReport;
  assert.deepEqual(routedFor(r, "TASK-005").map((x) => x.text), ["b"]);
});

test("reviewAttemptArchivePath keeps the archive out of the canonical report name", () => {
  const dir = "/spec";
  assert.equal(
    reviewAttemptArchivePath(dir, "TASK-001", 2),
    path.join(dir, "tasks", "TASK-001--review.attempt-2.md"),
  );
  assert.notEqual(reviewAttemptArchivePath(dir, "TASK-001", 2), reviewFilePath(dir, "TASK-001"));
});

/**
 * The collector is the mechanism that turns a free-text review handoff into
 * something the loop can feed a later task: it reads every completed task's
 * review report and keeps the fixes routed to the task about to run.
 */
async function specWithReviews(): Promise<{ specDir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "routed-"));
  const specDir = path.join(root, "spec");
  const tasksDir = path.join(specDir, "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    reviewFilePath(specDir, "TASK-001"),
    report("PASSED", "  - to: TASK-003\n    text: route from one"),
    "utf8",
  );
  await writeFile(
    reviewFilePath(specDir, "TASK-002"),
    report("FAILED", "  - to: TASK-003\n    text: route from two\n  - to: TASK-004\n    text: other target"),
    "utf8",
  );
  return { specDir, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

test("collectRoutedSuggestions gathers handoffs aimed at a task and tags their source", async () => {
  const { specDir, cleanup } = await specWithReviews();
  try {
    const routed = await collectRoutedSuggestions(specDir, "TASK-003", ["TASK-001", "TASK-002"]);
    assert.deepEqual(
      routed.map((r) => ({ from: r.from, text: r.text })),
      [
        { from: "TASK-001", text: "route from one" },
        { from: "TASK-002", text: "route from two" },
      ],
    );
  } finally {
    await cleanup();
  }
});

test("collectRoutedSuggestions ignores a missing review without failing", async () => {
  const { specDir, cleanup } = await specWithReviews();
  try {
    const routed = await collectRoutedSuggestions(specDir, "TASK-003", ["TASK-001", "TASK-999"]);
    assert.equal(routed.length, 1);
    assert.equal(routed[0].from, "TASK-001");
  } finally {
    await cleanup();
  }
});
