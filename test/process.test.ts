import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { formatElapsed, killProcessTree, spawnProcess } from "../src/util/process.ts";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("formatElapsed renders compact durations", () => {
  const cases: Array<[number, string]> = [
    [0, "0ms"],
    [12, "12ms"],
    [999, "999ms"],
    [1000, "1.0s"],
    [1234, "1.2s"],
    [9900, "9.9s"],
    [10000, "10s"],
    [45000, "45s"],
    [60000, "1m"],
    [125000, "2m 05s"],
    [3600000, "1h"],
    [3660000, "1h 1m"],
  ];
  for (const [ms, expected] of cases) {
    assert.equal(formatElapsed(ms), expected, `${ms}ms -> ${expected}`);
  }
});

test("formatElapsed rejects nonsense input", () => {
  assert.equal(formatElapsed(Number.NaN), "0ms");
  assert.equal(formatElapsed(-5), "0ms");
});

test("spawnProcess captures stdout and a clean exit", async () => {
  const res = await spawnProcess(process.execPath, ["-e", "process.stdout.write('hello world')"]);
  assert.equal(res.exitCode, 0);
  assert.equal(res.signal, null);
  assert.equal(res.timedOut, false);
  assert.equal(res.stdout, "hello world");
});

test("spawnProcess streams chunks via onStdout", async () => {
  const chunks: string[] = [];
  const res = await spawnProcess(process.execPath, ["-e", "process.stdout.write('aa'); process.stdout.write('bb')"], {
    onStdout: (c) => chunks.push(c),
  });
  assert.equal(res.exitCode, 0);
  assert.equal(chunks.join(""), "aabb");
});

test("spawnProcess captures stderr on failure", async () => {
  const res = await spawnProcess(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(3)"]);
  assert.equal(res.exitCode, 3);
  assert.equal(res.stderr, "boom");
});

test("spawnProcess enforces a timeout and kills the tree", async () => {
  const res = await spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 150,
  });
  assert.equal(res.timedOut, true);
  assert.ok(res.signal === "SIGTERM" || res.signal === "SIGKILL", `unexpected signal ${res.signal}`);
  assert.ok(res.elapsedMs < 5000, `elapsed too high: ${res.elapsedMs}`);
});

test("killProcessTree tears down a detached process group", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
    stdio: "ignore",
    detached: true,
  });
  const pid = child.pid!;
  assert.equal(isAlive(pid), true);

  assert.equal(killProcessTree(pid, "SIGKILL"), true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(isAlive(pid), false);

  // Killing an already-dead group is a safe, non-throwing no-op.
  assert.equal(killProcessTree(pid, "SIGKILL"), false);
});

test("a failed spawn settles as an error and a later abort kills nothing", async () => {
  const controller = new AbortController();
  const res = await spawnProcess("definitely-not-a-real-binary-xyz", [], { signal: controller.signal });

  assert.equal(res.exitCode, null);
  assert.ok(res.stderr.length > 0, "the spawn error is reported on stderr");

  // The abort listener outlives the failed spawn: with no pid there is nothing
  // to signal, and the kill must not throw from inside the listener.
  let uncaught: unknown = null;
  const onUncaught = (err: unknown): void => {
    uncaught = err;
  };
  process.on("uncaughtException", onUncaught);
  try {
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.equal(uncaught, null);
});

test("killProcessTree ignores a missing pid instead of throwing", () => {
  assert.equal(killProcessTree(Number.NaN), false);
  assert.equal(killProcessTree(0), false);
  assert.equal(killProcessTree(-1), false);
});
