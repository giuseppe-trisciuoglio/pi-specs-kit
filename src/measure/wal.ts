/**
 * Write-ahead buffer of raw per-message measurement rows, kept under the
 * agent state directory rather than the project: a phase killed halfway
 * still leaves its consumption on disk, and checkpoint commits never sweep
 * up hundreds of raw rows. Only the consolidated per-phase and per-window
 * rows reach the versioned ledger; the rows of a finished scope are pruned
 * from here.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageSummary } from "./ledger.ts";

export interface WalRow {
  v: 1;
  /** Project root the measurement belongs to, for cross-project pruning. */
  project: string;
  scope: "phase" | "window";
  /** Unique id of the phase or window instance the row belongs to. */
  scope_id: string;
  /** Null while unattributed: a window whose spec does not exist yet. */
  spec: string | null;
  task?: string;
  phase?: string;
  ts: string;
  /** Window rows: when the window opened, for retroactive consolidation. */
  started_at?: string;
  usage: UsageSummary;
  cost_total: number;
  model: string | null;
}

/** Default location, alongside the other per-agent state of the host CLI. */
export function walPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".pi", "agent", "specs-kit", "measurements-wal.jsonl");
}

export function appendWalRow(filePath: string, row: WalRow): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(row) + "\n", "utf8");
}

/** Read all rows, skipping lines that are not valid measurement objects. */
export function readWalRows(filePath: string): WalRow[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const rows: WalRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
      if (record && typeof record.scope_id === "string") rows.push(parsed as WalRow);
    } catch {
      // A half-written line (kill mid-append) must not hide the rest.
    }
  }
  return rows;
}

/** Rewrite the file keeping only the rows the predicate accepts (tmp+rename). */
export function pruneWalRows(filePath: string, keep: (row: WalRow) => boolean): void {
  const rows = readWalRows(filePath);
  // Nothing recorded, or nothing matching: leave the file system untouched,
  // so a run that measured nothing creates no state file at all.
  if (rows.length === 0) return;
  const kept = rows.filter(keep);
  if (kept.length === rows.length) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, kept.map((row) => JSON.stringify(row)).join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
  renameSync(tmp, filePath);
}
