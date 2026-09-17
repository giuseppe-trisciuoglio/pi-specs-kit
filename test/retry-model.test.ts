/**
 * A stronger model from the second attempt on. The first attempt is
 * speculative and cheap; once it has failed, the run pays for another review
 * and another gate behind every further attempt, so the rule is that
 * intelligence follows the cost of the error.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../src/agent/spawner.ts";
import type { RoleConfig, SpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { loadSpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { LoopBudget } from "../src/loop/budget.ts";
import { attemptModel } from "../src/loop/phase-escalation.ts";
import { PhaseSpawner } from "../src/loop/phase-spawn.ts";
import { configuredModels } from "../src/loop/model-check.ts";

function outcome(over: Partial<PhaseRunOutcome> = {}): PhaseRunOutcome {
  return {
    exitCode: 0,
    timedOut: false,
    aborted: false,
    stopReason: "stop",
    errorMessage: null,
    elapsedMs: 1,
    stderr: "",
    assistantMessages: 2,
    ...over,
  };
}

const QUOTA = '429 {"type":"error","error":{"type":"rate_limit_error"}}';

async function withConfig(agents: Record<string, unknown>, fn: (config: SpecsKitConfig) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "retry-model-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(dir, "specs-kit.yaml"), YAML.stringify({ agents }), "utf8");
  await fn(await loadSpecsKitConfig(dir));
}

/** Spawner deps recording the model and thinking level of every spawn. */
function spawnerDeps(
  config: SpecsKitConfig,
  spawnPhase: (opts: PhaseSpawnOptions) => Promise<PhaseRunOutcome>,
  notify: (message: string) => void = () => {},
) {
  return {
    config,
    specDir: ".",
    budget: new LoopBudget({ maxSpawnsPerTask: 99, maxSpawnsPerRun: 999, maxRunDurationMs: 3_600_000, maxRunDurationHardMs: null }),
    spawnPhase,
    onNotify: (message: string) => notify(message),
    onStream: () => {},
    onLogPath: () => {},
    onPhaseStart: () => {},
    onLogLine: () => {},
    meter: undefined,
    beginMeter: () => null,
    warnAutoModel: () => {},
  };
}

/** Walk the escalation path with a role layout shared by the two fallback
 * tests: which model answers with a quota error, the sequence of spawns and
 * the calls those spawns are expected to produce. The role carries a primary,
 * a retry and a fallback so every escalation step is reachable. */
async function runFallbackScenario(opts: {
  failingModel: string;
  steps: ReadonlyArray<{ attempt: number; taskId?: string }>;
  expectedCalls: ReadonlyArray<string>;
}): Promise<void> {
  await withConfig(
    { agent_model: "provider/cheap", agent_retry_model: "provider/strong", agent_fallback_model: "provider/spare" },
    async (config) => {
      const calls: string[] = [];
      const deps = spawnerDeps(config, async (spawnOpts) => {
        const model = String(spawnOpts.model);
        calls.push(model);
        if (model === opts.failingModel) return outcome({ exitCode: 1, stopReason: "error", errorMessage: QUOTA });
        return outcome();
      });
      const spawner = new PhaseSpawner(deps);
      for (const step of opts.steps) {
        await spawner.spawn(
          {
            taskId: step.taskId ?? "TASK-001",
            label: "implementation",
            role: "agent" as const,
            prompt: "do it",
            attempt: step.attempt,
          },
          undefined,
          undefined,
          false,
        );
      }
      assert.deepEqual(calls, opts.expectedCalls);
    },
  );
}

// --- the decision, on its own ------------------------------------------------

const ROLE: RoleConfig = {
  model: "provider/cheap",
  thinkingLevel: "low",
  retryModel: "provider/strong",
  retryThinkingLevel: "high",
};

test("the first attempt runs on the primary model and the second on the retry model", () => {
  assert.deepEqual(attemptModel(ROLE, 1), { model: "provider/cheap", thinkingLevel: "low", retry: false });
  assert.deepEqual(attemptModel(ROLE, 2), { model: "provider/strong", thinkingLevel: "high", retry: true });
  assert.deepEqual(attemptModel(ROLE, 5), { model: "provider/strong", thinkingLevel: "high", retry: true });
});

test("the attempt the retry model takes over from is configurable", () => {
  const role = { ...ROLE, retryFromAttempt: 3 };
  assert.equal(attemptModel(role, 2).model, "provider/cheap");
  assert.equal(attemptModel(role, 3).model, "provider/strong");
});

test("a role without a retry model keeps its primary on every attempt", () => {
  const role: RoleConfig = { model: "provider/cheap", thinkingLevel: "low" };
  for (const attempt of [1, 2, 9]) {
    assert.deepEqual(attemptModel(role, attempt), { model: "provider/cheap", thinkingLevel: "low", retry: false });
  }
});

