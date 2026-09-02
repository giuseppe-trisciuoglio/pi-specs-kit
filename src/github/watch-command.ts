/**
 * The `/specs-kit-watch` surface: wires the issue watcher to the session's
 * controller and to the `gh` CLI. Kept out of the extension factory so the
 * factory stays a list of registrations, and built lazily at the first command
 * so nothing reaches GitHub at load time.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LoopEndReason } from "../loop/engine.ts";
import type { LoopController } from "../loop/loop-controller.ts";
import { createGhClient } from "./gh-cli.ts";
import { IssueWatcher, type WatcherSettings } from "./issue-watcher.ts";
import { report } from "../ui/report.ts";

export interface IssueWatchService {
  handle(args: string, ctx: ExtensionCommandContext): Promise<void>;
  /** Report the end of a run to the issue that asked for it, when there is one. */
  noteFinished(reason: LoopEndReason, error?: string): void;
  stop(): void;
}

/** Outcome comment posted on the issue when the run it asked for ends. */
function summarize(controller: LoopController, reason: LoopEndReason, error?: string): string {
  const status = controller.status();
  const spec = status.specId ?? status.specDir ?? "the spec";
  const progress = `${status.doneInRange}/${status.totalInRange} tasks`;
  if (reason === "completed") {
    return `[specs-kit] Loop completed on \`${spec}\` — ${progress}.`;
  }
  const ending = reason === "stopped" ? "stopped on request" : "halted";
  const detail = error ?? status.error;
  return `[specs-kit] Loop ${ending} on \`${spec}\` — ${progress}.${detail ? `\n\n${detail}` : ""}`;
}

export function createIssueWatchService(
  controller: LoopController,
  notify: (message: string, type: "info" | "warning" | "error") => void,
): IssueWatchService {
  let watcher: IssueWatcher | null = null;

  const settings = (): WatcherSettings => {
    const config = controller.config;
    if (!config) throw new Error("config not loaded");
    const github = config.github;
    return {
      labels: {
        ready: github.readyLabel,
        running: github.runningLabel,
        done: github.doneLabel,
        failed: github.failedLabel,
      },
      pollIntervalMs: github.pollIntervalMs,
      commentOnFinish: github.commentOnFinish,
      specsDir: config.specsDir,
    };
  };

  const build = (projectRoot: string): IssueWatcher => {
    const gh = createGhClient(projectRoot);
    return new IssueWatcher({
      settings,
      listReady: (label) => gh.listOpenIssuesByLabel(label),
      ensureLabels: (labels) => gh.ensureLabels(labels),
      editLabels: (issue, add, remove) => gh.editLabels(issue, add, remove),
      comment: (issue, body) => gh.comment(issue, body),
      runnableSpecs: async () =>
        (await controller.listSpecs()).filter((spec) => spec.hasTasks).map((spec) => spec.dir),
      isRunning: () => controller.isRunning(),
      startLoop: async (request) => {
        await controller.start(request);
      },
      notify,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  };

  return {
    async handle(args, ctx) {
      const tokens = args.split(/\s+/).filter(Boolean);
      const config = controller.config ?? (await controller.loadConfig(ctx.cwd));

      if (tokens.includes("--stop")) {
        report(ctx, watcher?.stop() ? "[specs-kit] Issue watcher stopped." : "[specs-kit] No issue watcher running.");
        return;
      }

      if (tokens.includes("--status")) {
        if (!watcher?.watching) {
          report(ctx, "[specs-kit] Issue watcher: idle.");
          return;
        }
        const active = watcher.activeIssue;
        report(
          ctx,
          `[specs-kit] Issue watcher: watching \`${config.github.readyLabel}\`` +
            ` every ${Math.round(config.github.pollIntervalMs / 1000)}s` +
            `${active === null ? "" : ` · running issue #${active}`}`,
        );
        return;
      }

      // gh is an external dependency of this feature alone: a project without
      // it keeps every other command working, so a failed probe reports and
      // returns instead of throwing.
      const probe = await createGhClient(config.projectRoot).probe();
      if (!probe.ok) {
        report(ctx, `[specs-kit] Issue watching unavailable: ${probe.reason}.`);
        return;
      }

      watcher ??= build(config.projectRoot);

      if (tokens.includes("--once")) {
        await watcher.pollOnce();
        report(ctx, "[specs-kit] Ready issues checked once.");
        return;
      }

      if (!watcher.start()) {
        report(ctx, "[specs-kit] Issue watcher already running; stop it with /specs-kit-watch --stop.");
        return;
      }
      report(
        ctx,
        `[specs-kit] Watching issues labeled \`${config.github.readyLabel}\`` +
          ` every ${Math.round(config.github.pollIntervalMs / 1000)}s.`,
      );
    },

    noteFinished(reason, error) {
      if (!watcher || watcher.activeIssue === null) return;
      void watcher.noteFinished(
        reason === "completed" ? "completed" : reason === "stopped" ? "stopped" : "aborted",
        summarize(controller, reason, error),
      );
    },

    stop() {
      watcher?.stop();
    },
  };
}

export function registerWatchCommand(
  pi: ExtensionAPI,
  service: IssueWatchService,
  onInvoke?: (ctx: ExtensionCommandContext) => void,
): void {
  pi.registerCommand("specs-kit-watch", {
    description: "Watch GitHub issues and start the loop on the ones labeled ready",
    handler: (args, ctx) => {
      onInvoke?.(ctx);
      return service.handle(args, ctx);
    },
  });
}
