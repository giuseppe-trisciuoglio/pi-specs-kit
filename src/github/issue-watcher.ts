/**
 * Polls the project's GitHub issues for the ready label and starts the loop on
 * the spec the issue points at. Polling rather than a webhook: both designs
 * need a process alive on this machine, and polling needs no endpoint, no
 * tunnel and no repository-level webhook — only the `gh` the operator already
 * uses.
 *
 * The label itself is the anti-double-start mechanism: an issue that has been
 * picked up no longer carries the ready label, so a second poll cannot see it
 * again. An issue nobody can resolve is skipped for the rest of the session
 * instead of being commented on at every poll.
 *
 * Every collaborator is injected, so the tests drive the whole lifecycle
 * without a network, a clock, or a loop engine.
 */

import type { GhIssue } from "./gh-cli.ts";
import { resolveIssueRequest, type IssueRunRequest } from "./issue-spec.ts";

export interface WatcherLabels {
  ready: string;
  running: string;
  done: string;
  failed: string;
}

/**
 * Values re-read before every poll, so an edit to the configuration file
 * reaches the watcher the same way it reaches the loop's phases.
 */
export interface WatcherSettings {
  labels: WatcherLabels;
  pollIntervalMs: number;
  commentOnFinish: boolean;
  /** Specs root of the project, relative to its root. */
  specsDir: string;
}

/** How a run the watcher started ended, in the engine's own vocabulary. */
export type WatchedRunOutcome = "completed" | "stopped" | "aborted";

export interface IssueWatcherDeps {
  settings(): WatcherSettings;
  listReady(label: string): Promise<GhIssue[]>;
  ensureLabels(labels: string[]): Promise<void>;
  editLabels(issue: number, add: string[], remove: string[]): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
  /** Spec directories that exist and already have tasks to run. */
  runnableSpecs(): Promise<string[]>;
  /** True while any loop of this session is running, ours or not. */
  isRunning(): boolean;
  startLoop(request: IssueRunRequest): Promise<void>;
  notify(message: string, type: "info" | "warning" | "error"): void;
  /** Delay between polls; injectable so tests never wait on a real clock. */
  wait(ms: number): Promise<void>;
}

export class IssueWatcher {
  readonly #deps: IssueWatcherDeps;
  #watching = false;
  #stopped = false;
  /** Issue whose run is in flight; null when the watcher started nothing. */
  #active: number | null = null;
  /** Issues that cannot be acted on: commented once, then left alone. */
  readonly #skipped = new Set<number>();
  /** Last poll error already reported, so a broken gh warns once, not forever. */
  #lastPollError: string | null = null;

  constructor(deps: IssueWatcherDeps) {
    this.#deps = deps;
  }

  get watching(): boolean {
    return this.#watching;
  }

  /** Issue number of the run the watcher started, when one is in flight. */
  get activeIssue(): number | null {
    return this.#active;
  }

