/**
 * Phase execution helpers shared by the loop engine: skill resolution,
 * prompt assembly, system prompt overrides, subprocess spawning with log
 * capture and learner output capture. The engine owns the state machine;
 * everything that talks to the agent subprocess lives here.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PHASE_ROLE, type PhaseName, type RoleName, type SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { FixPlan } from "../fixplan/fix-plan.ts";
import type { TaskFile } from "../tasks/task-parser.ts";
import type { PiStreamEvent } from "../agent/json-stream.ts";
import { assistantText, formatStreamEvent } from "../agent/stream-format.ts";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../agent/spawner.ts";
import type { PhaseHandle, PhaseMeter } from "../measure/phase-meter.ts";
import { PhaseLogWriter } from "../util/log-writer.ts";
import { buildPhasePrompt } from "../prompt/prompt-builder.ts";
import { resolvePhaseSkill, type ResolvedSkill } from "../prompt/skill-resolver.ts";
import type { LoopBudget } from "./budget.ts";
import type { HookResult } from "./hooks.ts";
import { runPhaseHooks } from "./hooks.ts";
import { loadProjectLearnings, parseLearnings } from "./learner.ts";
import type { RoutedSuggestion } from "./review-report.ts";

export interface PhaseExecutorDeps {
  config: SpecsKitConfig;
  /** Absolute path of the active spec directory. */
  specDir: string;
  /** Run ceilings, charged once per agent subprocess. */
  budget: LoopBudget;
  spawnPhase: (opts: PhaseSpawnOptions) => Promise<PhaseRunOutcome>;
  runHooks: typeof runPhaseHooks;
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
}

export interface PhaseStepResult {
  /** False when a pre hook failed: the phase subprocess never started. */
  preHooksOk: boolean;
  hookResults: HookResult[];
  outcome: PhaseRunOutcome | null;
}

/** A resolved system prompt override: its text plus how to apply it. */
export interface SystemPromptOverrideText {
  mode: "append" | "replace";
  content: string;
}

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

/**
 * Executes the single phases of the loop on behalf of the engine: hooks,
 * prompt, subprocess and per-phase log file. Skills are resolved once per
 * phase (a missing one warns only the first time).
 */
export class PhaseExecutor {
  readonly #deps: PhaseExecutorDeps;
  readonly #skills = new Map<PhaseName, ResolvedSkill | null>();
  readonly #autoModelWarned = new Set<RoleName>();

  constructor(deps: PhaseExecutorDeps) {
    this.#deps = deps;
  }

