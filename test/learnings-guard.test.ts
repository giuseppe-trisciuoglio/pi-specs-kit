import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureLearningsGuard, enforceLearningsGuard } from "../src/loop/learnings-guard.ts";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

/** Project layout with the learnings file in the state the scenario needs. */
async function project(initial: string | null): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "learnings-guard-"));
  tmpDirs.push(root);
  await mkdir(path.join(root, "docs/specs"), { recursive: true });
  const file = path.join(root, "docs/specs/learnings.md");
  if (initial !== null) await writeFile(file, initial, "utf8");
  return { root, file };
}

test("an untouched learnings file is left alone and reports no change", async () => {
  const { root, file } = await project("- keep modules small\n");
  const guard = await captureLearningsGuard(root, "docs/specs");

  assert.equal(await enforceLearningsGuard(guard), false);
  assert.equal(await readFile(file, "utf8"), "- keep modules small\n");
});

test("a line appended by a phase is reverted to the captured bytes", async () => {
  const { root, file } = await project("- keep modules small\n");
  const guard = await captureLearningsGuard(root, "docs/specs");
  await writeFile(file, "- keep modules small\n- note the failure taught me\n", "utf8");

  assert.equal(await enforceLearningsGuard(guard), true);
  assert.equal(await readFile(file, "utf8"), "- keep modules small\n");
});

test("a file a phase created from nothing is removed again", async () => {
  const { root, file } = await project(null);
  const guard = await captureLearningsGuard(root, "docs/specs");
  await writeFile(file, "- invented mid-task\n", "utf8");

  assert.equal(await enforceLearningsGuard(guard), true);
  assert.equal(existsSync(file), false, "the guard restores the absence it captured");
});

test("a file a phase deleted is restored from the captured bytes", async () => {
  const { root, file } = await project("- keep modules small\n");
  const guard = await captureLearningsGuard(root, "docs/specs");
  await rm(file, { force: true });

  assert.equal(await enforceLearningsGuard(guard), true);
  assert.equal(await readFile(file, "utf8"), "- keep modules small\n");
});
