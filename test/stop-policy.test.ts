import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { loadFixPlan } from "../src/fixplan/fix-plan.ts";
import { LoopEngine } from "../src/loop/engine.ts";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../src/agent/spawner.ts";
import { reviewFilePath } from "../src/loop/review-report.ts";

// Pins the deliberate completion policy of the tail: a graceful stop
// requested while the sync phase is running does not cancel the task
// completion. The task is still recorded as done, checkpointed and announced;
// the run only yields as stopped at the next task boundary.

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

const FIXED_NOW = new Date("2026-02-10T12:00:00Z");

function taskContent(n: number): string {
  const id = `TASK-00${n}`;
  return [
    "---",
    `id: ${id}`,
    `title: Task number ${n}`,
    "status: pending",
    "dependencies: []",
    "ac-mapping: []",
    "imp-requirements: []",
    "---",
    "",
    `Body of task ${n}.`,
    "",
  ].join("\n");
}

async function createSpec(): Promise<{ root: string; specDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "stop-policy-"));
  tmpDirs.push(root);
  const specDir = path.join(root, "docs/specs/001-spec");
  await mkdir(path.join(specDir, "tasks"), { recursive: true });
  for (let n = 1; n <= 3; n++) {
    await writeFile(path.join(specDir, "tasks", `TASK-00${n}.md`), taskContent(n), "utf8");
  }
  return { root, specDir };
}

function taskOf(prompt: string): string {
  return /TASK-\d{3}/.exec(prompt)?.[0] ?? "?";
}

function phaseOf(prompt: string): string {
  if (prompt.includes("Output only the bullet list")) return "learner";
  if (prompt.includes("Write your verdict to tasks/")) return "review";
  if (prompt.includes("Clean up the code")) return "cleanup";
  if (prompt.includes("Update the specification documentation")) return "sync";
  return "implementation";
}

function okOutcome(exitCode: number | null): PhaseRunOutcome {
  return { exitCode, timedOut: false, aborted: false, stopReason: "stop", errorMessage: null, elapsedMs: 1, stderr: "" };
}

test("a stop requested during the sync still completes the task, checkpoint and notification", async () => {
  const { root, specDir } = await createSpec();
  const config = await loadSpecsKitConfig(root);
  config.mode = "full";
  config.run.noCommit = false;

  const calls: string[] = [];
  const checkpoints: string[] = [];
  const notifications: { message: string; type: string }[] = [];

  let engine: LoopEngine;
  const spawnPhase = async (spawnOpts: PhaseSpawnOptions): Promise<PhaseRunOutcome> => {
    const task = taskOf(spawnOpts.prompt);
    const phase = phaseOf(spawnOpts.prompt);
    calls.push(`${task}:${phase}`);

    if (phase === "review") {
      await writeFile(
        reviewFilePath(specDir, task),
        "---\nreview_status: PASSED\nsummary: Looks good\nissues: []\n---\n\nAll checks passed.\n",
        "utf8",
      );
    }
    if (task === "TASK-001" && phase === "sync") {
      // Graceful stop: the current phase finishes, the loop exits at the next
      // boundary. This is the request the completion policy is being pinned
      // against.
      engine.stop();
    }
    return okOutcome(0);
  };

  engine = new LoopEngine(
    {
      config,
      spawnPhase,
      runHooks: async () => [],
      commitCheckpoint: async (_root, message) => {
        checkpoints.push(message);
        return { committed: true };
      },
      now: () => FIXED_NOW,
    },
    {
      onNotify: (message, type) => notifications.push({ message, type }),
    },
  );

  const result = await engine.start({ specDir });
  const plan = await loadFixPlan(specDir);

  assert.ok(plan, "fix plan persisted");
  assert.equal(result.reason, "stopped");
  // The stop request arrived during the sync, so the sync itself still ran;
  // nothing after it was skipped either.
  assert.deepEqual(calls, [
    "TASK-001:implementation",
    "TASK-001:review",
    "TASK-001:cleanup",
    "TASK-001:learner",
    "TASK-001:sync",
  ]);
  assert.deepEqual(plan.done, ["TASK-001"]);
  assert.deepEqual(checkpoints, ["checkpoint: TASK-001 attempt 1"]);
  assert.ok(notifications.some((n) => n.message === "task TASK-001 completed" && n.type === "info"));
  // The last persisted step is the completion bookkeeping, not a stop: the
  // stop only took effect once the task had been recorded as finished.
  assert.equal(plan.state.step, "update_done");
  assert.equal(plan.state.current_task, "TASK-001");

  const taskFile = await readFile(path.join(specDir, "tasks", "TASK-001.md"), "utf8");
  assert.match(taskFile, /status: reviewed/);
});
