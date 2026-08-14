import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSpecsKitConfig, type SpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { loadFixPlan, saveFixPlan, type FixPlan } from "../src/fixplan/fix-plan.ts";
import { LoopEngine, type LoopEndReason, type LoopStartOptions } from "../src/loop/engine.ts";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../src/agent/spawner.ts";
import { reviewFilePath } from "../src/loop/review-report.ts";

// Characterization test for the entry guard of the per-task cycle: resuming a
// task whose attempts were already spent must run no phase and fall straight
// into the failure funnel, with the same message and persisted state as the
// retry guard this edge reproduces. The narrow window it pins is a run that
// stopped after the attempt counter was persisted but before the funnel wrote
// its own step.

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

const FIXED_NOW = new Date("2026-02-10T12:00:00Z");
const MAX_ATTEMPTS = 3;
const FAILURE = "TASK-001: task not completed after 3 attempts";

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

/** Spec with two pending tasks under a tmp project root. */
async function createSpec(): Promise<{ root: string; specDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "entry-guard-"));
  tmpDirs.push(root);
  const specDir = path.join(root, "docs/specs/001-spec");
  await mkdir(path.join(specDir, "tasks"), { recursive: true });
  for (let n = 1; n <= 2; n++) {
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
  states: Array<FixPlan["state"]>;
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
  const states: Array<FixPlan["state"]> = [];

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
 * Rewrite the persisted plan so the next resume re-enters the given task with
 * its attempts already spent, as if the previous run had stopped right after
 * incrementing the counter and before the failure funnel could write its step.
 */
async function pinExhaustedAttempts(specDir: string, taskId: string, maxAttempts: number): Promise<void> {
  const plan = await loadFixPlan(specDir);
  assert.ok(plan, "a first run must have persisted the fix plan");
  plan.done = [];
  plan.pending = plan.tasks.map((t) => t.id);
  plan.state = {
    ...plan.state,
    step: "implementation",
    current_task: taskId,
    current_task_file: `tasks/${taskId}.md`,
    current_task_lang: null,
    retry_count: maxAttempts,
    review_file_retry: 0,
    review_file_error: null,
    error: null,
  };
  await saveFixPlan(specDir, plan);
}

test("resuming a task with attempts already spent runs no phase and halts from the funnel", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "fast";
    config.run.maxAttempts = MAX_ATTEMPTS;
  };
  await runLoop(root, specDir, () => {}, configure);
  await pinExhaustedAttempts(specDir, "TASK-001", MAX_ATTEMPTS);

  const resumed = await runLoop(root, specDir, () => {}, configure, { resume: true });

  assert.equal(resumed.result.reason, "halted");
  assert.equal(resumed.result.error, FAILURE);
  // Not a single phase spawns: the entry guard routes straight to the funnel.
  assert.deepEqual(resumed.calls, []);
  assert.equal(resumed.plan.state.step, "failed");
  assert.equal(resumed.plan.state.error, FAILURE);
  assert.deepEqual(resumed.plan.done, []);
  assert.ok(
    resumed.notifications.some((n) => n.message === `loop stopped: ${FAILURE}` && n.type === "error"),
    "the funnel reports the loop stop with the usual message",
  );
  assert.ok(
    resumed.states.some((s) => s.step === "failed" && s.error === FAILURE),
    "the funnel persists the failed step with the usual error",
  );
});

test("with continue-on-failure the funnel falls through to the next task", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "fast";
    config.run.maxAttempts = MAX_ATTEMPTS;
    config.run.continueOnFailure = true;
  };
  await runLoop(root, specDir, () => {}, configure);
  await pinExhaustedAttempts(specDir, "TASK-001", MAX_ATTEMPTS);

  const resumed = await runLoop(root, specDir, () => {}, configure, { resume: true });

  assert.equal(resumed.result.reason, "completed");
  // The resumed task falls into the funnel without spawning; the walk then
  // moves on to the following task, which runs the full fast-mode sequence.
  assert.deepEqual(sequence(resumed.calls), [
    "TASK-002:implementation",
    "TASK-002:review",
    "TASK-002:learner",
    "TASK-002:sync",
  ]);
  assert.deepEqual(resumed.plan.done, ["TASK-002"]);
  assert.equal(resumed.plan.state.step, "done");
  assert.equal(resumed.plan.state.error, null);
  assert.ok(
    resumed.notifications.some((n) => n.message === `${FAILURE}; continuing with the next task` && n.type === "error"),
    "the funnel reports that the walk continues with the next task",
  );
  assert.ok(
    resumed.states.some((s) => s.step === "failed" && s.error === FAILURE),
    "the funnel still persists the failed step before the next task takes over",
  );
});
