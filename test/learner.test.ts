import test from "node:test";
import assert from "node:assert/strict";
import { MAX_LEARNINGS, mergeLearnings, parseLearnings } from "../src/loop/learner.ts";

test("parseLearnings accepts dash, star, bullet and numbered bullets", () => {
  const text = [
    "- dash learning",
    "* star learning",
    "• unicode bullet learning",
    "1. numbered with dot",
    "2) numbered with paren",
  ].join("\n");
  assert.deepEqual(parseLearnings(text), [
    "dash learning",
    "star learning",
    "unicode bullet learning",
    "numbered with dot",
    "numbered with paren",
  ]);
});

test("parseLearnings ignores headings, prose and blank lines", () => {
  const text = [
    "## Learnings",
    "",
    "Some prose explaining the outcome.",
    "- the only real learning",
    "   ",
    "another prose line without a bullet",
  ].join("\n");
  assert.deepEqual(parseLearnings(text), ["the only real learning"]);
});

test("parseLearnings deduplicates identical bullets and trims them", () => {
  const text = ["-   repeated learning   ", "- repeated learning", "* other learning", "- other learning"].join("\n");
  assert.deepEqual(parseLearnings(text), ["repeated learning", "other learning"]);
});

test("parseLearnings returns an empty list for text without bullets", () => {
  assert.deepEqual(parseLearnings("no bullets here\nnone at all"), []);
});

test("mergeLearnings appends new entries and skips case-insensitive duplicates", () => {
  const existing = ["Existing learning", "second one"];
  const incoming = ["existing LEARNING", "brand new", "SECOND ONE", "another new"];
  assert.deepEqual(mergeLearnings(existing, incoming), [
    "Existing learning",
    "second one",
    "brand new",
    "another new",
  ]);
});

test("mergeLearnings does not mutate the existing list", () => {
  const existing = ["keep me"];
  const merged = mergeLearnings(existing, ["fresh"]);
  assert.deepEqual(existing, ["keep me"]);
  assert.deepEqual(merged, ["keep me", "fresh"]);
});

test("mergeLearnings rotates the oldest entries out beyond the cap", () => {
  const existing = ["l1", "l2", "l3"];
  const incoming = ["l4", "l5"];
  assert.deepEqual(mergeLearnings(existing, incoming, 4), ["l2", "l3", "l4", "l5"]);
});

test("mergeLearnings keeps the default cap consistent with MAX_LEARNINGS", () => {
  const existing = Array.from({ length: MAX_LEARNINGS }, (_, i) => `learning ${i}`);
  const merged = mergeLearnings(existing, ["overflow learning"]);
  assert.equal(merged.length, MAX_LEARNINGS);
  assert.equal(merged[0], "learning 1");
  assert.equal(merged[merged.length - 1], "overflow learning");
});
