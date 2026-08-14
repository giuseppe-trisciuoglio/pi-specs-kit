import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PhaseLedgerRow } from "../src/measure/ledger.ts";
import { PhaseMeter, type PhaseMeterDeps } from "../src/measure/phase-meter.ts";
import { readWalRows } from "../src/measure/wal.ts";

let clock = 0;
let ids = 0;

function setup(): { deps: PhaseMeterDeps; ledgerFile: string; walFile: string; warnings: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "phase-meter-"));
  const ledgerFile = path.join(dir, "docs", "specs", "measurements.jsonl");
  const walFile = path.join(dir, "wal.jsonl");
  const warnings: string[] = [];
  clock = 1_000;
  ids = 0;
  return {
    ledgerFile,
    walFile,
    warnings,
    deps: {
      ledgerFile,
      walFile,
      projectRoot: dir,
      onNotify: (message) => warnings.push(message),
      now: () => new Date(clock),
      newId: () => `id-${++ids}`,
    },
  };
}

function assistantMessage(input: number, output: number, model = "fake/fake-model"): unknown {
  const [provider, id] = model.split("/");
  return {
    role: "assistant",
    provider,
    model: id,
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: 0.001 } },
  };
}

function messageEnd(message: unknown): unknown {
  return { type: "message_end", message };
}

function ledgerRows(file: string): PhaseLedgerRow[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as PhaseLedgerRow);
}

test("a finished phase writes one consolidated ledger row and prunes the WAL", () => {
  const { deps, ledgerFile, walFile } = setup();
  const meter = new PhaseMeter(deps);

  const handle = meter.beginPhase({
    spec: "001-spec",
    task: "TASK-001",
    phase: "implementation",
    attempt: 2,
    role: "agent",
    model: null,
  });
  clock += 500;
  meter.recordEvent(handle, messageEnd(assistantMessage(100, 10)));
  meter.recordEvent(handle, { type: "turn_start" }); // not a message: ignored
  clock += 500;
  meter.recordEvent(handle, messageEnd(assistantMessage(200, 20)));
  clock += 500;
  meter.finishPhase(handle);

  const rows = ledgerRows(ledgerFile);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.kind, "phase");
  assert.equal(row.spec, "001-spec");
  assert.equal(row.task, "TASK-001");
  assert.equal(row.phase, "implementation");
  assert.equal(row.attempt, 2);
  assert.equal(row.role, "agent");
  assert.equal(row.model, "fake/fake-model");
  assert.equal(row.duration_ms, 1500);
  assert.deepEqual(row.usage, { input: 300, output: 30, cache_read: 0, cache_write: 0, total: 330 });
  assert.equal(row.cost_total, 0.002);
  assert.deepEqual(readWalRows(walFile), []);
});

test("messages without usage contribute nothing but the row is still written", () => {
  const { deps, ledgerFile } = setup();
  const meter = new PhaseMeter(deps);
  const handle = meter.beginPhase({
    spec: "001-spec",
    task: "TASK-002",
    phase: "review",
    attempt: 1,
    role: "reviewer",
    model: "configured/model",
  });
  meter.recordEvent(handle, messageEnd({ role: "assistant", stopReason: "stop" }));
  meter.finishPhase(handle);

  const [row] = ledgerRows(ledgerFile);
  assert.deepEqual(row.usage, { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 });
  // No usage observed on the stream: the configured model is the fallback.
  assert.equal(row.model, "configured/model");
});

test("a killed phase leaves its raw rows in the WAL and no ledger row", () => {
  const { deps, ledgerFile, walFile } = setup();
  const meter = new PhaseMeter(deps);
  const handle = meter.beginPhase({
    spec: "001-spec",
    task: "TASK-003",
    phase: "sync",
    attempt: 1,
    role: "synchronizer",
    model: null,
  });
  meter.recordEvent(handle, messageEnd(assistantMessage(50, 5)));
  // No finishPhase: the process died mid-phase.

  const rows = readWalRows(walFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope, "phase");
  assert.equal(rows[0].task, "TASK-003");
  assert.throws(() => readFileSync(ledgerFile, "utf8"), /ENOENT/);
});

test("an I/O failure warns once and disables measurement silently", () => {
  const { deps, walFile, warnings } = setup();
  // A regular file where the WAL child path should resolve through.
  mkdirSync(path.dirname(walFile), { recursive: true });
  writeFileSync(walFile, "occupied", "utf8");
  const meter = new PhaseMeter({ ...deps, walFile: path.join(walFile, "child") });
  const handle = meter.beginPhase({
    spec: "001-spec",
    task: "TASK-004",
    phase: "cleanup",
    attempt: 1,
    role: "cleaner",
    model: null,
  });
  meter.recordEvent(handle, messageEnd(assistantMessage(1, 1)));
  meter.recordEvent(handle, messageEnd(assistantMessage(1, 1)));
  meter.finishPhase(handle);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /measurement disabled/);
});
