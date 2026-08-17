import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  changedProtectedPaths,
  protectedPathsFeedback,
  protectedSpecFiles,
  snapshotProtectedPaths,
} from "../src/loop/protected-paths.ts";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

/** Spec folder with a requirement document, a contract and the derived docs. */
async function createSpec(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "protected-paths-"));
  tmpDirs.push(root);
  const specDir = path.join(root, "001-spec");
  await mkdir(path.join(specDir, "contracts"), { recursive: true });
  await writeFile(path.join(specDir, "2026-08-17--feature.md"), "# Feature\n\nREQ-001 the system shall.\n");
  await writeFile(path.join(specDir, "2026-08-17--feature--tasks.md"), "# Tasks\n");
  await writeFile(path.join(specDir, "2026-08-17--feature--technical-plan.md"), "# Plan\n");
  await writeFile(path.join(specDir, "decision-log.md"), "# Decisions\n");
  await writeFile(path.join(specDir, "contracts", "git.md"), "the guard uses a dry-run push\n");
  return specDir;
}

test("the requirement document and the contracts are protected, the working docs are not", async () => {
  const specDir = await createSpec();

  const files = (await protectedSpecFiles(specDir)).map((f) => path.relative(specDir, f)).sort();

  assert.deepEqual(files, ["2026-08-17--feature.md", "contracts/git.md"]);
});

test("a rewritten contract is reported, a rewritten decision log is not", async () => {
  const specDir = await createSpec();
  const before = await snapshotProtectedPaths(specDir);

  await writeFile(path.join(specDir, "contracts", "git.md"), "the guard uses merge-base\n");
  await writeFile(path.join(specDir, "decision-log.md"), "# Decisions\n\nDEC-012 we changed the guard.\n");

  const changed = changedProtectedPaths(before, await snapshotProtectedPaths(specDir), specDir);
  assert.deepEqual(changed, ["contracts/git.md"]);
});

test("rewriting a protected file with identical bytes is not a change", async () => {
  const specDir = await createSpec();
  const before = await snapshotProtectedPaths(specDir);

  await writeFile(path.join(specDir, "contracts", "git.md"), "the guard uses a dry-run push\n");

  assert.deepEqual(changedProtectedPaths(before, await snapshotProtectedPaths(specDir), specDir), []);
});

test("deleting a protected document counts as changing it", async () => {
  const specDir = await createSpec();
  const before = await snapshotProtectedPaths(specDir);

  await rm(path.join(specDir, "2026-08-17--feature.md"));

  assert.deepEqual(changedProtectedPaths(before, await snapshotProtectedPaths(specDir), specDir), [
    "2026-08-17--feature.md",
  ]);
});

test("a spec folder that does not exist yields no snapshot and no findings", async () => {
  const snapshot = await snapshotProtectedPaths("/nowhere/at/all");

  assert.equal(snapshot.size, 0);
  assert.deepEqual(changedProtectedPaths(snapshot, snapshot, "/nowhere/at/all"), []);
});

test("the feedback names the files and rules out the way agents usually take", () => {
  const feedback = protectedPathsFeedback(["contracts/git.md"]);

  assert.match(feedback, /contracts\/git\.md/);
  assert.match(feedback, /Restore them/);
  assert.match(feedback, /Rewording them to match the code is never one of the two/);
});
