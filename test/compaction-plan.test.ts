import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_COMPACT_ENV,
  applyCompaction,
  buildSummaryPrompt,
  estimateConversationTokens,
  isThresholdPercent,
  keepRecentTokens,
  messageText,
  overThreshold,
  planCut,
  readThresholdPercent,
  renderConversation,
  type PlanMessage,
} from "../src/agent/compaction-plan.ts";

/** A conversation: the phase prompt, then alternating turns of a given size. */
function conversation(turns: number, chars = 4000): PlanMessage[] {
  const messages: PlanMessage[] = [{ role: "user", content: "implement the task", timestamp: 1 }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "assistant", content: [{ type: "text", text: "x".repeat(chars) }] });
    messages.push({ role: "user", content: [{ type: "toolResult", output: "y".repeat(chars) }] });
  }
  return messages;
}

test("the threshold is read from the environment inside its band", () => {
  assert.equal(readThresholdPercent({ [AUTO_COMPACT_ENV]: "50" }), 50);
  assert.equal(readThresholdPercent({}), null);
  assert.equal(readThresholdPercent({ [AUTO_COMPACT_ENV]: "" }), null);
  // Out of band or not a whole percentage: the phase runs on the CLI behavior
  // rather than on a number nobody chose.
  for (const bad of ["0", "9", "91", "50.5", "half"]) {
    assert.equal(readThresholdPercent({ [AUTO_COMPACT_ENV]: bad }), null, bad);
  }
  assert.equal(isThresholdPercent(10), true);
  assert.equal(isThresholdPercent(90), true);
  assert.equal(isThresholdPercent(91), false);
});

test("the threshold compares the tokens in flight against the window", () => {
  assert.equal(overThreshold(100_000, 200_000, 50), true);
  assert.equal(overThreshold(99_999, 200_000, 50), false);
  assert.equal(overThreshold(100_000, 0, 50), false);
  // Half of what the threshold buys is kept whole, so a cut always happens.
  assert.equal(keepRecentTokens(200_000, 50), 50_000);
});

test("the cut lands on an assistant message and keeps the recent budget", () => {
  const messages = conversation(20);
  const keep = 5_000;
  const cut = planCut(messages, keep);

  assert.ok(cut !== null);
  assert.equal(messages[cut].role, "assistant");
  assert.ok(cut >= 1, "the phase prompt is never the start of the kept part");
  assert.ok(
    estimateConversationTokens(messages.slice(cut)) >= keep,
    "the kept turns must cover the recent budget",
  );
});

test("a cut is refused when there is nothing new to summarize", () => {
  const messages = conversation(20);
  const first = planCut(messages, 5_000);
  assert.ok(first !== null);
  // Asking for a cut past the end of the conversation: the previous one still
  // stands rather than paying for a second summary of the same stretch.
  assert.equal(planCut(messages, 5_000, messages.length), null);
  // A conversation with no assistant message has no well-formed cut point.
  assert.equal(planCut([{ role: "user", content: "only a prompt" }], 1), null);
});

test("the compacted request keeps the prompt, the summary and the recent turns", () => {
  const messages = conversation(6);
  const cut = planCut(messages, 4_000);
  assert.ok(cut !== null);

  const compacted = applyCompaction(messages, cut, "the summary of the work so far");

  assert.equal(compacted.length, messages.length - cut + 1);
  assert.equal(compacted[0].role, "user");
  // The head is the original prompt message rewritten, so what the runtime put
  // on it (the timestamp among the rest) survives the compaction.
  assert.equal(compacted[0].timestamp, 1);
  const head = messageText(compacted[0]);
  assert.match(head, /implement the task/);
  assert.match(head, /the summary of the work so far/);
  // The kept part starts on an assistant message: a tool result whose call was
  // summarized away would be dangling.
  assert.equal(compacted[1].role, "assistant");
  assert.deepEqual(compacted.slice(1), messages.slice(cut));
});

test("the summarizer prompt carries the transcript and merges the earlier summary", () => {
  const rendered = renderConversation([
    { role: "user", content: "do the thing" },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ]);
  assert.match(rendered, /## user\ndo the thing/);
  assert.match(rendered, /## assistant\ndone/);

  const first = buildSummaryPrompt(rendered);
  assert.ok(!first.includes("Earlier summary"));
  const merged = buildSummaryPrompt(rendered, "what happened before");
  assert.match(merged, /Earlier summary/);
  assert.match(merged, /what happened before/);
});

test("a huge block is capped in the summarizer prompt but still counted", () => {
  const message: PlanMessage = { role: "user", content: [{ type: "toolResult", output: "z".repeat(200_000) }] };
  const rendered = renderConversation([message]);

  assert.ok(rendered.length < 20_000, `rendered too long: ${rendered.length}`);
  assert.match(rendered, /characters elided/);
  // The estimate reads the whole message: the cut has to know what it is cutting.
  assert.ok(estimateConversationTokens([message]) > 40_000);
});
