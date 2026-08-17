import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { graphRefreshFailedWarning, refreshCodebaseGraph } from "../src/loop/codebase-graph.ts";

const graphifyAvailable = spawnSync("graphify", ["--help"], { stdio: "ignore" }).status === 0;

/** A tiny source tree graphify can extract without any model call. */
function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codebase-graph-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(
    path.join(dir, "src", "greeter.py"),
    "import json\n\n\ndef greet(name):\n    return json.dumps({'hello': name})\n",
  );
  return dir;
}

test("a real refresh re-extracts the tree and reports what it built", { skip: !graphifyAvailable }, async () => {
  const dir = makeProject();

  const result = await refreshCodebaseGraph(dir);

  assert.equal(result.status, "refreshed", `unexpected status: ${result.status} ${result.detail}`);
  assert.match(result.detail, /nodes/, `no summary in: ${result.detail}`);
});

test("a directory with nothing to extract still does not fail the loop", { skip: !graphifyAvailable }, async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "codebase-graph-empty-"));

  const result = await refreshCodebaseGraph(empty);

  // Whatever graphify makes of an empty tree, the loop only cares that the
  // answer is one of the three it knows how to handle.
  assert.ok(["refreshed", "failed", "unavailable"].includes(result.status), result.status);
});

test("a missing graphify is reported as unavailable, not as a failure", async () => {
  // The loop already warns once at start when graphify is absent; repeating it
  // per task would be noise, so the two outcomes are kept apart.
  const dir = makeProject();
  const previousPath = process.env.PATH;
  process.env.PATH = path.join(dir, "definitely-empty");
  try {
    const result = await refreshCodebaseGraph(dir);
    assert.equal(result.status, "unavailable");
    assert.equal(result.detail, "");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("the warning says what the phases will be reading instead", () => {
  const message = graphRefreshFailedWarning("graphify update timed out");

  assert.match(message, /^\[specs-kit\]/);
  assert.match(message, /graphify update timed out/);
  assert.match(message, /predate the tasks already completed/);
});
