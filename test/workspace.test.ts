import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loopArtifactExclusions, workspaceFingerprint } from "../src/loop/workspace.ts";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

/** Fresh git repository in a temp dir with one commit, so HEAD is born. */
function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "workspace-test-"));
  for (const args of [
    ["init"],
    ["config", "user.email", "loop@example.invalid"],
    ["config", "user.name", "Loop Test"],
  ]) {
    assert.equal(spawnSync("git", args, { cwd: dir, stdio: "ignore" }).status, 0, `git ${args[0]} failed`);
  }
  writeFileSync(path.join(dir, "src.txt"), "original\n");
  spawnSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "first"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("an unchanged worktree fingerprints identically", { skip: !gitAvailable }, async () => {
  const dir = initRepo();

  const before = await workspaceFingerprint(dir);
  const after = await workspaceFingerprint(dir);

  assert.ok(before, "fingerprint should be readable in a git repo");
  assert.equal(after, before);
});

test("editing a tracked file changes the fingerprint", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  const before = await workspaceFingerprint(dir);

  writeFileSync(path.join(dir, "src.txt"), "edited\n");

  assert.notEqual(await workspaceFingerprint(dir), before);
});

test("an untracked new file changes the fingerprint", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  const before = await workspaceFingerprint(dir);

  writeFileSync(path.join(dir, "added.txt"), "brand new\n");

  assert.notEqual(await workspaceFingerprint(dir), before);
});

test("a change under an excluded path leaves the fingerprint alone", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  mkdirSync(path.join(dir, "specs", "001", "_ralph_loop"), { recursive: true });
  const excluded = ["specs/001/_ralph_loop"];
  const before = await workspaceFingerprint(dir, excluded);

  writeFileSync(path.join(dir, "specs", "001", "_ralph_loop", "fix_plan.json"), '{"step":"review"}');

  assert.equal(await workspaceFingerprint(dir, excluded), before);
  // The exclusion is scoped: a sibling file under the same spec still counts.
  writeFileSync(path.join(dir, "specs", "001", "notes.md"), "real work\n");
  assert.notEqual(await workspaceFingerprint(dir, excluded), before);
});

test("ignored paths never reach the fingerprint", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  writeFileSync(path.join(dir, ".gitignore"), "target/\n");
  const before = await workspaceFingerprint(dir);

  mkdirSync(path.join(dir, "target"), { recursive: true });
  writeFileSync(path.join(dir, "target", "app.jar"), "build output");

  assert.equal(await workspaceFingerprint(dir), before);
});

test("the real index is never touched", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  writeFileSync(path.join(dir, "staged.txt"), "deliberately staged\n");
  spawnSync("git", ["add", "staged.txt"], { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "loose.txt"), "deliberately unstaged\n");
  const indexBefore = readFileSync(path.join(dir, ".git", "index"));

  await workspaceFingerprint(dir);

  const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout;
  assert.ok(status.includes("A  staged.txt"), `staged file lost its staging: ${status}`);
  assert.ok(status.includes("?? loose.txt"), `unstaged file got staged: ${status}`);
  assert.deepEqual(readFileSync(path.join(dir, ".git", "index")), indexBefore);
});

test("a directory outside git yields no fingerprint instead of throwing", { skip: !gitAvailable }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "workspace-plain-"));
  writeFileSync(path.join(dir, "src.txt"), "not tracked anywhere");

  assert.equal(await workspaceFingerprint(dir), null);
});

test("loopArtifactExclusions points at the loop folder of the spec", () => {
  assert.deepEqual(loopArtifactExclusions("/repo", "/repo/docs/specs/001"), ["docs/specs/001/_ralph_loop"]);
  // A spec folder outside the project root writes nothing this tree would see.
  assert.deepEqual(loopArtifactExclusions("/repo", "/elsewhere/001"), []);
  assert.deepEqual(loopArtifactExclusions("/repo", "/repo"), []);
});
