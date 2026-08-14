/**
 * Renders a phase the way an interactive session renders itself, by feeding
 * the session events to the very components the agent CLI uses: assistant
 * messages with their markdown and thinking blocks, tool rows with their
 * per-tool renderers, diffs and collapsed output.
 *
 * This module imports those components at runtime, so it stays out of the unit
 * tests; the logic that can be tested without a terminal lives in the pure
 * stream modules it builds on.
 */

import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, type TUI } from "@earendil-works/pi-tui";
import type { PiStreamEvent } from "../agent/json-stream.ts";
import { applyAssistantEvent, asAssistantMessage, startAssistantDraft, type AssistantDraft } from "../agent/assistant-stream.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export class Transcript extends Container {
  readonly #tui: TUI;
  readonly #cwd: string;
  /** Tool components still waiting for their result, by tool call id. */
  readonly #pendingTools = new Map<string, ToolExecutionComponent>();
  #streaming: AssistantMessageComponent | null = null;
  #draft: AssistantDraft | null = null;
  #expanded = false;

  constructor(tui: TUI, cwd: string) {
    super();
    this.#tui = tui;
    this.#cwd = cwd;
  }

  get expanded(): boolean {
    return this.#expanded;
  }

  /** Expand or collapse every tool row at once, as the agent CLI does. */
  setExpanded(expanded: boolean): void {
    this.#expanded = expanded;
    for (const child of this.children) {
      if (child instanceof ToolExecutionComponent) child.setExpanded(expanded);
    }
  }

  /** Drop everything: a new phase is a new session with its own transcript. */
  reset(): void {
    this.clear();
    this.#pendingTools.clear();
    this.#streaming = null;
    this.#draft = null;
  }

  /** Replay a whole history, then keep applying events as they arrive. */
  replay(events: readonly PiStreamEvent[]): void {
    this.reset();
    for (const event of events) this.apply(event);
  }

  apply(event: PiStreamEvent): void {
    switch (event.type) {
      case "message_start":
        this.#startMessage(event.message);
        return;
      case "message_update":
        this.#updateMessage(event.assistantMessageEvent);
        return;
      case "message_end":
        this.#endMessage(event.message);
        return;
      case "tool_execution_start": {
        const tool = this.#tool(event.toolCallId, event.toolName, event.args);
        tool.markExecutionStarted();
        return;
      }
      case "tool_execution_update": {
        const tool = this.#pendingTools.get(event.toolCallId);
        tool?.updateResult({ ...event.partialResult, isError: false }, true);
        return;
      }
      case "tool_execution_end": {
        const tool = this.#pendingTools.get(event.toolCallId);
        if (tool) {
          tool.updateResult({ ...event.result, isError: event.isError });
          this.#pendingTools.delete(event.toolCallId);
        }
        return;
      }
      default:
        // Lifecycle markers, and whatever a newer agent CLI emits, change
        // nothing on screen; the phase log keeps them for inspection.
        return;
    }
  }

  #startMessage(message: unknown): void {
    // Only the assistant is shown. The user message of a phase is the built
    // prompt, thousands of lines the operator did not ask to re-read, and the
    // tool-result messages are already rendered inside their tool row.
    const draft = startAssistantDraft(message);
    if (!draft) return;
    const component = new AssistantMessageComponent();
    this.addChild(component);
    this.#streaming = component;
    this.#draft = draft;
    component.updateContent(asAssistantMessage(draft), true);
    this.#tui.requestRender();
  }

  #updateMessage(assistantMessageEvent: unknown): void {
    if (!this.#streaming || !this.#draft) return;
    this.#draft = applyAssistantEvent(this.#draft, assistantMessageEvent);
    this.#streaming.updateContent(asAssistantMessage(this.#draft), true);
    this.#tui.requestRender();
  }

  #endMessage(message: unknown): void {
    const final = startAssistantDraft(message);
    if (!final || !this.#streaming) return;
    this.#draft = final;
    this.#streaming.updateContent(asAssistantMessage(final), false);
    this.#streaming = null;

    const stopReason = asRecord(message)?.stopReason;
    if (stopReason === "aborted" || stopReason === "error") {
      // A run that died leaves its tools without a result: say so in place,
      // rather than leaving rows spinning forever.
      const errorMessage = (asRecord(message)?.errorMessage as string | undefined) ?? "Error";
      for (const tool of this.#pendingTools.values()) {
        tool.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
      }
      this.#pendingTools.clear();
    } else {
      // Arguments are complete: this is what triggers the diff of edit tools.
      for (const tool of this.#pendingTools.values()) tool.setArgsComplete();
    }
    this.#tui.requestRender();
  }

  /** The row of a tool call, created on first sight of its id. */
  #tool(toolCallId: string, toolName: string, args: unknown): ToolExecutionComponent {
    const existing = this.#pendingTools.get(toolCallId);
    if (existing) {
      existing.updateArgs(args);
      return existing;
    }
    // No tool definition is passed: this transcript watches another process,
    // whose registered tools are not ours to resolve. Built-in tools keep
    // their own renderers; anything else falls back to the generic row.
    const component = new ToolExecutionComponent(toolName, toolCallId, args, undefined, undefined, this.#tui, this.#cwd);
    component.setExpanded(this.#expanded);
    this.addChild(component);
    this.#pendingTools.set(toolCallId, component);
    return component;
  }
}
