import test from "node:test";
import assert from "node:assert/strict";
import { learningScore, MAX_LEARNINGS, mergeLearnings, parseLearnings } from "../src/loop/learner.ts";

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

test("mergeLearnings appends new entries and reheats case-insensitive repeats", () => {
  const merged = mergeLearnings({
    existing: ["Existing learning", "second one"],
    incoming: ["existing LEARNING", "brand new", "SECOND ONE", "another new"],
    iteration: 5,
  });

  // A repeat is evidence the project met the insight again, not a new entry:
  // it warms the one already there instead of taking a second slot.
  assert.deepEqual(merged.learnings, ["Existing learning", "second one", "brand new", "another new"]);
  assert.equal(merged.stats[0].hits, 2);
  assert.equal(merged.stats[1].hits, 2);
  assert.equal(merged.stats[2].hits, 1);
});

test("a cited insight is reheated without being restated", () => {
  const merged = mergeLearnings({
    existing: ["the application layer imports no framework types"],
    incoming: ["something this task added"],
    confirmed: ["the application layer imports no framework types"],
    iteration: 9,
  });

  assert.equal(merged.learnings.length, 2, "the citation must not add a copy");
  assert.equal(merged.stats[0].hits, 2);
  assert.equal(merged.stats[0].lastSeen, 9);
});

test("mergeLearnings does not mutate the existing list", () => {
  const existing = ["keep me"];
  const merged = mergeLearnings({ existing, incoming: ["fresh"], iteration: 1 });
  assert.deepEqual(existing, ["keep me"]);
  assert.deepEqual(merged.learnings, ["keep me", "fresh"]);
});

test("the coldest entry is evicted, not the oldest", () => {
  // The regression this replaces: an architectural invariant recorded early was
  // dropped four tasks later to make room for a note about a JPA default,
  // purely because it was older.
  const merged = mergeLearnings({
    existing: ["layer rule", "jpa default tip"],
    stats: [
      { hits: 3, fromRejection: true, lastSeen: 2 },
      { hits: 1, fromRejection: false, lastSeen: 9 },
    ],
    incoming: ["something new"],
    iteration: 10,
    max: 2,
  });

  assert.deepEqual(merged.learnings, ["layer rule", "something new"]);
});

test("an insight paid for with a rejected review outlives one from a clean pass", () => {
  const cheap = mergeLearnings({ existing: [], incoming: ["tip"], iteration: 0 });
  const paid = mergeLearnings({ existing: [], incoming: ["rule"], iteration: 0, fromRejection: true });

  assert.ok(learningScore(paid.stats[0], 6) > learningScore(cheap.stats[0], 6));
  // Both still cool with time; the paid one simply starts higher.
  assert.ok(learningScore(paid.stats[0], 20) < learningScore(paid.stats[0], 6));
});

test("a plan written before scoring existed reads as neutral instead of failing", () => {
  const merged = mergeLearnings({ existing: ["a", "b"], incoming: ["c"], iteration: 4 });

  assert.equal(merged.stats.length, 3);
  for (const stat of merged.stats) assert.equal(stat.hits, 1);
});

test("mergeLearnings keeps the default cap consistent with MAX_LEARNINGS", () => {
  const existing = Array.from({ length: MAX_LEARNINGS }, (_, i) => `learning ${i}`);
  const merged = mergeLearnings({ existing, incoming: ["overflow learning"], iteration: 1 });

  assert.equal(merged.learnings.length, MAX_LEARNINGS);
  assert.ok(merged.learnings.includes("overflow learning"));
});