  async #skill(phase: PhaseName): Promise<ResolvedSkill | null> {
    if (!this.#skills.has(phase)) {
      const skill = await resolvePhaseSkill(phase);
      if (!skill) {
        this.#deps.onNotify(`skill for phase ${phase} not found: prompt without a skill block`, "warning");
      }
      this.#skills.set(phase, skill);
    }
    return this.#skills.get(phase) ?? null;
  }

  /**
   * Applies the configured policy to an override that cannot be honored
   * (unreadable file, missing file/text value): loud by default, downgraded
   * to a warning when the operator asked for "skip". Never silent.
   */
  #unusableOverride(phase: PhaseName, detail: string): undefined {
    if (this.#deps.config.prompts.unsupportedPolicy === "error") {
      throw new Error(`system prompt override for phase ${phase}: ${detail}`);
    }
    this.#deps.onNotify(`system prompt override for phase ${phase} ignored: ${detail}`, "warning");
    return undefined;
  }

  /**
   * System prompt override for a phase, resolved from its configured source
   * (inline text or a file relative to the project root). All four
   * mode/source combinations of the schema are supported; the mode decides
   * whether the text replaces the agent system prompt or is appended to it.
   */
  async #systemPromptOverride(phase: PhaseName): Promise<SystemPromptOverrideText | undefined> {
    const { config } = this.#deps;
    const override = config.prompts.phaseOverrides[phase];
    if (!override) return undefined;
    if (override.source === "text") {
      if (!override.text) return this.#unusableOverride(phase, 'source "text" without a "text" value');
      return { mode: override.mode, content: override.text };
    }
    if (!override.file) return this.#unusableOverride(phase, 'source "file" without a "file" value');
    const file = path.resolve(config.projectRoot, override.file);
    try {
      return { mode: override.mode, content: await readFile(file, "utf8") };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return this.#unusableOverride(phase, `cannot read ${file} (${reason})`);
    }
  }

  /**
   * Warn once per role about the "auto" model: in ephemeral mode the agent CLI
   * gets no --model flag and falls back to the last model used interactively,
   * which is rarely what the operator expects from an unattended loop.
   */
  #warnAutoModel(role: RoleName): void {
    if (this.#autoModelWarned.has(role)) return;
    this.#autoModelWarned.add(role);
    this.#deps.onNotify(
      `role ${role} has model "auto": the agent CLI picks the last model used interactively, ` +
        `set agents.${role}_model to pin it`,
      "warning",
    );
  }

  /**
   * Open a measurement handle for a phase about to run. The configured model
   * is only a fallback: the meter prefers the model observed on the stream.
   */
  #beginMeter(spec: string, task: string, phase: string, attempt: number, role: RoleName): PhaseHandle | null {
    const meter = this.#deps.meter;
    if (!meter) return null;
    const configured = this.#deps.config.roles[role].model;
    return meter.beginPhase({
      spec,
      task,
      phase,
      attempt,
      role,
      model: configured && configured !== "auto" ? configured : null,
    });
  }

  async #spawn(
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
    if (!roleConfig.model || roleConfig.model === "auto") this.#warnAutoModel(role);
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

  /**
   * Run one of the four executable phases: pre hooks, prompt build, spawn,
   * post hooks. A failed pre hook blocks the phase (the engine counts the
   * attempt); a failed post hook is only a warning.
   */
  async run(
    phase: PhaseName,
    task: TaskFile,
    plan: FixPlan,
    opts: {
      reviewFeedback?: string | null;
      reviewFormatError?: string | null;
      signal?: AbortSignal;
      /** Public API contracts from completed dependency tasks. */
      upstreamProvides?: string[];
      /** Fixes reviewers routed to this task from earlier completed tasks. */
      routedSuggestions?: RoutedSuggestion[];
      /**
       * When false, a failing pre-hook does not block the phase: its output
       * is included in the prompt so the agent can see what is wrong and try
       * to fix it. Defaults to true (pre-hook failures block the phase).
       */
      blockOnPreHookFailure?: boolean;
    } = {},
  ): Promise<PhaseStepResult> {
    const { config } = this.#deps;
    const role = PHASE_ROLE[phase];
    const blockOnFailure = opts.blockOnPreHookFailure !== false;
    // The handle spans hooks and subprocess alike: the phase duration in the
    // ledger is the whole step, not just the agent session.
    const meterHandle = this.#beginMeter(plan.spec_id, task.frontmatter.id, phase, plan.state.retry_count + 1, role);
    try {
      const preResults = await this.#deps.runHooks(config.hooks, phase, "pre", config.projectRoot, {
        onStdoutLine: (line) => this.#deps.onLogLine(`[pre-${phase}] ${line}`),
        onStderrLine: (line) => this.#deps.onLogLine(`[pre-${phase}] ! ${line}`),
      });
      if (preResults.some((r) => !r.ok) && blockOnFailure) {
        return { preHooksOk: false, hookResults: preResults, outcome: null };
      }
      const [skill, systemPromptOverride] = await Promise.all([this.#skill(phase), this.#systemPromptOverride(phase)]);

      // Project-level learnings accumulated across specs.
      let projectLearnings: string[] | undefined;
      try {
        const loaded = await loadProjectLearnings(config.projectRoot, config.specsDir);
        if (loaded.length > 0) projectLearnings = loaded;
      } catch {
        // Project learnings are optional.
      }

      const prompt = buildPhasePrompt({
        config,
        specDir: this.#deps.specDir,
        phase,
        task,
        learnings: plan.learnings,
        skill,
        preHookResults: preResults,
        reviewFeedback: opts.reviewFeedback ?? null,
        reviewFormatError: opts.reviewFormatError ?? null,
        upstreamProvides: opts.upstreamProvides,
        routedSuggestions: opts.routedSuggestions,
        projectLearnings,
      });
      const { outcome } = await this.#spawn(
        task.frontmatter.id,
        phase,
        role,
        prompt,
        systemPromptOverride,
        opts.signal,
        false,
        meterHandle,
      );
      const postResults = await this.#deps.runHooks(config.hooks, phase, "post", config.projectRoot, {
        onStdoutLine: (line) => this.#deps.onLogLine(`[post-${phase}] ${line}`),
        onStderrLine: (line) => this.#deps.onLogLine(`[post-${phase}] ! ${line}`),
      });
      const failedPost = postResults.find((r) => !r.ok);
      if (failedPost) this.#deps.onNotify(`post-${phase} hook failed: ${failedPost.command}`, "warning");
      return { preHooksOk: true, hookResults: [...preResults, ...postResults], outcome };
    } finally {
      if (meterHandle) this.#deps.meter?.finishPhase(meterHandle);
    }
  }

  /** Run the learner role and capture its textual output. */
  async runLearner(task: TaskFile, opts: { signal?: AbortSignal } = {}): Promise<LearnerResult> {
    const spec = path.basename(this.#deps.specDir);
    const meterHandle = this.#beginMeter(spec, task.frontmatter.id, "learner", 1, "learner");
    try {
      return await this.#spawn(task.frontmatter.id, "learner", "learner", buildLearnerPrompt(task), undefined, opts.signal, true, meterHandle);
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
    const meterHandle = this.#beginMeter(path.basename(this.#deps.specDir), "learnings", "compact", 1, "learner");
    try {
      const { text } = await this.#spawn(
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