  /**
   * Begin polling in the background. Returns false when already watching: a
   * second watcher would race the first one onto the same issue.
   */
  start(): boolean {
    if (this.#watching) return false;
    this.#watching = true;
    this.#stopped = false;
    void this.#loop();
    return true;
  }

  /** Stop polling. The run already started, if any, is left alone. */
  stop(): boolean {
    if (!this.#watching) return false;
    this.#stopped = true;
    this.#watching = false;
    return true;
  }

  async #loop(): Promise<void> {
    const labels = this.#deps.settings().labels;
    // Best-effort: a repository where the labels cannot be created still works
    // as soon as somebody applies an existing one.
    try {
      await this.#deps.ensureLabels([labels.ready, labels.running, labels.done, labels.failed]);
    } catch {
      // Nothing to repair here; the poll below reports any real problem.
    }
    while (!this.#stopped) {
      await this.pollOnce();
      if (this.#stopped) break;
      await this.#deps.wait(this.#deps.settings().pollIntervalMs);
    }
  }

  /**
   * One pass over the ready issues. Starts at most one run, and starts nothing
   * while a loop is already running: one loop per session holds whether the
   * run was asked for by an issue or by a command.
   */
  async pollOnce(): Promise<void> {
    if (this.#active !== null || this.#deps.isRunning()) return;
    const settings = this.#deps.settings();

    let issues: GhIssue[];
    try {
      issues = await this.#deps.listReady(settings.labels.ready);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.#lastPollError) {
        this.#lastPollError = message;
        this.#deps.notify(`[specs-kit] cannot read the ready issues: ${message}`, "warning");
      }
      return;
    }
    this.#lastPollError = null;

    const issue = issues.find((candidate) => !this.#skipped.has(candidate.number));
    if (!issue) return;

    const request = await this.#requestOf(issue, settings);
    if (!request) return;

    await this.#pickUp(issue, request, settings);
  }

  /**
   * What the issue is asking to run, or nothing when it cannot be honored. An
   * unusable issue keeps its label — the operator's intent is still on record
   * — and is reported once, on the issue and to the session.
   */
  async #requestOf(issue: GhIssue, settings: WatcherSettings): Promise<IssueRunRequest | null> {
    const resolved = resolveIssueRequest(issue.body, settings.specsDir);
    if (!resolved.ok) return await this.#skip(issue, resolved.detail);

    const specDir = resolved.request.specDir;
    const runnable = await this.#deps.runnableSpecs();
    if (!runnable.includes(specDir)) {
      return await this.#skip(issue, `\`${specDir}\` is not a spec with tasks to run in this project`);
    }
    return resolved.request;
  }

  /**
   * Awaited on purpose: the poll is not done with an issue until the reason it
   * was skipped is on the issue itself, where the operator will look.
   */
  async #skip(issue: GhIssue, detail: string): Promise<null> {
    this.#skipped.add(issue.number);
    this.#deps.notify(`[specs-kit] issue #${issue.number} skipped: ${detail}`, "warning");
    await this.#say(
      issue.number,
      `[specs-kit] This issue was not started: ${detail}.\n\n` +
        "The label was left in place; fix the issue body and restart the watcher with " +
        "`/specs-kit-watch` to try again.",
    );
    return null;
  }

  /** Swap the labels, then start the run the issue asked for. */
  async #pickUp(issue: GhIssue, request: IssueRunRequest, settings: WatcherSettings): Promise<void> {
    const labels = settings.labels;
    try {
      await this.#deps.editLabels(issue.number, [labels.running], [labels.ready]);
    } catch (err) {
      // The label swap is what keeps the next poll from starting this issue a
      // second time, so a failure here is a reason not to start at all.
      const message = err instanceof Error ? err.message : String(err);
      await this.#skip(issue, `the labels could not be updated (${message})`);
      return;
    }

    this.#active = issue.number;
    try {
      await this.#deps.startLoop(request);
      this.#deps.notify(
        `[specs-kit] Loop started from issue #${issue.number} on ${request.specDir}.`,
        "info",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#active = null;
      this.#skipped.add(issue.number);
      this.#deps.notify(`[specs-kit] issue #${issue.number} could not start: ${message}`, "error");
      await this.#settle(issue.number, labels.failed, labels.running, `[specs-kit] The loop could not start: ${message}`, settings);
    }
  }

  /**
   * Record how the run started from an issue ended. Called by the session that
   * owns the engine, since the watcher does not listen to the loop itself.
   */
  async noteFinished(outcome: WatchedRunOutcome, summary: string): Promise<void> {
    const issue = this.#active;
    if (issue === null) return;
    this.#active = null;
    const settings = this.#deps.settings();
    const label = outcome === "completed" ? settings.labels.done : settings.labels.failed;
    await this.#settle(issue, label, settings.labels.running, summary, settings);
  }

  async #settle(
    issue: number,
    add: string,
    remove: string,
    summary: string,
    settings: WatcherSettings,
  ): Promise<void> {
    try {
      await this.#deps.editLabels(issue, [add], [remove]);
      if (settings.commentOnFinish) await this.#deps.comment(issue, summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#deps.notify(`[specs-kit] issue #${issue} not updated: ${message}`, "warning");
    }
  }

  /** Post a comment without letting a GitHub failure reach the caller. */
  async #say(issue: number, body: string): Promise<void> {
    try {
      await this.#deps.comment(issue, body);
    } catch {
      // The notification already told the operator; a lost comment is not
      // worth failing a poll over.
    }
  }
}
