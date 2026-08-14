import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJsonlParser, type PiStreamEvent } from "../src/agent/json-stream.ts";
import { applyAssistantEvent, startAssistantDraft, type AssistantDraft } from "../src/agent/assistant-stream.ts";

const CAPTURED = readFileSync(fileURLToPath(new URL("./fixtures/agent-stream.jsonl", import.meta.url)), "utf8");

function parse(text: string): PiStreamEvent[] {
  const events: PiStreamEvent[] = [];
  const parser = createJsonlParser((e) => events.push(e));
  parser.push(text);
  parser.flush();
  return events;
}

/**
 * Replay a stream the way the transcript does, keeping the drafts rebuilt from
 * the deltas and, next to them, the authoritative messages the run ended with.
 */
function replay(events: PiStreamEvent[]): { rebuilt: AssistantDraft[]; authoritative: unknown[] } {
  const rebuilt: AssistantDraft[] = [];
  const authoritative: unknown[] = [];
  let draft: AssistantDraft | null = null;
  for (const event of events) {
    if (event.type === "message_start") {
      const started = startAssistantDraft(event.message);
      if (started) draft = started;
    } else if (event.type === "message_update" && draft) {
      draft = applyAssistantEvent(draft, event.assistantMessageEvent);
    } else if (event.type === "message_end" && draft) {
      const final = startAssistantDraft(event.message);
      if (final) {
        rebuilt.push(draft);
        authoritative.push(final);
        draft = null;
      }
    }
  }
  return { rebuilt, authoritative };
}

function textOf(draft: AssistantDraft): string {
  return draft.content
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");
}

function thinkingOf(draft: AssistantDraft): string {
  return draft.content
    .filter((b) => b.type === "thinking")
    .map((b) => String(b.thinking ?? ""))
    .join("");
}

test("the message rebuilt from the deltas matches the one the run reports", () => {
  const { rebuilt, authoritative } = replay(parse(CAPTURED));
  assert.ok(rebuilt.length >= 2, "the capture should hold a tool turn and an answer turn");

  for (const [i, draft] of rebuilt.entries()) {
    const final = authoritative[i] as AssistantDraft;
    assert.equal(textOf(draft), textOf(final), `text of message ${i}`);
    assert.equal(thinkingOf(draft), thinkingOf(final), `thinking of message ${i}`);
  }
});

test("tool calls are rebuilt whole, arguments included", () => {
  const { rebuilt } = replay(parse(CAPTURED));
  const calls = rebuilt.flatMap((d) => d.content.filter((b) => b.type === "toolCall"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "read");
  assert.deepEqual(calls[0].arguments, { path: "note.txt" });
});

test("only assistant messages open a draft", () => {
  assert.equal(startAssistantDraft({ role: "user", content: [] }), null);
  assert.equal(startAssistantDraft({ role: "toolResult", content: [] }), null);
  assert.equal(startAssistantDraft("nonsense"), null);
  assert.deepEqual(startAssistantDraft({ role: "assistant", content: [] }), { role: "assistant", content: [] });
});

test("the draft keeps the fields the renderer reads besides the content", () => {
  const draft = startAssistantDraft({ role: "assistant", content: [], provider: "zai", model: "glm", usage: { input: 3 } });
  assert.equal(draft?.provider, "zai");
  assert.equal(draft?.model, "glm");
  assert.deepEqual(draft?.usage, { input: 3 });
});

test("deltas that arrive without their opening event still land", () => {
  let draft = startAssistantDraft({ role: "assistant", content: [] })!;
  draft = applyAssistantEvent(draft, { type: "text_delta", contentIndex: 0, delta: "no start event" });
  assert.equal(textOf(draft), "no start event");
});

test("a block index beyond the content grows it instead of throwing", () => {
  let draft = startAssistantDraft({ role: "assistant", content: [] })!;
  draft = applyAssistantEvent(draft, { type: "text_delta", contentIndex: 3, delta: "late" });
  assert.equal(draft.content.length, 4);
  assert.equal(textOf(draft), "late");
});

test("text_end and thinking_end replace what the deltas built", () => {
  let draft = startAssistantDraft({ role: "assistant", content: [] })!;
  draft = applyAssistantEvent(draft, { type: "text_delta", contentIndex: 0, delta: "par" });
  draft = applyAssistantEvent(draft, { type: "text_end", contentIndex: 0, content: "partial then whole" });
  assert.equal(textOf(draft), "partial then whole");

  draft = applyAssistantEvent(draft, { type: "thinking_delta", contentIndex: 1, delta: "hm" });
  draft = applyAssistantEvent(draft, { type: "thinking_end", contentIndex: 1, content: "hmm, ok" });
  assert.equal(thinkingOf(draft), "hmm, ok");
});

test("a failed run replaces the draft with the message carrying the error", () => {
  let draft = startAssistantDraft({ role: "assistant", content: [] })!;
  draft = applyAssistantEvent(draft, { type: "text_delta", contentIndex: 0, delta: "half an answ" });
  draft = applyAssistantEvent(draft, {
    type: "error",
    reason: "error",
    error: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider blew up" },
  });
  assert.equal(draft.errorMessage, "provider blew up");
  assert.equal(textOf(draft), "");
});

test("an update this version does not know leaves the draft untouched", () => {
  const draft = startAssistantDraft({ role: "assistant", content: [{ type: "text", text: "kept" }] })!;
  assert.equal(textOf(applyAssistantEvent(draft, { type: "brand_new_delta", contentIndex: 0 })), "kept");
  assert.equal(textOf(applyAssistantEvent(draft, "not an object")), "kept");
});