test("a retry model that names no thinking level inherits the role's", () => {
  const role: RoleConfig = { model: "provider/cheap", thinkingLevel: "low", retryModel: "provider/strong" };
  assert.deepEqual(attemptModel(role, 2), { model: "provider/strong", thinkingLevel: "low", retry: true });
});

test("a retry_from_attempt below two is read as absent", async () => {
  // Attempt one is not a retry: such a value would only give the role a
  // second name for its primary model, so the default applies instead.
  await withConfig({ agent_model: "provider/cheap", agent_retry_model: "provider/strong", agent_retry_from_attempt: 1 }, async (config) => {
    assert.equal(config.roles.agent.retryFromAttempt, undefined);
    assert.equal(attemptModel(config.roles.agent, 1).model, "provider/cheap");
    assert.equal(attemptModel(config.roles.agent, 2).model, "provider/strong");
  });
});

// --- the spawner ------------------------------------------------------------

test("the spawner sends each attempt to the model its number earns", async () => {
  await withConfig(
    { agent_model: "provider/cheap", agent_thinking_level: "low", agent_retry_model: "provider/strong", agent_retry_thinking_level: "high" },
    async (config) => {
      const calls: Array<[string, string | undefined]> = [];
      const deps = spawnerDeps(config, async (opts) => {
        calls.push([String(opts.model), opts.thinkingLevel]);
        return outcome();
      });
      const spawner = new PhaseSpawner(deps);
      const request = { taskId: "TASK-001", label: "implementation", role: "agent" as const, prompt: "do it" };
      await spawner.spawn({ ...request, attempt: 1 }, undefined, undefined, false);
      await spawner.spawn({ ...request, attempt: 2 }, undefined, undefined, false);
      await spawner.spawn({ ...request, attempt: 3 }, undefined, undefined, false);

      assert.deepEqual(calls, [
        ["provider/cheap", "low"],
        ["provider/strong", "high"],
        ["provider/strong", "high"],
      ]);
    },
  );
});

test("a request without an attempt counts as the first one", async () => {
  // The learner and the compaction pass have no attempt of their own: they
  // must not quietly spend the retry model on work that never retries.
  await withConfig({ learner_model: "provider/cheap", learner_retry_model: "provider/strong" }, async (config) => {
    const calls: string[] = [];
    const deps = spawnerDeps(config, async (opts) => {
      calls.push(String(opts.model));
      return outcome();
    });
    const spawner = new PhaseSpawner(deps);
    await spawner.spawn({ taskId: "TASK-001", label: "learner", role: "learner", prompt: "x" }, undefined, undefined, false);
    assert.deepEqual(calls, ["provider/cheap"]);
  });
});

test("the switch to the retry model is notified with the attempt that earned it", async () => {
  await withConfig({ agent_model: "provider/cheap", agent_retry_model: "provider/strong" }, async (config) => {
    const notices: string[] = [];
    const deps = spawnerDeps(config, async () => outcome(), (message) => notices.push(message));
    const spawner = new PhaseSpawner(deps);
    const request = { taskId: "TASK-001", label: "implementation", role: "agent" as const, prompt: "do it" };
    await spawner.spawn({ ...request, attempt: 1 }, undefined, undefined, false);
    assert.deepEqual(notices, [], "the first attempt is the ordinary one and says nothing");
    await spawner.spawn({ ...request, attempt: 2 }, undefined, undefined, false);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /attempt 2 for TASK-001 runs on the agent retry model provider\/strong/);
  });
});

test("the retry model falls back like any primary, and its own death is remembered", () =>
  runFallbackScenario({
    failingModel: "provider/strong",
    steps: [
      { attempt: 2 },
      { attempt: 3 },
      // The first attempt of a fresh task is unaffected: it is the retry
      // model that died, and the sticky memory answers for that model alone.
      { attempt: 1, taskId: "TASK-002" },
    ],
    expectedCalls: ["provider/strong", "provider/spare", "provider/spare", "provider/cheap"],
  }),
);

test("a dead primary does not condemn the retry model with it", () =>
  runFallbackScenario({
    failingModel: "provider/cheap",
    steps: [
      { attempt: 1 },
      { attempt: 2 },
      { attempt: 1, taskId: "TASK-002" },
    ],
    expectedCalls: ["provider/cheap", "provider/spare", "provider/strong", "provider/spare"],
  }),
);

// --- the pre-flight ---------------------------------------------------------

test("the retry model is checked against the catalogue with the primaries", async () => {
  await withConfig({ agent_model: "provider/cheap", agent_retry_model: "provider/strong" }, async (config) => {
    assert.deepEqual(
      configuredModels(config).map((m) => [m.role, m.model, m.field]),
      [
        ["agent", "provider/cheap", undefined],
        ["agent", "provider/strong", "retry"],
      ],
    );
  });
});

test("a retry model identical to the primary is not checked twice", async () => {
  await withConfig({ agent_model: "provider/cheap", agent_retry_model: "provider/cheap" }, async (config) => {
    assert.equal(configuredModels(config).length, 1);
  });
});
