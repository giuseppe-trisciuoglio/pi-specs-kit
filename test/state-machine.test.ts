import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSpecsKitConfig, type SpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { loadFixPlan, type FixPlan, type LoopState } from "../src/fixplan/fix-plan.ts";
import { parseTaskFile } from "../src/tasks/task-parser.ts";
import { LoopEngine, type LoopEndReason, type LoopStartOptions } from "../src/loop/engine.ts";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../src/agent/spawner.ts";
import { runPhaseHooks, type HookResult } from "../src/loop/hooks.ts";
import { reviewFilePath } from "../src/loop/review-report.ts";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

const FIXED_NOW = new Date("2026-02-10T12:00:00Z");
const FIXED_DATE = "2026-02-10";

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
  const root = await mkdtemp(path.join(tmpdir(), "state-machine-"));
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
  /** Non-zero exit code, marking the phase as failed. */
  fail?: boolean;
  /** Review verdict to write; "missing" writes no report at all. */
  review?: "PASSED" | "FAILED" | "missing";
  /** Assistant text emitted on the stream (learner output). */
  text?: string;
  /** Hang until the abort signal fires, then report an aborted run. */
  waitAbort?: boolean;
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
  runHooks: typeof runPhaseHooks = async () => [],
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
    if (b.waitAbort) {
      await new Promise<void>((resolve) => {
        if (spawnOpts.signal?.aborted) resolve();
        else spawnOpts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return okOutcome(null, true);
    }
    const text = b.text ?? (phase === "learner" ? `- learning for ${task}\n` : undefined);
    // The learner's answer is read off a completed message, as on the wire.
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
      runHooks,
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
const countCalls = (calls: SpawnCall[], task: string, phase: string): number =>
  calls.filter((c) => c.task === task && c.phase === phase).length;

test("an empty task selection halts instead of reporting a completed run", async () => {
  for (const range of [
    { fromTask: "TASK-003", toTask: "TASK-001" }, // inverted
    { fromTask: "TASK-099" }, // beyond the last task
  ]) {
    const { root, specDir } = await createSpec();
    const config = await loadSpecsKitConfig(root);
    const engine = new LoopEngine(
      {
        config,
        spawnPhase: async () => assert.fail("no phase may run on an empty selection"),
        runHooks: async () => [],
        now: () => FIXED_NOW,
      },
      {},
    );

    const result = await engine.start({ specDir, ...range });
    assert.equal(result.reason, "halted", JSON.stringify(range));
    assert.match(result.error ?? "", /selects no task/);
    assert.equal(await loadFixPlan(specDir), null, "no fix plan is written for a rejected range");
  }
});

test("a spec whose tasks dir holds no task file halts with a clear error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "state-machine-"));
  tmpDirs.push(root);
  const specDir = path.join(root, "docs/specs/001-spec");
  await mkdir(path.join(specDir, "tasks"), { recursive: true });
  await writeFile(path.join(specDir, "tasks", "TASK-001--review.md"), "# stale\n", "utf8");

  const config = await loadSpecsKitConfig(root);
  const engine = new LoopEngine({ config, runHooks: async () => [], now: () => FIXED_NOW }, {});
  const result = await engine.start({ specDir });
  assert.equal(result.reason, "halted");
  assert.match(result.error ?? "", /no task files under/);
});

test("bare task numbers are accepted as range bounds", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    () => {},
    (config) => {
      config.run.fromTask = "02";
      config.run.toTask = "2";
    },
  );

  assert.equal(run.result.reason, "completed");
  assert.deepEqual(run.plan.done, ["TASK-002"]);
  assert.equal(run.plan.task_range.from_num, 2);
  assert.equal(run.plan.task_range.to_num, 2);
  assert.equal(run.plan.task_range.total_in_range, 1);
});

