import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJsonlParser, type PiStreamEvent } from "../src/agent/json-stream.ts";
import { agentEndOutcome, assistantText, formatStreamEvent, toLogLines } from "../src/agent/stream-format.ts";

/** A stream captured from a real run: one tool call, thinking, then an answer. */
const CAPTURED = readFileSync(fileURLToPath(new URL("./fixtures/agent-stream.jsonl", import.meta.url)), "utf8");

function collect(chunks: string[]): PiStreamEvent[] {
  const events: PiStreamEvent[] = [];
  const parser = createJsonlParser((e) => events.push(e));
  for (const chunk of chunks) parser.push(chunk);
  parser.flush();
  return events;
}

test("the captured stream parses into session events, none dropped", () => {
  const events = collect([CAPTURED]);
  assert.equal(events.length, CAPTURED.trim().split("\n").length);
  assert.equal(events.filter((e) => e.type === "unparsed_line").length, 0);

  const types = new Set(events.map((e) => e.type));
  for (const expected of ["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end", "agent_end"]) {
    assert.ok(types.has(expected as PiStreamEvent["type"]), `missing ${expected}`);
  }
});

test("streaming updates carry no cumulative message, only the delta", () => {
  const updates = collect([CAPTURED]).filter((e) => e.type === "message_update");
  assert.ok(updates.length > 0);
  // This is why the transcript rebuilds the message from the deltas itself.
  assert.ok(updates.every((e) => !("message" in e)));
});

test("non-JSON lines surface as unparsed, never dropped", () => {
  assert.deepEqual(collect(["this is not json\n"]), [{ type: "unparsed_line", line: "this is not json" }]);
});

test("JSON that is not an event surfaces as unparsed", () => {
  assert.deepEqual(collect(["[1,2,3]\n"]), [{ type: "unparsed_line", line: "[1,2,3]" }]);
  assert.deepEqual(collect(['{"no":"type"}\n']), [{ type: "unparsed_line", line: '{"no":"type"}' }]);
});

test("an event type this version does not know still travels", () => {
  const events = collect(['{"type":"brand_new_event","payload":42}\n']);
  assert.equal(events.length, 1);
  assert.equal(events[0].type as string, "brand_new_event");
});

test("chunks split mid-line are buffered until complete", () => {
  const line = '{"type":"agent_start"}';
  const half = Math.floor(line.length / 2);
  const events = collect([line.slice(0, half), line.slice(half) + "\n"]);
  assert.deepEqual(events.map((e) => e.type), ["agent_start"]);
});

test("flush processes a trailing line without newline", () => {
  assert.deepEqual(collect(["tail with no newline"]), [{ type: "unparsed_line", line: "tail with no newline" }]);
});

test("assistantText reads the answer off the completed message", () => {
  const ends = collect([CAPTURED]).filter((e) => e.type === "message_end");
  const answers = ends.map((e) => assistantText((e as { message: unknown }).message)).filter((t) => t.length > 0);
  assert.equal(answers.length, 1);
  assert.match(answers[0], /hello from the fixture/);
});

test("agentEndOutcome reads the stop reason of the closing event", () => {
  const events = collect([CAPTURED]);
  const outcomes = events.map(agentEndOutcome).filter((o) => o !== null);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.stopReason, "stop");
  assert.equal(outcomes[0]?.errorMessage, null);
});

test("agentEndOutcome reports a failed run", () => {
  const [event] = collect([
    JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider blew up" }],
    }) + "\n",
  ]);
  assert.deepEqual(agentEndOutcome(event), { stopReason: "error", errorMessage: "provider blew up" });
});

test("agentEndOutcome without an assistant message still closes the run", () => {
  const [event] = collect([JSON.stringify({ type: "agent_end", messages: [] }) + "\n"]);
  assert.deepEqual(agentEndOutcome(event), { stopReason: null, errorMessage: null });
});

test("the log of the captured stream shows the tools and the answer", () => {
  const lines = collect([CAPTURED]).flatMap((e) => {
    const formatted = formatStreamEvent(e);
    return formatted === null ? [] : toLogLines(formatted);
  });
  assert.ok(lines.some((l) => l.startsWith("> tool read(")), lines.join("\n"));
  assert.ok(lines.includes("< tool read"));
  assert.ok(lines.some((l) => l.startsWith("(thinking) ")));
  assert.ok(lines.some((l) => /hello from the fixture/.test(l)));
  // Streaming updates never reach the log: one line per delta would drown it.
  assert.equal(lines.filter((l) => l.startsWith("? ")).length, 0);
});

test("formatStreamEvent marks failed tools and truncates long arguments", () => {
  const failed = formatStreamEvent({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    result: {},
    isError: true,
  } as PiStreamEvent);
  assert.equal(failed, "< tool bash (error)");

  const long = formatStreamEvent({
    type: "tool_execution_start",
    toolCallId: "c2",
    toolName: "write",
    args: { content: "x".repeat(500) },
  } as PiStreamEvent);
  assert.ok(long !== null && long.endsWith("…)"), long ?? "");
  assert.ok(long.length < 140);
});

test("an unknown event still reaches the log as its raw JSON", () => {
  const [event] = collect(['{"type":"brand_new_event","payload":42}\n']);
  assert.equal(formatStreamEvent(event), '? {"type":"brand_new_event","payload":42}');
});
