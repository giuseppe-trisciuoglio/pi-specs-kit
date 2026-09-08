import test from "node:test";
import assert from "node:assert/strict";
import {
  addBlockers,
  blockersForTask,
  buildFailureLearnerPrompt,
  injectableBlockers,
  MAX_BLOCKERS,
  MAX_BLOCKERS_CHARS,
  MAX_BLOCKER_TEXT,
  normalizeBlockers,
  parseBlockers,
  promotableFacts,
  pruneTaskBlockers,
  repeatedWall,
  resolveTaskBlockers,
  type Blocker,
} from "../src/loop/blockers.ts";

function blocker(overrides: Partial<Blocker> = {}): Blocker {
  return { task: "TASK-005", attempt: 1, kind: "verified_fact", text: "a fact", resolved: false, ...overrides };
}

test("labelled bullets become blockers, unlabelled ones are dropped", () => {
  const text = [
    "Here is what stopped the attempt:",
    "- VERIFIED_FACT: getPhase() returns Integer.MAX_VALUE - 1024",
    "- SPEC_CONTRADICTION: the manifest and the cited decision give different paths",
    "- the probe beans go live in every test suite",
    "* UNOWNED_DECISION: nobody decided whether probes are lazy",
    "3) ENV: the build times out after 15 minutes",
  ].join("\n");

  const found = parseBlockers(text, "TASK-005", 2);

  assert.deepEqual(
    found.map((b) => b.kind),
    ["verified_fact", "spec_contradiction", "unowned_decision", "env"],
  );
  // A bullet with no label says nothing about what the loop should do with it,
  // and the kind is exactly what decides between a retry and an escalation.
  assert.ok(!found.some((b) => b.text.includes("probe beans")));
  assert.ok(found.every((b) => b.task === "TASK-005" && b.attempt === 2 && !b.resolved));
});

test("a blocker longer than the per-entry cap is truncated where it is recorded", () => {
  const found = parseBlockers(`- ENV: ${"x".repeat(MAX_BLOCKER_TEXT * 2)}`, "TASK-001", 1);

  assert.equal(found.length, 1);
  assert.equal(found[0].text.length, MAX_BLOCKER_TEXT);
});

test("the same entry twice in one answer is stored once", () => {
  const found = parseBlockers("- ENV: the build times out\n- env: The build times out.", "TASK-001", 1);

  assert.equal(found.length, 1);
});

test("the memory rotates the oldest out when it overflows", () => {
  const existing = Array.from({ length: MAX_BLOCKERS }, (_, i) => blocker({ text: `old ${i}` }));

  const merged = addBlockers(existing, [blocker({ text: "the newest one" })]);

  assert.equal(merged.length, MAX_BLOCKERS);
  assert.equal(merged[merged.length - 1].text, "the newest one");
  assert.ok(!merged.some((b) => b.text === "old 0"), "the coldest, which here is the oldest, goes");
});

test("injection deduplicates a wall several attempts hit and keeps the order found", () => {
  const stored = [
    blocker({ attempt: 1, kind: "unowned_decision", text: "who owns the probe schedule" }),
    blocker({ attempt: 1, text: "getPhase() returns MAX_VALUE - 1024" }),
    blocker({ attempt: 2, kind: "unowned_decision", text: "Who owns the probe schedule?" }),
  ];

  const injected = injectableBlockers(stored);

  assert.deepEqual(
    injected.map((b) => b.text),
    ["getPhase() returns MAX_VALUE - 1024", "Who owns the probe schedule?"],
  );
});

test("injection stops at the character budget, newest first", () => {
  const long = (n: number): Blocker => blocker({ attempt: n, text: `${n} ${"x".repeat(MAX_BLOCKERS_CHARS / 2 - 30)}` });

  const injected = injectableBlockers([long(1), long(2), long(3)]);

  assert.equal(injected.length, 2);
  assert.deepEqual(injected.map((b) => b.attempt), [2, 3]);
});

