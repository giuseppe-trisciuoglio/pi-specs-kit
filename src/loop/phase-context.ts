/**
 * Phase prompt context: skill resolution, system prompt overrides and the
 * assembled prompt for the four executable phases. The executor delegates the
 * construction of what the agent subprocess reads to this helper, so the
 * prompt never has to be built where the spawn is performed.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PhaseName, RoleName, SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { PhaseHandle, PhaseMeter } from "../measure/phase-meter.ts";
import { inlinesSpecDocs, loadSpecDocs, type ContextFileSet } from "../prompt/context-files.ts";
import { buildPhasePrompt } from "../prompt/prompt-builder.ts";
import { resolvePhaseSkill, type ResolvedSkill } from "../prompt/skill-resolver.ts";
import { loadProjectLearnings } from "./learner.ts";
import type { HookResult } from "./hooks.ts";
import type {
  CleanupPhaseInput,
  ImplementationPhaseInput,
  ReviewPhaseInput,
  SyncPhaseInput,
} from "./phase-inputs.ts";

/** A resolved system prompt override: its text plus how to apply it. */
export interface SystemPromptOverrideText {
  mode: "append" | "replace";
  content: string;
}

export type PhaseInput = ImplementationPhaseInput | ReviewPhaseInput | CleanupPhaseInput | SyncPhaseInput;

export interface PhaseContextDeps {
  config: SpecsKitConfig;
  /** Absolute path of the active spec directory. */
  specDir: string;
  onNotify: (message: string, type: "info" | "warning" | "error") => void;
  /** Phase measurement; absent in tests that do not care about the ledger. */
  meter?: PhaseMeter;
}

export interface BuiltPrompt {
  prompt: string;
  systemPromptOverride: SystemPromptOverrideText | undefined;
}

/** Resolves and caches the prompt ingredients for a phase. */
export class PhaseContext {
  readonly #deps: PhaseContextDeps;
  readonly #skills = new Map<PhaseName, ResolvedSkill | null>();
  readonly #autoModelWarned = new Set<RoleName>();

  constructor(deps: PhaseContextDeps) {
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
  warnAutoModel(role: RoleName): void {
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
  beginMeter(spec: string, task: string, phase: string, attempt: number, role: RoleName): PhaseHandle | null {
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

  /**
   * Assemble the prompt for one executable phase from its declared ingress.
   * Channels a phase cannot declare keep the value the wide signature
   * defaulted them to: no feedback, no format error, no contracts, no routed
   * fixes.
   */
  async buildPrompt(phase: PhaseName, input: PhaseInput, preResults: HookResult[]): Promise<BuiltPrompt> {
    const { config } = this.#deps;
    const [skill, systemPromptOverride] = await Promise.all([this.#skill(phase), this.#systemPromptOverride(phase)]);

    // Project-level learnings accumulated across specs.
    let projectLearnings: string[] | undefined;
    try {
      const loaded = await loadProjectLearnings(config.projectRoot, config.specsDir);
      if (loaded.length > 0) projectLearnings = loaded;
    } catch {
      // Project learnings are optional.
    }

    // Review and sync read the spec folder; handing them the documents costs
    // one prompt instead of one turn per file. Best-effort like the learnings:
    // an unreadable folder leaves the phase to discover it the old way.
    let contextFiles: ContextFileSet | undefined;
    if (inlinesSpecDocs(phase)) {
      try {
        contextFiles = await loadSpecDocs(this.#deps.specDir);
      } catch {
        contextFiles = undefined;
      }
    }

    const prompt = buildPhasePrompt({
      config,
      specDir: this.#deps.specDir,
      phase,
      task: input.task,
      learnings: input.learnings,
      skill,
      preHookResults: preResults,
      reviewFeedback: "reviewFeedback" in input ? input.reviewFeedback : null,
      postHookFailures: "postHookFailures" in input ? input.postHookFailures : undefined,
      reviewFormatError: "reviewFormatError" in input ? input.reviewFormatError : null,
      priorAttemptArchives: "priorAttemptArchives" in input ? input.priorAttemptArchives : undefined,
      upstreamProvides: "upstreamProvides" in input ? input.upstreamProvides : undefined,
      routedSuggestions: "routedSuggestions" in input ? input.routedSuggestions : undefined,
      projectLearnings,
      contextFiles,
    });
    return { prompt, systemPromptOverride };
  }
}
