/**
 * The review phase is a contract between two artifacts written in different
 * places: the report template the reviewer fills in, and the parser that reads
 * the verdict out of it. Nothing else in the suite compares them — the fake
 * agent of the e2e writes the parser's own shape, so it would keep passing
 * while a real reviewer following the template produced something unreadable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReviewReport } from "../src/loop/review-report.ts";

const TEMPLATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../skills/specs-kit-task-review/templates/task-review.md",
);

/** The template with its placeholders filled in, as a reviewer would leave it. */
async function filled(status: string): Promise<string> {
  const raw = await readFile(TEMPLATE, "utf8");
  return raw
    .replace(/\$\{REVIEW_STATUS\}/g, status)
    .replace(/\$\{REVIEW_SUMMARY\}/g, "the implementation matches the task")
    .replace(/\$\{ISSUE\}/g, "no regression test for the new branch")
    .replace(/\$\{[A-Z_]+\}/g, "placeholder");
}

test("the review template yields a report the loop can read", async () => {
  const report = parseReviewReport(await filled("PASSED"));

  assert.ok(report, "the filled template must parse");
  assert.equal(report.status, "PASSED");
  assert.equal(report.summary, "the implementation matches the task");
  assert.deepEqual(report.issues, ["no regression test for the new branch"]);
  assert.ok(report.body.includes("Task Review Report"), "the human-facing body survives parsing");
});

test("the review template carries a FAILED verdict just as well", async () => {
  const report = parseReviewReport(await filled("FAILED"));

  assert.ok(report);
  assert.equal(report.status, "FAILED");
});

test("the review template documents no status outside the two the parser accepts", async () => {
  const raw = await readFile(TEMPLATE, "utf8");

  // The template used to describe a four-value vocabulary the loop never knew
  // how to read; a reviewer picking one of those left the loop with no verdict.
  for (const removed of ["needs_fix", "`partial`", "escalate"]) {
    assert.ok(!raw.includes(removed), `the template still offers ${removed} as a verdict`);
  }
  assert.ok(raw.startsWith("---\nreview_status:"), "the verdict must be the first thing in the file");
});
