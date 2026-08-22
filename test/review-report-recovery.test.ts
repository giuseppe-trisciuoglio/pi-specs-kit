import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewReport, reviewFormatReminder } from "../src/loop/review-report.ts";
import { recoverFrontmatter } from "../src/loop/review-report-recovery.ts";

// The shape that actually breaks in the field: hand-written prose values
// carrying a colon followed by a space. As YAML this is a parse error, and the
// whole report used to be discarded — verdict, findings and all — for a
// quoting slip, at the price of a full re-spawn of the review phase.
const UNQUOTED_COLON = `---
review_status: PASSED
summary: local half is correct: 16 tests green
issues: []
routed:
  - to: TASK-007
    text: Align contracts/git.md with the implementation: the guard uses merge-base
---

# Report body
`;

test("a verdict survives a value that is not valid YAML", () => {
  const report = parseReviewReport(UNQUOTED_COLON);

  assert.ok(report, "the report must not be discarded over a quoting slip");
  assert.equal(report.status, "PASSED");
  assert.equal(report.recovered, true, "the caller can tell a salvaged block from a clean one");
  assert.match(report.summary, /^local half is correct: 16 tests green$/);
  assert.equal(report.body, "# Report body");
});

test("the routed handoffs survive the same salvage", () => {
  const report = parseReviewReport(UNQUOTED_COLON);

  assert.deepEqual(report?.routed, [
    { to: "TASK-007", text: "Align contracts/git.md with the implementation: the guard uses merge-base" },
  ]);
});

test("a well-formed report is parsed by the strict path, untouched", () => {
  const report = parseReviewReport(
    '---\nreview_status: FAILED\nsummary: "missing test"\nissues:\n  - add the case\nrouted: []\n---\n\nbody\n',
  );

  assert.equal(report?.status, "FAILED");
  assert.equal(report?.recovered, false);
  assert.deepEqual(report?.issues, ["add the case"]);
});

test("a heading written above the block does not hide the verdict", () => {
  const report = parseReviewReport(
    "# Review of TASK-001\n\n---\nreview_status: PASSED\nsummary: ok\nissues: []\n---\n\nbody\n",
  );

  assert.equal(report?.status, "PASSED");
});

test("prose that merely contains a rule is not read as a report", () => {
  const prose = `${"filler\n".repeat(25)}---\nreview_status: PASSED\n---\n`;

  assert.equal(parseReviewReport(prose), null);
});

test("no verdict anywhere is still no report", () => {
  assert.equal(parseReviewReport("---\nsummary: I forgot the status\nissues: []\n---\n\nbody\n"), null);
  assert.equal(recoverFrontmatter("summary: nothing to see"), null);
});

test("spec conflicts are read from both the list and the inline form", () => {
  const listed = parseReviewReport(
    "---\nreview_status: PASSED\nsummary: ok\nissues: []\nspec_conflicts:\n  - REQ-024 refuses what the code reuses\n---\n",
  );
  const inline = parseReviewReport("---\nreview_status: PASSED\nsummary: ok\nspec_conflicts: []\n---\n");

  assert.deepEqual(listed?.specConflicts, ["REQ-024 refuses what the code reuses"]);
  assert.deepEqual(inline?.specConflicts, []);
});

test("the reminder names the rule that breaks and the file to repair", () => {
  const bare = reviewFormatReminder("TASK-002");
  const repair = reviewFormatReminder("TASK-002", {
    preservedPath: "docs/specs/001/tasks/TASK-002--review.unreadable.md",
  });
  const missing = reviewFormatReminder("TASK-002", { missing: true });

  assert.match(bare, /review_status/);
  assert.match(bare, /colon/, "the reminder must name what actually breaks the block");
  assert.doesNotMatch(bare, /preserved/);
  assert.match(repair, /TASK-002--review\.unreadable\.md/);
  assert.match(repair, /Do not review the task again/, "a repair spawn rewrites the block, it does not re-review");
  // A missing report and an unreadable one are different failures: the missing
  // case has nothing to repair, so it says plainly that no file was produced.
  assert.match(missing, /produced no file at all/);
  assert.doesNotMatch(missing, /preserved/);
  for (const text of [bare, repair, missing]) {
    assert.match(text, /review_status: "PASSED"/, "the skeleton quotes every value, status included");
  }
});
