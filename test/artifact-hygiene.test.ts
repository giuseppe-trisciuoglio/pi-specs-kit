import test from "node:test";
import assert from "node:assert/strict";
import { trackedArtifactsWarning, trackedLoopArtifacts } from "../src/loop/artifact-hygiene.ts";
import type { RunResult } from "../src/util/process.ts";

/** Scripted git that records the arguments it was asked to run. */
function fakeGit(result: Partial<RunResult>, calls: string[][] = []): {
  run: (command: string, args: string[]) => Promise<RunResult>;
  calls: string[][];
} {
  const run = async (command: string, args: string[]): Promise<RunResult> => {
    calls.push([command, ...args]);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...result } as RunResult;
  };
  return { run, calls };
}

test("the loop's own artifacts are looked up under version control", async () => {
  const git = fakeGit({ stdout: "graphify-out/graph.json\ndocs/specs/001/_ralph_loop/fix_plan.json\n" });

  const tracked = await trackedLoopArtifacts(
    "/repo",
    "/repo/docs/specs/001",
    git.run as unknown as Parameters<typeof trackedLoopArtifacts>[2],
  );

  assert.deepEqual(tracked, ["graphify-out/graph.json", "docs/specs/001/_ralph_loop/fix_plan.json"]);
  assert.deepEqual(git.calls[0], [
    "git",
    "ls-files",
    "--",
    "graphify-out",
    "docs/specs/001/_ralph_loop",
  ]);
});

test("a project that ignores them has nothing to report", async () => {
  const git = fakeGit({ stdout: "\n" });

  const tracked = await trackedLoopArtifacts(
    "/repo",
    "/repo/docs/specs/001",
    git.run as unknown as Parameters<typeof trackedLoopArtifacts>[2],
  );

  assert.deepEqual(tracked, []);
});

test("outside a repository the check stays silent", async () => {
  const git = fakeGit({ exitCode: 128, stderr: "not a git repository" });

  const tracked = await trackedLoopArtifacts(
    "/repo",
    "/repo/docs/specs/001",
    git.run as unknown as Parameters<typeof trackedLoopArtifacts>[2],
  );

  assert.deepEqual(tracked, []);
});

test("a git that throws is not a reason to refuse the run", async () => {
  const throwing = async (): Promise<RunResult> => {
    throw new Error("spawn failed");
  };

  const tracked = await trackedLoopArtifacts(
    "/repo",
    "/repo/docs/specs/001",
    throwing as unknown as Parameters<typeof trackedLoopArtifacts>[2],
  );

  assert.deepEqual(tracked, []);
});

test("the warning names the files and what to do about them", () => {
  const warning = trackedArtifactsWarning(["graphify-out/graph.json", "a", "b", "c"]);

  assert.match(warning, /^\[specs-kit\]/);
  assert.match(warning, /graphify-out\/graph\.json/);
  assert.match(warning, /\+1 more/);
  assert.match(warning, /\.gitignore/);
});
