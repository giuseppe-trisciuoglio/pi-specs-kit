import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHook, runPhaseHooks } from "../src/loop/hooks.ts";
import { defaultHooks, type HooksConfig } from "../src/config/specs-kit-config.ts";

function workDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hooks-test-"));
}

function hooksWith(phase: Partial<{ pre: string[]; post: string[] }>, timeoutMs = 10_000): HooksConfig {
  const hooks = defaultHooks();
  hooks.timeoutMs = timeoutMs;
  hooks.implementation = { pre: phase.pre ?? [], post: phase.post ?? [] };
  return hooks;
}

test("runHook captures stdout, stderr and the exit code", async () => {
  const res = await runHook("printf 'hello out'; printf 'hello err' >&2", { cwd: workDir(), timeoutMs: 10_000 });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.equal(res.timedOut, false);
  assert.ok(res.output.includes("hello out"), `missing stdout in: ${res.output}`);
  assert.ok(res.output.includes("hello err"), `missing stderr in: ${res.output}`);
});

test("runHook reports a failing command as not ok", async () => {
  const res = await runHook("echo failing; exit 3", { cwd: workDir(), timeoutMs: 10_000 });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 3);
  assert.equal(res.timedOut, false);
  assert.ok(res.output.includes("failing"));
});

test("runHook enforces the timeout", async () => {
  const res = await runHook("sleep 30", { cwd: workDir(), timeoutMs: 150 });
  assert.equal(res.timedOut, true);
  assert.equal(res.ok, false);
});

test("runPhaseHooks stops pre hooks at the first failure", async () => {
  const cwd = workDir();
  const marker = path.join(cwd, "second-ran.marker");
  const hooks = hooksWith({ pre: ["exit 1", `touch ${marker}`] });

  const results = await runPhaseHooks(hooks, "implementation", "pre", cwd);

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(existsSync(marker), false, "the hook after the failure must not run");
});

test("runPhaseHooks runs every post hook when all succeed", async () => {
  const cwd = workDir();
  const first = path.join(cwd, "first.marker");
  const second = path.join(cwd, "second.marker");
  const hooks = hooksWith({ post: [`touch ${first}`, `touch ${second}`] });

  const results = await runPhaseHooks(hooks, "implementation", "post", cwd);

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
  assert.equal(existsSync(first), true);
  assert.equal(existsSync(second), true);
});

test("runPhaseHooks returns no results for an empty hook list", async () => {
  const results = await runPhaseHooks(defaultHooks(), "implementation", "pre", workDir());
  assert.deepEqual(results, []);
});

test("runPhaseHooks propagates the timeout from the hooks config", async () => {
  const hooks = hooksWith({ pre: ["sleep 30"] }, 150);
  const results = await runPhaseHooks(hooks, "implementation", "pre", workDir());

  assert.equal(results.length, 1);
  assert.equal(results[0].timedOut, true);
  assert.equal(results[0].ok, false);
});
