/**
 * Model list model shared by the two pickers: what a catalogue entry is, how a
 * query narrows it, how the entries are ordered and which slice of them is on
 * screen. Pure by design — the selectors only render what these functions
 * decide, so the whole geometry stays testable without a terminal.
 */

export interface ModelEntry {
  provider: string;
  id: string;
  /** Display name from the catalogue, when it carries one. */
  name?: string;
  /** Whether the model reasons, i.e. whether a thinking level means anything. */
  reasoning?: boolean;
  contextWindow?: number;
}

/** Leave the model choice to the agent CLI. */
export const AUTO = "auto";

/** How many models the interactive selector keeps on screen at once. */
export const VISIBLE_MODELS = 10;

/** Configured value of a model, in the form the agent CLI expects. */
export function modelValue(model: ModelEntry): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Text a query is matched against. The provider leads so that a
 * provider-prefixed query ranks the direct entry above the ids that carry a
 * second provider inside them, the way proxy catalogues list them.
 */
export function modelSearchText(model: ModelEntry): string {
  return `${model.provider} ${modelValue(model)} ${model.id}${model.name ? ` ${model.name}` : ""}`;
}

/**
 * Keep the models matching every whitespace-separated term of the query.
 * Matching is case-insensitive over the search text, so both "sonnet" and
 * "anthropic sonnet" narrow the list as an operator would expect.
 */
export function filterModels(models: readonly ModelEntry[], query: string): ModelEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
  if (terms.length === 0) return [...models];
  return models.filter((model) => {
    const haystack = modelSearchText(model).toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * Configured model first, then grouped by provider: it is the entry an
 * operator looks for when opening the picker just to check what is set.
 */
export function orderModels(models: readonly ModelEntry[], current?: string): ModelEntry[] {
  return [...models].sort((a, b) => {
    const aCurrent = modelValue(a) === current;
    const bCurrent = modelValue(b) === current;
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
  });
}

export interface ListWindow {
  start: number;
  end: number;
}

/**
 * Slice of the list around the highlighted row. The selection sits in the
 * middle while there is room on both sides, so the rows scroll under a stable
 * cursor instead of the cursor jumping to an edge.
 */
export function listWindow(selectedIndex: number, total: number, maxVisible = VISIBLE_MODELS): ListWindow {
  if (total <= maxVisible) return { start: 0, end: total };
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
  return { start, end: Math.min(start + maxVisible, total) };
}

/** Position of the highlighted row, shown only when the list is truncated. */
export function counterText(selectedIndex: number, total: number): string {
  return `(${Math.min(selectedIndex + 1, total)}/${total})`;
}

function contextLabel(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k context` : `${tokens} context`;
}

/**
 * Detail line for the highlighted model. Thinking support is spelled out
 * because model and thinking level are configured together for a role, and a
 * level set on a model that does not reason is a silent no-op.
 */
export function modelDetail(model: ModelEntry): string {
  const parts = [model.name ?? model.id];
  if (model.contextWindow) parts.push(contextLabel(model.contextWindow));
  if (model.reasoning !== undefined) parts.push(model.reasoning ? "thinking supported" : "no thinking");
  return parts.join(" · ");
}