test("an existing fix plan is reconciled with the task files on disk", async () => {
  const { root, specDir } = await createSpec();
  await runLoop(root, specDir, () => {});

  // A task file added after the first run joins the metadata of the next one:
  // both totals must describe the same selection.
  await writeFile(path.join(specDir, "tasks", "TASK-004.md"), taskContent(4), "utf8");
  const grown = await runLoop(root, specDir, () => {});
  assert.equal(grown.result.reason, "completed");
  assert.equal(grown.plan.tasks.length, 4);
  assert.deepEqual(grown.plan.done, ["TASK-001", "TASK-002", "TASK-003", "TASK-004"]);
  assert.deepEqual(grown.plan.range_progress, { done_in_range: 4, percent: 100, total_in_range: 4 });
  assert.equal(grown.plan.task_range.total_in_range, 4);

  // A removed task file leaves both totals at the surviving count.
  await rm(path.join(specDir, "tasks", "TASK-002.md"));
  const shrunk = await runLoop(root, specDir, () => {});
  assert.equal(shrunk.result.reason, "completed");
  assert.equal(shrunk.plan.tasks.length, 3);
  assert.deepEqual(shrunk.plan.range_progress, { done_in_range: 3, percent: 100, total_in_range: 3 });
  assert.equal(shrunk.plan.task_range.total_in_range, 3);
});

test("happy path full mode: three tasks, all phases, frontmatter and checkpoints", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(root, specDir, () => {}, (config) => {
    config.mode = "full";
    config.run.noCommit = false;
  });

  assert.equal(run.result.reason, "completed");
  const expected: string[] = [];
  for (const id of ["TASK-001", "TASK-002", "TASK-003"]) {
    for (const phase of ["implementation", "review", "cleanup", "learner", "sync"]) expected.push(`${id}:${phase}`);
  }
  assert.deepEqual(sequence(run.calls), expected);

  assert.deepEqual(run.plan.done, ["TASK-001", "TASK-002", "TASK-003"]);
  assert.deepEqual(run.plan.range_progress, { done_in_range: 3, percent: 100, total_in_range: 3 });
  assert.equal(run.plan.state.step, "done");

  assert.deepEqual(run.checkpoints, [
    "checkpoint: TASK-001 attempt 1",
    "checkpoint: TASK-002 attempt 1",
    "checkpoint: TASK-003 attempt 1",
  ]);
  assert.deepEqual(run.plan.learnings, ["learning for TASK-001", "learning for TASK-002", "learning for TASK-003"]);

  for (const id of ["TASK-001", "TASK-002", "TASK-003"]) {
    const task = parseTaskFile("", await readFile(path.join(specDir, "tasks", `${id}.md`), "utf8"));
    assert.equal(task.frontmatter.status, "reviewed");
    assert.equal(task.frontmatter.implementedDate, FIXED_DATE);
    assert.equal(task.frontmatter.reviewedDate, FIXED_DATE);
  }
  assert.ok(run.states.length > 0, "state changes emitted");
});

test("fast mode: cleanup and frontmatter rewrite skipped, sync only on the last task", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(root, specDir, () => {}, (config) => {
    config.mode = "fast";
  });

  assert.equal(run.result.reason, "completed");
  assert.deepEqual(sequence(run.calls), [
    "TASK-001:implementation",
    "TASK-001:review",
    "TASK-001:learner",
    "TASK-002:implementation",
    "TASK-002:review",
    "TASK-002:learner",
    "TASK-003:implementation",
    "TASK-003:review",
    "TASK-003:learner",
    "TASK-003:sync",
  ]);
  assert.deepEqual(run.plan.done, ["TASK-001", "TASK-002", "TASK-003"]);

  const task = parseTaskFile("", await readFile(path.join(specDir, "tasks/TASK-001.md"), "utf8"));
  assert.equal(task.frontmatter.status, "pending");
  assert.equal(task.frontmatter.implementedDate, undefined);
});

