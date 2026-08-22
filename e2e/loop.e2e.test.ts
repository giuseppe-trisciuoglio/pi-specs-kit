import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { LoopEngine, type LoopEndReason } from "../src/loop/engine.ts";
import { loadFixPlan, type FixPlan } from "../src/fixplan/fix-plan.ts";
import { LoopController } from "../src/loop/loop-controller.ts";
import type { LedgerRow, PhaseLedgerRow } from "../src/measure/ledger.ts";
import { readWalRows } from "../src/measure/wal.ts";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN_DIR = path.join(E2E_DIR, "fake-bin");
const SPEC_REL = "docs/specs/e2e-spec";

/** Env vars understood by the fake agent, cleaned up after every run. HOME
 * rides the same mechanism: the measurement write-ahead file lives under the
 * home directory, which must point into the throwaway project. */
const FAKE_VARS = [
  "FAKE_PI_SPEC_DIR",
  "FAKE_PI_FAIL_PHASE",
  "FAKE_PI_FAIL_TIMES",
  "FAKE_PI_STATE_FILE",
  "FAKE_PI_REVIEW_VERDICT",
  "FAKE_PI_SKIP_REVIEW_FILE",
  "HOME",
];

interface FakeProject {
  projectRoot: string;
  specDir: string;
}

/** Create a throwaway project with a three-task spec and no config file. */
async function setupProject(): Promise<FakeProject> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "e2e-loop-"));
  const specDir = path.join(projectRoot, SPEC_REL);
  await mkdir(path.join(specDir, "tasks"), { recursive: true });
  const titles: Record<string, string> = { "TASK-001": "First", "TASK-002": "Second", "TASK-003": "Third" };
  for (const [id, title] of Object.entries(titles)) {
    const content = `---\nid: ${id}\ntitle: ${title}\nstatus: pending\ndependencies: []\n---\n\nImplementa ${id}.\n`;
    await writeFile(path.join(specDir, "tasks", `${id}.md`), content, "utf8");
  }
  return { projectRoot, specDir };
}

/**
 * Run `fn` with the fake agent dir at the head of PATH and the given fake
 * agent env vars set; every touched variable is restored afterwards.
 */
