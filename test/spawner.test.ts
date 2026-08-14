import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentPhase } from "../src/agent/spawner.ts";
import type { PiStreamEvent } from "../src/agent/json-stream.ts";
import { assistantText } from "../src/agent/stream-format.ts";

/**
 * Fake agent binary: an executable script with a node shebang that ignores
 * the CLI flags and emits a canned stream. (Spawning node directly would not
 * work: it would try to parse the agent CLI flags as its own.)
 */
function writeFakePi(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-agent-"));
  const bin = join(dir, "agent");
  writeFileSync(bin, `#!${process.execPath}\n${body}`);
  chmodSync(bin, 0o755);
  return bin;
}

const SUCCESS_BODY = `
const lines = [
  JSON.stringify({ type: "session", id: "s1" }),
  JSON.stringify({ type: "agent_start" }),
  JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "all done" }] } }),
  JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn", errorMessage: null }] }),
];
process.stdout.write("ARGV:" + JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(lines.join("\\n") + "\\n");
process.stderr.write("some warning\\n");
`;

const HANG_BODY = `setInterval(() => {}, 1000);`;

test("successful run parses events, captures argv and stderr", async () => {
  const piBin = writeFakePi(SUCCESS_BODY);
  const events: PiStreamEvent[] = [];
  const stderrLines: string[] = [];

  const outcome = await runAgentPhase({
    prompt: "do the thing",
    model: "provider/model-x",
    thinkingLevel: "low",
    appendSystemPrompt: "extra rules",
    systemPrompt: "you are a loop phase",
    cwd: tmpdir(),
    timeoutMs: 10_000,
    piBin,
    onEvent: (e) => events.push(e),
    onStderrLine: (l) => stderrLines.push(l),
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.aborted, false);
  assert.equal(outcome.stopReason, "end_turn");
  assert.equal(outcome.errorMessage, null);
  assert.ok(outcome.elapsedMs >= 0);
  assert.match(outcome.stderr, /some warning/);
  assert.deepEqual(stderrLines, ["some warning"]);

  const argvRaw = events.find((e) => e.type === "unparsed_line" && e.line.startsWith("ARGV:"));
  assert.ok(argvRaw && argvRaw.type === "unparsed_line", "fake binary should echo its argv");
  const argv = JSON.parse(argvRaw.line.slice("ARGV:".length)) as string[];
  assert.deepEqual(argv.slice(0, 3), ["--print", "--mode", "json"]);
  assert.ok(argv.includes("--no-session"));
  assert.deepEqual(argv[argv.indexOf("--model") + 1], "provider/model-x");
  assert.deepEqual(argv[argv.indexOf("--thinking") + 1], "low");
  assert.deepEqual(argv[argv.indexOf("--append-system-prompt") + 1], "extra rules");
  assert.deepEqual(argv[argv.indexOf("--system-prompt") + 1], "you are a loop phase");
  assert.equal(argv[argv.length - 1], "do the thing");

  const answers = events.filter((e) => e.type === "message_end").map((e) => assistantText(e.message));
  assert.deepEqual(answers, ["all done"]);
  assert.ok(events.some((e) => e.type === "agent_end"));
});

test("model 'auto' and unset thinking level omit the flags", async () => {
  const piBin = writeFakePi(SUCCESS_BODY);
  const events: PiStreamEvent[] = [];

  await runAgentPhase({
    prompt: "p",
    model: "auto",
    cwd: tmpdir(),
    timeoutMs: 10_000,
    piBin,
    onEvent: (e) => events.push(e),
  });

  const argvRaw = events.find((e) => e.type === "unparsed_line" && e.line.startsWith("ARGV:"));
  assert.ok(argvRaw && argvRaw.type === "unparsed_line");
  const argv = JSON.parse(argvRaw.line.slice("ARGV:".length)) as string[];
  assert.ok(!argv.includes("--model"));
  assert.ok(!argv.includes("--thinking"));
  assert.ok(!argv.includes("--append-system-prompt"));
});

test("stopReason error propagates to the outcome", async () => {
  const piBin = writeFakePi(`
process.stdout.write(JSON.stringify({
  type: "agent_end",
  messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider down" }],
}) + "\\n");
process.exit(1);
`);
  const outcome = await runAgentPhase({ prompt: "p", cwd: tmpdir(), timeoutMs: 10_000, piBin });
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.stopReason, "error");
  assert.equal(outcome.errorMessage, "provider down");
});

test("timeout kills a subprocess that never exits", async () => {
  const piBin = writeFakePi(HANG_BODY);
  const outcome = await runAgentPhase({ prompt: "p", cwd: tmpdir(), timeoutMs: 150, piBin });
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.aborted, false);
  assert.ok(outcome.elapsedMs < 5000, `elapsed too high: ${outcome.elapsedMs}`);
});

test("abort signal terminates the subprocess", async () => {
  const piBin = writeFakePi(HANG_BODY);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  const outcome = await runAgentPhase({
    prompt: "p",
    cwd: tmpdir(),
    timeoutMs: 30_000,
    signal: controller.signal,
    piBin,
  });
  assert.equal(outcome.aborted, true);
  assert.equal(outcome.timedOut, false);
  assert.ok(outcome.elapsedMs < 5000, `elapsed too high: ${outcome.elapsedMs}`);
});