test("implementation fails once then succeeds; retry count is persisted", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.task === "TASK-001" && call.phase === "implementation" && call.n === 1 ? { fail: true } : {}),
    (config) => {
      config.mode = "fast";
      config.run.noCommit = false;
    },
  );

  assert.equal(run.result.reason, "completed");
  assert.equal(countCalls(run.calls, "TASK-001", "implementation"), 2);
  assert.equal(run.checkpoints[0], "checkpoint: TASK-001 attempt 2");
  const retried = run.states.find((s) => s.current_task === "TASK-001" && s.retry_count === 1);
  assert.ok(retried, "retry_count 1 persisted for TASK-001");
});

test("halt after max attempts with state.error and reason halted", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.phase === "implementation" ? { fail: true } : {}),
    (config) => {
      config.mode = "fast";
      config.run.maxAttempts = 2;
    },
  );

  assert.equal(run.result.reason, "halted");
  assert.ok(run.result.error?.includes("TASK-001"));
  assert.equal(run.plan.state.step, "failed");
  assert.equal(run.plan.state.retry_count, 2);
  assert.ok(run.plan.state.error?.includes("TASK-001"));
  assert.deepEqual(run.plan.done, []);
  assert.equal(countCalls(run.calls, "TASK-001", "implementation"), 2);
  assert.equal(run.calls.some((c) => c.task === "TASK-002"), false);
});

test("a review rejecting twice with the same feedback ends the task instead of looping", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.phase === "review" ? { review: "FAILED" } : {}),
    (config) => {
      config.mode = "fast";
      config.run.maxAttempts = 5;
    },
  );

  // The reviewer keeps handing back the identical rejection, so the second
  // implementation had nothing new to work from: the three attempts left would
  // have bought three more copies of the same pair of agent sessions.
  assert.equal(run.result.reason, "halted");
  assert.equal(countCalls(run.calls, "TASK-001", "implementation"), 2);
  assert.equal(countCalls(run.calls, "TASK-001", "review"), 2);
  assert.match(run.plan.state.error ?? "", /identical feedback/);
  assert.equal(run.plan.state.step, "failed");
});

test("a reviewer that never leaves a readable verdict does not re-run the implementation", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.phase === "review" ? { review: "missing" } : {}),
    (config) => {
      config.mode = "fast";
      config.run.maxAttempts = 5;
      config.run.reviewFileRetry = 2;
    },
  );

  // Re-implementing working code cannot teach the reviewer to write its report,
  // so the review file budget is spent once and the task ends there — not
  // once per attempt, which is what made the two counters multiply.
  assert.equal(run.result.reason, "halted");
  assert.equal(countCalls(run.calls, "TASK-001", "implementation"), 1);
  assert.equal(countCalls(run.calls, "TASK-001", "review"), 3);
  assert.match(run.plan.state.error ?? "", /review file missing or invalid/);
});

test("the per-task spawn ceiling halts the run even with continue on failure", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.phase === "review" ? { review: "FAILED" } : {}),
    (config) => {
      config.mode = "fast";
      config.run.continueOnFailure = true;
      config.run.maxSpawnsPerTask = 3;
      // Wide enough that only the per-task ceiling can be the one that fires.
      config.run.maxAttempts = 50;
      config.run.reviewFileRetry = 50;
    },
  );

  assert.equal(run.result.reason, "halted");
  assert.match(run.result.error ?? "", /task budget exhausted for TASK-001/);
  assert.equal(run.calls.length, 3);
  assert.equal(run.calls.some((c) => c.task === "TASK-002"), false, "an exhausted budget does not roll on");
  assert.equal(run.plan.state.step, "failed");
});

test("the per-run spawn ceiling stops the range partway through", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(root, specDir, () => {}, (config) => {
    config.mode = "fast";
    config.run.continueOnFailure = true;
    // Fast mode spends three sessions on a task that passes first time
    // (implementation, review, learner), so the fourth crosses the ceiling.
    config.run.maxSpawnsPerRun = 3;
  });

  assert.equal(run.result.reason, "halted");
  assert.match(run.result.error ?? "", /run budget exhausted/);
  assert.deepEqual(run.plan.done, ["TASK-001"], "the work already finished stays done");
  assert.equal(run.calls.length, 3);
});

