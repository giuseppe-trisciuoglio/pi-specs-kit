import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PhaseLogWriter } from "../src/util/log-writer.ts";

function freshSpecDir(): string {
  return mkdtempSync(join(tmpdir(), "phase-log-"));
}

test("writes lines to a file under _ralph_loop/logs", async () => {
  const specDir = freshSpecDir();
  const writer = new PhaseLogWriter(specDir, "TASK-001", "implementation");

  assert.match(writer.path, /_ralph_loop\/logs\/TASK-001-implementation-.+\.log$/);
  assert.ok(writer.path.startsWith(specDir));
  // The directory is created lazily on the first write.
  assert.equal(existsSync(dirname(writer.path)), false);

  writer.writeLine("first line");
  writer.writeLine("second line");
  await writer.close();

  assert.equal(readFileSync(writer.path, "utf8"), "first line\nsecond line\n");
});

test("writeStream skips null and writes formatted lines", async () => {
  const specDir = freshSpecDir();
  const writer = new PhaseLogWriter(specDir, "TASK-002", "review");

  writer.writeStream("> tool read({})");
  writer.writeStream(null);
  writer.writeStream("< tool read");
  await writer.close();

  assert.equal(readFileSync(writer.path, "utf8"), "> tool read({})\n< tool read\n");
});

test("noLogFiles makes the writer a no-op but keeps the path", async () => {
  const specDir = freshSpecDir();
  const writer = new PhaseLogWriter(specDir, "TASK-003", "cleanup", { noLogFiles: true });

  writer.writeLine("never written");
  writer.writeStream("also never");
  await writer.close();

  assert.match(writer.path, /TASK-003-cleanup-.+\.log$/);
  assert.equal(existsSync(writer.path), false);
  assert.equal(existsSync(dirname(writer.path)), false);
});

test("close without any write is safe", async () => {
  const specDir = freshSpecDir();
  const writer = new PhaseLogWriter(specDir, "TASK-004", "sync");
  await writer.close();
  assert.equal(existsSync(writer.path), false);
});

test("an unwritable log path degrades to a no-op with one warning", async () => {
  const specDir = freshSpecDir();
  // A regular file where the logs directory should go: mkdirSync throws.
  writeFileSync(join(specDir, "_ralph_loop"), "not a directory", "utf8");

  const failures: string[] = [];
  const writer = new PhaseLogWriter(specDir, "TASK-005", "implementation", {
    onFailure: (message) => failures.push(message),
  });

  writer.writeLine("first");
  writer.writeLine("second");
  await writer.close();

  assert.equal(failures.length, 1, failures.join(" | "));
  assert.match(failures[0], /phase log disabled/);
  assert.equal(existsSync(writer.path), false);
});
