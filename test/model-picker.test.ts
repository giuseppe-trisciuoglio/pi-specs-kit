import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO,
  CLEAR_FILTER,
  KEEP,
  MODEL_LIMIT,
  buildModelPickList,
  filterEntry,
  moreEntry,
  type ModelEntry,
} from "../src/ui/model-picker.ts";

function catalogue(count: number, provider = "anthropic"): ModelEntry[] {
  return Array.from({ length: count }, (_, i) => ({ provider, id: `model-${String(i).padStart(2, "0")}` }));
}

const MIXED: ModelEntry[] = [
  { provider: "anthropic", id: "claude-sonnet-5" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "openai", id: "gpt-5" },
  { provider: "google", id: "gemini-3-pro" },
];

test("the list is capped and reports how many matches are hidden", () => {
  const list = buildModelPickList(catalogue(30));
  const models = list.options.filter((option) => list.values.has(option));
  assert.equal(models.length, MODEL_LIMIT);
  assert.equal(list.matchCount, 30);
  assert.equal(list.hiddenCount, 30 - MODEL_LIMIT);
  assert.equal(list.options.at(-1), moreEntry(30 - MODEL_LIMIT));
});

test("showAll lists every match without the expand entry", () => {
  const list = buildModelPickList(catalogue(30), { showAll: true });
  assert.equal(list.values.size, 30);
  assert.equal(list.hiddenCount, 0);
  assert.ok(!list.options.some((option) => option.startsWith("Show ")));
});

test("keep, auto and the filter entry always lead the list", () => {
  const list = buildModelPickList(MIXED);
  assert.deepEqual(list.options.slice(0, 3), [KEEP, AUTO, filterEntry("")]);
  assert.ok(!list.options.includes(CLEAR_FILTER));
});

test("an active filter narrows the models and offers to clear itself", () => {
  const list = buildModelPickList(MIXED, { query: "gpt" });
  assert.deepEqual(list.options, [KEEP, AUTO, filterEntry("gpt"), CLEAR_FILTER, "openai/gpt-5"]);
  assert.equal(list.matchCount, 1);
});

test("a filter matching nothing leaves only the control entries", () => {
  const list = buildModelPickList(MIXED, { query: "llama" });
  assert.deepEqual(list.options, [KEEP, AUTO, filterEntry("llama"), CLEAR_FILTER]);
  assert.equal(list.matchCount, 0);
  assert.equal(list.hiddenCount, 0);
});

test("the configured model is listed first and marked, and resolves to its id", () => {
  const list = buildModelPickList(MIXED, { current: "google/gemini-3-pro" });
  assert.equal(list.options[3], "google/gemini-3-pro (current)");
  assert.equal(list.values.get("google/gemini-3-pro (current)"), "google/gemini-3-pro");
});

test("the configured model surfaces from beyond the cap", () => {
  const models = [...catalogue(30), { provider: "openai", id: "gpt-5" }];
  const list = buildModelPickList(models, { current: "openai/gpt-5" });
  assert.equal(list.options[3], "openai/gpt-5 (current)");
  assert.equal(list.hiddenCount, 31 - MODEL_LIMIT);
});

test("a configured model outside the filter is not listed", () => {
  const list = buildModelPickList(MIXED, { query: "gpt", current: "google/gemini-3-pro" });
  assert.ok(!list.options.some((option) => option.includes("gemini")));
});

test("every listed model resolves to a provider/id value", () => {
  const list = buildModelPickList(MIXED, { current: "openai/gpt-5" });
  for (const [label, value] of list.values) {
    assert.ok(label.startsWith(value));
    assert.match(value, /^[^/]+\/.+$/);
  }
});
