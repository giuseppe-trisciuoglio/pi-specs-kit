/**
 * One-line rendering of session events, for the phase log files and the status
 * widget. The transcript does not go through here: it feeds the events to the
 * components that render an interactive session. This module stays pure so it
 * can be unit tested against a captured stream.
 */

import type { PiStreamEvent } from "./json-stream.ts";

/** Max length of the compacted tool-call arguments preview. */
const MAX_ARGS_PREVIEW = 120;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function compactArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  let s: string;
  try {
    s = JSON.stringify(args) ?? "<unserializable arguments>";
  } catch {
    s = "<unserializable arguments>";
  }
  return s.length > MAX_ARGS_PREVIEW ? s.slice(0, MAX_ARGS_PREVIEW) + "…" : s;
}

/** The text an assistant message ended up carrying, thinking blocks excluded. */
export function assistantText(message: unknown): string {
  const record = asRecord(message);
  if (record?.role !== "assistant") return "";
  const content = Array.isArray(record.content) ? record.content : [];
  let out = "";
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === "text") out += asString(b.text) ?? "";
  }
  return out;
}

/** The same message rendered for a log: thinking blocks marked, text as is. */
function assistantLogText(message: unknown): string | null {
  const record = asRecord(message);
  if (record?.role !== "assistant") return null;
  const content = Array.isArray(record.content) ? record.content : [];
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === "thinking") {
      const thinking = asString(b.thinking);
      if (thinking) parts.push(`(thinking) ${thinking}`);
    } else if (b.type === "text") {
      const text = asString(b.text);
      if (text) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * How the run ended, read off the closing event: the stop reason and error of
 * its last assistant message. Null for every other event.
 */
export function agentEndOutcome(event: PiStreamEvent): { stopReason: string | null; errorMessage: string | null } | null {
  if (event.type !== "agent_end") return null;
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = asRecord(messages[i]);
    if (message?.role === "assistant") {
      return { stopReason: asString(message.stopReason), errorMessage: asString(message.errorMessage) };
    }
  }
  return { stopReason: null, errorMessage: null };
}

/**
 * Render an event as log text, or null when it carries nothing worth a line.
 *
 * Assistant text is emitted once the message is complete rather than delta by
 * delta, which keeps the log readable at the price of losing the in-flight
 * message when a phase is killed mid-answer — that message is the one the
 * operator was watching live in the transcript anyway.
 */
export function formatStreamEvent(event: PiStreamEvent): string | null {
  switch (event.type) {
    case "message_end":
      return assistantLogText(event.message);
    case "tool_execution_start":
      return `> tool ${event.toolName}(${compactArgs(event.args)})`;
    case "tool_execution_end":
      return `< tool ${event.toolName}${event.isError ? " (error)" : ""}`;
    case "unparsed_line":
      return `? ${event.line}`;
    // Streaming updates, lifecycle markers and the tool-result echo of the
    // messages are all covered by the cases above.
    case "message_start":
    case "message_update":
    case "tool_execution_update":
    case "turn_start":
    case "turn_end":
    case "agent_start":
    case "agent_end":
    case "agent_settled":
    case "session":
      return null;
    default:
      return `? ${JSON.stringify(event)}`;
  }
}

/**
 * Split formatted text into single lines, for the consumers that lay out one
 * row per line. Empty lines are kept: they carry the paragraph breaks of the
 * agent's markdown.
 */
export function toLogLines(formatted: string): string[] {
  return formatted.split("\n");
}
