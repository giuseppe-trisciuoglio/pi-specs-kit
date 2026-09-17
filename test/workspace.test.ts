import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  changedWorkspaceFiles,
  loopArtifactExclusions,
  reviewArtifactExclusions,
  workspaceDiff,
  workspaceFingerprint,
} from "../src/loop/workspace.ts";

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

test("loopArtifactExclusions covers the loop folder of the spec and the generated graph", () => {
  assert.deepEqual(loopArtifactExclusions("/repo", "/repo/docs/specs/001"), [
    "graphify-out",
    "docs/specs/001/_ralph_loop",
  ]);
  // A spec folder outside the project root writes nothing this tree would see,
  // but the graph is generated into the project root either way.
  assert.deepEqual(loopArtifactExclusions("/repo", "/elsewhere/001"), ["graphify-out"]);
  assert.deepEqual(loopArtifactExclusions("/repo", "/repo"), ["graphify-out"]);
});

test("the diff from a fingerprint taken earlier is the patch of what changed", { skip: !gitAvailable }, async () => {
  // The tree object a fingerprint writes lands in the repository's own object
  // store, which is what lets a phase diff against a tree an earlier phase saw.
  const dir = initRepo();
  const base = await workspaceFingerprint(dir);

  writeFileSync(path.join(dir, "src.txt"), "edited by the retry\n");
  writeFileSync(path.join(dir, "added.txt"), "brand new\n");

  const diff = await workspaceDiff(dir, base, [], 64 * 1024);

  assert.ok(diff, "a changed worktree yields a patch");
  assert.equal(diff.truncated, false);
  assert.match(diff.stat, /src\.txt/);
  assert.match(diff.stat, /added\.txt/);
  assert.match(diff.patch, /\+edited by the retry/);
  assert.match(diff.patch, /\+brand new/);
});

test("a worktree the retry left alone yields no patch at all", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  const base = await workspaceFingerprint(dir);

  assert.equal(await workspaceDiff(dir, base, [], 64 * 1024), null);
});

test("the patch is cut at the ceiling and says so", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  const base = await workspaceFingerprint(dir);
  writeFileSync(path.join(dir, "src.txt"), "x\n".repeat(5000));

  const diff = await workspaceDiff(dir, base, [], 200);

  assert.ok(diff);
  assert.equal(diff.truncated, true);
  assert.match(diff.patch, /characters omitted/);
  // The stat is never cut: it is how a reader learns which files the patch
  // stops short of, and it costs one line per file.
  assert.match(diff.stat, /src\.txt/);
});

test("a diff without a base tree, without git or without a ceiling is simply absent", async () => {
  const dir = gitAvailable ? initRepo() : mkdtempSync(path.join(tmpdir(), "workspace-test-"));
  const base = gitAvailable ? await workspaceFingerprint(dir) : "0".repeat(40);

  assert.equal(await workspaceDiff(dir, null, [], 1024), null, "no base tree, no patch");
  assert.equal(await workspaceDiff(dir, base, [], 0), null, "a ceiling of zero turns the channel off");
  assert.equal(
    await workspaceDiff(mkdtempSync(path.join(tmpdir(), "workspace-nogit-")), "deadbeef", [], 1024),
    null,
    "outside a repository the signal is absent, never an exception",
  );
});

test("reviewArtifactExclusions keeps the archived verdicts out of the patch", () => {
  const root = "/repo";
  const excluded = reviewArtifactExclusions(root, "/repo/docs/specs/001-spec");

  assert.deepEqual(excluded, [
    "docs/specs/001-spec/tasks/*--review.md",
    "docs/specs/001-spec/tasks/*--review.attempt-*.md",
    "docs/specs/001-spec/tasks/*--review.unreadable.md",
  ]);
  assert.deepEqual(reviewArtifactExclusions(root, "/elsewhere/001-spec"), [], "a spec outside the tree excludes nothing");
});

