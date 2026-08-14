import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSpecsKitConfig, type SpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { loadFixPlan, saveFixPlan, type FixPlan, type LoopState, type LoopStep } from "../src/fixplan/fix-plan.ts";
import { LoopEngine, type LoopEndReason, type LoopStartOptions } from "../src/loop/engine.ts";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../src/agent/spawner.ts";
import { reviewFilePath } from "../src/loop/review-report.ts";

// Characterization tests for the resume paths of the per-task loop: they pin
// the behavior of the current control flow (entry guards at every starting
// step, the sync bookkeeping on a resume past the sync, and the asymmetric
// stop checks) so that moving the code around cannot silently change it.

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

/** Spec with three pending tasks under a tmp project root. */
async function createSpec(): Promise<{ root: string; specDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "resume-paths-"));
  tmpDirs.push(root);
  const specDir = path.join(root, "docs/specs/001-spec");
  await mkdir(path.join(specDir, "tasks"), { recursive: true });
  for (let n = 1; n <= 3; n++) {
    await writeFile(path.join(specDir, "tasks", `TASK-00${n}.md`), taskContent(n), "utf8");
  }
  return { root, specDir };
}

interface SpawnCall {
  task: string;
  phase: string;
  prompt: string;
  /** 1-based index of the call for this task+phase pair. */
  n: number;
}

interface BehaviorResult {
  fail?: boolean;
  review?: "PASSED" | "FAILED" | "missing";
  text?: string;
}

interface FakeCtx {
  engine: LoopEngine;
  specDir: string;
  spawnOpts: PhaseSpawnOptions;
}

type Behavior = (call: SpawnCall, ctx: FakeCtx) => BehaviorResult | void | Promise<BehaviorResult | void>;

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

function reviewContent(status: "PASSED" | "FAILED"): string {
  if (status === "PASSED") {
    return "---\nreview_status: PASSED\nsummary: Looks good\nissues: []\n---\n\nAll checks passed.\n";
  }
  return [
    "---",
    "review_status: FAILED",
    "summary: Found problems",
    "issues:",
    "  - Missing input validation",
    "  - No regression test",
    "---",
    "",
    "See issues above.",
    "",
  ].join("\n");
}

function okOutcome(exitCode: number | null, aborted = false): PhaseRunOutcome {
  return { exitCode, timedOut: false, aborted, stopReason: "stop", errorMessage: null, elapsedMs: 1, stderr: "" };
}

interface RunResult {
  result: { reason: LoopEndReason; error?: string };
  plan: FixPlan;
  calls: SpawnCall[];
  checkpoints: string[];
  notifications: { message: string; type: string }[];
  states: LoopState[];
  engine: LoopEngine;
}

