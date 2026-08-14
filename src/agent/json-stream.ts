/**
 * Incremental parser for the JSONL stream the agent subprocess writes on
 * stdout. Those lines are the session events of an interactive session,
 * serialized as they are, so consumers can hand them straight to the UI
 * components that render such a session instead of reducing them to text.
 *
 * The parser is deliberately tolerant: a line that is not JSON, and an event
 * whose type this version of the extension does not know, are both forwarded
 * rather than dropped, so nothing observed is lost on the way to the logs.
 */

import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * A stdout line that could not be read as a session event. Synthesized by the
 * parser: it never appears on the wire.
 */
export interface UnparsedStreamLine {
  type: "unparsed_line";
  line: string;
}

/**
 * The header the serialized stream opens with (session id, cwd, timestamp).
 * It travels on the wire but is absent from the declared session-event union,
 * so it is spelled out here rather than left to the unknown-type fallback.
 */
export interface SessionHeaderEvent {
  type: "session";
  [key: string]: unknown;
}

export type PiStreamEvent = JsonAgentSessionEvent | SessionHeaderEvent | UnparsedStreamLine;

function processLine(line: string, onEvent: (e: PiStreamEvent) => void): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    onEvent({ type: "unparsed_line", line: trimmed });
    return;
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
    onEvent({ type: "unparsed_line", line: trimmed });
    return;
  }
  // Tolerance point: an event whose type this version does not know still
  // travels as a session event. Every consumer switches on the type and has a
  // fallback branch, so an unknown type degrades instead of throwing.
  onEvent(parsed as JsonAgentSessionEvent);
}

/**
 * Line-oriented parser over the subprocess stdout. Chunks may split a line
 * anywhere; the remainder is buffered until the next chunk or an explicit
 * flush (call it when the stream ends).
 */
export function createJsonlParser(onEvent: (e: PiStreamEvent) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = "";
  return {
    push(chunk: string): void {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        processLine(line, onEvent);
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        processLine(buffer, onEvent);
        buffer = "";
      }
    },
  };
}
