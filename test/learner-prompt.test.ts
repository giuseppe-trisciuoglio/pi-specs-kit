import test from "node:test";
import assert from "node:assert/strict";
import type { TaskFile } from "../src/tasks/task-parser.ts";
import {
  buildLearnerPrompt,
  CONFIRMED_PREFIX,
  MAX_CONFIRMATIONS,
  parseConfirmations,
} from "../src/loop/phase-spawn.ts";

const TASK = {
  path: "/proj/docs/specs/001/tasks/TASK-006.md",
  frontmatter: { id: "TASK-006", title: "Login use case", status: "pending", dependencies: [], provides: [] },
  body: "body",
} as unknown as TaskFile;

const KNOWN = [
  "the application layer imports no Spring Security types",
  "build on JDK 21 even though the system default is 25",
];

test("with nothing learned yet the prompt stays the compact original", () => {
  const prompt = buildLearnerPrompt(TASK);

  assert.match(prompt, /TASK-006 "Login use case"/);
  assert.ok(!prompt.includes("already recorded"), "no memory block when there is no memory");
  assert.ok(!prompt.includes(CONFIRMED_PREFIX));
});

test("what the project already knows is handed over, with the instruction not to restate it", () => {
  const prompt = buildLearnerPrompt(TASK, KNOWN);

  for (const known of KNOWN) assert.ok(prompt.includes(known), `missing: ${known}`);
  assert.match(prompt, /Do not restate them, not even\nin different words/);
  assert.match(prompt, /list only what this task added/);
  // Restating in new words is exactly what made duplicates invisible to the
  // loop, so the alternative offered is a pointer, not a rewrite.
  assert.ok(prompt.includes(CONFIRMED_PREFIX));
  assert.ok(prompt.includes(String(MAX_CONFIRMATIONS)));
});

test("a citation is accepted only when it quotes an insight the learner was shown", () => {
  const text = [
    "- something genuinely new",
    `${CONFIRMED_PREFIX} the application layer imports no Spring Security types`,
    `${CONFIRMED_PREFIX} an insight nobody ever recorded`,
  ].join("\n");

  assert.deepEqual(parseConfirmations(text, KNOWN), [KNOWN[0]]);
});

test("citations tolerate bullets, quoting and case but never fuzzy matches", () => {
  const text = [
    `- ${CONFIRMED_PREFIX} "Build on JDK 21 even though the system default is 25"`,
    `${CONFIRMED_PREFIX} the application layer avoids Spring Security imports`,
  ].join("\n");

  // The second line means the same thing in different words. It is dropped:
  // the citation is a pointer into known text, and a paraphrase is not one.
  assert.deepEqual(parseConfirmations(text, KNOWN), [KNOWN[1]]);
});

test("a learner citing everything is capped and deduplicated", () => {
  const known = Array.from({ length: 10 }, (_, i) => `insight number ${i}`);
  const text = [...known, ...known].map((k) => `${CONFIRMED_PREFIX} ${k}`).join("\n");

  const cited = parseConfirmations(text, known);

  assert.equal(cited.length, MAX_CONFIRMATIONS);
  assert.equal(new Set(cited).size, cited.length);
});

test("output without citations yields none", () => {
  assert.deepEqual(parseConfirmations("- just a new insight\n- and another", KNOWN), []);
});
