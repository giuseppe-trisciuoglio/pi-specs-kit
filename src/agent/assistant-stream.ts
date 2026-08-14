/**
 * Rebuilds the assistant message that a streaming run is producing.
 *
 * An interactive session gets a cumulative snapshot of the message with every
 * update; the serialized stream does not carry it, only the opening message,
 * the deltas and the final message. This module replays the deltas onto the
 * opening message so the renderer has something complete to draw at any
 * moment. It stays free of runtime imports so it can be unit tested.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";

type Block = Record<string, unknown>;

/** The message being rebuilt: the wire fields, with content we own and mutate. */
export interface AssistantDraft {
  [key: string]: unknown;
  role: "assistant";
  content: Block[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Start a draft from the message that opens a run. Returns null for anything
 * that is not an assistant message, which is how callers filter the user and
 * tool-result messages sharing the same event.
 */
export function startAssistantDraft(message: unknown): AssistantDraft | null {
  const record = asRecord(message);
  if (!record || record.role !== "assistant") return null;
  const content = Array.isArray(record.content) ? record.content : [];
  return { ...record, role: "assistant", content: content.map((b) => ({ ...(asRecord(b) ?? {}) })) };
}

/** Grow the content array so `index` exists, then put `block` there. */
function setBlock(draft: AssistantDraft, index: number, block: Block): void {
  while (draft.content.length <= index) draft.content.push({ type: "text", text: "" });
  draft.content[index] = block;
}

/** The block at `index`, created with `seed` when the stream never opened it. */
function blockAt(draft: AssistantDraft, index: number, seed: Block): Block {
  while (draft.content.length <= index) draft.content.push({ type: "text", text: "" });
  const existing = draft.content[index];
  if (existing.type !== seed.type) {
    draft.content[index] = { ...seed };
  }
  return draft.content[index];
}

/**
 * Apply one streaming update to the draft, returning the draft to render.
 *
 * Tool-call deltas are skipped on purpose: their arguments arrive as partial
 * JSON that cannot be parsed until complete, and the tool rows of the
 * transcript are driven by the tool execution events instead, which carry the
 * arguments already assembled.
 */
export function applyAssistantEvent(draft: AssistantDraft, assistantMessageEvent: unknown): AssistantDraft {
  const event = asRecord(assistantMessageEvent);
  if (!event) return draft;
  const index = asIndex(event.contentIndex);

  switch (event.type) {
    case "text_start":
      if (index !== null) setBlock(draft, index, { type: "text", text: "" });
      return draft;
    case "text_delta": {
      if (index === null) return draft;
      const block = blockAt(draft, index, { type: "text", text: "" });
      block.text = asString(block.text) + asString(event.delta);
      return draft;
    }
    case "text_end":
      if (index !== null) setBlock(draft, index, { type: "text", text: asString(event.content) });
      return draft;
    case "thinking_start":
      if (index !== null) setBlock(draft, index, { type: "thinking", thinking: "" });
      return draft;
    case "thinking_delta": {
      if (index === null) return draft;
      const block = blockAt(draft, index, { type: "thinking", thinking: "" });
      block.thinking = asString(block.thinking) + asString(event.delta);
      return draft;
    }
    case "thinking_end":
      if (index !== null) setBlock(draft, index, { type: "thinking", thinking: asString(event.content) });
      return draft;
    case "toolcall_end": {
      const toolCall = asRecord(event.toolCall);
      if (index !== null && toolCall) setBlock(draft, index, { ...toolCall });
      return draft;
    }
    case "done": {
      const finished = startAssistantDraft(event.message);
      return finished ?? draft;
    }
    case "error": {
      const failed = startAssistantDraft(event.error);
      return failed ?? draft;
    }
    default:
      return draft;
  }
}

/**
 * Hand the draft to a renderer that wants the real message type. The cast is
 * the single point where wire data is trusted to have the expected shape; the
 * renderer tolerates missing fields the same way it does for a live session.
 */
export function asAssistantMessage(draft: AssistantDraft): AssistantMessage {
  return draft as unknown as AssistantMessage;
}
