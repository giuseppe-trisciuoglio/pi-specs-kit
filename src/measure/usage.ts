/**
 * Defensive extraction of token usage from assistant messages on the wire.
 * The stream is serialized session traffic, so the shape is read field by
 * field rather than through SDK types: a message without usage (fake agents,
 * providers that do not report it) simply contributes nothing.
 */

import type { UsageSummary } from "./ledger.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface MessageUsage {
  usage: UsageSummary;
  cost: number;
  /** "provider/model" when both are reported, else the bare model id. */
  model: string | null;
}

/**
 * Usage of a completed assistant message, or null for user/tool messages and
 * messages that carry no usage at all.
 */
export function messageUsage(message: unknown): MessageUsage | null {
  const record = asRecord(message);
  if (!record || record.role !== "assistant") return null;
  const usage = asRecord(record.usage);
  if (!usage) return null;
  const cost = asRecord(usage.cost);
  const provider = typeof record.provider === "string" ? record.provider : null;
  const modelId = typeof record.model === "string" ? record.model : null;
  return {
    usage: {
      input: num(usage.input),
      output: num(usage.output),
      cache_read: num(usage.cacheRead),
      cache_write: num(usage.cacheWrite),
      total: num(usage.totalTokens),
    },
    cost: num(cost?.total),
    model: provider && modelId ? `${provider}/${modelId}` : modelId,
  };
}

export function addUsage(sum: UsageSummary, usage: UsageSummary): void {
  sum.input += usage.input;
  sum.output += usage.output;
  sum.cache_read += usage.cache_read;
  sum.cache_write += usage.cache_write;
  sum.total += usage.total;
}
