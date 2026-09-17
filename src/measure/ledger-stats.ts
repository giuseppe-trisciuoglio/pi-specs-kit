/**
 * KPIs read directly off the phase rows of a spec's ledger: attempts per
 * task, review pass rates, minutes lost to a failed cycle, gate minutes,
 * loop hours and wall-clock hours. Before `outcome` and `hooks_ms` existed on
 * the `phase` row, these numbers required joining it with `spawn` rows and
 * reading the frontmatter of archived review reports; now they are readable
 * straight from the ledger. Pure and test-importable: no pi package import,
 * no file I/O — callers hand it the already-read ledger text.
 */

import type { LedgerRow, PhaseLedgerRow } from "./ledger.ts";

export interface SpecStats {
  spec: string;
  /** "phase" rows for this spec, of any kind. */
  totalPhaseRows: number;
  /** Rows with no `outcome` field: written before it existed, or by a caller
   * that closed the phase without one. Excluded from every ratio below. */
  unclassifiedRows: number;
  tasksSeen: number;
  attemptsPerTask: { mean: number; max: number };
  /** Fraction of tasks whose review passed on attempt 1, out of tasks with a
   * classified attempt-1 review. Null when there is nothing to divide by. */
  firstPassReviewRate: number | null;
  /** Fraction of all classified review rows, any attempt, that passed. */
  reviewPassRate: number | null;
  /** Median duration, in minutes, of an attempt whose implementation or
   * review did not pass — the cost of one retry round. */
  minutesPerFailedCycle: number | null;
  gateMinutesPerAttempt: { mean: number; total: number };
  loopHours: number;
  /** Elapsed time between the first and last phase row; null with fewer
   * than two timestamps to span. */
  wallClockHours: number | null;
}

/** Parse ledger JSONL text, skipping blank and malformed lines: a ledger read
 * for stats must survive a line a killed process left half-written. */
export function parseLedgerRows(raw: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && "kind" in parsed) rows.push(parsed as LedgerRow);
    } catch {
      // A malformed line does not stop the read: the rest of the ledger still counts.
    }
  }
  return rows;
}

function isPhaseRow(row: LedgerRow, spec: string): row is PhaseLedgerRow {
  return row.kind === "phase" && row.spec === spec;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const CYCLE_PHASES = new Set(["implementation", "review", "failure_learner"]);

/** A cycle counts as failed — the work paid for a retry rather than for the
 * task's progress — when the implementation or the review of that attempt
 * recorded an outcome that is not a pass. */
function outcomeFailed(row: PhaseLedgerRow | undefined): boolean {
  return row?.outcome !== undefined && row.outcome !== "passed";
}

/** Duration, in minutes, of every failed attempt cycle: a cycle groups every
 * implementation/review/learner row of one attempt of one task. */
function failedCycleDurations(phaseRows: PhaseLedgerRow[]): number[] {
  const byAttempt = new Map<string, PhaseLedgerRow[]>();
  for (const r of phaseRows) {
    if (!CYCLE_PHASES.has(r.phase)) continue;
    const key = `${r.task}#${r.attempt}`;
    const list = byAttempt.get(key);
    if (list) list.push(r);
    else byAttempt.set(key, [r]);
  }
  const durations: number[] = [];
  for (const list of byAttempt.values()) {
    const implRow = list.find((r) => r.phase === "implementation");
    const reviewRow = list.find((r) => r.phase === "review");
    if (!outcomeFailed(implRow) && !outcomeFailed(reviewRow)) continue;
    durations.push(list.reduce((sum, r) => sum + r.duration_ms, 0) / 60_000);
  }
  return durations;
}

/** Compute the KPIs of one spec from its ledger rows. */
export function computeSpecStats(rows: LedgerRow[], spec: string): SpecStats {
  const phaseRows = rows.filter((r): r is PhaseLedgerRow => isPhaseRow(r, spec));
  const unclassifiedRows = phaseRows.filter((r) => r.outcome === undefined).length;

  const implRows = phaseRows.filter((r) => r.phase === "implementation");
  const reviewRows = phaseRows.filter((r) => r.phase === "review");

  const attemptsByTask = new Map<string, number>();
  for (const r of implRows) attemptsByTask.set(r.task, Math.max(attemptsByTask.get(r.task) ?? 0, r.attempt));
  const attemptCounts = [...attemptsByTask.values()];

  const firstAttemptReviews = reviewRows.filter((r) => r.attempt === 1 && r.outcome !== undefined);
  const firstPassReviewRate =
    firstAttemptReviews.length > 0
      ? firstAttemptReviews.filter((r) => r.outcome === "passed").length / firstAttemptReviews.length
      : null;

  const classifiedReviews = reviewRows.filter((r) => r.outcome !== undefined);
  const reviewPassRate =
    classifiedReviews.length > 0
      ? classifiedReviews.filter((r) => r.outcome === "passed").length / classifiedReviews.length
      : null;

  const failedCycleMinutes = failedCycleDurations(phaseRows);

  const gateMinutes = implRows.filter((r) => r.hooks_ms !== undefined).map((r) => (r.hooks_ms ?? 0) / 60_000);

  const loopHours = phaseRows.reduce((sum, r) => sum + r.duration_ms, 0) / 3_600_000;
  const timestamps = phaseRows.map((r) => Date.parse(r.ts)).filter((t) => !Number.isNaN(t));
  const wallClockHours =
    timestamps.length > 1 ? (Math.max(...timestamps) - Math.min(...timestamps)) / 3_600_000 : null;

  return {
    spec,
    totalPhaseRows: phaseRows.length,
    unclassifiedRows,
    tasksSeen: attemptsByTask.size,
    attemptsPerTask: { mean: mean(attemptCounts), max: attemptCounts.length > 0 ? Math.max(...attemptCounts) : 0 },
    firstPassReviewRate,
    reviewPassRate,
    minutesPerFailedCycle: median(failedCycleMinutes),
    gateMinutesPerAttempt: { mean: mean(gateMinutes), total: gateMinutes.reduce((sum, v) => sum + v, 0) },
    loopHours,
    wallClockHours,
  };
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function minutes(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)} min`;
}

function hours(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)} h`;
}

/** Render the KPIs as the multi-line notification `/specs-kit-stats` and the
 * range close summary both print. */
export function formatSpecStats(stats: SpecStats): string {
  if (stats.totalPhaseRows === 0) return `[specs-kit] No ledger rows found for ${stats.spec}.`;
  const lines = [
    `[specs-kit] Loop stats for ${stats.spec}`,
    `tasks: ${stats.tasksSeen} · attempts/task: ${stats.attemptsPerTask.mean.toFixed(1)} (max ${stats.attemptsPerTask.max})`,
    `review: first-pass ${pct(stats.firstPassReviewRate)} · pass rate ${pct(stats.reviewPassRate)}`,
    `minutes per failed cycle: ${minutes(stats.minutesPerFailedCycle)}`,
    `gate: ${minutes(stats.gateMinutesPerAttempt.mean)}/attempt · ${stats.gateMinutesPerAttempt.total.toFixed(1)} min total`,
    `loop: ${stats.loopHours.toFixed(1)} h · wall clock: ${hours(stats.wallClockHours)}`,
  ];
  if (stats.unclassifiedRows > 0) {
    lines.push(`${stats.unclassifiedRows} phase row(s) unclassified (no outcome recorded)`);
  }
  return lines.join("\n");
}
