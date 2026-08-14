/**
 * Per-phase measurement: accumulates the token usage of the assistant
 * messages streamed by the phase subprocess, buffers each of them in the
 * write-ahead file and, when the phase ends, appends the consolidated row to
 * the ledger and drops the raw rows from the buffer. All I/O is best-effort:
 * a failure surfaces as one warning and measurement goes silent for the rest
 * of the run, never breaking the loop.
 */

import { randomUUID } from "node:crypto";
import { appendLedgerRow, type PhaseLedgerRow, type UsageSummary, zeroUsage } from "./ledger.ts";
import { addUsage, messageUsage } from "./usage.ts";
import { appendWalRow, pruneWalRows } from "./wal.ts";

export interface PhaseMeterDeps {
  ledgerFile: string;
  walFile: string;
  /** Project root, stamped on the write-ahead rows. */
  projectRoot: string;
  onNotify?: (message: string, type: "info" | "warning" | "error") => void;
  now?: () => Date;
  newId?: () => string;
}

export interface PhaseContext {
  spec: string;
  task: string;
  phase: string;
  attempt: number;
  role: string;
  model: string | null;
}

/** Accumulator of one running phase; treated as opaque by callers. */
export interface PhaseHandle {
  id: string;
  startedAtMs: number;
  context: PhaseContext;
  usage: UsageSummary;
  cost: number;
  model: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export class PhaseMeter {
  readonly #deps: Required<Pick<PhaseMeterDeps, "ledgerFile" | "walFile" | "projectRoot">> & PhaseMeterDeps;
  readonly #now: () => Date;
  readonly #newId: () => string;
  /** Set after the first I/O failure: measurement degrades to a no-op. */
  #broken = false;

  constructor(deps: PhaseMeterDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? (() => randomUUID());
  }

  beginPhase(context: PhaseContext): PhaseHandle {
    return {
      id: this.#newId(),
      startedAtMs: this.#now().getTime(),
      context,
      usage: zeroUsage(),
      cost: 0,
      model: context.model,
    };
  }

  /** Account for one stream event; only completed assistant messages count. */
  recordEvent(handle: PhaseHandle, event: unknown): void {
    const record = asRecord(event);
    if (record?.type !== "message_end") return;
    const found = messageUsage(record.message);
    if (!found) return;
    addUsage(handle.usage, found.usage);
    handle.cost += found.cost;
    if (found.model) handle.model = found.model;
    this.#io(() =>
      appendWalRow(this.#deps.walFile, {
        v: 1,
        project: this.#deps.projectRoot,
        scope: "phase",
        scope_id: handle.id,
        spec: handle.context.spec,
        task: handle.context.task,
        phase: handle.context.phase,
        ts: this.#now().toISOString(),
        usage: found.usage,
        cost_total: found.cost,
        model: found.model,
      }),
    );
  }

  /**
   * Consolidate the phase into the ledger and drop its raw rows. When the
   * process is killed before this point the raw rows stay in the buffer, so
   * the consumption is never lost — only the consolidated row is missing.
   */
  finishPhase(handle: PhaseHandle): void {
    const { context } = handle;
    const row: PhaseLedgerRow = {
      v: 1,
      kind: "phase",
      ts: this.#now().toISOString(),
      spec: context.spec,
      task: context.task,
      phase: context.phase,
      attempt: context.attempt,
      role: context.role,
      model: handle.model,
      duration_ms: this.#now().getTime() - handle.startedAtMs,
      usage: handle.usage,
      cost_total: handle.cost,
    };
    this.#io(() => appendLedgerRow(this.#deps.ledgerFile, row));
    this.#io(() => pruneWalRows(this.#deps.walFile, (raw) => raw.scope_id !== handle.id));
  }

  #io(fn: () => void): void {
    if (this.#broken) return;
    try {
      fn();
    } catch (err) {
      this.#broken = true;
      const reason = err instanceof Error ? err.message : String(err);
      this.#deps.onNotify?.(`measurement disabled: ${reason}`, "warning");
    }
  }
}
