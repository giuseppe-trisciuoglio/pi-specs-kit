import test from "node:test";
import assert from "node:assert/strict";
import { formatDurationMs, parseDurationMs } from "../src/util/duration.ts";

test("parseDurationMs accepts duration strings and plain numbers", () => {
  assert.equal(parseDurationMs("100ms"), 100);
  assert.equal(parseDurationMs("240s"), 240_000);
  assert.equal(parseDurationMs("60m"), 3_600_000);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.equal(parseDurationMs(42), 42);
  assert.equal(parseDurationMs("nope"), undefined);
});

test("formatDurationMs renders the shortest round-trippable string", () => {
  assert.equal(formatDurationMs(240_000), "4m");
  assert.equal(formatDurationMs(90_000), "90s");
  assert.equal(formatDurationMs(60_000), "1m");
  assert.equal(formatDurationMs(7_200_000), "2h");
  assert.equal(formatDurationMs(1500), "1500ms");
  for (const ms of [100, 1500, 240_000, 3_600_000, 7_200_000]) {
    assert.equal(parseDurationMs(formatDurationMs(ms)), ms);
  }
});
