/**
 * The checks that run when a range closes, after the last task and the final
 * sync: the ones the loop can perform itself, on facts the agents declared
 * about their own work.
 *
 * Both look at claims that were never re-derived — a coverage matrix citing
 * tests, and review findings handed to a later task — because a claim nobody
 * checks is indistinguishable from a claim that is true. Programmatic and
 * always run, including in the fast mode where the agentic sync happens once
 * per range: they cost no model call, so there is nothing to save by skipping
 * them. Best-effort: a check that cannot read what it needs yields no warning.
 */

import type { FixPlan } from "../fixplan/fix-plan.ts";
import { openRoutedSuggestions, openRoutedWarning } from "./routed-suggestions.ts";
import { checkTraceabilityMatrix, traceabilityWarning } from "./traceability-check.ts";

export interface RangeCloseDeps {
  projectRoot: string;
  /** Absolute path of the active spec directory. */
  specDir: string;
  /** Injectable for tests; absent means the real check. */
  checkTraceability?: typeof checkTraceabilityMatrix;
  openRouted?: typeof openRoutedSuggestions;
}

/**
 * Warnings to surface when the range closes, in the order the operator should
 * read them. Never throws: a failing check is a check that found nothing.
 */
export async function rangeCloseWarnings(plan: FixPlan, deps: RangeCloseDeps): Promise<string[]> {
  const warnings: string[] = [];
  const checkTraceability = deps.checkTraceability ?? checkTraceabilityMatrix;
  const openRouted = deps.openRouted ?? openRoutedSuggestions;

  try {
    const warning = traceabilityWarning(await checkTraceability(deps.projectRoot, deps.specDir));
    if (warning) warnings.push(warning);
  } catch {
    // A check that cannot run must not turn a completed range into a failure.
  }
  try {
    const warning = openRoutedWarning(await openRouted(deps.specDir, plan));
    if (warning) warnings.push(warning);
  } catch {
    // Same rule: advisory checks never gate the close.
  }
  return warnings;
}
