import test from "node:test";
import assert from "node:assert/strict";
import { briefFileName, buildBriefPrompt } from "../src/loop/brief.ts";
import { briefBlock } from "../src/prompt/prompt-blocks.ts";
import type { TaskFile } from "../src/tasks/task-parser.ts";

const TASK: TaskFile = {
  path: "/proj/specs/001-spec/tasks/TASK-002.md",
  num: 2,
  frontmatter: {
    id: "TASK-002",
    title: "Add the retry helper",
    status: "pending",
    dependencies: [],
    acMapping: [],
    impRequirements: [],
    provides: [],
  },
  body: "Extract the retry logic into a helper.",
};

test("briefFileName follows the task artifact naming", () => {
  assert.equal(briefFileName("TASK-002"), "TASK-002--brief.md");
});

test("the brief prompt asks for a read-only spawn writing the brief file", () => {
  const prompt = buildBriefPrompt({ task: TASK, briefPath: "specs/001-spec/tasks/TASK-002--brief.md" });
  assert.ok(prompt.includes("TASK-002--brief.md"));
  assert.ok(prompt.includes("do not modify any code"));
  assert.ok(prompt.includes("graphify-out/graph.json"));
  assert.ok(prompt.includes(".pi/rules"));
  // The sections the brief must contain, per the reading brief contract.
  assert.ok(prompt.includes("Files to touch"));
  assert.ok(prompt.includes("Patterns"));
  assert.ok(prompt.includes("tests to run"));
  assert.ok(prompt.includes("previous work left"));
  assert.ok(prompt.includes("Extract the retry logic into a helper."));
});

test("the brief prompt carries routed fixes and both memory channels", () => {
  const prompt = buildBriefPrompt({
    task: TASK,
    briefPath: "tasks/TASK-002--brief.md",
    routedSuggestions: [{ to: "TASK-002", text: "reuse the shared parser", from: "TASK-000" }],
    learnings: ["spec learnings travel in prompts"],
    projectLearnings: ["project learnings survive specs"],
  });
  assert.ok(prompt.includes("reuse the shared parser"));
  assert.ok(prompt.includes("spec learnings travel in prompts"));
  assert.ok(prompt.includes("project learnings survive specs"));
});

test("the brief block is present only when a brief exists", () => {
  assert.equal(briefBlock(null), null);
  assert.equal(briefBlock(undefined), null);
  assert.equal(briefBlock("   \n"), null);
  const block = briefBlock("Files to touch: src/util/retry.ts");
  assert.ok(block?.startsWith("<task_brief>"));
  assert.ok(block?.includes("src/util/retry.ts"));
});
