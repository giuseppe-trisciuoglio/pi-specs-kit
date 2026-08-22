import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../src/agent/spawner.ts";
import type { SpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { loadSpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { LoopBudget } from "../src/loop/budget.ts";
import { classifyPhaseFailure } from "../src/loop/phase-failure.ts";
import { PhaseSpawner } from "../src/loop/phase-spawn.ts";
import type { ListedModel } from "../src/loop/model-check.ts";

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

function spawnerDeps(
  config: SpecsKitConfig,
  spawnPhase: (opts: PhaseSpawnOptions) => Promise<PhaseRunOutcome>,
  opts: { listModels?: () => Promise<ListedModel[]>; notify?: (message: string) => void } = {},
) {
  return {
    config,
    specDir: ".",
    budget: new LoopBudget({ maxSpawnsPerTask: 99, maxSpawnsPerRun: 999, maxRunDurationMs: 3_600_000 }),
    spawnPhase,
    onNotify: (message: string) => opts.notify?.(message),
    onStream: () => {},
    onLogPath: () => {},
    onPhaseStart: () => {},
    onLogLine: () => {},
    meter: undefined,
    beginMeter: () => null,
    listModels: opts.listModels,
    warnAutoModel: () => {},
  };
}

async function withConfig(roles: Record<string, unknown>, fn: (config: SpecsKitConfig) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "escalation-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(dir, "specs-kit.yaml"), YAML.stringify({ agents: roles }), "utf8");
  const config = await loadSpecsKitConfig(dir);
  await fn(config);
}

const TASK_PROMPT = "review this";

test("a refused primary is retried once on the configured fallback model", async () => {
  await withConfig({ reviewer_model: "provider/a", reviewer_fallback_model: "provider/b" }, async (config) => {
    const calls: string[] = [];
    const deps = spawnerDeps(config, async (opts) => {
      calls.push(String(opts.model ?? "auto"));
      if (calls.length === 1) return outcome({ exitCode: 1, stopReason: "error", errorMessage: QUOTA });
      return outcome();
    });
    const notices: string[] = [];
    deps.onNotify = (message: string) => {
      notices.push(message);
    };
    const spawner = new PhaseSpawner(deps);
    const result = await spawner.spawn("TASK-001", "review", "reviewer", TASK_PROMPT, undefined, undefined, false);

    assert.deepEqual(calls, ["provider/a", "provider/b"]);
    assert.equal(classifyPhaseFailure(result.outcome), null, "the delivered fallback attempt is returned");
    assert.equal(notices.length, 1);
    assert.match(notices[0], /fallback model provider\/b/);
    assert.match(notices[0], /quota/);
  });
});

test("without a fallback the refusal reaches the caller unchanged", async () => {
  await withConfig({ reviewer_model: "provider/a" }, async (config) => {
    let calls = 0;
    const deps = spawnerDeps(config, async () => {
      calls++;
      return outcome({ exitCode: 1, stopReason: "error", errorMessage: QUOTA });
    });
    const spawner = new PhaseSpawner(deps);
    await spawner.spawn("TASK-001", "review", "reviewer", TASK_PROMPT, undefined, undefined, false);
    assert.equal(calls, 1, "no second spawn without an escalation model");
  });
});

test("a fallback identical to the primary does not escalate", async () => {
  await withConfig({ reviewer_model: "provider/a", reviewer_fallback_model: "provider/a" }, async (config) => {
    let calls = 0;
    const deps = spawnerDeps(config, async () => {
      calls++;
      return outcome({ exitCode: 1, stopReason: "error", errorMessage: QUOTA });
    });
    const spawner = new PhaseSpawner(deps);
    await spawner.spawn("TASK-001", "review", "reviewer", TASK_PROMPT, undefined, undefined, false);
    assert.equal(calls, 1);
  });
});

test("a silent spawn escalates and the notice asks the catalogue about the model", async () => {
  await withConfig({ reviewer_model: "provider/gone", reviewer_fallback_model: "provider/b" }, async (config) => {
    const calls: string[] = [];
    const deps = spawnerDeps(config, async (opts) => {
      calls.push(String(opts.model ?? "auto"));
      if (calls.length === 1) return outcome({ assistantMessages: 0 });
      return outcome();
    });
    let catalogueQueries = 0;
    deps.listModels = async () => {
      catalogueQueries++;
      return [{ provider: "provider", model: "other" }];
    };
    const notices: string[] = [];
    deps.onNotify = (message: string) => {
      notices.push(message);
    };
    const spawner = new PhaseSpawner(deps);
    const result = await spawner.spawn("TASK-001", "review", "reviewer", TASK_PROMPT, undefined, undefined, false);

    assert.deepEqual(calls, ["provider/gone", "provider/b"]);
    assert.equal(catalogueQueries, 1, "the empty-output diagnosis checks the catalogue once");
    assert.match(notices[0], /not in the agent CLI catalogue any more/);
    assert.equal(classifyPhaseFailure(result.outcome), null);
  });
});

test("an empty stream that also reports a quota error classifies as the refusal, not as silence", async () => {
  await withConfig({ reviewer_model: "provider/a" }, async (config) => {
    let calls = 0;
    const deps = spawnerDeps(config, async () => {
      calls++;
      return outcome({ exitCode: 1, stopReason: "error", errorMessage: QUOTA, assistantMessages: 0 });
    });
    const spawner = new PhaseSpawner(deps);
    const result = await spawner.spawn("TASK-001", "review", "reviewer", TASK_PROMPT, undefined, undefined, false);
    // The refusal names its cause, so the evidence beats the silence: the
    // diagnosis is quota, and the routing treats it as environmental.
    const failure = classifyPhaseFailure(result.outcome);
    assert.equal(failure?.kind, "quota");
    assert.equal(failure?.environment, true);
    assert.equal(calls, 1, "without a fallback the refusal is returned as is");
  });
});

test("every escalation attempt is charged to the budget like any other subprocess", async () => {
  await withConfig({ reviewer_model: "provider/a", reviewer_fallback_model: "provider/b" }, async (config) => {
    let calls = 0;
    const deps = spawnerDeps(config, async () => {
      calls++;
      return outcome({ exitCode: 1, stopReason: "error", errorMessage: QUOTA });
    });
    // A ceiling of exactly two: primary plus escalation fit, and one more
    // spawn of any kind is refused — the escalation cannot sneak past it.
    deps.budget = new LoopBudget({ maxSpawnsPerTask: 2, maxSpawnsPerRun: 2, maxRunDurationMs: 3_600_000 });
    const spawner = new PhaseSpawner(deps);
    await spawner.spawn("TASK-001", "review", "reviewer", TASK_PROMPT, undefined, undefined, false);
    assert.equal(calls, 2, "primary plus one escalation");
    assert.throws(() => deps.budget.consume(), /run budget exhausted/);
  });
});
