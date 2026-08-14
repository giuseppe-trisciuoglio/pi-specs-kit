import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthoringLedgerRow } from "../src/measure/ledger.ts";
import { AuthoringWindowTracker, type AuthoringWindowDeps } from "../src/measure/authoring-window.ts";
import { appendWalRow, readWalRows } from "../src/measure/wal.ts";

let clock = 0;
let ids = 0;

interface Setup {
  deps: AuthoringWindowDeps;
  ledgerFile: string;
  walFile: string;
  activeSpec: { value: string | null };
}

function setup(): Setup {
  const dir = mkdtempSync(path.join(tmpdir(), "authoring-window-"));
  const ledgerFile = path.join(dir, "docs", "specs", "measurements.jsonl");
  const walFile = path.join(dir, "wal.jsonl");
  const activeSpec = { value: null as string | null };
  clock = 1_000;
  ids = 0;
  return {
    ledgerFile,
    walFile,
    activeSpec,
    deps: {
      ledgerFile: () => ledgerFile,
      walFile,
      projectRoot: () => dir,
      activeSpec: () => activeSpec.value,
      now: () => new Date(clock),
      newId: () => `win-${++ids}`,
    },
  };
}

function assistantMessage(input: number, output: number): unknown {
  return {
    role: "assistant",
    provider: "fake",
    model: "fake-model",
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: 0.01 } },
  };
}

function ledgerRows(file: string): AuthoringLedgerRow[] {
  try {
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AuthoringLedgerRow);
  } catch {
    return [];
  }
}

test("a window closed with an active spec writes one authoring row", () => {
  const { deps, ledgerFile, walFile, activeSpec } = setup();
  const tracker = new AuthoringWindowTracker(deps);

  tracker.begin();
  assert.ok(tracker.isOpen());
  clock += 2_000;
  tracker.recordMessage(assistantMessage(100, 10));
  tracker.recordMessage({ role: "user", content: "not counted" });
  clock += 3_000;
  activeSpec.value = "docs/specs/001-spec";
  tracker.recordMessage(assistantMessage(200, 20));
  clock += 1_000;
  tracker.close();

  assert.ok(!tracker.isOpen());
  const rows = ledgerRows(ledgerFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "authoring");
  assert.equal(rows[0].spec, "001-spec");
  assert.equal(rows[0].duration_ms, 6_000);
  assert.deepEqual(rows[0].usage, { input: 300, output: 30, cache_read: 0, cache_write: 0, total: 330 });
  assert.equal(rows[0].cost_total, 0.02);
  assert.deepEqual(readWalRows(walFile), []);
});

test("a window closed without an active spec waits in the WAL for attribution", () => {
  const { deps, ledgerFile, walFile, activeSpec } = setup();
  const tracker = new AuthoringWindowTracker(deps);

  tracker.begin();
  clock += 1_000;
  tracker.recordMessage(assistantMessage(50, 5));
  clock += 1_000;
  tracker.close();
  assert.deepEqual(ledgerRows(ledgerFile), []);

  activeSpec.value = "docs/specs/002-new-spec";
  tracker.attributePending("docs/specs/002-new-spec");

  const rows = ledgerRows(ledgerFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].spec, "002-new-spec");
  assert.equal(rows[0].duration_ms, 1_000);
  assert.deepEqual(rows[0].usage, { input: 50, output: 5, cache_read: 0, cache_write: 0, total: 55 });
  assert.deepEqual(readWalRows(walFile), []);
});

test("begin supersedes an open window; an empty window leaves no row", () => {
  const { deps, ledgerFile, activeSpec } = setup();
  activeSpec.value = "docs/specs/001-spec";
  const tracker = new AuthoringWindowTracker(deps);

  tracker.begin();
  tracker.begin(); // closes the first window before any message arrived
  tracker.recordMessage(assistantMessage(10, 1));
  tracker.close();

  const rows = ledgerRows(ledgerFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage.input, 10);
});

test("attributePending ignores other projects and the window still open", () => {
  const { deps, ledgerFile, walFile, activeSpec } = setup();
  const tracker = new AuthoringWindowTracker(deps);
  // A raw row from another project, and one from a window closed mid-kill.
  appendWalRow(walFile, {
    v: 1,
    project: "/elsewhere",
    scope: "window",
    scope_id: "foreign",
    spec: null,
    ts: "2026-08-10T09:00:00.000Z",
    started_at: "2026-08-10T08:00:00.000Z",
    usage: { input: 9, output: 9, cache_read: 0, cache_write: 0, total: 18 },
    cost_total: 0,
    model: null,
  });

  tracker.begin();
  tracker.recordMessage(assistantMessage(5, 5));
  tracker.attributePending("docs/specs/001-spec");

  // Only the foreign row survived; the open window is attributed at close.
  assert.deepEqual(ledgerRows(ledgerFile), []);
  const rows = readWalRows(walFile);
  assert.equal(rows.length, 2);
  activeSpec.value = "docs/specs/001-spec";
  tracker.close();
  assert.equal(readWalRows(walFile).length, 1);
  assert.equal(readWalRows(walFile)[0].scope_id, "foreign");
});

test("close on shutdown consolidates like any other close", () => {
  const { deps, ledgerFile, activeSpec } = setup();
  activeSpec.value = "docs/specs/001-spec";
  const tracker = new AuthoringWindowTracker(deps);
  tracker.begin();
  tracker.recordMessage(assistantMessage(7, 3));
  tracker.close(); // session_shutdown handler calls the same method
  assert.equal(ledgerRows(ledgerFile).length, 1);
});
