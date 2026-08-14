/**
 * The status snapshot the engine exposes to the UI, and the mutable tracker
 * that keeps it in sync with the persisted plan. It lives apart from the
 * engine so the widget, the commands and the controller can describe an idle
 * session without instantiating a loop.
 */

import type { FixPlan, LoopStep, RangeProgress } from "../fixplan/fix-plan.ts";

export interface LoopStatus {
  running: boolean;
  stopping: "graceful" | "now" | null;
  specDir: string | null;
  specId: string | null;
  step: LoopStep | null;
  currentTask: string | null;
  retryCount: number;
  doneInRange: number;
  totalInRange: number;
  percent: number;
  error: string | null;
  logPath: string | null;
  lastStreamLine: string | null;
  /** Recent log lines from hooks and agent streams, newest first. */
  logLines: string[];
  startedAt: number | null;
}

/** Snapshot for a session where no loop ever started. */
export function idleStatus(): LoopStatus {
  return {
    running: false,
    stopping: null,
    specDir: null,
    specId: null,
    step: null,
    currentTask: null,
    retryCount: 0,
    doneInRange: 0,
    totalInRange: 0,
    percent: 0,
    error: null,
    logPath: null,
    lastStreamLine: null,
    logLines: [],
    startedAt: null,
  };
}

/** Mutable view the engine writes to as the run progresses. */
export class LoopStatusTracker {
  running = false;
  stopping: "graceful" | "now" | null = null;
  specDir: string | null = null;
  specId: string | null = null;
  step: LoopStep | null = null;
  currentTask: string | null = null;
  retryCount = 0;
  progress: RangeProgress = { done_in_range: 0, percent: 0, total_in_range: 0 };
  error: string | null = null;
  logPath: string | null = null;
  lastStreamLine: string | null = null;
  /** Ring buffer of recent log lines from hooks and agent streams. */
  logLines: string[] = [];
  startedAt: number | null = null;

  /** Reset the per-run fields; the spec and the last progress survive. */
  beginRun(now: number): void {
    this.running = true;
    this.stopping = null;
    this.startedAt = now;
    this.error = null;
    this.logPath = null;
    this.lastStreamLine = null;
    this.logLines = [];
  }

  endRun(): void {
    this.running = false;
    this.stopping = null;
  }

  /** Mirror the fields of a plan that was just persisted. */
  applyPlan(plan: FixPlan): void {
    this.step = plan.state.step;
    this.currentTask = plan.state.current_task;
    this.retryCount = plan.state.retry_count;
    this.progress = { ...plan.range_progress };
  }

  snapshot(): LoopStatus {
    return {
      running: this.running,
      stopping: this.stopping,
      specDir: this.specDir,
      specId: this.specId,
      step: this.step,
      currentTask: this.currentTask,
      retryCount: this.retryCount,
      doneInRange: this.progress.done_in_range,
      totalInRange: this.progress.total_in_range,
      percent: this.progress.percent,
      error: this.error,
      logPath: this.logPath,
      lastStreamLine: this.lastStreamLine,
      logLines: [...this.logLines],
      startedAt: this.startedAt,
    };
  }
}
