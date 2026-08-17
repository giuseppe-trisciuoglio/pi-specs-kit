import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("the loop's own artifacts stay out of the checkpoint", { skip: !gitAvailable }, async () => {
  // A checkpoint is meant to capture the work. The state file, the phase logs
  // and the generated graph are outputs of the run, and once swept in they
  // travel with every later commit into whatever the branch becomes.
  const dir = initRepo();
  mkdirSync(path.join(dir, "graphify-out"), { recursive: true });
  mkdirSync(path.join(dir, "docs/specs/001/_ralph_loop"), { recursive: true });
  writeFileSync(path.join(dir, "src.txt"), "the work");
  writeFileSync(path.join(dir, "graphify-out/graph.json"), "{}");
  writeFileSync(path.join(dir, "docs/specs/001/_ralph_loop/fix_plan.json"), "{}");

  const result = await commitCheckpoint(dir, "checkpoint: task", [
    "graphify-out",
    "docs/specs/001/_ralph_loop",
  ]);

  assert.equal(result.committed, true);
  const tracked = spawnSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  assert.deepEqual(tracked, ["src.txt"]);
});

test("without exclusions the checkpoint still takes the whole tree", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  mkdirSync(path.join(dir, "graphify-out"), { recursive: true });
  writeFileSync(path.join(dir, "src.txt"), "the work");
  writeFileSync(path.join(dir, "graphify-out/graph.json"), "{}");

  assert.equal((await commitCheckpoint(dir, "checkpoint: task")).committed, true);

  const tracked = spawnSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  assert.deepEqual(tracked, ["graphify-out/graph.json", "src.txt"]);
});
