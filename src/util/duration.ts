/**
 * Parse a human duration string ("100ms", "240s", "60m", "2h") into
 * milliseconds. Returns undefined for unparseable input so callers can fall
 * back to their default.
 *
 * A bare number, in the config file too, is milliseconds: `timeout: 3600` is
 * 3.6 seconds, not one hour. Always write the unit in the yaml ("1h", "3600s")
 * — a unitless value that looks like seconds kills every phase subprocess
 * almost immediately.
 */
export function parseDurationMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const factor = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return Math.round(amount * factor);
}

/**
 * Render milliseconds back to the shortest duration string parseDurationMs
 * accepts, so round-tripping through the config file stays lossless.
 */
export function formatDurationMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