test("continue on failure skips to the next task", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.task === "TASK-001" && call.phase === "implementation" ? { fail: true } : {}),
    (config) => {
      config.mode = "fast";
      config.run.maxAttempts = 1;
      config.run.continueOnFailure = true;
    },
  );

  assert.equal(run.result.reason, "completed");
  assert.deepEqual(run.plan.done, ["TASK-002", "TASK-003"]);
  assert.equal(run.plan.state.step, "done");
  assert.ok(run.notifications.some((n) => n.type === "error" && n.message.includes("TASK-001")));
});

test("a range completed after a failing last task does not persist its error", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.task === "TASK-003" && call.phase === "implementation" ? { fail: true } : {}),
    (config) => {
      config.mode = "fast";
      config.run.maxAttempts = 1;
      config.run.continueOnFailure = true;
    },
  );

  // No task follows to reset the state, so the error of the last one would
  // otherwise stay on disk next to a step reporting a completed range.
  assert.equal(run.result.reason, "completed");
  assert.deepEqual(run.plan.done, ["TASK-001", "TASK-002"]);
  assert.equal(run.plan.state.step, "done");
  assert.equal(run.plan.state.error, null);
  assert.ok(
    run.notifications.some((n) => n.type === "warning" && n.message.includes("range completed with failures")),
    "the failure is surfaced as a notice instead",
  );
});

test("a failure in the middle of the range is still reported at the end", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.task === "TASK-001" && call.phase === "implementation" ? { fail: true } : {}),
    (config) => {
      config.mode = "fast";
      config.run.maxAttempts = 1;
      config.run.continueOnFailure = true;
    },
  );

  // The tasks that follow reset the error in the state, so the closing notice
  // has to count failures as they happen rather than read what is left there.
  assert.equal(run.result.reason, "completed");
  assert.deepEqual(run.plan.done, ["TASK-002", "TASK-003"]);
  assert.equal(run.plan.state.error, null);
  assert.ok(
    run.notifications.some(
      (n) => n.type === "warning" && n.message.includes("range completed with failures (1 task)"),
    ),
    "a failure the run walked past is still surfaced at the end",
  );
});

test("rejected review feeds back into the next implementation prompt", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.task === "TASK-001" && call.phase === "review" && call.n === 1 ? { review: "FAILED" } : {}),
    (config) => {
      config.mode = "fast";
    },
  );

  assert.equal(run.result.reason, "completed");
  assert.equal(countCalls(run.calls, "TASK-001", "review"), 2);
  const retries = run.calls.filter((c) => c.task === "TASK-001" && c.phase === "implementation");
  assert.equal(retries.length, 2);
  assert.ok(retries[1].prompt.includes("<review_feedback>"));
  assert.ok(retries[1].prompt.includes("Found problems"));
  assert.ok(retries[1].prompt.includes("Missing input validation"));
});

test("missing review file triggers review file retries and re-spawns", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.task === "TASK-001" && call.phase === "review" && call.n === 1 ? { review: "missing" } : {}),
    (config) => {
      config.mode = "fast";
      config.run.reviewFileRetry = 2;
    },
  );

  assert.equal(run.result.reason, "completed");
  assert.equal(countCalls(run.calls, "TASK-001", "review"), 2);
  assert.equal(countCalls(run.calls, "TASK-001", "implementation"), 1);
  assert.ok(run.notifications.some((n) => n.message.includes("review file missing")));
});

