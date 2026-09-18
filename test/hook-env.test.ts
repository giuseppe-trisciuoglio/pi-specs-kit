import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  CHANGED_FILES_PATH_VAR,
  CHANGED_FILES_VAR,
  exportablePaths,
  openHookEnv,
} from "../src/loop/hook-env.ts";

test("exportablePaths keeps the order, drops blanks and duplicates", () => {
  assert.deepEqual(exportablePaths(["src/a.ts", "", "  ", "src/b.ts", "src/a.ts"]), ["src/a.ts", "src/b.ts"]);
});

test("exportablePaths strips the control characters a newline-separated list cannot carry", () => {
  assert.deepEqual(exportablePaths(["src/we\nird.ts", "src/nul\0.ts"]), ["src/weird.ts", "src/nul.ts"]);
});

test("exportablePaths reads an unreadable tree as an empty list", () => {
  assert.deepEqual(exportablePaths(null), []);
});

test("openHookEnv exports the list inline and in a file", async () => {
  const env = await openHookEnv(["src/a.ts", "src/b.ts"]);
  try {
    assert.equal(env.vars[CHANGED_FILES_VAR], "src/a.ts\nsrc/b.ts");
    const listFile = env.vars[CHANGED_FILES_PATH_VAR];
    assert.notEqual(listFile, "", "a non-empty list gets a file");
    assert.equal(readFileSync(listFile, "utf8"), "src/a.ts\nsrc/b.ts\n");
  } finally {
    await env.release();
  }
});

test("release drops the temp file", async () => {
  const env = await openHookEnv(["src/a.ts"]);
  const listFile = env.vars[CHANGED_FILES_PATH_VAR];
  await env.release();
  assert.equal(existsSync(listFile), false);
});

test("an unreadable tree sets both variables empty and writes no file", async () => {
  const env = await openHookEnv(null);
  try {
    assert.equal(env.vars[CHANGED_FILES_VAR], "");
    assert.equal(env.vars[CHANGED_FILES_PATH_VAR], "");
  } finally {
    await env.release();
  }
});
