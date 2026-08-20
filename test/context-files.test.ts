/**
 * Spec documents inlined in the prompt: what the two budgets admit, what they
 * cut, and what they name instead of dropping.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTEXT_FILES_BUDGET,
  CONTEXT_FILE_LIMIT,
  inlinesSpecDocs,
  loadSpecDocs,
} from "../src/prompt/context-files.ts";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

async function specDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "context-files-"));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

test("only the phases whose reading surface is the spec folder inline it", () => {
  assert.ok(inlinesSpecDocs("review"));
  assert.ok(inlinesSpecDocs("sync"));
  assert.ok(!inlinesSpecDocs("implementation"));
  assert.ok(!inlinesSpecDocs("cleanup"));
});

test("top-level markdown is read in name order, subdirectories are left alone", async () => {
  const dir = await specDir({
    "spec.md": "the spec",
    "decision-log.md": "the decisions",
    "notes.txt": "not markdown",
    "tasks/TASK-001.md": "the phase already has its own task",
    "_ralph_loop/fix_plan.json": "{}",
  });

  const set = await loadSpecDocs(dir);

  assert.deepEqual(
    set.files.map((f) => path.basename(f.path)),
    ["decision-log.md", "spec.md"],
  );
  assert.deepEqual(set.omitted, []);
  assert.ok(set.files.every((f) => path.isAbsolute(f.path)));
});

test("a document longer than the per-file limit arrives truncated and says so", async () => {
  const dir = await specDir({ "spec.md": "x".repeat(CONTEXT_FILE_LIMIT + 500) });

  const set = await loadSpecDocs(dir);

  assert.equal(set.files.length, 1);
  assert.equal(set.files[0].truncated, true);
  assert.equal(set.files[0].content.length, CONTEXT_FILE_LIMIT);
});

test("what the budget cannot fit is named, not dropped", async () => {
  const dir = await specDir({ "a.md": "a".repeat(80), "b.md": "b".repeat(80) });

  const set = await loadSpecDocs(dir, { budget: 100 });

  assert.deepEqual(
    set.files.map((f) => path.basename(f.path)),
    ["a.md"],
  );
  assert.deepEqual(
    set.omitted.map((p) => path.basename(p)),
    ["b.md"],
  );
});

test("a document too large to be worth reading is named without being opened", async () => {
  // Four times the per-file limit: the head would be cut anyway, so the path
  // carries it instead of the I/O.
  const dir = await specDir({ "huge.md": "h".repeat(CONTEXT_FILE_LIMIT * 4 + 1) });

  const set = await loadSpecDocs(dir);

  assert.deepEqual(set.files, []);
  assert.deepEqual(
    set.omitted.map((p) => path.basename(p)),
    ["huge.md"],
  );
});

test("an empty document contributes nothing at all", async () => {
  const dir = await specDir({ "blank.md": "\n\n  \n" });

  const set = await loadSpecDocs(dir);

  assert.deepEqual(set.files, []);
  assert.deepEqual(set.omitted, []);
});

test("an unreadable spec folder leaves the phase to discover it the old way", async () => {
  const set = await loadSpecDocs(path.join(tmpdir(), "context-files-absent-", String(Date.now())));

  assert.deepEqual(set.files, []);
  assert.deepEqual(set.omitted, []);
});

test("the default budget admits at least a handful of whole documents", () => {
  assert.ok(CONTEXT_FILES_BUDGET >= CONTEXT_FILE_LIMIT * 4);
});
