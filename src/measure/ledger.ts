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

/**
 * Structural summary of one agent subprocess outcome. PhaseRunOutcome
 * satisfies it structurally; the ledger never imports the spawner.
 */
export interface SpawnOutcomeSummary {
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  aborted: boolean;
  stopReason: string | null;
  errorMessage: string | null;
  elapsedMs: number;
  assistantMessages?: number;
}

/**
 * One agent subprocess outcome, recorded whether the phase delivered or not.
 * Spawns run sessionless by design, so this row is the only trace of what a
 * silent or refused subprocess actually did — the raw closing evidence a
 * post-mortem reads instead of guessing.
 */
export interface SpawnLedgerRow {
  v: 1;
  kind: "spawn";
  ts: string;
  spec: string;
  task: string;
  phase: string;
  attempt: number;
  role: string;
  /** Model the subprocess was spawned with; null when the CLI chose. */
  model: string | null;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  aborted: boolean;
  stop_reason: string | null;
  error_message: string | null;
  duration_ms: number;
  assistant_messages: number;
}

export type LedgerRow = PhaseLedgerRow | AuthoringLedgerRow | SpawnLedgerRow;

export const LEDGER_FILE_NAME = "measurements.jsonl";

export function ledgerPath(projectRoot: string, specsDir: string): string {
  return path.join(projectRoot, specsDir, LEDGER_FILE_NAME);
}

export function appendLedgerRow(filePath: string, row: LedgerRow): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(row) + "\n", "utf8");
}