test("resume from a persisted mid-loop state skips finished tasks", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "fast";
  };

  // First run: stop now while the second task's implementation is in flight.
  const first = await runLoop(
    root,
    specDir,
    (call, ctx) => {
      if (call.task === "TASK-002" && call.phase === "implementation") {
        setTimeout(() => ctx.engine.stop(true), 10);
        return { waitAbort: true };
      }
      return {};
    },
    configure,
  );
  assert.equal(first.result.reason, "stopped");
  assert.deepEqual(first.plan.done, ["TASK-001"]);
  assert.equal(first.plan.state.current_task, "TASK-002");
  assert.equal(first.plan.state.step, "implementation");

  // Second run: resume picks the second task up without re-running the first.
  const second = await runLoop(root, specDir, () => {}, configure, { resume: true });
  assert.equal(second.result.reason, "completed");
  assert.deepEqual(second.plan.done, ["TASK-001", "TASK-002", "TASK-003"]);
  assert.equal(second.calls.some((c) => c.task === "TASK-001"), false);
  assert.equal(countCalls(second.calls, "TASK-002", "implementation"), 1);
});

test("graceful stop finishes the current phase then exits", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call, ctx) => {
      if (call.task === "TASK-001" && call.phase === "implementation") ctx.engine.stop();
      return {};
    },
    (config) => {
      config.mode = "fast";
    },
  );

  assert.equal(run.result.reason, "stopped");
  assert.deepEqual(sequence(run.calls), ["TASK-001:implementation"]);
  assert.equal(run.plan.state.step, "implementation");
  assert.equal(run.plan.state.current_task, "TASK-001");
  assert.deepEqual(run.plan.done, []);
});

test("stop now aborts the in-flight spawn and unwinds", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call, ctx) => {
      if (call.task === "TASK-001" && call.phase === "implementation") {
        setTimeout(() => ctx.engine.stop(true), 10);
        return { waitAbort: true };
      }
      return {};
    },
    (config) => {
      config.mode = "fast";
    },
  );

  assert.equal(run.result.reason, "stopped");
  assert.deepEqual(sequence(run.calls), ["TASK-001:implementation"]);
  assert.equal(run.plan.state.step, "implementation");
  assert.deepEqual(run.plan.done, []);
});

test("a second start while running is a gentle failure", async () => {
  const { root, specDir } = await createSpec();
  const config = await loadSpecsKitConfig(root);
  let firstSpawn = true;
  const engine = new LoopEngine({
    config,
    spawnPhase: async () => {
      if (firstSpawn) {
        firstSpawn = false;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      return okOutcome(0);
    },
    runHooks: async () => [],
  });
  const first = engine.start({ specDir });
  const second = await engine.start({ specDir });
  assert.equal(second.reason, "halted");
  assert.ok(second.error?.includes("already running"));
  // The first run goes on with no reviewer output and eventually halts.
  const firstResult = await first;
  assert.equal(firstResult.reason, "halted");
});

test("resume with an explicit phase does not leak it into the next task", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "fast";
  };

  // First run: stop now while the second task's implementation is in flight.
  const first = await runLoop(
    root,
    specDir,
    (call, ctx) => {
      if (call.task === "TASK-002" && call.phase === "implementation") {
        setTimeout(() => ctx.engine.stop(true), 10);
        return { waitAbort: true };
      }
      return {};
    },
    configure,
  );
  assert.equal(first.result.reason, "stopped");
  assert.equal(first.plan.state.current_task, "TASK-002");

  // The UI picker always supplies a phase, so a resume from the TUI carries
  // one: it belongs to the resumed task only, never to the tasks after it.
  const second = await runLoop(root, specDir, () => {}, configure, { resume: true, phase: "review" });
  assert.equal(second.result.reason, "completed");
  assert.deepEqual(second.plan.done, ["TASK-001", "TASK-002", "TASK-003"]);
  assert.equal(countCalls(second.calls, "TASK-003", "implementation"), 1);
  assert.deepEqual(sequence(second.calls).filter((s) => s.startsWith("TASK-003")), [
    "TASK-003:implementation",
    "TASK-003:review",
    "TASK-003:learner",
    "TASK-003:sync",
  ]);
});

