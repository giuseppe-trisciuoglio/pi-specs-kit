/**
 * Mid-run configuration reload: the swap must keep the one shared config
 * object every loop module holds (no read site can go stale), the structural
 * anchors frozen (a run must not split across two roots), and a file that
 * does not load must warn and keep the last values, never kill the run. The
 * executor-level scenario pins the order: the reload is awaited before the
 * pre-hooks, so one phase reads everything from a single load.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSpecsKitConfig, type SpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { parseTaskFile, type TaskFile } from "../src/tasks/task-parser.ts";
import { ConfigReloader, loadConfigIfPresent } from "../src/loop/config-reload.ts";
import { PhaseExecutor } from "../src/loop/phases.ts";
import { LoopBudget } from "../src/loop/budget.ts";
import type { HookResult } from "../src/loop/hooks.ts";
import type { ImplementationPhaseInput } from "../src/loop/phase-inputs.ts";
import type { PhaseRunOutcome } from "../src/agent/spawner.ts";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "config-reload-"));
  tmpDirs.push(root);
  return root;
}

/** A fresh typed config with the given tweaks applied, as the loader would. */
async function freshConfig(root: string, tweak: (config: SpecsKitConfig) => void): Promise<SpecsKitConfig> {
  const config = await loadSpecsKitConfig(root);
  tweak(config);
  return config;
}

test("the swap refreshes the behavioral values on the same shared object", async () => {
  const root = await tmpRoot();
  const config = await loadSpecsKitConfig(root);
  const reloader = new ConfigReloader(config, {
    load: () => freshConfig(root, (c) => {
      c.roles.agent.model = "openai/gpt-5.2";
      c.run.maxAttempts = 9;
      c.mode = "full";
      c.hooks.implementation.pre = ["npm test"];
      c.knowledgeBase.files = ["docs/architecture.md"];
    }),
    notify: () => assert.fail("a successful reload must not warn"),
  });

  // A reader that captured the object before the reload: the swap has to
  // reach it, or the reload would only exist for readers nobody has.
  const heldByTheLoop = config;
  await reloader.refresh();

  assert.equal(heldByTheLoop.roles.agent.model, "openai/gpt-5.2");
  assert.equal(heldByTheLoop.run.maxAttempts, 9);
  assert.equal(heldByTheLoop.mode, "full");
  assert.deepEqual(heldByTheLoop.hooks.implementation.pre, ["npm test"]);
  assert.deepEqual(heldByTheLoop.knowledgeBase.files, ["docs/architecture.md"]);
});

test("the structural anchors stay frozen at the start values", async () => {
  const root = await tmpRoot();
  const config = await freshConfig(root, (c) => {
    c.spec = "docs/specs/001-spec";
  });
  const reloader = new ConfigReloader(config, {
    load: () => freshConfig(root, (c) => {
      c.specsDir = "elsewhere/specs";
      c.spec = "elsewhere/specs/999-other";
    }),
    notify: () => {},
  });

  await reloader.refresh();

  assert.equal(config.specsDir, "docs/specs", "the run resolved its paths from the start specsDir");
  assert.equal(config.spec, "docs/specs/001-spec", "the active spec of the walk is a start-time anchor");
  assert.equal(config.projectRoot, root);
});

test("the file re-read is the one the config was loaded from", async () => {
  const root = await tmpRoot();
  const config = await loadSpecsKitConfig(root);
  const seen: Array<{ projectRoot: string; configPath?: string }> = [];
  const reloader = new ConfigReloader(config, {
    load: async (projectRoot, configPath) => {
      seen.push({ projectRoot, configPath });
      return freshConfig(root, () => {});
    },
    notify: () => {},
  });

  await reloader.refresh();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].projectRoot, root);
  assert.equal(seen[0].configPath, config.configPath);
});

test("a file that does not load keeps the last values and warns, never throws", async () => {
  const root = await tmpRoot();
  const config = await freshConfig(root, (c) => {
    c.run.maxAttempts = 4;
  });
  const warnings: string[] = [];
  let reloaded = 0;
  const reloader = new ConfigReloader(config, {
    load: async () => {
      throw new Error("cannot parse config file /x/specs-kit.yaml: bad indentation");
    },
    notify: (message, type) => {
      assert.equal(type, "warning");
      warnings.push(message);
    },
    onReloaded: () => reloaded++,
  });

  await reloader.refresh();

  assert.equal(config.run.maxAttempts, 4, "the last loaded values stay in place");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[specs-kit\] config reload failed: /);
  assert.match(warnings[0], /keeping the last loaded values$/);
  assert.equal(reloaded, 0, "a failed reload must not re-apply anything");
});

