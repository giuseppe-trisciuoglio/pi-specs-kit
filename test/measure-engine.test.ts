import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSpecsKitConfig } from "../src/config/specs-kit-config.ts";
import type { PhaseLedgerRow } from "../src/measure/ledger.ts";
import { PhaseMeter } from "../src/measure/phase-meter.ts";
import { readWalRows } from "../src/measure/wal.ts";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../src/agent/spawner.ts";
import { LoopEngine } from "../src/loop/engine.ts";
import { reviewFilePath } from "../src/loop/review-report.ts";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

const TASK = [
  "---",
  "id: TASK-001",
  "title: The only task",
  "status: pending",
  "dependencies: []",
  "---",
  "",
  "Body of the task.",
  "",
].join("\n");

function phaseOf(prompt: string): string {
  if (prompt.includes("Output only the bullet list")) return "learner";
  if (prompt.includes("Write your verdict to tasks/")) return "review";
  if (prompt.includes("Clean up the code")) return "cleanup";
  if (prompt.includes("Update the specification documentation")) return "sync";
  return "implementation";
}

function okOutcome(): PhaseRunOutcome {
  return { exitCode: 0, timedOut: false, aborted: false, stopReason: "stop", errorMessage: null, elapsedMs: 1, stderr: "" };
}

test("a full run appends one ledger row per phase and leaves no WAL rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "measure-engine-"));
  tmpDirs.push(root);
  const specDir = path.join(root, "docs/specs/001-spec");
  await mkdir(path.join(specDir, "tasks"), { recursive: true });
  await writeFile(path.join(specDir, "tasks", "TASK-001.md"), TASK, "utf8");

  const config = await loadSpecsKitConfig(root);
  config.mode = "full";
  const ledgerFile = path.join(root, "ledger.jsonl");
  const walFile = path.join(root, "wal.jsonl");
  const meter = new PhaseMeter({ ledgerFile, walFile, projectRoot: root });

  const spawnPhase = async (opts: PhaseSpawnOptions): Promise<PhaseRunOutcome> => {
    const phase = phaseOf(opts.prompt);
    const emit = (input: number): void =>
      opts.onEvent?.({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "fake",
          model: "fake-model",
          content: [{ type: "text", text: phase === "learner" ? "- a learning\n" : "done" }],
          usage: { input, output: 10, cacheRead: 1, cacheWrite: 0, totalTokens: input + 11, cost: { total: 0.001 } },
        },
      } as Parameters<NonNullable<typeof opts.onEvent>>[0]);
    emit(100);
    emit(200);
    if (phase === "review") {
      await writeFile(reviewFilePath(specDir, "TASK-001"), "---\nreview_status: PASSED\n---\n\nOK.\n", "utf8");
    }
    return okOutcome();
  };

  const engine = new LoopEngine(
    { config, spawnPhase, runHooks: async () => [], commitCheckpoint: async () => ({ committed: true }), refreshCodebaseGraph: async () => ({ status: "unavailable" as const, detail: "" }), meter },
    {},
  );
  const result = await engine.start({ specDir });
  assert.equal(result.reason, "completed");

  const rows = (await readFile(ledgerFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as PhaseLedgerRow);
  assert.deepEqual(
    rows.map((row) => row.phase),
    ["implementation", "review", "cleanup", "learner", "sync"],
  );
  for (const row of rows) {
    assert.equal(row.kind, "phase");
    assert.equal(row.spec, "001-spec");
    assert.equal(row.task, "TASK-001");
    assert.equal(row.model, "fake/fake-model");
    assert.deepEqual(row.usage, { input: 300, output: 20, cache_read: 2, cache_write: 0, total: 322 });
    assert.equal(row.cost_total, 0.002);
  }
  assert.deepEqual(readWalRows(walFile), []);
});

test("a retried phase records the declared attempt number in the ledger", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "measure-engine-"));
  tmpDirs.push(root);
  const specDir = path.join(root, "docs/specs/001-spec");
  await mkdir(path.join(specDir, "tasks"), { recursive: true });
  await writeFile(path.join(specDir, "tasks", "TASK-001.md"), TASK, "utf8");

  const config = await loadSpecsKitConfig(root);
  const ledgerFile = path.join(root, "ledger.jsonl");
  const walFile = path.join(root, "wal.jsonl");
  const meter = new PhaseMeter({ ledgerFile, walFile, projectRoot: root });

  // The first implementation spawn fails, forcing one retry: the ledger rows
  // of that task must carry attempt 1 then 2, and the phases that run after
  // the failure inherit the attempt the node declared at the boundary.
  let implSpawns = 0;
  const spawnPhase = async (opts: PhaseSpawnOptions): Promise<PhaseRunOutcome> => {
    const phase = phaseOf(opts.prompt);
    if (phase === "implementation") {
      implSpawns++;
      if (implSpawns === 1) return { ...okOutcome(), exitCode: 1, stopReason: "error" };
    }
    if (phase === "review") {
      await writeFile(reviewFilePath(specDir, "TASK-001"), "---\nreview_status: PASSED\n---\n\nOK.\n", "utf8");
    }
    return okOutcome();
  };

  const engine = new LoopEngine(
    { config, spawnPhase, runHooks: async () => [], commitCheckpoint: async () => ({ committed: true }), refreshCodebaseGraph: async () => ({ status: "unavailable" as const, detail: "" }), meter },
    {},
  );
  const result = await engine.start({ specDir });
  assert.equal(result.reason, "completed");

  const rows = (await readFile(ledgerFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as PhaseLedgerRow);
  assert.deepEqual(
    rows.filter((row) => row.phase === "implementation").map((row) => row.attempt),
    [1, 2],
  );
  assert.equal(rows.find((row) => row.phase === "review")?.attempt, 2);
});
