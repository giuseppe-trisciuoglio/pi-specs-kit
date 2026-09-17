import test from "node:test";
import assert from "node:assert/strict";
import { computeSpecStats, formatSpecStats, parseLedgerRows } from "../src/measure/ledger-stats.ts";
import type { PhaseLedgerRow } from "../src/measure/ledger.ts";

const SPEC = "015-token-list-pricing";

function phaseRow(over: Partial<PhaseLedgerRow>): PhaseLedgerRow {
  return {
    v: 1,
    kind: "phase",
    ts: "2026-09-14T13:00:00.000Z",
    spec: SPEC,
    task: "TASK-001",
    phase: "implementation",
    attempt: 1,
    role: "agent",
    model: "fake/fake-model",
    duration_ms: 60_000,
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
    cost_total: 0,
    ...over,
  };
}

function ledgerText(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

test("parseLedgerRows skips blank and malformed lines", () => {
  const rows = parseLedgerRows(`${JSON.stringify(phaseRow({}))}\n\n{ not json\n${JSON.stringify(phaseRow({ attempt: 2 }))}\n`);
  assert.equal(rows.length, 2);
});

test("attempts per task counts the highest implementation attempt seen, mixing old rows without an outcome", () => {
  const rows = [
    // An old row, written before outcome/hooks_ms existed.
    phaseRow({ task: "TASK-001", attempt: 1 }),
    phaseRow({ task: "TASK-001", attempt: 2, outcome: "passed", hooks_ms: 5_000 }),
    phaseRow({ task: "TASK-002", attempt: 1, outcome: "passed", hooks_ms: 1_000 }),
  ];
  const stats = computeSpecStats(rows, SPEC);
  assert.equal(stats.tasksSeen, 2);
  assert.equal(stats.attemptsPerTask.mean, 1.5);
  assert.equal(stats.attemptsPerTask.max, 2);
  assert.equal(stats.unclassifiedRows, 1, "the pre-outcome row is counted but not classified");
});

test("first-pass review rate looks only at attempt-1 reviews, review pass rate at every classified review", () => {
  const rows = [
    phaseRow({ task: "TASK-001", phase: "review", attempt: 1, outcome: "review_failed" }),
    phaseRow({ task: "TASK-001", phase: "review", attempt: 2, outcome: "passed" }),
    phaseRow({ task: "TASK-002", phase: "review", attempt: 1, outcome: "passed" }),
  ];
  const stats = computeSpecStats(rows, SPEC);
  // 1 of 2 attempt-1 reviews passed.
  assert.equal(stats.firstPassReviewRate, 0.5);
  // 2 of 3 classified reviews passed overall.
  assert.equal(stats.reviewPassRate, 2 / 3);
});

test("minutes per failed cycle is the median duration of attempts whose implementation or review did not pass", () => {
  const rows = [
    // First attempt fails at the gate and burns two minutes.
    phaseRow({ task: "first", attempt: 1, phase: "implementation", outcome: "gate_failed", duration_ms: 120_000 }),
    // The retry succeeds at both the gate and the review, so it is not a failed cycle.
    phaseRow({ task: "first", attempt: 2, phase: "implementation", outcome: "passed", duration_ms: 60_000 }),
    phaseRow({ task: "first", attempt: 2, phase: "review", outcome: "passed", duration_ms: 30_000 }),
    // A second task whose implementation passes but whose review rejects it.
    phaseRow({ task: "second", attempt: 1, phase: "implementation", outcome: "passed", duration_ms: 180_000 }),
    phaseRow({ task: "second", attempt: 1, phase: "review", outcome: "review_failed", duration_ms: 60_000 }),
  ];
  const stats = computeSpecStats(rows, SPEC);
  // Two failed cycles of two and four minutes; the median is three.
  assert.equal(stats.minutesPerFailedCycle, 3);
});

test("gate minutes per attempt averages hooks_ms of implementation rows only", () => {
  const rows = [
    phaseRow({ task: "TASK-001", attempt: 1, hooks_ms: 60_000 }),
    phaseRow({ task: "TASK-001", attempt: 2, hooks_ms: 180_000 }),
    // A review row's hooks_ms does not count toward the gate figure.
    phaseRow({ task: "TASK-001", attempt: 2, phase: "review", hooks_ms: 30_000 }),
  ];
  const stats = computeSpecStats(rows, SPEC);
  assert.equal(stats.gateMinutesPerAttempt.mean, 2);
  assert.equal(stats.gateMinutesPerAttempt.total, 4);
});

test("loop hours sum every phase row's duration; wall-clock hours spans the first and last timestamp", () => {
  const rows = [
    phaseRow({ ts: "2026-09-14T10:00:00.000Z", duration_ms: 3_600_000 }),
    phaseRow({ ts: "2026-09-14T13:00:00.000Z", duration_ms: 3_600_000 }),
  ];
  const stats = computeSpecStats(rows, SPEC);
  assert.equal(stats.loopHours, 2);
  assert.equal(stats.wallClockHours, 3);
});

test("a spec with no rows yields null ratios instead of dividing by zero", () => {
  const stats = computeSpecStats([], SPEC);
  assert.equal(stats.firstPassReviewRate, null);
  assert.equal(stats.reviewPassRate, null);
  assert.equal(stats.minutesPerFailedCycle, null);
  assert.equal(stats.wallClockHours, null);
  assert.equal(stats.loopHours, 0);
});

test("rows of another spec are excluded entirely", () => {
  const rows = [phaseRow({ spec: "other-spec" }), phaseRow({})];
  const stats = computeSpecStats(rows, SPEC);
  assert.equal(stats.totalPhaseRows, 1);
});

test("formatSpecStats reports unclassified rows and renders n/a for empty ratios", () => {
  const rows = [phaseRow({})];
  const text = formatSpecStats(computeSpecStats(rows, SPEC));
  assert.match(text, /\[specs-kit\] Loop stats for 015-token-list-pricing/);
  assert.match(text, /n\/a/);
  assert.match(text, /1 phase row\(s\) unclassified/);
});

test("formatSpecStats names the spec with no ledger rows instead of printing zeros", () => {
  const text = formatSpecStats(computeSpecStats([], SPEC));
  assert.equal(text, `[specs-kit] No ledger rows found for ${SPEC}.`);
});

test("a mixed ledger of old and new rows still parses and reports", () => {
  const raw = ledgerText([
    phaseRow({ task: "TASK-001", attempt: 1 }),
    phaseRow({ task: "TASK-001", attempt: 2, outcome: "passed", hooks_ms: 2_000 }),
    { v: 1, kind: "spawn", ts: "2026-09-14T13:00:00.000Z", spec: SPEC, task: "TASK-001", phase: "implementation", attempt: 1, role: "agent", model: null, exit_code: 0, signal: null, timed_out: false, aborted: false, stop_reason: null, error_message: null, duration_ms: 1, assistant_messages: 1 },
  ]);
  const stats = computeSpecStats(parseLedgerRows(raw), SPEC);
  assert.equal(stats.totalPhaseRows, 2, "the spawn row is not a phase row");
  assert.equal(stats.unclassifiedRows, 1);
});
