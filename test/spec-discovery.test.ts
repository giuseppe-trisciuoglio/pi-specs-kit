import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverSpecs } from "../src/loop/spec-discovery.ts";

const SPECS_DIR = "docs/specs";

function project(): string {
  return mkdtempSync(path.join(tmpdir(), "spec-discovery-"));
}

function mkSpec(root: string, name: string): string {
  const dir = path.join(root, SPECS_DIR, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("missing specs root yields an empty list", async () => {
  assert.deepEqual(await discoverSpecs(project(), SPECS_DIR), []);
});

test("discovers specs with and without tasks, sorted by directory", async () => {
  const root = project();
  const withTasks = mkSpec(root, "002-beta");
  mkdirSync(path.join(withTasks, "tasks"));
  writeFileSync(path.join(withTasks, "tasks", "TASK-001.md"), "# t\n");
  mkSpec(root, "001-alpha"); // no tasks yet
  const specs = await discoverSpecs(root, SPECS_DIR);
  assert.deepEqual(specs, [
    { dir: path.join(SPECS_DIR, "001-alpha"), hasTasks: false },
    { dir: path.join(SPECS_DIR, "002-beta"), hasTasks: true },
  ]);
});

test("empty tasks directory does not count as having tasks", async () => {
  const root = project();
  const dir = mkSpec(root, "001-alpha");
  mkdirSync(path.join(dir, "tasks"));
  const specs = await discoverSpecs(root, SPECS_DIR);
  assert.deepEqual(specs, [{ dir: path.join(SPECS_DIR, "001-alpha"), hasTasks: false }]);
});

test("a tasks dir without task files does not count as having tasks", async () => {
  const root = project();
  const dir = mkSpec(root, "001-alpha");
  mkdirSync(path.join(dir, "tasks"));
  // A leftover review report and a placeholder: the loader would find nothing.
  writeFileSync(path.join(dir, "tasks", "TASK-001--review.md"), "# stale review\n");
  writeFileSync(path.join(dir, "tasks", ".gitkeep"), "");
  writeFileSync(path.join(dir, "tasks", "README.md"), "notes\n");
  const specs = await discoverSpecs(root, SPECS_DIR);
  assert.deepEqual(specs, [{ dir: path.join(SPECS_DIR, "001-alpha"), hasTasks: false }]);
});

test("hidden directories at the specs root are not specs", async () => {
  const root = project();
  mkSpec(root, "001-alpha");
  mkSpec(root, ".git");
  const specs = await discoverSpecs(root, SPECS_DIR);
  assert.deepEqual(specs, [{ dir: path.join(SPECS_DIR, "001-alpha"), hasTasks: false }]);
});

test("plain files at the specs root are ignored", async () => {
  const root = project();
  mkSpec(root, "001-alpha");
  writeFileSync(path.join(root, SPECS_DIR, "README.md"), "note\n");
  const specs = await discoverSpecs(root, SPECS_DIR);
  assert.deepEqual(specs, [{ dir: path.join(SPECS_DIR, "001-alpha"), hasTasks: false }]);
});