test("the review artifacts never reach the patch a re-review reads", { skip: !gitAvailable }, async () => {
  // Between the two trees the loop archives the verdict it replaces. Left in,
  // the patch would hand the re-review the whole text of the previous one.
  const dir = initRepo();
  const tasks = path.join(dir, "docs/specs/001-spec/tasks");
  mkdirSync(tasks, { recursive: true });
  writeFileSync(path.join(tasks, "TASK-001--review.md"), "---\nreview_status: FAILED\n---\n\nthe verdict\n");
  const base = await workspaceFingerprint(dir);

  writeFileSync(path.join(tasks, "TASK-001--review.attempt-1.md"), "---\nreview_status: FAILED\n---\n\nthe verdict\n");
  writeFileSync(path.join(dir, "src.txt"), "the retry's work\n");

  const excluded = reviewArtifactExclusions(dir, path.join(dir, "docs/specs/001-spec"));
  const diff = await workspaceDiff(dir, base, excluded, 64 * 1024);

  assert.ok(diff);
  assert.match(diff.patch, /the retry's work/);
  assert.ok(!diff.patch.includes("the verdict"), "the archived verdict stays out of the patch");
  assert.ok(!diff.stat.includes("review"), "and out of the summary above it");
});

test("changedWorkspaceFiles lists what stands on top of the last commit", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  assert.deepEqual(await changedWorkspaceFiles(dir), [], "a committed tree has changed nothing");

  writeFileSync(path.join(dir, "src.txt"), "edited\n");
  mkdirSync(path.join(dir, "mod"), { recursive: true });
  writeFileSync(path.join(dir, "mod", "added.txt"), "brand new\n");

  assert.deepEqual(await changedWorkspaceFiles(dir), ["mod/added.txt", "src.txt"]);
});

test("changedWorkspaceFiles leaves out the excluded and the ignored paths", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  writeFileSync(path.join(dir, ".gitignore"), "target/\n");
  spawnSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "ignore rules"], { cwd: dir, stdio: "ignore" });
  mkdirSync(path.join(dir, "specs", "001", "_ralph_loop"), { recursive: true });
  writeFileSync(path.join(dir, "specs", "001", "_ralph_loop", "fix_plan.json"), '{"step":"review"}');
  mkdirSync(path.join(dir, "target"), { recursive: true });
  writeFileSync(path.join(dir, "target", "app.jar"), "build output");
  writeFileSync(path.join(dir, "src.txt"), "edited\n");

  assert.deepEqual(await changedWorkspaceFiles(dir, ["specs/001/_ralph_loop"]), ["src.txt"]);
});

test("an unborn HEAD reads the whole worktree as changed", { skip: !gitAvailable }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "workspace-unborn-"));
  assert.equal(spawnSync("git", ["init"], { cwd: dir, stdio: "ignore" }).status, 0);
  writeFileSync(path.join(dir, "first.txt"), "nothing committed yet\n");

  assert.deepEqual(await changedWorkspaceFiles(dir), ["first.txt"]);
});

test("a directory outside git yields no list instead of throwing", { skip: !gitAvailable }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "workspace-plain-"));
  writeFileSync(path.join(dir, "src.txt"), "not tracked anywhere");

  assert.equal(await changedWorkspaceFiles(dir), null);
});

test("reading the changed files never touches the real index", { skip: !gitAvailable }, async () => {
  const dir = initRepo();
  writeFileSync(path.join(dir, "staged.txt"), "deliberately staged\n");
  spawnSync("git", ["add", "staged.txt"], { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "loose.txt"), "deliberately unstaged\n");
  const indexBefore = readFileSync(path.join(dir, ".git", "index"));

  assert.deepEqual(await changedWorkspaceFiles(dir), ["loose.txt", "staged.txt"]);

  assert.deepEqual(readFileSync(path.join(dir, ".git", "index")), indexBefore);
});