test("onReloaded fires after each successful swap, with the shared object", async () => {
  const root = await tmpRoot();
  const config = await loadSpecsKitConfig(root);
  const received: SpecsKitConfig[] = [];
  const reloader = new ConfigReloader(config, {
    load: () => freshConfig(root, () => {}),
    notify: () => {},
    onReloaded: (c) => received.push(c),
  });

  await reloader.refresh();
  await reloader.refresh();

  assert.equal(received.length, 2);
  assert.ok(received.every((c) => c === config), "listeners re-apply from the same shared object");
});

test("nothing to reload is a silent no-op, not the all-default config", async () => {
  const root = await tmpRoot();
  const config = await freshConfig(root, (c) => {
    c.run.noCommit = false;
    c.mode = "full";
  });
  let notified = 0;
  let reloaded = 0;
  const reloader = new ConfigReloader(config, {
    load: async () => null,
    notify: () => notified++,
    onReloaded: () => reloaded++,
  });

  await reloader.refresh();

  assert.equal(config.run.noCommit, false, "an absent file must not reset the start values");
  assert.equal(config.mode, "full");
  assert.equal(notified, 0, "nothing wrong: no warning");
  assert.equal(reloaded, 0, "nothing swapped: no listeners");
});

test("loadConfigIfPresent reads the file once it exists, null while absent", async () => {
  const root = await tmpRoot();

  assert.equal(await loadConfigIfPresent(root), null, "no file, nothing to reload");

  await writeFile(path.join(root, "specs-kit.yaml"), "run:\n  max_attempts: 7\n", "utf8");
  const loaded = await loadConfigIfPresent(root);
  assert.ok(loaded);
  assert.equal(loaded.run.maxAttempts, 7, "a file created mid-run is picked up by the next reload");
});

const TASK: TaskFile = parseTaskFile(
  "docs/specs/001-spec/tasks/TASK-001.md",
  [
    "---",
    "id: TASK-001",
    "title: Task number 1",
    "status: pending",
    "dependencies: []",
    "provides: []",
    "---",
    "",
    "Body of task 1.",
    "",
  ].join("\n"),
);

const okOutcome: PhaseRunOutcome = {
  exitCode: 0,
  timedOut: false,
  aborted: false,
  stopReason: "stop",
  errorMessage: null,
  elapsedMs: 1,
  stderr: "",
};

test("the executor awaits the reload before the pre-hooks of the phase", async () => {
  const root = await tmpRoot();
  const specDir = path.join(root, "docs/specs/001-spec");
  await mkdir(path.join(specDir, "tasks"), { recursive: true });
  await writeFile(path.join(root, "docs/specs/learnings.md"), "# Project Learnings\n", "utf8");
  await writeFile(path.join(specDir, "spec.md"), "# Spec\n\nThe feature, described.\n", "utf8");

  const config = await loadSpecsKitConfig(root);
  config.run.noLogFiles = true;
  const reloader = new ConfigReloader(config, {
    load: () => freshConfig(root, (c) => {
      c.hooks.implementation.pre = ["npm test"];
    }),
    notify: () => {},
  });

  const order: string[] = [];
  const hooksSeen: string[][] = [];
  const executor = new PhaseExecutor({
    config,
    specDir,
    budget: new LoopBudget({ maxSpawnsPerTask: 10, maxSpawnsPerRun: 10, maxRunDurationMs: 3_600_000 }),
    spawnPhase: async () => okOutcome,
    runHooks: async (hooks, _phase, stage) => {
      order.push(`hooks:${stage}`);
      hooksSeen.push(hooks.implementation.pre);
      return [] as HookResult[];
    },
    refreshConfig: async () => {
      order.push("reload");
      await reloader.refresh();
    },
    onNotify: () => {},
    onStream: () => {},
    onLogPath: () => {},
    onPhaseStart: () => {},
    onLogLine: () => {},
  });

  const input: ImplementationPhaseInput = {
    task: TASK,
    learnings: [],
    specId: "001-spec",
    attempt: 1,
    reviewFeedback: null,
    postHookFailures: null,
    upstreamProvides: [],
    routedSuggestions: [],
    firstAttempt: true,
  };
  await executor.run("implementation", input);

  assert.deepEqual(order, ["reload", "hooks:pre", "hooks:post"]);
  assert.deepEqual(hooksSeen[0], ["npm test"], "the phase gates on the hooks of the fresh load");
});
