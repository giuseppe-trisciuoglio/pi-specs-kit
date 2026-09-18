/**
 * Run budget: the ceilings of a whole run. The per-phase timeout only bounds a
 * single subprocess, and the retry counters multiply with each other (a review
 * budget spent inside every attempt), so a phase that keeps failing the same
 * way costs the product of the two rather than a known maximum.
 *
 * The spawn ceilings are absolute: crossing one ends the run, whatever the
 * continue-on-failure setting says. The wall clock has two levels instead,
 * because a run that takes longer than expected is usually ordinary work and
 * not a runaway: the soft ceiling only warns and lets the run carry on, and
 * only the hard one — far above it — ends the run.
 */

import { formatElapsed } from "../util/process.ts";

/**
 * How many times the soft ceiling the hard one sits at when the configuration
 * does not name it. Far enough that a run merely slower than planned reaches
 * the end of its range, close enough that a run stuck in a loop still stops on
 * its own instead of burning a night of tokens.
 */
export const HARD_RUN_DURATION_MULTIPLE = 3;

export interface BudgetLimits {
  /** Agent subprocesses a single task may spend, across all its phases. */
  maxSpawnsPerTask: number;
  /** Agent subprocesses the whole run may spend. */
  maxSpawnsPerRun: number;
  /** Wall-clock the run is expected to fit in: crossing it warns, once. */
  maxRunDurationMs: number;
  /**
   * Wall-clock the run may never cross: it halts there. Null means the
   * configuration left it out and the default multiple of the soft ceiling
   * applies.
   */
  maxRunDurationHardMs: number | null;
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

/**
 * The wall clock that actually halts. An unset hard ceiling is the multiple of
 * the soft one; a hard ceiling configured below the soft one would make the
 * warning unreachable, so the soft value wins and the two coincide.
 */
export function hardRunDurationMs(softMs: number, hardMs: number | null): number {
  if (hardMs === null) return softMs * HARD_RUN_DURATION_MULTIPLE;
  return Math.max(hardMs, softMs);
}

export interface BudgetDeps {
  now?: () => number;
  /** Where the one soft-ceiling warning goes; absent means nobody is listening. */
  notify?: (message: string, type: "info" | "warning" | "error") => void;
}

export class LoopBudget {
  #limits: BudgetLimits;
  readonly #now: () => number;
  readonly #notify: (message: string, type: "info" | "warning" | "error") => void;
  readonly #startedAt: number;
  #runSpawns = 0;
  #taskSpawns = 0;
  #taskId: string | null = null;
  /** The soft ceiling already warned about; a new value earns a new warning. */
  #softWarnedFor: number | null = null;

  constructor(limits: BudgetLimits, deps: BudgetDeps | (() => number) = {}) {
    const resolved = typeof deps === "function" ? { now: deps } : deps;
    this.#limits = limits;
    this.#now = resolved.now ?? (() => Date.now());
    this.#notify = resolved.notify ?? (() => {});
    this.#startedAt = this.#now();
  }

  /**
   * Re-apply the ceilings after a mid-run configuration reload. Counters and
   * the start timestamp carry over: only the limits change, never what the run
   * already spent. Moving the soft ceiling arms the warning again: an operator
   * who raised it after the first one wants to hear about the new one too.
   */
  reconfigure(limits: BudgetLimits): void {
    if (limits.maxRunDurationMs !== this.#limits.maxRunDurationMs) this.#softWarnedFor = null;
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
   *
   * The failure learner is the one exception, and it asks for it explicitly:
   * it runs because the task's own allowance ran out, so charging it to that
   * allowance would make the phase that explains the exhaustion impossible to
   * run. It stays charged to the run and duration ceilings, which are the ones
   * that bound the whole run.
   */
  consume(opts: { offTaskBudget?: boolean } = {}): void {
    const elapsed = this.#now() - this.#startedAt;
    const hard = hardRunDurationMs(this.#limits.maxRunDurationMs, this.#limits.maxRunDurationHardMs);
    if (elapsed >= hard) {
      throw new BudgetExceededError(
        "duration",
        `run budget exhausted: ${formatElapsed(elapsed)} elapsed, hard limit ${formatElapsed(hard)}`,
      );
    }
    if (elapsed >= this.#limits.maxRunDurationMs && this.#softWarnedFor !== this.#limits.maxRunDurationMs) {
      this.#softWarnedFor = this.#limits.maxRunDurationMs;
      this.#notify(
        `[specs-kit] run past its expected duration: ${formatElapsed(elapsed)} elapsed, ` +
          `expected ${formatElapsed(this.#limits.maxRunDurationMs)}; continuing until ${formatElapsed(hard)}`,
        "warning",
      );
    }
    if (this.#runSpawns >= this.#limits.maxSpawnsPerRun) {
      throw new BudgetExceededError(
        "run",
        `run budget exhausted: ${this.#runSpawns} agent sessions, limit ${this.#limits.maxSpawnsPerRun}`,
      );
    }
    if (!opts.offTaskBudget && this.#taskSpawns >= this.#limits.maxSpawnsPerTask) {
      const task = this.#taskId ?? "the current task";
      throw new BudgetExceededError(
        "task",
        `task budget exhausted for ${task}: ${this.#taskSpawns} agent sessions, limit ${this.#limits.maxSpawnsPerTask}`,
      );
    }
    this.#runSpawns++;
    if (!opts.offTaskBudget) this.#taskSpawns++;
  }

  snapshot(): BudgetSnapshot {
    return {
      runSpawns: this.#runSpawns,
      taskSpawns: this.#taskSpawns,
      elapsedMs: this.#now() - this.#startedAt,
    };
  }
}