/** Run the loop on an existing spec with a scripted spawn and fake hooks/git. */
async function runLoop(
  root: string,
  specDir: string,
  behavior: Behavior,
  configure: (config: SpecsKitConfig) => void = () => {},
  startOpts: Partial<LoopStartOptions> = {},
): Promise<RunResult> {
  const config = await loadSpecsKitConfig(root);
  configure(config);

  const calls: SpawnCall[] = [];
  const counts = new Map<string, number>();
  const checkpoints: string[] = [];
  const notifications: { message: string; type: string }[] = [];
  const states: LoopState[] = [];

  let engine: LoopEngine;
  const spawnPhase = async (spawnOpts: PhaseSpawnOptions): Promise<PhaseRunOutcome> => {
    const task = taskOf(spawnOpts.prompt);
    const phase = phaseOf(spawnOpts.prompt);
    const key = `${task}:${phase}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const call: SpawnCall = { task, phase, prompt: spawnOpts.prompt, n };
    calls.push(call);

    const b = (await behavior(call, { engine, specDir, spawnOpts })) ?? {};
    const text = b.text ?? (phase === "learner" ? `- learning for ${task}\n` : undefined);
    if (text) {
      spawnOpts.onEvent?.({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      } as Parameters<NonNullable<typeof spawnOpts.onEvent>>[0]);
    }
    if (phase === "review" && b.review !== "missing") {
      await writeFile(reviewFilePath(specDir, task), reviewContent(b.review ?? "PASSED"), "utf8");
    }
    return okOutcome(b.fail ? 1 : 0);
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
      onStateChange: (plan) => states.push({ ...plan.state }),
      onNotify: (message, type) => notifications.push({ message, type }),
    },
  );

  const result = await engine.start({ specDir, ...startOpts });
  const plan = await loadFixPlan(specDir);
  assert.ok(plan, "fix plan persisted");
  return { result, plan, calls, checkpoints, notifications, states, engine };
}

const sequence = (calls: SpawnCall[]): string[] => calls.map((c) => `${c.task}:${c.phase}`);

/**
 * Rewrite the persisted plan so the next resume re-enters the given task at
 * the given step, as if the previous run had stopped exactly there.
 */
async function pinResumePoint(specDir: string, taskId: string, step: LoopStep, done: string[]): Promise<void> {
  const plan = await loadFixPlan(specDir);
  assert.ok(plan, "a first run must have persisted the fix plan");
  plan.done = [...done];
  plan.pending = plan.tasks.map((t) => t.id).filter((id) => !done.includes(id));
  plan.state = {
    ...plan.state,
    step,
    current_task: taskId,
    current_task_file: `tasks/${taskId}.md`,
    current_task_lang: null,
    retry_count: 0,
    review_file_retry: 0,
    review_file_error: null,
    error: null,
  };
  await saveFixPlan(specDir, plan);
}

test("resume at review skips the implementation phase entirely", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "fast";
  };
  await runLoop(root, specDir, () => {}, configure);
  await pinResumePoint(specDir, "TASK-001", "review", []);

  const resumed = await runLoop(root, specDir, () => {}, configure, { resume: true, toTask: "TASK-001" });

  assert.equal(resumed.result.reason, "completed");
  // The first implementation is skipped, so no prompt of this run can carry
  // a review feedback block: the cycle opens directly on the reviewer.
  assert.deepEqual(sequence(resumed.calls), ["TASK-001:review", "TASK-001:learner", "TASK-001:sync"]);
  assert.ok(resumed.calls.every((c) => !c.prompt.includes("<review_feedback>")));
  assert.deepEqual(resumed.plan.done, ["TASK-001"]);
});

test("resume at review still routes a rejection into the retried implementation", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "fast";
  };
  await runLoop(root, specDir, () => {}, configure);
  await pinResumePoint(specDir, "TASK-001", "review", []);

  const resumed = await runLoop(
    root,
    specDir,
    (call) => (call.task === "TASK-001" && call.phase === "review" && call.n === 1 ? { review: "FAILED" } : {}),
    configure,
    { resume: true, toTask: "TASK-001" },
  );

  assert.equal(resumed.result.reason, "completed");
  assert.deepEqual(sequence(resumed.calls), [
    "TASK-001:review",
    "TASK-001:implementation",
    "TASK-001:review",
    "TASK-001:learner",
    "TASK-001:sync",
  ]);
  const retry = resumed.calls.find((c) => c.phase === "implementation");
  assert.ok(retry?.prompt.includes("<review_feedback>"));
  assert.ok(retry?.prompt.includes("Found problems"));
});

test("resume at cleanup in fast mode skips cleanup but runs learner and sync", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "fast";
  };
  await runLoop(root, specDir, () => {}, configure);
  await pinResumePoint(specDir, "TASK-001", "cleanup", []);

  const resumed = await runLoop(root, specDir, () => {}, configure, { resume: true, toTask: "TASK-001" });

  assert.equal(resumed.result.reason, "completed");
  assert.deepEqual(sequence(resumed.calls), ["TASK-001:learner", "TASK-001:sync"]);
});

test("resume at cleanup in full mode runs the cleanup phase", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "full";
  };
  await runLoop(root, specDir, () => {}, configure);
  await pinResumePoint(specDir, "TASK-001", "cleanup", []);

  const resumed = await runLoop(root, specDir, () => {}, configure, { resume: true, toTask: "TASK-001" });

  assert.equal(resumed.result.reason, "completed");
  assert.deepEqual(sequence(resumed.calls), ["TASK-001:cleanup", "TASK-001:learner", "TASK-001:sync"]);
});

test("resume at learner skips the cleanup phase even in full mode", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "full";
  };
  await runLoop(root, specDir, () => {}, configure);
  await pinResumePoint(specDir, "TASK-001", "learner", []);

  const resumed = await runLoop(root, specDir, () => {}, configure, { resume: true, toTask: "TASK-001" });

  assert.equal(resumed.result.reason, "completed");
  assert.deepEqual(sequence(resumed.calls), ["TASK-001:learner", "TASK-001:sync"]);
});

test("resume at sync runs only the sync phase before update_done", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "full";
  };
  await runLoop(root, specDir, () => {}, configure);
  await pinResumePoint(specDir, "TASK-001", "sync", []);

  const resumed = await runLoop(root, specDir, () => {}, configure, { resume: true, toTask: "TASK-001" });

  assert.equal(resumed.result.reason, "completed");
  assert.deepEqual(sequence(resumed.calls), ["TASK-001:sync"]);
});

test("entry at sync in fast mode on a non-last task skips the sync phase and keeps the end-of-range sync", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "fast";
    config.run.continueOnFailure = true;
  };
  // The range starts at the sync phase. In fast mode the sync belongs to the
  // last task of the selection, so the first task must pass through
  // update_done without any sync spawn and without marking the sync as run:
  // the failing tail then closes the range with the end-of-range sync on that
  // task.
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.task === "TASK-001" ? {} : { fail: true }),
    configure,
    { phase: "sync" },
  );

  assert.equal(run.result.reason, "completed");
  // No spawn for the skipped entry sync: the run opens on the second task's
  // failed attempts, and the only sync spawn is the end-of-range one, riding
  // on the last completed task after the tail exhausted its attempts.
  assert.deepEqual(sequence(run.calls), [
    ...Array(5).fill("TASK-002:implementation"),
    ...Array(5).fill("TASK-003:implementation"),
    "TASK-001:sync",
  ]);
  assert.deepEqual(run.plan.done, ["TASK-001"]);
});

test("resume past the sync marks it as already run without executing it", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "fast";
    config.run.noCommit = false;
  };
  await runLoop(root, specDir, () => {}, configure);
  // The previous run stopped right after the sync of the last task of the
  // range: only update_done and the checkpoint were left.
  await pinResumePoint(specDir, "TASK-002", "update_done", ["TASK-001"]);

  const resumed = await runLoop(root, specDir, () => {}, configure, { resume: true, toTask: "TASK-002" });

  assert.equal(resumed.result.reason, "completed");
  // Not a single phase spawns: update_done is bookkeeping, and the
  // resume-past-sync bookkeeping marks the sync as done, which also
  // suppresses the end-of-range sync. The run completes with no sync at all.
  assert.deepEqual(resumed.calls, []);
  assert.deepEqual(resumed.checkpoints, ["checkpoint: TASK-002 attempt 1"]);
  assert.deepEqual(resumed.plan.done, ["TASK-001", "TASK-002"]);
  assert.equal(resumed.plan.state.step, "done");
});

test("a graceful stop requested during the sync still completes update_done and the checkpoint", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call, ctx) => {
      if (call.task === "TASK-001" && call.phase === "sync") ctx.engine.stop();
      return {};
    },
    (config) => {
      config.mode = "full";
      config.run.noCommit = false;
    },
  );

  // There is no stop check between the sync and update_done: a graceful stop
  // requested mid-sync does not prevent the task from being recorded as done
  // and checkpointed. The walk only yields at the next task boundary.
  assert.equal(run.result.reason, "stopped");
  assert.deepEqual(sequence(run.calls), [
    "TASK-001:implementation",
    "TASK-001:review",
    "TASK-001:cleanup",
    "TASK-001:learner",
    "TASK-001:sync",
  ]);
  assert.deepEqual(run.plan.done, ["TASK-001"]);
  assert.deepEqual(run.checkpoints, ["checkpoint: TASK-001 attempt 1"]);
  assert.ok(run.notifications.some((n) => n.message === "task TASK-001 completed"));
  assert.equal(run.plan.state.step, "update_done");
  assert.equal(run.plan.state.current_task, "TASK-001");
});
