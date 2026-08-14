/**
 * Authoring window tracking: the interactive-session tokens spent creating a
 * spec. A window opens with an authoring command and closes at the next
 * specs-kit command or when the session ends. Raw rows go to the write-ahead
 * buffer; the consolidated row reaches the ledger when the window closes with
 * an active spec to attribute it to. The window that authors the very first
 * spec has nothing to be attributed to while it runs, so its raw rows wait in
 * the buffer and are consolidated retroactively when the spec becomes active.
 *
 * Like the phase meter, all I/O is best-effort and goes silent after the
 * first failure.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendLedgerRow, type AuthoringLedgerRow, type UsageSummary, zeroUsage } from "./ledger.ts";
import { addUsage, messageUsage } from "./usage.ts";
import { appendWalRow, pruneWalRows, readWalRows, type WalRow } from "./wal.ts";

export interface AuthoringWindowDeps {
  /** Where consolidated rows land; null while no config is loaded. */
  ledgerFile: () => string | null;
  walFile: string;
  /** Project root, stamped on the write-ahead rows; null without a config. */
  projectRoot: () => string | null;
  /** Active spec directory relative to the project root; null when none. */
  activeSpec: () => string | null;
  onNotify?: (message: string, type: "info" | "warning" | "error") => void;
  now?: () => Date;
  newId?: () => string;
}

interface OpenWindow {
  id: string;
  startedAt: Date;
  usage: UsageSummary;
  cost: number;
  messages: number;
}

export class AuthoringWindowTracker {
  readonly #deps: AuthoringWindowDeps;
  readonly #now: () => Date;
  readonly #newId: () => string;
  #window: OpenWindow | null = null;
  #broken = false;

  constructor(deps: AuthoringWindowDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? (() => randomUUID());
  }

  isOpen(): boolean {
    return this.#window !== null;
  }

  /** Open a new window; one already open is closed first. */
  begin(): void {
    this.close();
    this.#window = { id: this.#newId(), startedAt: this.#now(), usage: zeroUsage(), cost: 0, messages: 0 };
  }

  /**
   * Close the current window. With an active spec the consolidated row goes
   * to the ledger and the raw rows are pruned; without one the raw rows stay
   * in the buffer until attributePending picks them up.
   */
  close(): void {
    const window = this.#window;
    this.#window = null;
    // A window that consumed nothing (a command opened and immediately
    // superseded) is not worth a ledger row.
    if (!window || window.messages === 0) return;
    const specDir = this.#deps.activeSpec();
    if (!specDir) return;
    const ledgerFile = this.#deps.ledgerFile();
    if (!ledgerFile) return;
    const now = this.#now();
    this.#appendRow(ledgerFile, {
      v: 1,
      kind: "authoring",
      ts: now.toISOString(),
      spec: path.basename(specDir),
      started_at: window.startedAt.toISOString(),
      duration_ms: now.getTime() - window.startedAt.getTime(),
      usage: window.usage,
      cost_total: window.cost,
    });
    this.#io(() => pruneWalRows(this.#deps.walFile, (row) => row.scope_id !== window.id));
  }

  /** Account for one interactive-session message; assistant usage only. */
  recordMessage(message: unknown): void {
    const window = this.#window;
    if (!window) return;
    const found = messageUsage(message);
    if (!found) return;
    addUsage(window.usage, found.usage);
    window.cost += found.cost;
    window.messages++;
    const project = this.#deps.projectRoot();
    if (!project) return;
    this.#io(() =>
      appendWalRow(this.#deps.walFile, {
        v: 1,
        project,
        scope: "window",
        scope_id: window.id,
        spec: null,
        ts: this.#now().toISOString(),
        started_at: window.startedAt.toISOString(),
        usage: found.usage,
        cost_total: found.cost,
        model: found.model,
      }),
    );
  }

  /**
   * Consolidate the raw rows of windows that closed before their spec existed
   * (or never closed, from a killed session), one ledger row per window. The
   * window currently open is excluded: it is attributed when it closes.
   */
  attributePending(specDir: string): void {
    const project = this.#deps.projectRoot();
    const ledgerFile = this.#deps.ledgerFile();
    if (!project || !ledgerFile) return;
    const openId = this.#window?.id ?? null;
    const pending = readWalRows(this.#deps.walFile).filter(
      (row) => row.scope === "window" && row.spec === null && row.project === project && row.scope_id !== openId,
    );
    const byWindow = new Map<string, WalRow[]>();
    for (const row of pending) {
      const group = byWindow.get(row.scope_id);
      if (group) group.push(row);
      else byWindow.set(row.scope_id, [row]);
    }
    if (byWindow.size === 0) return;
    const spec = path.basename(specDir);
    const pruned = new Set<string>();
    for (const [scopeId, rows] of byWindow) {
      const usage = zeroUsage();
      let cost = 0;
      let startedAt = rows[0].started_at ?? rows[0].ts;
      let lastTs = rows[0].ts;
      for (const row of rows) {
        addUsage(usage, row.usage);
        cost += row.cost_total;
        if (row.started_at && row.started_at < startedAt) startedAt = row.started_at;
        if (row.ts > lastTs) lastTs = row.ts;
      }
      // The close time of a window from a killed session is unknown; the last
      // recorded activity is the best approximation left on disk.
      const duration = Date.parse(lastTs) - Date.parse(startedAt);
      this.#appendRow(ledgerFile, {
        v: 1,
        kind: "authoring",
        ts: this.#now().toISOString(),
        spec,
        started_at: startedAt,
        duration_ms: Number.isFinite(duration) && duration >= 0 ? duration : 0,
        usage,
        cost_total: cost,
      });
      pruned.add(scopeId);
    }
    this.#io(() => pruneWalRows(this.#deps.walFile, (row) => !pruned.has(row.scope_id)));
  }

  #appendRow(ledgerFile: string, row: AuthoringLedgerRow): void {
    this.#io(() => appendLedgerRow(ledgerFile, row));
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
