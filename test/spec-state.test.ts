import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveAuthoringStep } from "../src/authoring/spec-state.ts";

const SPEC_REL = "docs/specs/001-feature";

/** Fresh temp project root. */
function project(): string {
  return mkdtempSync(path.join(tmpdir(), "spec-state-"));
}

/** Create and return the spec dir path inside the given project root. */
function specDir(root: string): string {
  const dir = path.join(root, SPEC_REL);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("missing spec directory falls back to brainstorm", async () => {
  const root = project();
  const step = await deriveAuthoringStep(root, SPEC_REL);
  assert.equal(step.stage, "brainstorm");
  assert.equal(step.skillName, "specs-kit-brainstorm");
  assert.ok(step.directive.includes(SPEC_REL), "directive names the spec dir");
});

test("empty spec directory (aux files only) still needs brainstorm", async () => {
  const root = project();
  const dir = specDir(root);
  writeFileSync(path.join(dir, "user-request.md"), "idea");
  writeFileSync(path.join(dir, "brainstorming-notes.md"), "notes");
  const step = await deriveAuthoringStep(root, SPEC_REL);
  assert.equal(step.stage, "brainstorm");
});

test("functional spec with open questions routes to spec-check", async () => {
  const root = project();
  const dir = specDir(root);
  writeFileSync(
    path.join(dir, "2026-01-02--feature.md"),
    "# Spec\nThe system SHALL behave [NEEDS CLARIFICATION: which way?] when idle.\n",
  );
  const step = await deriveAuthoringStep(root, SPEC_REL);
  assert.equal(step.stage, "spec-check");
  assert.equal(step.skillName, "specs-kit-spec-check");
  assert.ok(step.directive.includes("2026-01-02--feature.md"));
});

test("clean functional spec without technical plan routes to technical-plan", async () => {
  const root = project();
  const dir = specDir(root);
  writeFileSync(path.join(dir, "2026-01-02--feature.md"), "# Spec\nNo open questions here.\n");
  const step = await deriveAuthoringStep(root, SPEC_REL);
  assert.equal(step.stage, "technical-plan");
  assert.equal(step.skillName, "specs-kit-technical-plan");
});

test("functional spec plus technical plan routes to spec-to-tasks", async () => {
  const root = project();
  const dir = specDir(root);
  writeFileSync(path.join(dir, "2026-01-02--feature.md"), "# Spec\n");
  writeFileSync(path.join(dir, "2026-01-03--technical-plan.md"), "# Tech plan\n");
  const step = await deriveAuthoringStep(root, SPEC_REL);
  assert.equal(step.stage, "spec-to-tasks");
  assert.equal(step.skillName, "specs-kit-spec-to-tasks");
});

test("tasks directory with task files marks the spec ready", async () => {
  const root = project();
  const dir = specDir(root);
  writeFileSync(path.join(dir, "2026-01-02--feature.md"), "# Spec\n");
  const tasks = path.join(dir, "tasks");
  mkdirSync(tasks);
  writeFileSync(path.join(tasks, "TASK-001.md"), "# Task 1\n");
  const step = await deriveAuthoringStep(root, SPEC_REL);
  assert.equal(step.stage, "ready");
  assert.equal(step.skillName, "");
  assert.ok(step.summary.includes("/specs-kit-run"));
});

test("spec-to-tasks artifacts are not mistaken for functional specs", async () => {
  const root = project();
  const dir = specDir(root);
  // A spec-to-tasks run that died before writing tasks/: only its own
  // artifacts are left at the spec root.
  writeFileSync(path.join(dir, "data-model.md"), "# Data model\n");
  writeFileSync(path.join(dir, "traceability-matrix.md"), "| ac | task |\n");
  writeFileSync(path.join(dir, "2026-01-02--feature--tasks.md"), "[NEEDS CLARIFICATION: nope]\n");
  const step = await deriveAuthoringStep(root, SPEC_REL);
  assert.equal(step.stage, "brainstorm", "no functional spec is present");
});

test("spec-check names the file that actually holds the marker", async () => {
  const root = project();
  const dir = specDir(root);
  writeFileSync(path.join(dir, "2026-01-02--feature.md"), "# Spec\nAll settled here.\n");
  writeFileSync(
    path.join(dir, "2026-01-05--second.md"),
    "# Spec\n[NEEDS CLARIFICATION: which way?]\n",
  );
  const step = await deriveAuthoringStep(root, SPEC_REL);
  assert.equal(step.stage, "spec-check");
  assert.ok(step.directive.includes("2026-01-05--second.md"), step.directive);
  assert.ok(!step.directive.includes("2026-01-02--feature.md"), step.directive);
});

test("a tasks directory holding only a review report is not ready", async () => {
  const root = project();
  const dir = specDir(root);
  writeFileSync(path.join(dir, "2026-01-02--feature.md"), "# Spec\n");
  writeFileSync(path.join(dir, "2026-01-03--technical-plan.md"), "# Tech plan\n");
  const tasks = path.join(dir, "tasks");
  mkdirSync(tasks);
  writeFileSync(path.join(tasks, "TASK-001--review.md"), "# stale review\n");
  const step = await deriveAuthoringStep(root, SPEC_REL);
  assert.equal(step.stage, "spec-to-tasks");
});

test("empty tasks directory does not mark the spec ready", async () => {
  const root = project();
  const dir = specDir(root);
  writeFileSync(path.join(dir, "2026-01-02--feature.md"), "# Spec\n");
  mkdirSync(path.join(dir, "tasks")); // no TASK-*.md inside
  const step = await deriveAuthoringStep(root, SPEC_REL);
  assert.equal(step.stage, "technical-plan");
});