test("force re-runs a completed range instead of skipping every done task", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "fast";
  };

  const first = await runLoop(root, specDir, () => {}, configure);
  assert.deepEqual(first.plan.done, ["TASK-001", "TASK-002", "TASK-003"]);

  const forced = await runLoop(root, specDir, () => {}, configure, { force: true });
  assert.equal(forced.result.reason, "completed");
  assert.equal(countCalls(forced.calls, "TASK-001", "implementation"), 1);
  assert.equal(countCalls(forced.calls, "TASK-003", "implementation"), 1);
  assert.deepEqual(forced.plan.done, ["TASK-001", "TASK-002", "TASK-003"]);
});

test("force only clears the tasks inside the selected range", async () => {
  const { root, specDir } = await createSpec();
  const configure = (config: SpecsKitConfig): void => {
    config.mode = "fast";
  };
  await runLoop(root, specDir, () => {}, configure);

  const forced = await runLoop(root, specDir, () => {}, configure, { force: true, fromTask: "TASK-003" });
  assert.equal(forced.result.reason, "completed");
  assert.deepEqual(sequence(forced.calls).map((s) => s.split(":")[0]), [
    "TASK-003",
    "TASK-003",
    "TASK-003",
    "TASK-003",
  ]);
  assert.deepEqual(forced.plan.done, ["TASK-001", "TASK-002", "TASK-003"]);
});

test("a task file that disappears does not abort the loop at update_done", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    async (call) => {
      // The implementation agent renames its own task file away.
      if (call.task === "TASK-001" && call.phase === "implementation") {
        await rm(path.join(specDir, "tasks", "TASK-001.md"));
      }
      return {};
    },
    (config) => {
      config.mode = "full";
    },
  );

  assert.equal(run.result.reason, "completed");
  assert.deepEqual(run.plan.done, ["TASK-001", "TASK-002", "TASK-003"]);
  assert.ok(run.notifications.some((n) => n.type === "warning" && n.message.includes("frontmatter of TASK-001")));
});

test("fast mode syncs even when the last tasks of the range fail", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.task === "TASK-003" && call.phase === "implementation" ? { fail: true } : {}),
    (config) => {
      config.mode = "fast";
      config.run.maxAttempts = 1;
      config.run.continueOnFailure = true;
    },
  );

  assert.equal(run.result.reason, "completed");
  assert.deepEqual(run.plan.done, ["TASK-001", "TASK-002"]);
  // The single sync fast mode guarantees rides on the last task that made it
  // through; a failing tail must not make it vanish.
  const syncs = run.calls.filter((c) => c.phase === "sync");
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].task, "TASK-002");
});

test("a missing prompt override file halts with a clear error, or warns when skipping", async () => {
  const { root, specDir } = await createSpec();
  const withOverride = (policy: "error" | "skip") => (config: SpecsKitConfig): void => {
    config.mode = "fast";
    config.prompts.unsupportedPolicy = policy;
    config.prompts.phaseOverrides.implementation = {
      mode: "append",
      source: "file",
      file: "prompts/missing.md",
    };
  };

  const halted = await runLoop(root, specDir, () => {}, withOverride("error"));
  assert.equal(halted.result.reason, "halted");
  assert.match(halted.result.error ?? "", /system prompt override for phase implementation/);
  assert.match(halted.result.error ?? "", /cannot read/);

  const skipped = await runLoop(root, specDir, () => {}, withOverride("skip"));
  assert.equal(skipped.result.reason, "completed");
  assert.ok(
    skipped.notifications.some((n) => n.type === "warning" && n.message.includes("override for phase implementation")),
  );
});

