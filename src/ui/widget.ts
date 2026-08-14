/**
 * Live status widget: shown above the editor while a loop runs. First line
 * carries spec, task, phase, attempt and progress; subsequent lines show the
 * most recent log lines from hooks and the agent stream, truncated to fit.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { LoopStatus } from "../loop/engine.ts";

/** Status snapshot enriched with the configured retry ceiling. */
export interface WidgetStatus extends LoopStatus {
  maxAttempts: number;
}

/** Widget key used with setWidget. */
export const WIDGET_KEY = "specs-kit";

/** Maximum number of log lines shown in the widget body. */
const LOG_LINES_MAX = 5;

/** Widget lines are ASCII-only; length equals visibleWidth. Fall back to 80. */
function terminalWidth(): number {
  return process.stdout.columns ?? 80;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Elapsed time since the loop start, as mm:ss (minutes keep growing). */
function elapsed(startedAt: number | null, now: Date): string {
  if (startedAt === null) return "00:00";
  const seconds = Math.max(0, Math.floor((now.getTime() - startedAt) / 1000));
  return `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
}

function truncate(line: string, width: number): string {
  if (line.length <= width) return line;
  return `${line.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Widget lines for a status snapshot: the progress line, plus up to
 * LOG_LINES_MAX recent log lines (hook output and agent stream), each
 * truncated to fit the available width.
 */
export function formatWidgetLines(status: WidgetStatus, now: Date = new Date()): string[] {
  const spec = status.specId ?? "?";
  const task = status.currentTask ?? "—";
  const step = status.step ?? "—";
  const attempt = status.retryCount + 1;
  const head =
    `● ${spec} — ${task} · ${step} · attempt ${attempt}/${status.maxAttempts}` +
    ` · done ${status.doneInRange}/${status.totalInRange} (${status.percent}%) · ${elapsed(status.startedAt, now)}`;
  const width = terminalWidth();
  const truncatedHead = truncate(head, width);
  const logLines = status.logLines.map((line) => truncate(line, width));
  return logLines.length > 0 ? [truncatedHead, ...logLines.slice(-LOG_LINES_MAX)] : [truncatedHead];
}

/** Mirror the loop status into the widget; hides it when the loop is idle. */
export function updateLoopWidget(ui: Pick<ExtensionUIContext, "setWidget">, status: WidgetStatus, hasUI: boolean): void {
  if (!hasUI) return;
  ui.setWidget(WIDGET_KEY, status.running ? formatWidgetLines(status) : undefined);
}
