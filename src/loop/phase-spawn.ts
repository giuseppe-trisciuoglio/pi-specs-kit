/**
 * Phase spawn execution: the agent subprocess, its log file and the learner
 * and hook subroutines. Everything that talks to the agent CLI lives here;
 * the prompt handed to it is built elsewhere and passed in already assembled.
 */

import path from "node:path";
import type { PiStreamEvent } from "../agent/json-stream.ts";
import { assistantText, formatStreamEvent } from "../agent/stream-format.ts";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../agent/spawner.ts";
import type { RoleName, SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { TaskFile } from "../tasks/task-parser.ts";
import type { PhaseHandle, PhaseMeter } from "../measure/phase-meter.ts";
import { PhaseLogWriter } from "../util/log-writer.ts";
import type { LoopBudget } from "./budget.ts";
import type { HookResult } from "./hooks.ts";
import { parseLearnings } from "./learner.ts";
import type { SystemPromptOverrideText } from "./phase-context.ts";

export interface LearnerResult {
  outcome: PhaseRunOutcome;
  /** Concatenated assistant text emitted during the run. */
  text: string;
}

/** A phase subprocess outcome counts as failed on any of these conditions. */
export function spawnFailed(outcome: PhaseRunOutcome | null): boolean {
  if (!outcome) return true;
  return outcome.exitCode !== 0 || outcome.timedOut || outcome.aborted || outcome.stopReason === "error";
}

/**
 * Compact prompt for the learner role: task id/title plus the request for a
 * bullet list of reusable learnings. Deliberately not built with the phase
 * prompt builder, which targets the four executable phases.
 */
export function buildLearnerPrompt(task: TaskFile): string {
  const fm = task.frontmatter;
  return (
    [
      `The task ${fm.id} "${fm.title}" has just been implemented and approved by review.`,
      "Write the reusable learnings from this task as a bullet list, one insight per line",
      'starting with "-": pitfalls encountered, project conventions worth remembering,',
      "anything that would help future tasks. Output only the bullet list.",
    ].join("\n") + "\n"
  );
}

export interface PhaseSpawnerDeps {
  config: SpecsKitConfig;
  /** Absolute path of the active spec directory. */
  specDir: string;
  /** Run ceilings, charged once per agent subprocess. */
  budget: LoopBudget;
  spawnPhase: (opts: PhaseSpawnOptions) => Promise<PhaseRunOutcome>;
  onNotify: (message: string, type: "info" | "warning" | "error") => void;
  /** Forwarded for every stream event, with its formatted log line. */
  onStream: (event: PiStreamEvent, formatted: string | null) => void;
  /** Called with the log file path of each spawned phase. */
  onLogPath: (logPath: string) => void;
  /** Called once per phase subprocess, before it starts. */
  onPhaseStart: () => void;
  /** Called with a formatted log line from hooks or the agent stream. */
  onLogLine: (line: string) => void;
  /** Phase measurement; absent in tests that do not care about the ledger. */
  meter?: PhaseMeter;
  warnAutoModel: (role: RoleName) => void;
  beginMeter: (spec: string, task: string, phase: string, attempt: number, role: RoleName) => PhaseHandle | null;
}

/** Spawns agent subprocesses and runs the learner and hook subroutines. */
export class PhaseSpawner {
  readonly #deps: PhaseSpawnerDeps;

  constructor(deps: PhaseSpawnerDeps) {
    this.#deps = deps;
  }

  async spawn(
    taskId: string,
    label: string,
    role: RoleName,
    prompt: string,
    systemPromptOverride: SystemPromptOverrideText | undefined,
    signal: AbortSignal | undefined,
    captureText: boolean,
    meterHandle: PhaseHandle | null = null,
  ): Promise<LearnerResult> {
    const { config } = this.#deps;
    // Every phase reaches the agent through here, so charging the budget at
    // this single point is what makes the ceilings inescapable. It throws
    // before the log file is opened: a refused spawn leaves nothing behind.
    this.#deps.budget.consume();
    const writer = new PhaseLogWriter(this.#deps.specDir, taskId, label, {
      noLogFiles: config.run.noLogFiles,
      onFailure: (message) => this.#deps.onNotify(message, "warning"),
    });
    this.#deps.onLogPath(writer.path);
    this.#deps.onPhaseStart();
    if (config.run.showPrompt) writer.writeLine(`$ prompt\n${prompt}`);
    let text = "";
    const roleConfig = config.roles[role];
    if (!roleConfig.model || roleConfig.model === "auto") this.#deps.warnAutoModel(role);
    try {
      const outcome = await this.#deps.spawnPhase({
        prompt,
        model: roleConfig.model,
        thinkingLevel: roleConfig.thinkingLevel,
        appendSystemPrompt: systemPromptOverride?.mode === "append" ? systemPromptOverride.content : undefined,
        systemPrompt: systemPromptOverride?.mode === "replace" ? systemPromptOverride.content : undefined,
        cwd: config.projectRoot,
        timeoutMs: config.run.timeoutMs,
        signal,
        onEvent: (event) => {
          if (meterHandle) this.#deps.meter?.recordEvent(meterHandle, event);
          // The learner's answer is read off the completed message: over the
          // wire the deltas carry no cumulative snapshot to read it from.
          if (captureText && event.type === "message_end") text += assistantText(event.message);
          const formatted = formatStreamEvent(event);
          writer.writeStream(formatted);
          this.#deps.onStream(event, formatted);
        },
        onStderrLine: (line) => writer.writeLine(`! stderr: ${line}`),
      });
      return { outcome, text };
    } finally {
      await writer.close();
    }
  }

  /** Run the learner role and capture its textual output. */
  async runLearner(task: TaskFile, opts: { signal?: AbortSignal } = {}): Promise<LearnerResult> {
    const spec = path.basename(this.#deps.specDir);
    const meterHandle = this.#deps.beginMeter(spec, task.frontmatter.id, "learner", 1, "learner");
    try {
      return await this.spawn(task.frontmatter.id, "learner", "learner", buildLearnerPrompt(task), undefined, opts.signal, true, meterHandle);
    } finally {
      if (meterHandle) this.#deps.meter?.finishPhase(meterHandle);
    }
  }

  /**
   * Spawn the learner to compact the project-level learnings: deduplicate,
   * merge related entries, and drop outdated insights. Returns the cleaned list.
   */
  async compactLearnings(learnings: string[], opts: { signal?: AbortSignal } = {}): Promise<string[]> {
    const prompt = [
      "Review the following accumulated project learnings. Clean up the list:",
      "- Remove entries that are outdated or no longer relevant.",
      "- Merge entries that say the same thing in different ways.",
      "- Keep only actionable, reusable insights — drop trivia.",
      "- Output only the cleaned bullet list, one insight per line starting with \"-\".",
      "",
      learnings.map((l) => `- ${l}`).join("\n"),
    ].join("\n");
    const meterHandle = this.#deps.beginMeter(path.basename(this.#deps.specDir), "learnings", "compact", 1, "learner");
    try {
      const { text } = await this.spawn(
        "learnings",
        "compact",
        "learner",
        prompt,
        undefined,
        opts.signal,
        true,
        meterHandle,
      );
      return parseLearnings(text);
    } finally {
      if (meterHandle) this.#deps.meter?.finishPhase(meterHandle);
    }
  }

  /** Run a hook command and stream its output through the log channel. */
  async runHook(
    command: string,
    label: string,
    opts: { cwd: string; timeoutMs: number; signal?: AbortSignal } = { cwd: ".", timeoutMs: 30_000 },
  ): Promise<HookResult> {
    const { runHook: runHookImpl } = await import("../loop/hooks.ts");
    return runHookImpl(command, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      stream: {
        onStdoutLine: (line) => this.#deps.onLogLine(`[${label}] ${line}`),
        onStderrLine: (line) => this.#deps.onLogLine(`[${label}] ! ${line}`),
      },
    });
  }
}
