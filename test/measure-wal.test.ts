import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendWalRow, pruneWalRows, readWalRows, walPath, type WalRow } from "../src/measure/wal.ts";

function row(scopeId: string, overrides: Partial<WalRow> = {}): WalRow {
  return {
    v: 1,
    project: "/root",
    scope: "phase",
    scope_id: scopeId,
    spec: "001-spec",
    task: "TASK-001",
    phase: "implementation",
    ts: "2026-08-10T10:00:00.000Z",
    usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2 },
    cost_total: 0,
    model: null,
    ...overrides,
  };
}

function freshWal(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "measure-wal-"));
  return path.join(dir, "wal", "measurements-wal.jsonl");
}

test("walPath lives under the agent state directory", () => {
  assert.equal(walPath("/home/x"), path.join("/home/x", ".pi", "agent", "specs-kit", "measurements-wal.jsonl"));
});

test("append and read round-trip, creating the directory lazily", () => {
  const file = freshWal();
  appendWalRow(file, row("a"));
  appendWalRow(file, row("b"));
  const rows = readWalRows(file);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.scope_id), ["a", "b"]);
});

test("readWalRows tolerates a missing file and corrupt lines", () => {
  const file = freshWal();
  assert.deepEqual(readWalRows(file), []);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"v":1,"scope_id":"ok"}\nnot json\n{"no_scope":true}\n', "utf8");
  const rows = readWalRows(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope_id, "ok");
});

test("pruneWalRows drops the matching scope and keeps everything else", () => {
  const file = freshWal();
  appendWalRow(file, row("a"));
  appendWalRow(file, row("b", { project: "/other" }));
  appendWalRow(file, row("a", { ts: "2026-08-10T10:01:00.000Z" }));

  pruneWalRows(file, (r) => r.scope_id !== "a");

  const rows = readWalRows(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope_id, "b");
  assert.equal(rows[0].project, "/other");
});

test("pruneWalRows to empty leaves an empty file", () => {
  const file = freshWal();
  appendWalRow(file, row("a"));
  pruneWalRows(file, () => false);
  assert.equal(readFileSync(file, "utf8"), "");
  assert.deepEqual(readWalRows(file), []);
});
