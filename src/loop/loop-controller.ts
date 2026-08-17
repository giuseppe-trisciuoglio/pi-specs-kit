/**
 * Loop controller: the session state shared between the slash commands (and,
 * later, the LLM tools). Owns the lazily loaded config and the single active
 * loop engine, forwarding engine events to injected callbacks so the callers
 * stay free of engine wiring. Only one loop may be active at a time.
 */

import path from "node:path";
import type { PiStreamEvent } from "../agent/json-stream.ts";
import { formatStreamEvent, toLogLines } from "../agent/stream-format.ts";
import { updateActiveSpec } from "../config/config-writer.ts";
import { loadSpecsKitConfig, type SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { RefreshOutcome } from "../fixplan/fix-plan.ts";
import { refreshFixPlan } from "../fixplan/refresh.ts";
import { trackedArtifactsWarning, trackedLoopArtifacts } from "./artifact-hygiene.ts";
import { LoopEngine, type LoopEndReason, type LoopStartOptions } from "./engine.ts";
import { idleStatus, type LoopStatus } from "./loop-status.ts";
import { findGraphifySkill, graphifyMissingWarning } from "../prompt/graphify.ts";
import {
  configuredModels,
  findMissingModels,
  listModels,
  modelListUnavailableWarning,
  unknownModelsError,
  type ListedModel,
} from "./model-check.ts";
import { discoverSpecs, type SpecInfo } from "./spec-discovery.ts";

export interface ControllerEvents {
  /** Human-readable engine notifications to surface to the operator. */
  onNotify?(message: string, type: "info" | "warning" | "error"): void;
  /** Fired on every persisted state change or stream line, for the widget. */
  onUpdate?(status: LoopStatus): void;
  /** Fired once when the loop terminates, with its end reason. */
  onFinished?(reason: LoopEndReason, error?: string): void;
  /** Fired after a new active spec is persisted, for measurement attribution. */
  onActiveSpecChanged?(specDir: string): void;
}

/**
 * Injectable collaborators with safe real defaults, so unit tests can pin a
 * deterministic environment without touching the live filesystem.
 */
export interface ControllerDeps {
  /** Locates the graphify skill; defaults to the shared-directory lookup. */
  findGraphifySkill?: typeof findGraphifySkill;
  /** Queries the agent CLI model catalogue; defaults to `pi --list-models`. */
  listModels?: () => Promise<ListedModel[]>;
  /** Lists the loop's own artifacts git already tracks; defaults to the real check. */
  trackedLoopArtifacts?: (projectRoot: string, specDir: string) => Promise<string[]>;
}

/** Ring buffer capacity of log lines shown in the widget. */
const LOG_LINES_MAX = 10;

export class LoopController {
  #config: SpecsKitConfig | null = null;
  #engine: LoopEngine | null = null;
  readonly #events: ControllerEvents;
  /**
   * Events of the phase currently running, kept so a transcript opened late
   * can replay it from the start. Cleared when the next phase begins: a phase
   * is one agent session, and the transcript shows one session at a time.
   * Not capped — the peak is a single session, which the agent CLI itself
   * holds in memory when the same run happens interactively.
   */
  #phaseEvents: PiStreamEvent[] = [];
  readonly #streamListeners = new Set<(event: PiStreamEvent) => void>();
  readonly #phaseStartListeners = new Set<() => void>();
  #logLines: string[] = [];
  readonly #logLineListeners = new Set<(line: string) => void>();
  readonly #findGraphifySkill: typeof findGraphifySkill;
  readonly #listModels: () => Promise<ListedModel[]>;
  readonly #trackedLoopArtifacts: (projectRoot: string, specDir: string) => Promise<string[]>;

  constructor(events: ControllerEvents = {}, deps: ControllerDeps = {}) {
    this.#events = events;
    this.#findGraphifySkill = deps.findGraphifySkill ?? findGraphifySkill;
    this.#listModels = deps.listModels ?? listModels;
    this.#trackedLoopArtifacts =
      deps.trackedLoopArtifacts ?? ((root, spec) => trackedLoopArtifacts(root, spec));
  }

  /** Load the yaml config of a project root into memory. */
  async loadConfig(projectRoot: string): Promise<SpecsKitConfig> {
    this.#config = await loadSpecsKitConfig(projectRoot);
    return this.#config;
  }

  get config(): SpecsKitConfig | null {
    return this.#config;
  }

  /**
   * Persist the active spec and reload the config in one step. Callers must
   * go through here rather than calling updateActiveSpec directly: the cached
   * config is what every later command reads, so a write without the reload
   * leaves the rest of the session pointing at the previous spec.
   */
  async setActiveSpec(specDir: string): Promise<SpecsKitConfig> {
    const config = this.#requireConfig();
    await updateActiveSpec(config.configPath, specDir);
    const reloaded = await this.loadConfig(config.projectRoot);
    this.#safely(() => this.#events.onActiveSpecChanged?.(specDir));
    return reloaded;
  }

  get engine(): LoopEngine | null {
    return this.#engine;
  }

  isRunning(): boolean {
    return this.#engine?.running ?? false;
  }

  /**
   * Start the loop in the background. Resolves with the first persisted
   * status snapshot (range and task counts already filled); the terminal
   * outcome arrives later through the onFinished callback. A second start
   * while running is a gentle error, not an exception with a stack trace.
   */
  async start(opts: LoopStartOptions): Promise<LoopStatus> {
    const config = this.#requireConfig();
    if (this.isRunning()) throw new Error("a loop is already running");

    // graphify builds the codebase graph the sync phase projects onto the
    // spec's Knowledge Graph; warn up front when it is missing so the
    // operator can install it before that projection degrades. Surfaced as a
    // warning, not a blocker: the loop still runs, only the Knowledge Graph
    // becomes unavailable.
    if (!(await this.#findGraphifySkill())) {
      this.#safely(() => this.#events.onNotify?.(graphifyMissingWarning(), "warning"));
    }

    // A mistyped model id is only discovered at spawn time, once per attempt.
    // Check the configured models against the CLI catalogue before the run: a
    // model the CLI does not know is a certainty, so refusing to start is
    // cheaper than spending the run budget on it. When the catalogue cannot
    // be read the check is skipped with a warning — uncertainty does not
    // block the operator, the same choice made for a missing graphify. With
    // every role on "auto" there is nothing to validate and the CLI is not
    // even queried.
    const configured = configuredModels(config);
    if (configured.length > 0) {
      const listed = await this.#listModels();
      if (listed.length === 0) {
        this.#safely(() => this.#events.onNotify?.(modelListUnavailableWarning(), "warning"));
      } else {
        const missing = findMissingModels(configured, listed);
        if (missing.length > 0) {
          throw new Error(unknownModelsError(missing));
        }
      }
    }

    // What the loop generates is meant to stay out of the history it produces.
    // Tracked artifacts cannot be excluded after the fact, so they are named
    // now, while the operator can still ignore them.
    const tracked = await this.#trackedLoopArtifacts(
      config.projectRoot,
      path.resolve(config.projectRoot, opts.specDir),
    );
    if (tracked.length > 0) {
      this.#safely(() => this.#events.onNotify?.(trackedArtifactsWarning(tracked), "warning"));
    }

    let markStarted: () => void = () => {};
    let failStart: (err: Error) => void = () => {};
    const started = new Promise<void>((resolve, reject) => {
      markStarted = resolve;
      failStart = reject;
    });
    let settled = false;

    const engine = new LoopEngine({ config }, {
      onNotify: (message, type) => this.#safely(() => this.#events.onNotify?.(message, type)),
      onStateChange: () => {
        if (!settled) {
          settled = true;
          markStarted();
        }
        this.#safely(() => this.#events.onUpdate?.(engine.status()));
      },
      onStream: (event) => {
        this.#phaseEvents.push(event);
        for (const listener of this.#streamListeners) this.#safely(() => listener(event));
        const formatted = formatStreamEvent(event);
        if (formatted) for (const line of toLogLines(formatted)) this.#pushLogLine(line);
        this.#safely(() => this.#events.onUpdate?.(engine.status()));
      },
      onPhaseStart: () => {
        // Listeners are told first, while the events of the phase that just
        // ended are still readable, and the buffer is dropped after.
        for (const listener of this.#phaseStartListeners) this.#safely(() => listener());
        this.#phaseEvents = [];
      },
      onLogLine: (line) => {
        this.#pushLogLine(line);
        for (const listener of this.#logLineListeners) this.#safely(() => listener(line));
      },
    });
    this.#engine = engine;

    void engine
      .start(opts)
      .then((result) => {
        if (!settled) {
          // The loop ended before the first persisted state: surface an early
          // failure to the caller instead of hanging the start command.
          settled = true;
          if (result.error) failStart(new Error(result.error));
          else markStarted();
        }
        this.#safely(() => this.#events.onFinished?.(result.reason, result.error));
      })
      .catch((err: unknown) => {
        // engine.start never rejects, but a detached chain must not be able to
        // produce an unhandled rejection — nor leave `await started` hanging.
        if (!settled) {
          settled = true;
          failStart(err instanceof Error ? err : new Error(String(err)));
        }
      });

    await started;
    return engine.status();
  }

  /** Delegate a stop request to the engine; returns false when idle. */
  stop(now = false): boolean {
    if (!this.#engine?.running) return false;
    this.#engine.stop(now);
    return true;
  }

  /**
   * Subscribe to session events as they arrive. Replay what the phase already
   * produced with getPhaseEvents(); the returned function unsubscribes.
   */
  subscribeStream(listener: (event: PiStreamEvent) => void): () => void {
    this.#streamListeners.add(listener);
    return () => {
      this.#streamListeners.delete(listener);
    };
  }

  /** Subscribe to phase boundaries, where the event history is dropped. */
  subscribePhaseStart(listener: () => void): () => void {
    this.#phaseStartListeners.add(listener);
    return () => {
      this.#phaseStartListeners.delete(listener);
    };
  }

  /** Subscribe to log lines emitted by hooks and the agent stream. */
  subscribeLogLines(listener: (line: string) => void): () => void {
    this.#logLineListeners.add(listener);
    return () => {
      this.#logLineListeners.delete(listener);
    };
  }

  /** Events of the phase currently running, oldest first. */
  getPhaseEvents(): PiStreamEvent[] {
    return [...this.#phaseEvents];
  }

  #pushLogLine(line: string): void {
    this.#logLines.push(line);
    if (this.#logLines.length > LOG_LINES_MAX) {
      this.#logLines.splice(0, this.#logLines.length - LOG_LINES_MAX);
    }
  }

  /**
   * Run a UI callback without letting it reach the engine: these are purely
   * presentational (widget, notifications) and a throwing TUI must not abort
   * an otherwise healthy loop.
   */
  #safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[specs-kit] UI callback failed: ${message}\n`);
    }
  }

  /**
   * Reconcile the fix plan of a spec with its task files on disk. Refused
   * while a loop is running: the refresh is a read-modify-write of the same
   * file the engine rewrites at every state transition, so the next
   * transition would overwrite it and the reported update would be lost.
   */
  async refreshFixPlan(specDir: string): Promise<RefreshOutcome> {
    const config = this.#requireConfig();
    if (this.isRunning()) {
      throw new Error("a loop is running: stop it before refreshing the fix plan");
    }
    const absolute = path.resolve(config.projectRoot, specDir);
    return refreshFixPlan(absolute, path.relative(config.projectRoot, absolute));
  }

  /** Current status: the engine snapshot, or an idle one when never started. */
  status(): LoopStatus {
    const base = this.#engine?.status() ?? idleStatus();
    return { ...base, logLines: [...this.#logLines] };
  }

  /**
   * Spec directories under the specs root: every direct child directory,
   * flagged with whether it already has tasks, as paths relative to the
   * project root. Shared by the loop picker (tasks required) and the
   * authoring commands (any authoring state).
   */
  async listSpecs(): Promise<SpecInfo[]> {
    const config = this.#requireConfig();
    return discoverSpecs(config.projectRoot, config.specsDir);
  }

  #requireConfig(): SpecsKitConfig {
    if (!this.#config) throw new Error("config not loaded: call loadConfig first");
    return this.#config;
  }
}
