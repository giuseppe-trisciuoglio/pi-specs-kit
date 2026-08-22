import test from "node:test";
import assert from "node:assert/strict";
import type { PhaseRunOutcome } from "../src/agent/spawner.ts";
import {
  classifyPhaseFailure,
  environmentFailureMessage,
  spawnFailed,
  type PhaseFailureKind,
} from "../src/loop/phase-failure.ts";

function outcome(over: Partial<PhaseRunOutcome> = {}): PhaseRunOutcome {
  return {
    exitCode: 0,
    timedOut: false,
    aborted: false,
    stopReason: "stop",
    errorMessage: null,
    elapsedMs: 1,
    stderr: "",
    ...over,
  };
}

/** The message the provider actually returned when the run ran out of budget. */
const REAL_429 =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Token Plan usage limit reached: ' +
  'Upgrade your Token Plan or purchase Credits for more usage. (2056)"},"request_id":"06cf8fefa16767d0"}';

/** The stderr line a mistyped provider prefix produced. */
const REAL_MODEL_TYPO = 'Error: Model "pencode-go/deepseek-v4-pro" not found. Use --list-models to see available models.';

test("a phase that delivered is not a failure", () => {
  assert.equal(classifyPhaseFailure(outcome()), null);
  assert.equal(spawnFailed(outcome()), false);
});

test("the rate limit that ended the real run is read as an environment failure", () => {
  const failure = classifyPhaseFailure(outcome({ exitCode: 1, stopReason: "error", errorMessage: REAL_429 }));

  assert.equal(failure?.kind, "quota");
  assert.equal(failure?.environment, true);
  assert.match(failure!.detail, /Token Plan usage limit reached/);
});

test("a mistyped model id is read from stderr, not from the error message", () => {
  const failure = classifyPhaseFailure(outcome({ exitCode: 1, stderr: REAL_MODEL_TYPO }));

  assert.equal(failure?.kind, "model");
  assert.equal(failure?.environment, true);
  assert.match(failure!.detail, /pencode-go/);
});

test("each refusal shape is classified and marked as an environment failure", () => {
  const cases: [string, PhaseFailureKind][] = [
    ["401 Unauthorized", "auth"],
    ["403 forbidden", "auth"],
    ["invalid api key provided", "auth"],
    ["Error: unknown model gpt-nope", "model"],
    ["rate_limit_error: slow down", "quota"],
    ["insufficient_quota for this organization", "quota"],
    ["You have run out of credits, purchase credits to continue", "quota"],
  ];
  for (const [message, kind] of cases) {
    const failure = classifyPhaseFailure(outcome({ exitCode: 1, errorMessage: message }));
    assert.equal(failure?.kind, kind, message);
    assert.equal(failure?.environment, true, message);
  }
});

test("structural outcomes are read before the error text", () => {
  // A timeout is a fact about the subprocess; whatever the agent said on its
  // way out does not turn it into a provider refusal.
  const timedOut = classifyPhaseFailure(outcome({ timedOut: true, errorMessage: REAL_429 }));
  assert.equal(timedOut?.kind, "timeout");
  assert.equal(timedOut?.environment, false);

  const aborted = classifyPhaseFailure(outcome({ aborted: true }));
  assert.equal(aborted?.kind, "aborted");
  assert.equal(aborted?.environment, false);

  const missing = classifyPhaseFailure(null);
  assert.equal(missing?.kind, "agent-error");
  assert.equal(missing?.environment, false);
});

test("an agent error the loop cannot attribute stays retryable", () => {
  // Only a recognized refusal ends the task; anything else keeps the old
  // behaviour, because a retry might still get through.
  const failure = classifyPhaseFailure(outcome({ exitCode: 1, errorMessage: "connection reset by peer" }));

  assert.equal(failure?.kind, "agent-error");
  assert.equal(failure?.environment, false);
  assert.equal(spawnFailed(outcome({ exitCode: 1 })), true);
});

test("a long provider payload is trimmed and flattened for the notification", () => {
  const failure = classifyPhaseFailure(
    outcome({ exitCode: 1, errorMessage: `429 rate limit\n${"x".repeat(900)}` }),
  );

  assert.ok(failure!.detail.length <= 301, `detail not trimmed: ${failure!.detail.length}`);
  assert.ok(!failure!.detail.includes("\n"), "detail keeps a newline");
  assert.ok(failure!.detail.endsWith("…"));
});

test("the operator message names the cause, quotes the provider and says a retry cannot help", () => {
  const failure = classifyPhaseFailure(outcome({ exitCode: 1, stopReason: "error", errorMessage: REAL_429 })!);
  const message = environmentFailureMessage("review", "TASK-013", failure!);

  assert.match(message, /review could not run for TASK-013/);
  assert.match(message, /no budget left/);
  assert.match(message, /Token Plan usage limit reached/);
  assert.match(message, /fails identically/);
  assert.match(message, /change the model for this role/);
});

test("an error message without an error stop reason is still a failure", () => {
  // The shape that walked past the old guard: the provider refuses before the
  // first token, the closing message carries the refusal, and the stop reason
  // stays unset. Evidence, not taxonomy, decides.
  const failure = classifyPhaseFailure(outcome({ errorMessage: REAL_429 }));

  assert.equal(failure?.kind, "quota");
  assert.equal(failure?.environment, true);
});

test("a termination signal counts as a failure whatever the exit code says", () => {
  const failure = classifyPhaseFailure(outcome({ signal: "SIGTERM", exitCode: 0 }));

  assert.equal(failure?.kind, "agent-error");
  assert.match(failure!.detail, /SIGTERM/);
});

test("a clean exit with an empty stream is its own kind of failure", () => {
  // A phase whose contract is a written artifact cannot have delivered when
  // no assistant message ever arrived — this is the eight-blind-spawns case.
  const silent = classifyPhaseFailure(outcome({ assistantMessages: 0 }));
  assert.equal(silent?.kind, "no-output");
  assert.equal(silent?.environment, false);

  // An outcome that does not carry the count says nothing about silence.
  const uncounted = classifyPhaseFailure(outcome({ assistantMessages: undefined }));
  assert.equal(uncounted, null);
});
