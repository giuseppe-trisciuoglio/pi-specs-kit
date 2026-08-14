import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseRunArgs } from "../src/ui/run-args.ts";
import { formatWidgetLines, updateLoopWidget, type WidgetStatus } from "../src/ui/widget.ts";

const NOW = new Date("2026-01-01T10:12:34Z");
const STARTED_AT = new Date("2026-01-01T10:00:00Z").getTime();

function status(overrides: Partial<WidgetStatus> = {}): WidgetStatus {
  return {
    running: true,
    stopping: null,
    specDir: "/proj/docs/specs/034-x",
    specId: "034-x",
    step: "review",
    currentTask: "TASK-009",
    retryCount: 1,
    doneInRange: 7,
    totalInRange: 10,
    percent: 70,
    error: null,
    logPath: null,
    lastStreamLine: null,
    logLines: [],
    startedAt: STARTED_AT,
    maxAttempts: 5,
    ...overrides,
  };
}

function fakeUi(): { ui: Pick<ExtensionUIContext, "setWidget">; calls: (string[] | undefined)[] } {
  const calls: (string[] | undefined)[] = [];
  const ui = {
    setWidget: (_key: string, content: string[] | undefined) => {
      calls.push(content);
    },
  } as unknown as Pick<ExtensionUIContext, "setWidget">;
  return { ui, calls };
}

test("formatWidgetLines renders the progress line", () => {
  const lines = formatWidgetLines(status(), NOW);
  assert.deepEqual(lines, ["● 034-x — TASK-009 · review · attempt 2/5 · done 7/10 (70%) · 12:34"]);
});

test("formatWidgetLines appends log lines truncated to terminal width", () => {
  const lines = formatWidgetLines(status({ logLines: ["x".repeat(150)] }), NOW);
  const width = process.stdout.columns ?? 80;
  assert.equal(lines.length, 2);
  assert.equal(lines[1].length, width);
  assert.ok(lines[1].endsWith("…"));
});

test("formatWidgetLines keeps short log lines intact", () => {
  const lines = formatWidgetLines(status({ logLines: ["tool call: read src/a.ts"] }), NOW);
  assert.deepEqual(lines[1], "tool call: read src/a.ts");
});

test("formatWidgetLines shows up to LOG_LINES_MAX lines, newest first", () => {
  const lines = formatWidgetLines(
    status({ logLines: ["a", "b", "c", "d", "e", "f", "g"] }),
    NOW,
  );
  assert.equal(lines.length, 1 + 5);
  // logLines are newest-first; slice(-5) takes the last 5 (most recent)
  assert.deepEqual(lines.slice(1), ["c", "d", "e", "f", "g"]);
});

test("formatWidgetLines is empty when there are no log lines", () => {
  const lines = formatWidgetLines(status({ logLines: [] }), NOW);
  assert.deepEqual(lines, ["● 034-x — TASK-009 · review · attempt 2/5 · done 7/10 (70%) · 12:34"]);
});

test("formatWidgetLines handles a missing start time and fields", () => {
  const lines = formatWidgetLines(status({ startedAt: null, currentTask: null, step: null, specId: null }), NOW);
  assert.equal(lines[0], "● ? — — · — · attempt 2/5 · done 7/10 (70%) · 00:00");
});

test("updateLoopWidget shows while running, hides when idle, no-op without UI", () => {
  const { ui, calls } = fakeUi();
  updateLoopWidget(ui, status(), true);
  updateLoopWidget(ui, status({ running: false }), true);
  updateLoopWidget(ui, status(), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.length, 1);
  assert.equal(calls[1], undefined);
});

test("parseRunArgs parses flags and values", () => {
  const parsed = parseRunArgs("--spec docs/specs/034-x --from-task TASK-002 --to-task TASK-005 --phase review --resume --force");
  assert.equal(parsed.spec, "docs/specs/034-x");
  assert.equal(parsed.fromTask, "TASK-002");
  assert.equal(parsed.toTask, "TASK-005");
  assert.equal(parsed.phase, "review");
  assert.equal(parsed.resume, true);
  assert.equal(parsed.force, true);
});

test("parseRunArgs defaults to an empty selection", () => {
  const parsed = parseRunArgs("  ");
  assert.equal(parsed.spec, undefined);
  assert.equal(parsed.fromTask, undefined);
  assert.equal(parsed.toTask, undefined);
  assert.equal(parsed.phase, undefined);
  assert.equal(parsed.resume, false);
  assert.equal(parsed.force, false);
});

test("parseRunArgs ignores unknown tokens", () => {
  const parsed = parseRunArgs("--bogus value --resume");
  assert.equal(parsed.resume, true);
  assert.equal(parsed.spec, undefined);
});
