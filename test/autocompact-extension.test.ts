import test from "node:test";
import assert from "node:assert/strict";
import autoCompactExtension from "../src/agent/autocompact-extension.ts";
import { AUTO_COMPACT_ENV, messageText, type PlanMessage } from "../src/agent/compaction-plan.ts";

/**
 * The extension only imports types from the agent packages, so it can be driven
 * here with a hand-made runtime: a recorder for the handler it registers, and a
 * context that answers with a fixed window and a scripted summarizer.
 */
interface Harness {
  context: (messages: PlanMessage[], tokens: number | null) => Promise<PlanMessage[] | undefined>;
  registered: string[];
  summarized: number;
}

function harness(options: { percent?: string; summary?: () => string; window?: number } = {}): Harness {
  const previous = process.env[AUTO_COMPACT_ENV];
  if (options.percent === undefined) delete process.env[AUTO_COMPACT_ENV];
  else process.env[AUTO_COMPACT_ENV] = options.percent;

  const state: Harness = { registered: [], summarized: 0, context: async () => undefined };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      state.registered.push(event);
      handlers.set(event, handler);
    },
  };
  try {
    autoCompactExtension(pi as never);
  } finally {
    if (previous === undefined) delete process.env[AUTO_COMPACT_ENV];
    else process.env[AUTO_COMPACT_ENV] = previous;
  }

  const window = options.window ?? 200_000;
  state.context = async (messages, tokens) => {
    const handler = handlers.get("context");
    if (!handler) return undefined;
    const ctx = {
      model: { id: "model-x" },
      signal: undefined,
      getContextUsage: () => ({ tokens, contextWindow: window, percent: null }),
      modelRegistry: {
        complete: async () => {
          state.summarized++;
          return { role: "assistant", content: [{ type: "text", text: (options.summary ?? (() => "SUMMARY"))() }] };
        },
      },
    };
    const result = (await handler({ type: "context", messages }, ctx)) as { messages: PlanMessage[] } | undefined;
    return result?.messages;
  };
  return state;
}

/** A conversation of `turns` assistant/tool-result pairs after the phase prompt. */
function conversation(turns: number, chars = 40_000): PlanMessage[] {
  const messages: PlanMessage[] = [{ role: "user", content: "implement the task", timestamp: 7 }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "assistant", content: [{ type: "text", text: `step ${i} `.repeat(chars / 8) }] });
    messages.push({ role: "user", content: [{ type: "toolResult", output: "o".repeat(chars) }] });
  }
  return messages;
}

test("without a threshold in the environment the phase is left alone", async () => {
  const run = harness();
  assert.deepEqual(run.registered, [], "nothing is registered, so nothing can go wrong later");
});

test("below the threshold the request goes out untouched", async () => {
  const run = harness({ percent: "50" });
  assert.deepEqual(run.registered, ["context"]);

  const messages = conversation(2);
  assert.equal(await run.context(messages, 40_000), undefined);
  assert.equal(run.summarized, 0);
});

test("above the threshold the request is replaced by prompt, summary and recent turns", async () => {
  const run = harness({ percent: "50" });
  const messages = conversation(12);

  const compacted = await run.context(messages, 120_000);

  assert.ok(compacted);
  assert.equal(run.summarized, 1);
  assert.ok(compacted.length < messages.length);
  assert.equal(compacted[0].role, "user");
  assert.match(messageText(compacted[0]), /implement the task/);
  assert.match(messageText(compacted[0]), /SUMMARY/);
  assert.equal(compacted[1].role, "assistant");
});

test("the compaction in force is reapplied without paying for a second summary", async () => {
  const run = harness({ percent: "50" });
  const messages = conversation(12);

  const first = await run.context(messages, 120_000);
  assert.ok(first);
  // The session still holds the original messages, so the next request arrives
  // whole; below the threshold it must come back compacted all the same.
  const second = await run.context(messages, 40_000);

  assert.deepEqual(second, first);
  assert.equal(run.summarized, 1);
});

test("a failing summarizer leaves the phase running on its full context", async () => {
  const run = harness({
    percent: "50",
    summary: () => {
      throw new Error("provider down");
    },
  });

  assert.equal(await run.context(conversation(12), 120_000), undefined);
  assert.equal(run.summarized, 1, "the failure happened inside the summarization call");
});

test("no context window means no compaction", async () => {
  const run = harness({ percent: "50", window: 0 });
  assert.equal(await run.context(conversation(12), 120_000), undefined);
  assert.equal(run.summarized, 0);
});

test("a conversation with no cut point is sent as it is", async () => {
  const run = harness({ percent: "50" });
  // One user message: there is no assistant message to start the kept part on.
  assert.equal(await run.context([{ role: "user", content: "just the prompt" }], 120_000), undefined);
  assert.equal(run.summarized, 0);
});
