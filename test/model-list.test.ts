import test from "node:test";
import assert from "node:assert/strict";
import {
  VISIBLE_MODELS,
  counterText,
  filterModels,
  listWindow,
  modelDetail,
  modelValue,
  orderModels,
  type ModelEntry,
} from "../src/ui/model-list.ts";

const MIXED: ModelEntry[] = [
  { provider: "anthropic", id: "claude-sonnet-5" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "openai", id: "gpt-5" },
  { provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro" },
];

const values = (models: ModelEntry[]): string[] => models.map(modelValue);

test("filterModels keeps every model when the query is empty or blank", () => {
  assert.deepEqual(filterModels(MIXED, ""), MIXED);
  assert.deepEqual(filterModels(MIXED, "   "), MIXED);
});

test("filterModels matches provider and id case-insensitively", () => {
  assert.deepEqual(values(filterModels(MIXED, "SONNET")), ["anthropic/claude-sonnet-5"]);
  assert.deepEqual(values(filterModels(MIXED, "anthropic")), [
    "anthropic/claude-sonnet-5",
    "anthropic/claude-haiku-4-5",
  ]);
});

test("filterModels requires every term to match", () => {
  assert.deepEqual(values(filterModels(MIXED, "anthropic haiku")), ["anthropic/claude-haiku-4-5"]);
  assert.deepEqual(filterModels(MIXED, "openai haiku"), []);
});

test("filterModels matches the display name too", () => {
  assert.deepEqual(values(filterModels(MIXED, "Gemini 3")), ["google/gemini-3-pro"]);
});

test("orderModels puts the configured model first and groups the rest by provider", () => {
  assert.deepEqual(values(orderModels(MIXED, "openai/gpt-5")), [
    "openai/gpt-5",
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-sonnet-5",
    "google/gemini-3-pro",
  ]);
});

test("orderModels without a configured model is a stable provider grouping", () => {
  assert.deepEqual(values(orderModels(MIXED)), [
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-sonnet-5",
    "google/gemini-3-pro",
    "openai/gpt-5",
  ]);
});

test("a list shorter than the window is shown whole", () => {
  assert.deepEqual(listWindow(0, 4), { start: 0, end: 4 });
  assert.deepEqual(listWindow(3, 4), { start: 0, end: 4 });
});

test("the window keeps the selection centred and clamps at both ends", () => {
  assert.deepEqual(listWindow(0, 100, 10), { start: 0, end: 10 });
  assert.deepEqual(listWindow(20, 100, 10), { start: 15, end: 25 });
  assert.deepEqual(listWindow(99, 100, 10), { start: 90, end: 100 });
});

test("the window never exceeds the number of visible rows", () => {
  for (let selected = 0; selected < 380; selected++) {
    const { start, end } = listWindow(selected, 380);
    assert.equal(end - start, VISIBLE_MODELS);
    assert.ok(selected >= start, `row ${selected} starts before the window`);
    assert.ok(selected < end, `row ${selected} falls after the window`);
  }
});

test("the counter reports the position in the whole match set", () => {
  assert.equal(counterText(0, 380), "(1/380)");
  assert.equal(counterText(379, 380), "(380/380)");
});

test("the detail line falls back to the id and reports thinking support", () => {
  assert.equal(modelDetail({ provider: "openai", id: "gpt-5" }), "gpt-5");
  assert.equal(
    modelDetail({ provider: "x", id: "m", name: "Model M", contextWindow: 256_000, reasoning: true }),
    "Model M · 256k context · thinking supported",
  );
  assert.equal(
    modelDetail({ provider: "x", id: "m", name: "Model M", contextWindow: 900, reasoning: false }),
    "Model M · 900 context · no thinking",
  );
});