test("a wall repeated in two consecutive attempts is found, a fact is not", () => {
  const stored = [
    blocker({ attempt: 1, kind: "spec_contradiction", text: "the decision R4-E5 does not exist" }),
    blocker({ attempt: 2, kind: "spec_contradiction", text: "The decision R4-E5 does not exist." }),
    blocker({ attempt: 1, text: "getPhase() returns MAX_VALUE - 1024" }),
    blocker({ attempt: 2, text: "getPhase() returns MAX_VALUE - 1024" }),
  ];

  const wall = repeatedWall(stored, "TASK-005", 2);

  assert.equal(wall?.kind, "spec_contradiction");
  // A fact repeated is not a wall: it is memory doing its job.
  assert.equal(repeatedWall(stored.slice(2), "TASK-005", 2), null);
});

test("an action only a person can perform is a wall, and is labelled as one", () => {
  // What ENV used to stand in for: a credential, an account, a signature. ENV
  // is a build or a network, which a retry may legitimately clear; this never
  // is, so the second hit ends the task instead of buying another spawn.
  const stored = [
    blocker({ attempt: 1, kind: "operator_action", text: "no vault write access for the provider credential" }),
    blocker({ attempt: 2, kind: "operator_action", text: "No vault write access for the provider credential." }),
  ];

  assert.equal(repeatedWall(stored, "TASK-005", 2)?.kind, "operator_action");
  assert.deepEqual(
    parseBlockers("- OPERATOR_ACTION: the account has to be bought by a person", "TASK-005", 1).map((b) => b.kind),
    ["operator_action"],
  );
});

test("a wall of another task, or of a non-consecutive attempt, is not a repeat", () => {
  const first = blocker({ attempt: 1, kind: "unowned_decision", text: "who owns the schedule" });
  const third = blocker({ attempt: 3, kind: "unowned_decision", text: "who owns the schedule" });

  assert.equal(repeatedWall([first, third], "TASK-005", 3), null);
  assert.equal(repeatedWall([first, { ...third, task: "TASK-006" }], "TASK-006", 3), null);
});

test("a task's blockers are resolved on the pass and pruned right after", () => {
  const stored = [blocker({ text: "mine" }), blocker({ task: "TASK-006", text: "someone else's" })];

  const resolved = resolveTaskBlockers(stored, "TASK-005");
  assert.deepEqual(resolved.map((b) => b.resolved), [true, false]);
  assert.deepEqual(blockersForTask(resolved, "TASK-005"), []);

  const pruned = pruneTaskBlockers(resolved, "TASK-005");
  assert.deepEqual(pruned.map((b) => b.task), ["TASK-006"]);
});

test("only verified facts are offered to the learner, deduplicated", () => {
  const stored = [
    blocker({ attempt: 1, text: "getPhase() returns MAX_VALUE - 1024" }),
    blocker({ attempt: 2, text: "GetPhase() returns MAX_VALUE - 1024" }),
    blocker({ attempt: 2, kind: "spec_contradiction", text: "the manifest contradicts itself" }),
  ];

  assert.deepEqual(promotableFacts(stored, "TASK-005"), ["getPhase() returns MAX_VALUE - 1024"]);
});

test("a persisted state of any shape loads without breaking the plan", () => {
  assert.equal(normalizeBlockers(undefined), undefined);
  assert.deepEqual(normalizeBlockers([]), []);
  assert.deepEqual(
    normalizeBlockers([
      { task: "TASK-001", attempt: 2, kind: "env", text: "timeout", resolved: true },
      { task: "TASK-001", kind: "made_up", text: "nope" },
      { kind: "env", text: "no task" },
      "not an object",
    ]),
    [{ task: "TASK-001", attempt: 2, kind: "env", text: "timeout", resolved: true }],
  );
});

test("the failure learner is told what failed, the labels, and what earlier attempts found", () => {
  const prompt = buildFailureLearnerPrompt({
    taskId: "TASK-005",
    title: "Provider health probes",
    attempt: 2,
    detail: "implementation timeout: the phase ran past its ceiling",
    known: ["VERIFIED_FACT: getPhase() returns MAX_VALUE - 1024"],
  });

  assert.match(prompt, /Attempt 2 of the task TASK-005 "Provider health probes"/);
  assert.match(prompt, /What the loop observed: implementation timeout/);
  for (const label of ["SPEC_CONTRADICTION", "VERIFIED_FACT", "UNOWNED_DECISION", "OPERATOR_ACTION", "ENV"]) {
    assert.ok(prompt.includes(label), `missing label ${label}`);
  }
  assert.ok(prompt.includes("getPhase() returns MAX_VALUE - 1024"));
  assert.match(prompt, /do not modify\nany file/i);
});