test("every schema-valid override shape reaches the agent as append or replace", async () => {
  const shapes = [
    { mode: "append", source: "file" },
    { mode: "append", source: "text" },
    { mode: "replace", source: "file" },
    { mode: "replace", source: "text" },
  ] as const;

  for (const { mode, source } of shapes) {
    const { root, specDir } = await createSpec();
    await mkdir(path.join(root, "prompts"), { recursive: true });
    await writeFile(path.join(root, "prompts", "extra.md"), "rules from the file", "utf8");

    const seen: PhaseSpawnOptions[] = [];
    const run = await runLoop(
      root,
      specDir,
      (call, ctx) => {
        if (call.phase === "implementation") seen.push(ctx.spawnOpts);
      },
      (config) => {
        config.mode = "fast";
        config.prompts.phaseOverrides.implementation = {
          mode,
          source,
          file: "prompts/extra.md",
          text: "inline rules",
        };
      },
    );

    const label = `${mode}/${source}`;
    assert.equal(run.result.reason, "completed", label);
    const content = source === "file" ? "rules from the file" : "inline rules";
    for (const opts of seen) {
      assert.equal(opts.appendSystemPrompt, mode === "append" ? content : undefined, label);
      assert.equal(opts.systemPrompt, mode === "replace" ? content : undefined, label);
    }
    // Only the overridden phase carries it.
    const others = run.calls.filter((c) => c.phase !== "implementation");
    assert.ok(others.length > 0, label);
  }
});

test("an override missing the value its source needs halts, or warns when skipping", async () => {
  for (const policy of ["error", "skip"] as const) {
    const { root, specDir } = await createSpec();
    const run = await runLoop(root, specDir, () => {}, (config) => {
      config.mode = "fast";
      config.prompts.unsupportedPolicy = policy;
      // source "text" with no text: nothing to send to the agent.
      config.prompts.phaseOverrides.implementation = { mode: "replace", source: "text" };
    });

    if (policy === "error") {
      assert.equal(run.result.reason, "halted");
      assert.match(run.result.error ?? "", /system prompt override for phase implementation/);
      assert.match(run.result.error ?? "", /without a "text" value/);
    } else {
      assert.equal(run.result.reason, "completed");
      assert.ok(
        run.notifications.some((n) => n.type === "warning" && n.message.includes("override for phase implementation")),
      );
    }
  }
});

test("a role left on the auto model warns once", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(root, specDir, () => {}, (config) => {
    config.mode = "fast";
    config.roles.reviewer = { model: "provider/careful" };
  });

  const auto = run.notifications.filter((n) => n.message.includes('model "auto"'));
  assert.equal(auto.filter((n) => n.message.includes("role agent")).length, 1);
  assert.equal(auto.some((n) => n.message.includes("role reviewer")), false);
});

test("a red implementation post hook fails the attempt and does not reach review", async () => {
  const { root, specDir } = await createSpec();
  const FAILING_POST: HookResult = {
    command: "npm run build",
    ok: false,
    exitCode: 1,
    timedOut: false,
    output: "build failed: 2 errors",
  };
  // The gate is red only for the first implementation post run: the retry
  // then passes and the task completes, proving the attempt was spent without
  // ever handing a broken workspace to the reviewer.
  let postRuns = 0;
  const run = await runLoop(
    root,
    specDir,
    () => {},
    (config) => {
      config.mode = "fast";
    },
    {},
    async (_hooks, _phase, stage) => {
      if (stage !== "post") return [];
      postRuns++;
      return postRuns === 1 ? [FAILING_POST] : [];
    },
  );

  assert.equal(run.result.reason, "completed");
  const impls = run.calls.filter((c) => c.task === "TASK-001" && c.phase === "implementation");
  assert.equal(impls.length, 2, "the red gate costs the attempt like a spawn failure");
  assert.ok(
    run.states.some((s) => s.current_task === "TASK-001" && s.retry_count === 1),
    "retry_count 1 persisted after the red gate",
  );
  assert.ok(!impls[0].prompt.includes("post hooks of the previous attempt"), "first attempt has no gate history");
  assert.ok(impls[1].prompt.includes("post hooks of the previous attempt (failed only):"));
  assert.ok(impls[1].prompt.includes("$ npm run build\nstatus: failed\noutput:\nbuild failed: 2 errors"));
  const review = run.calls.find((c) => c.task === "TASK-001" && c.phase === "review");
  assert.ok(review, "the reviewer is only spawned after a green gate");
  assert.ok(run.plan.done.includes("TASK-001"), "the task completes once the gate is green");
});

