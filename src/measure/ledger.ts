/**
 * Measurement ledger: an append-only JSONL record of token consumption and
 * durations, versioned with the project next to the spec directories. It is
 * not loop state — losing it never blocks a restart — so it deliberately
 * lives outside the fix plan, which is rewritten whole on every transition.
 *
 * Writes are synchronous: rows are few (one per phase, one per window) and a
 * fire-and-forget promise would make ordering and error handling worse for no
 * measurable gain.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** Token totals of a consolidated row, flattened from the wire shape. */
export interface UsageSummary {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

export function zeroUsage(): UsageSummary {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 };
}

/** One executed phase of the loop, hooks included in the duration. */
export interface PhaseLedgerRow {
  v: 1;
  kind: "phase";
  ts: string;
  spec: string;
  task: string;
  phase: string;
  attempt: number;
  role: string;
  /** Model that produced the stream when observed, else the configured one. */
  model: string | null;
  duration_ms: number;
  usage: UsageSummary;
  cost_total: number;
}

/** One authoring window of the interactive session, attributed to a spec. */
export interface AuthoringLedgerRow {
  v: 1;
  kind: "authoring";
  ts: string;
  spec: string;
  started_at: string;
  duration_ms: number;
  usage: UsageSummary;
  cost_total: number;
}

export type LedgerRow = PhaseLedgerRow | AuthoringLedgerRow;

export const LEDGER_FILE_NAME = "measurements.jsonl";

export function ledgerPath(projectRoot: string, specsDir: string): string {
  return path.join(projectRoot, specsDir, LEDGER_FILE_NAME);
}

export function appendLedgerRow(filePath: string, row: LedgerRow): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(row) + "\n", "utf8");
}
