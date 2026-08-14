import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendLedgerRow, ledgerPath, type PhaseLedgerRow } from "../src/measure/ledger.ts";
import { messageUsage, addUsage } from "../src/measure/usage.ts";
import { zeroUsage } from "../src/measure/ledger.ts";

function phaseRow(phase: string): PhaseLedgerRow {
  return {
    v: 1,
    kind: "phase",
    ts: "2026-08-10T10:00:00.000Z",
    spec: "001-spec",
    task: "TASK-001",
    phase,
    attempt: 1,
    role: "agent",
    model: "fake/fake-model",
    duration_ms: 1000,
    usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, total: 15 },
    cost_total: 0.01,
  };
}

test("ledgerPath resolves next to the spec directories", () => {
  assert.equal(ledgerPath("/root", "docs/specs"), path.join("/root", "docs/specs", "measurements.jsonl"));
});

test("appendLedgerRow creates the file and keeps rows in order", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "measure-ledger-"));
  const file = path.join(dir, "nested", "measurements.jsonl");

  appendLedgerRow(file, phaseRow("implementation"));
  appendLedgerRow(file, phaseRow("review"));

  const rows = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as PhaseLedgerRow);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.phase), ["implementation", "review"]);
  assert.equal(rows[0].usage.total, 15);
});

test("messageUsage reads the wire shape and flattens it", () => {
  const found = messageUsage({
    role: "assistant",
    provider: "anthropic",
    model: "claude",
    usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, totalTokens: 128, cost: { total: 0.5 } },
  });
  assert.deepEqual(found, {
    usage: { input: 100, output: 20, cache_read: 5, cache_write: 3, total: 128 },
    cost: 0.5,
    model: "anthropic/claude",
  });
});

test("messageUsage tolerates missing pieces", () => {
  assert.equal(messageUsage(null), null);
  assert.equal(messageUsage({ role: "user" }), null);
  assert.equal(messageUsage({ role: "assistant" }), null);
  const found = messageUsage({ role: "assistant", model: "bare", usage: { input: 1, output: 2, totalTokens: 3 } });
  assert.deepEqual(found, {
    usage: { input: 1, output: 2, cache_read: 0, cache_write: 0, total: 3 },
    cost: 0,
    model: "bare",
  });
});

test("addUsage accumulates field by field", () => {
  const sum = zeroUsage();
  addUsage(sum, { input: 1, output: 2, cache_read: 3, cache_write: 4, total: 10 });
  addUsage(sum, { input: 5, output: 6, cache_read: 7, cache_write: 8, total: 26 });
  assert.deepEqual(sum, { input: 6, output: 8, cache_read: 10, cache_write: 12, total: 36 });
});