test("with attempts exhausted a red implementation post hook closes the task through the funnel", async () => {
  const { root, specDir } = await createSpec();
  const FAILING_POST: HookResult = {
    command: "npm run build",
    ok: false,
    exitCode: 1,
    timedOut: false,
    output: "build failed",
  };
  const run = await runLoop(
    root,
    specDir,
    () => {},
    (config) => {
      config.mode = "fast";
      config.run.maxAttempts = 2;
    },
    {},
    async (_hooks, _phase, stage) => (stage === "post" ? [FAILING_POST] : []),
  );

  // The exhaustion guard covers the new status: with the budget spent the
  // red gate must route to the failure funnel, not loop back for a third try.
  assert.equal(run.result.reason, "halted");
  assert.ok(run.result.error?.includes("TASK-001"));
  assert.equal(run.plan.state.step, "failed");
  assert.equal(run.plan.state.retry_count, 2);
  assert.equal(countCalls(run.calls, "TASK-001", "implementation"), 2);
  assert.equal(run.calls.some((c) => c.task === "TASK-001" && c.phase === "review"), false);
});

test("a red post hook of cleanup or sync is recorded and reported at range close", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    () => {},
    (config) => {
      config.mode = "full";
    },
    {},
    async (_hooks, phase, stage) => {
      if (stage !== "post" || (phase !== "cleanup" && phase !== "sync")) return [];
      return [
        { command: `npm run ${phase}`, ok: false, exitCode: 1, timedOut: false, output: `gate ${phase} failed` },
      ];
    },
  );

  // Cleanup and sync have no retry path: their red gates must not vanish into
  // transient warnings. The run completes, the closing notice names the gate,
  // and the field is cleared so the next run starts blank.
  assert.equal(run.result.reason, "completed");
  assert.deepEqual(run.plan.done, ["TASK-001", "TASK-002", "TASK-003"]);
  const closing = run.notifications.filter((n) => n.message.includes("failed post-hook gate"));
  assert.equal(closing.length, 1, "one notice at close, whatever the transient warnings");
  assert.ok(closing[0].type === "warning");
  assert.ok(closing[0].message.includes("sync"), "the notice names the last red gate");
  assert.equal(run.plan.state.postHookGateFailed, null, "cleared after the notice");
});

test("a red post hook of the end-of-range sync is recorded and reported at close", async () => {
  const { root, specDir } = await createSpec();
  const run = await runLoop(
    root,
    specDir,
    (call) => (call.task === "TASK-001" ? {} : { fail: true }),
    (config) => {
      config.mode = "fast";
      config.run.continueOnFailure = true;
    },
    { phase: "sync" },
    async (_hooks, phase, stage) =>
      stage === "post" && phase === "sync"
        ? [{ command: "npm run sync", ok: false, exitCode: 1, timedOut: false, output: "gate sync failed" }]
        : [],
  );

  // No task sync ran (the first task's entry sync is skipped in fast mode and
  // the tail fails), so the end-of-range sync fires on the completed task and
  // its red gate is recorded like any other.
  assert.equal(run.result.reason, "completed");
  const closing = run.notifications.filter((n) => n.message.includes("failed post-hook gate"));
  assert.equal(closing.length, 1);
  assert.ok(closing[0].message.includes("sync"));
  assert.equal(run.plan.state.postHookGateFailed, null, "cleared after the notice");
});
