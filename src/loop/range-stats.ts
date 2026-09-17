/**
 * Loop KPI summary printed when a range closes: the same figures
 * `/specs-kit-stats` reads, so a run ends with its own numbers and there is
 * nothing to go back to the ledger for. Best-effort, like every ledger read:
 * a missing or unreadable ledger yields no summary rather than a failed close.
 */

import { readFile } from "node:fs/promises";
import type { SpecsKitConfig } from "../config/specs-kit-config.ts";
import { computeSpecStats, formatSpecStats, parseLedgerRows } from "../measure/ledger-stats.ts";
import { ledgerPath } from "../measure/ledger.ts";

export async function rangeStatsSummary(config: SpecsKitConfig, specId: string): Promise<string | null> {
  try {
    const raw = await readFile(ledgerPath(config.projectRoot, config.specsDir), "utf8");
    const stats = computeSpecStats(parseLedgerRows(raw), specId);
    return stats.totalPhaseRows > 0 ? formatSpecStats(stats) : null;
  } catch {
    return null;
  }
}
