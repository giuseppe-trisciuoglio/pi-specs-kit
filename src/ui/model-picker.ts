/**
 * List building for the dialog based model picker, the fallback used where no
 * terminal is available to draw the interactive selector on. A selection
 * dialog has no type-ahead and the catalogue can hold hundreds of entries, so
 * the list is capped and narrowed through an explicit filter term. This module
 * is pure: the view only renders what it returns and collects the answers.
 */

import { AUTO, filterModels, modelValue, orderModels, type ModelEntry } from "./model-list.ts";

export { AUTO, type ModelEntry };

/** Keep the current value untouched. */
export const KEEP = "(keep)";
/** Ask again with a different filter term. */
export const CLEAR_FILTER = "Clear filter";

/** How many models are listed at once before the list is truncated. */
export const MODEL_LIMIT = 8;

export function filterEntry(query: string): string {
  return query === "" ? "Filter models…" : `Filter: ${query} (edit)`;
}

export function moreEntry(hidden: number): string {
  return `Show ${hidden} more…`;
}

export interface ModelPickListOptions {
  /** Current filter term; empty means no filtering. */
  query?: string;
  /** Model configured for the role, listed first when it matches. */
  current?: string;
  /** Max models listed; ignored when `showAll` is set. */
  limit?: number;
  /** List every match, no truncation. */
  showAll?: boolean;
}

export interface ModelPickList {
  /** Entries to hand to the selection dialog, in order. */
  options: string[];
  /** Resolves a listed entry back to its "provider/id" value. */
  values: Map<string, string>;
  /** Models matching the current filter, before truncation. */
  matchCount: number;
  /** Matches left out by the truncation. */
  hiddenCount: number;
}

/** Build the entries of one round of the model picker. */
export function buildModelPickList(
  models: readonly ModelEntry[],
  opts: ModelPickListOptions = {},
): ModelPickList {
  const query = opts.query ?? "";
  const limit = opts.showAll ? Number.POSITIVE_INFINITY : (opts.limit ?? MODEL_LIMIT);

  const matches = filterModels(models, query);
  const ordered = orderModels(matches, opts.current);
  const shown = ordered.slice(0, limit);
  const hiddenCount = ordered.length - shown.length;

  const options = [KEEP, AUTO, filterEntry(query)];
  if (query !== "") options.push(CLEAR_FILTER);

  const values = new Map<string, string>();
  for (const model of shown) {
    const value = modelValue(model);
    const label = value === opts.current ? `${value} (current)` : value;
    options.push(label);
    values.set(label, value);
  }
  if (hiddenCount > 0) options.push(moreEntry(hiddenCount));

  return { options, values, matchCount: matches.length, hiddenCount };
}
