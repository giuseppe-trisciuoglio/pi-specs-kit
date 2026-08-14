/**
 * Fullscreen transcript of the phase currently running. The body is rendered
 * by the same components an interactive session uses; this module is the shell
 * around them: viewport and scrolling, the footer line carrying
 * task/phase/elapsed, and the keys.
 *
 * Closing the transcript never touches the loop. The interrupt key aborts the
 * in-flight phase, which the engine counts as a failed attempt — the one
 * deliberate divergence from the keys of an interactive session.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { LoopController } from "../loop/loop-controller.ts";
import type { LoopStatus } from "../loop/engine.ts";
import { Transcript } from "./transcript.ts";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Elapsed time since the loop start, as mm:ss (minutes keep growing). */
function elapsed(startedAt: number | null): string {
  if (startedAt === null) return "00:00";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
}

function footerLine(status: LoopStatus): string {
  if (!status.running && !status.specId) return "[specs-kit] no active loop";
  const spec = status.specId ?? "?";
  const task = status.currentTask ?? "—";
  const step = status.step ?? "—";
  const run = status.running ? "running" : "finished";
  return `${spec} — ${task} · ${step} · ${run} · ${elapsed(status.startedAt)}`;
}

/** Rows the footer and the key hint take away from the transcript. */
const CHROME_ROWS = 2;

class AttachView implements Component {
  readonly #tui: TUI;
  readonly #keys: KeybindingsManager;
  readonly #controller: LoopController;
  readonly #transcript: Transcript;
  readonly #done: () => void;
  readonly #onInterrupt: () => void;
  /** Lines between the bottom of the content and the bottom of the viewport. */
  #scrollBack = 0;
  #unsubscribe: Array<() => void> = [];
  #timer: NodeJS.Timeout | null;
  /** Latest log line from hooks, shown below the transcript. */
  #lastHookLine: string | null = null;
  #unsubLogLines: (() => void) | null = null;

  constructor(
    tui: TUI,
    keys: KeybindingsManager,
    controller: LoopController,
    cwd: string,
    done: () => void,
    onInterrupt: () => void,
  ) {
    this.#tui = tui;
    this.#keys = keys;
    this.#controller = controller;
    this.#done = done;
    this.#onInterrupt = onInterrupt;
    this.#transcript = new Transcript(tui, cwd);
    this.#transcript.replay(controller.getPhaseEvents());
    this.#unsubscribe.push(
      controller.subscribeStream((event) => {
        this.#transcript.apply(event);
        this.#tui.requestRender();
      }),
      controller.subscribePhaseStart(() => {
        this.#transcript.reset();
        this.#scrollBack = 0;
        this.#lastHookLine = null;
        this.#tui.requestRender();
      }),
    );
    this.#unsubLogLines = controller.subscribeLogLines((line) => {
      this.#lastHookLine = line;
      this.#tui.requestRender();
    });
    // Footer elapsed clock; unref'd so it never holds the process open.
    this.#timer = setInterval(() => this.#tui.requestRender(), 1000);
    this.#timer.unref?.();
  }

  get #viewportHeight(): number {
    return Math.max(1, this.#tui.terminal.rows - CHROME_ROWS);
  }

  render(width: number): string[] {
    const status = this.#controller.status();
    const lines = this.#transcript.render(width).map((l) => truncateToWidth(l, width));
    const body = lines.length > 0 ? lines : [this.#emptyLine(status)];

    const height = this.#viewportHeight;
    // Clamp on every render: the content grows under the viewport and the
    // terminal can be resized while scrolled back.
    const maxScrollBack = Math.max(0, body.length - height);
    if (this.#scrollBack > maxScrollBack) this.#scrollBack = maxScrollBack;
    const end = body.length - this.#scrollBack;
    const visible = body.slice(Math.max(0, end - height), end);

    let padLines = Math.max(0, height - visible.length);
    if (this.#lastHookLine) padLines = Math.max(0, padLines - 1);
    const padding = Array.from({ length: padLines }, () => "");

    const output = [...visible, ...padding];
    if (this.#lastHookLine) output.push(truncateToWidth(this.#lastHookLine, width));
    return [...output, footerLine(status), this.#hint()];
  }

  #emptyLine(status: LoopStatus): string {
    return status.running
      ? "(waiting for the phase to produce something…)"
      : "No active loop: nothing to show.";
  }

  #hint(): string {
    const position = this.#scrollBack > 0 ? `scrolled back ${this.#scrollBack} · ` : "";
    const tools = this.#transcript.expanded ? "collapse tools" : "expand tools";
    return `${position}q/Esc: close · ctrl+o: ${tools} · ctrl+c: interrupt the phase`;
  }

  #scrollBy(lines: number): void {
    this.#scrollBack = Math.max(0, this.#scrollBack + lines);
    this.#tui.requestRender();
  }

  handleInput(data: string): void {
    if (data === "q" || data === "\u001b") {
      this.dispose();
      this.#done();
      return;
    }
    if (data === "\u0003") {
      const engine = this.#controller.engine;
      if (engine?.running) {
        engine.interruptPhase();
        this.#onInterrupt();
      }
      return;
    }
    if (this.#keys.matches(data, "app.tools.expand")) {
      this.#transcript.setExpanded(!this.#transcript.expanded);
      this.#tui.requestRender();
      return;
    }
    // Scrolling follows the keys of the agent CLI's own fullscreen view.
    if (this.#keys.matches(data, "tui.altScreen.pageUp")) return this.#scrollBy(this.#viewportHeight);
    if (this.#keys.matches(data, "tui.altScreen.pageDown")) return this.#scrollBy(-this.#viewportHeight);
    if (this.#keys.matches(data, "tui.altScreen.top")) return this.#scrollBy(Number.MAX_SAFE_INTEGER);
    if (this.#keys.matches(data, "tui.altScreen.bottom")) return this.#scrollBy(-Number.MAX_SAFE_INTEGER);
    if (this.#keys.matches(data, "tui.select.up")) return this.#scrollBy(1);
    if (this.#keys.matches(data, "tui.select.down")) return this.#scrollBy(-1);
  }

  invalidate(): void {
    this.#transcript.invalidate();
  }

  dispose(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#unsubLogLines?.();
  }
}

/** Open the fullscreen transcript; resolves when the operator closes it. */
export async function openAttachView(ctx: ExtensionCommandContext, controller: LoopController): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    const message = "[specs-kit] The transcript requires interactive mode (TUI).";
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else process.stdout.write(`${message}\n`);
    return;
  }
  const cwd = controller.config?.projectRoot ?? process.cwd();
  await ctx.ui.custom<void>((tui, _theme, keybindings, done) => {
    return new AttachView(tui, keybindings, controller, cwd, () => done(), () => {
      ctx.ui.notify("[specs-kit] Phase interrupted: it counts as a failed attempt.", "warning");
    });
  });
}
