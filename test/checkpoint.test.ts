import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitCheckpoint } from "../src/loop/checkpoint.ts";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

/** Fresh git repository in a temp dir with a local identity configured. */
function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "checkpoint-test-"));
  for (const args of [
    ["init"],
    ["config", "user.email", "loop@example.invalid"],
    ["config", "user.name", "Loop Test"],
  ]) {
    const res = spawnSync("git", args, { cwd: dir, stdio: "ignore" });
    assert.equal(res.status, 0, `git ${args[0]} failed`);
  }
  return dir;
}

function gitLog(dir: string): string {
  const res = spawnSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, `git log failed: ${res.stderr}`);
  return res.stdout;
}

test("commitCheckpoint commits pending changes", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  writeFileSync(path.join(dir, "state.txt"), "work in progress");

  const result = await commitCheckpoint(dir, "checkpoint: task done");

  assert.equal(result.committed, true);
  assert.equal(result.reason, undefined);
  assert.ok(gitLog(dir).includes("checkpoint: task done"), "checkpoint commit missing from git log");
});

test("commitCheckpoint reports a clean tree as 'no changes'", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  writeFileSync(path.join(dir, "state.txt"), "work in progress");
  assert.equal((await commitCheckpoint(dir, "first")).committed, true);

  const result = await commitCheckpoint(dir, "second");

  assert.equal(result.committed, false);
  assert.equal(result.reason, "no changes");
});

test("commitCheckpoint on a non-git directory fails without throwing", { skip: !gitAvailable }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "checkpoint-plain-"));
  writeFileSync(path.join(dir, "state.txt"), "not tracked anywhere");

  const result = await commitCheckpoint(dir, "should not happen");

  assert.equal(result.committed, false);
  assert.ok(typeof result.reason === "string" && result.reason.length > 0);
});
