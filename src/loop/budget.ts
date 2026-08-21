/**
 * Run budget: the hard ceilings of a whole run. The per-phase timeout only
 * bounds a single subprocess, and the retry counters multiply with each other
 * (a review budget spent inside every attempt), so a phase that keeps failing
 * the same way costs the product of the two rather than a known maximum.
 * These ceilings are absolute: crossing one ends the run, whatever the
 * continue-on-failure setting says.
 */

import { formatElapsed } from "../util/process.ts";

export interface BudgetLimits {
  /** Agent subprocesses a single task may spend, across all its phases. */
  maxSpawnsPerTask: number;
  /** Agent subprocesses the whole run may spend. */
  maxSpawnsPerRun: number;
  /** Wall-clock limit of the whole run. */
  maxRunDurationMs: number;
}

export type BudgetScope = "task" | "run" | "duration";

/** Raised when a ceiling is crossed; the engine turns it into a halt. */
export class BudgetExceededError extends Error {
  readonly scope: BudgetScope;

  constructor(scope: BudgetScope, message: string) {
    super(message);
    this.name = "BudgetExceededError";
    this.scope = scope;
  }
}

export interface BudgetSnapshot {
  runSpawns: number;
  taskSpawns: number;
  elapsedMs: number;
}

export class LoopBudget {
  #limits: BudgetLimits;
  readonly #now: () => number;
  readonly #startedAt: number;
  #runSpawns = 0;
  #taskSpawns = 0;
  #taskId: string | null = null;

  constructor(limits: BudgetLimits, now: () => number = () => Date.now()) {
    this.#limits = limits;
    this.#now = now;
    this.#startedAt = now();
  }

  /**
   * Re-apply the ceilings after a mid-run configuration reload. Counters and
   * the start timestamp carry over: only the limits change, never what the
   * run already spent.
   */
  reconfigure(limits: BudgetLimits): void {
    this.#limits = limits;
  }

  /** Open the per-task allowance; the run-level counters keep accumulating. */
  startTask(taskId: string): void {
    this.#taskId = taskId;
    this.#taskSpawns = 0;
  }

  /**
   * Account for one agent subprocess, before it starts. Throws when a ceiling
   * is crossed: every phase goes through the same choke point, so no spawn
   * path can escape the budget by forgetting to ask.
   */
  consume(): void {
    const elapsed = this.#now() - this.#startedAt;
    if (elapsed >= this.#limits.maxRunDurationMs) {
      throw new BudgetExceededError(
        "duration",
        `run budget exhausted: ${formatElapsed(elapsed)} elapsed, limit ${formatElapsed(this.#limits.maxRunDurationMs)}`,
      );
    }
    if (this.#runSpawns >= this.#limits.maxSpawnsPerRun) {
      throw new BudgetExceededError(
        "run",
        `run budget exhausted: ${this.#runSpawns} agent sessions, limit ${this.#limits.maxSpawnsPerRun}`,
      );
    }
    if (this.#taskSpawns >= this.#limits.maxSpawnsPerTask) {
      const task = this.#taskId ?? "the current task";
      throw new BudgetExceededError(
        "task",
        `task budget exhausted for ${task}: ${this.#taskSpawns} agent sessions, limit ${this.#limits.maxSpawnsPerTask}`,
      );
    }
    this.#runSpawns++;
    this.#taskSpawns++;
  }

  snapshot(): BudgetSnapshot {
    return {
      runSpawns: this.#runSpawns,
      taskSpawns: this.#taskSpawns,
      elapsedMs: this.#now() - this.#startedAt,
    };
  }
}