async function withFakePi<T>(fakeEnv: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const savedPath = process.env.PATH;
  const savedFake = new Map(FAKE_VARS.map((k) => [k, process.env[k]]));
  process.env.PATH = `${FAKE_BIN_DIR}${path.delimiter}${savedPath ?? ""}`;
  for (const k of FAKE_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(fakeEnv)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    for (const [k, v] of savedFake) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

interface LoopRunResult {
  reason: LoopEndReason;
  error?: string;
}

/**
 * Start a real loop against the fake project: the engine uses the default
 * phase spawner, so `pi` resolves to the fake binary via PATH.
 */
async function runLoop(
  project: FakeProject,
  fakeEnv: Record<string, string>,
  opts: { resume?: boolean; states?: FixPlan[] } = {},
): Promise<LoopRunResult> {
  const config = await loadSpecsKitConfig(project.projectRoot);
  const engine = new LoopEngine({ config }, { onStateChange: (p) => opts.states?.push(structuredClone(p)) });
  return withFakePi(
    { FAKE_PI_SPEC_DIR: project.specDir, HOME: path.join(project.projectRoot, "fake-home"), ...fakeEnv },
    () => engine.start({ specDir: SPEC_REL, resume: opts.resume }),
  );
}

test("e2e: full loop over three tasks completes with the expected fix plan", { timeout: 120_000 }, async () => {
  const project = await setupProject();
  try {
    const result = await runLoop(project, {});
    assert.equal(result.reason, "completed");

    const plan = await loadFixPlan(project.specDir);
    assert.ok(plan);
    assert.deepEqual(plan.done, ["TASK-001", "TASK-002", "TASK-003"]);
    assert.deepEqual(plan.pending, []);
    assert.deepEqual(plan.range_progress, { done_in_range: 3, percent: 100, total_in_range: 3 });
    assert.ok(plan.learnings.length > 0, "learnings from the learner phase");
    assert.equal(plan.state.step, "done");

    for (const id of ["TASK-001", "TASK-002", "TASK-003"]) {
      const review = await readFile(path.join(project.specDir, "tasks", `${id}--review.md`), "utf8");
      assert.match(review, /review_status: PASSED/);
    }

    const logs = await readdir(path.join(project.specDir, "_ralph_loop", "logs"));
    assert.ok(logs.length > 0, "phase log files under _ralph_loop/logs");

    // Measurement ledger: one consolidated row per executed phase, plus one
    // raw spawn-outcome row per agent subprocess. The default mode is fast,
    // so cleanup never runs and sync rides on the last task.
    const ledgerRows = (await readFile(path.join(project.projectRoot, "docs/specs/measurements.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as LedgerRow);
    const phaseRows = ledgerRows.filter((r): r is PhaseLedgerRow => r.kind === "phase");
    const countPhase = (phase: string): number => phaseRows.filter((r) => r.phase === phase).length;
    assert.equal(phaseRows.length, 10, JSON.stringify(ledgerRows.map((r) => `${(r as PhaseLedgerRow).task}:${(r as PhaseLedgerRow).phase}`)));
    assert.equal(ledgerRows.length - phaseRows.length, 10, "one spawn row per subprocess");
    assert.equal(countPhase("implementation"), 3);
    assert.equal(countPhase("review"), 3);
    assert.equal(countPhase("learner"), 3);
    assert.equal(countPhase("sync"), 1);
    for (const row of phaseRows) {
      assert.equal(row.spec, "e2e-spec");
      assert.match(row.task, /^TASK-00[123]$/);
      // The fake agent emits two messages per phase: 100+10 and 200+20 tokens.
      assert.deepEqual(row.usage, { input: 300, output: 30, cache_read: 0, cache_write: 0, total: 330 });
      assert.equal(row.model, "fake/fake-model");
      assert.ok(row.duration_ms >= 0);
    }
    // Completed phases prune their raw rows from the write-ahead file.
    const walRows = readWalRows(
      path.join(project.projectRoot, "fake-home", ".pi", "agent", "specs-kit", "measurements-wal.jsonl"),
    );
    assert.deepEqual(walRows, []);
  } finally {
    await rm(project.projectRoot, { recursive: true, force: true });
  }
});

test("e2e: a failing implementation phase is retried and the loop completes", { timeout: 120_000 }, async () => {
  const project = await setupProject();
  try {
    const states: FixPlan[] = [];
    const result = await runLoop(
      project,
      {
        FAKE_PI_FAIL_PHASE: "implementation",
        FAKE_PI_FAIL_TIMES: "1",
        FAKE_PI_STATE_FILE: path.join(project.projectRoot, "fake-state.txt"),
      },
      { states },
    );
    assert.equal(result.reason, "completed");
    assert.ok(
      states.some((s) => s.state.retry_count >= 1),
      "a retry should be observable in the state history",
    );
    const plan = await loadFixPlan(project.specDir);
    assert.ok(plan);
    assert.deepEqual(plan.done, ["TASK-001", "TASK-002", "TASK-003"]);
  } finally {
    await rm(project.projectRoot, { recursive: true, force: true });
  }
});

test("e2e: exhausting the attempts halts the loop with an error state", { timeout: 120_000 }, async () => {
  const project = await setupProject();
  try {
    // The default config allows 5 attempts; failing every spawn forces a halt.
    const result = await runLoop(project, {
      FAKE_PI_FAIL_PHASE: "implementation",
      FAKE_PI_FAIL_TIMES: "99",
      FAKE_PI_STATE_FILE: path.join(project.projectRoot, "fake-state.txt"),
    });
    assert.equal(result.reason, "halted");
    assert.ok(result.error, "halt reason");

    const plan = await loadFixPlan(project.specDir);
    assert.ok(plan);
    assert.equal(plan.state.step, "failed");
    assert.ok(plan.state.error, "persisted error state");
    assert.deepEqual(plan.done, []);
  } finally {
    await rm(project.projectRoot, { recursive: true, force: true });
  }
});

test("e2e: a halted loop resumes and completes once the failure is gone", { timeout: 120_000 }, async () => {
  const project = await setupProject();
  try {
    const stateFile = path.join(project.projectRoot, "fake-state.txt");
    const halted = await runLoop(project, {
      FAKE_PI_FAIL_PHASE: "implementation",
      FAKE_PI_FAIL_TIMES: "99",
      FAKE_PI_STATE_FILE: stateFile,
    });
    assert.equal(halted.reason, "halted");

    const resumed = await runLoop(
      project,
      { FAKE_PI_FAIL_PHASE: "implementation", FAKE_PI_FAIL_TIMES: "0", FAKE_PI_STATE_FILE: stateFile },
      { resume: true },
    );
    assert.equal(resumed.reason, "completed");

    const plan = await loadFixPlan(project.specDir);
    assert.ok(plan);
    assert.deepEqual(plan.done, ["TASK-001", "TASK-002", "TASK-003"]);
    assert.deepEqual(plan.pending, []);
    assert.equal(plan.range_progress.percent, 100);
  } finally {
    await rm(project.projectRoot, { recursive: true, force: true });
  }
});

test("e2e: tool events reach the buffer a transcript replays, one phase at a time", { timeout: 120_000 }, async () => {
  const project = await setupProject();
  try {
    await withFakePi({ FAKE_PI_SPEC_DIR: project.specDir, HOME: path.join(project.projectRoot, "fake-home") }, async () => {
      const controller = new LoopController();
      await controller.loadConfig(project.projectRoot);

      // Snapshot the buffer at the end of each phase, before the next one
      // clears it: this is what a transcript opened at that moment would show.
      const perPhase: number[] = [];
      let toolCalls = 0;
      controller.subscribePhaseStart(() => perPhase.push(controller.getPhaseEvents().length));
      controller.subscribeStream((event) => {
        if (event.type === "tool_execution_start") toolCalls++;
      });

      await controller.start({ specDir: SPEC_REL });
      while (controller.isRunning()) await new Promise((resolve) => setTimeout(resolve, 20));

      assert.ok(toolCalls > 0, "tool executions travel through the stream channel");
      // Every phase but the first was preceded by a non-empty buffer, and the
      // buffer never accumulates across phases.
      assert.ok(perPhase.length > 1, "more than one phase ran");
      assert.equal(perPhase[0], 0, "the first phase starts from an empty buffer");
      assert.ok(perPhase.slice(1).every((n) => n > 0), `each phase leaves events behind: ${perPhase.join(",")}`);

      const events = controller.getPhaseEvents();
      assert.ok(events.length > 0, "the last phase is still replayable");
      assert.ok(events.some((e) => e.type === "message_update"), "streaming deltas are buffered");
    });
  } finally {
    await rm(project.projectRoot, { recursive: true, force: true });
  }
});

test("e2e: refreshing the fix plan is refused while a loop is running", { timeout: 120_000 }, async () => {
  const project = await setupProject();
  try {
    await withFakePi({ FAKE_PI_SPEC_DIR: project.specDir, HOME: path.join(project.projectRoot, "fake-home") }, async () => {
      const controller = new LoopController();
      await controller.loadConfig(project.projectRoot);
      await controller.start({ specDir: SPEC_REL });

      // The refresh is a read-modify-write of the same file the engine
      // rewrites at every transition: allowing both would lose one of them.
      await assert.rejects(() => controller.refreshFixPlan(SPEC_REL), /loop is running/);

      controller.stop(true);
      while (controller.isRunning()) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await controller.refreshFixPlan(SPEC_REL), "Nothing to refresh");
    });
  } finally {
    await rm(project.projectRoot, { recursive: true, force: true });
  }
});
