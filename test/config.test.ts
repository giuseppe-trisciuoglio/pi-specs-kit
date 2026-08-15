import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  CONFIG_FILE_NAME,
  DEFAULT_RUN_CONFIG,
  ROLE_NAMES,
  loadSpecsKitConfig,
} from "../src/config/specs-kit-config.ts";
import { ensureConfigFile } from "../src/config/config-init.ts";
import {
  updateActiveSpec,
  updateHooksTimeout,
  updatePhaseHooks,
  updateReviewPanel,
  updateRoleConfig,
  updateRunConfig,
} from "../src/config/config-writer.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "specs-kit-config-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const FULL_CONFIG = `
version: "1"
specs_dir: docs/custom-specs
spec: docs/custom-specs/active
mode: full
poll_interval: 250ms
agents:
  agent: pi
  agent_model: provider/fast
  agent_thinking_level: high
  reviewer_model: provider/careful
  learner_thinking_level: low
run:
  max_attempts: 7
  timeout: 60m
  no_commit: false
  yolo: false
  debug_stream: false
  no_log_files: true
  show_prompt: false
  skill_content: false
  verbose: true
  continue_on_failure: true
  resume: true
  review_file_retry: 9
  from_task: "02"
  to_task: "05"
git:
  baseBranch: develop
hooks:
  timeout: 240s
  implementation:
    pre: npm run lint
    post: [npm test, npm run build]
  review: { pre: [], post: [] }
  cleanup: { pre: [], post: [] }
  sync: { pre: [], post: [] }
knowledge_base:
  files: ["./docs/a.md", "./docs/b.md"]
prompts:
  system_overrides:
    unsupported_policy: skip
    agent_phase:
      pi:
        implementation: { mode: append, source: file, file: ./extra.md }
        review: { mode: replace, source: text, text: be strict }
`;

test("missing file yields all defaults", async () => {
  await withTempDir(async (dir) => {
    const config = await loadSpecsKitConfig(dir);
    assert.equal(config.version, "1");
    assert.equal(config.projectRoot, dir);
    assert.equal(config.configPath, path.join(dir, CONFIG_FILE_NAME));
    assert.equal(config.specsDir, "docs/specs");
    assert.equal(config.spec, undefined);
    assert.equal(config.mode, "fast");
    assert.equal(config.pollIntervalMs, 100);
    for (const role of ROLE_NAMES) {
      assert.equal(config.roles[role].model, "auto");
      assert.equal(config.roles[role].thinkingLevel, undefined);
    }
    assert.deepEqual(config.run, DEFAULT_RUN_CONFIG);
    assert.equal(config.git.baseBranch, "main");
    assert.equal(config.hooks.timeoutMs, 240_000);
    assert.deepEqual(config.hooks.implementation, { pre: [], post: [] });
    assert.deepEqual(config.knowledgeBase.files, []);
    assert.equal(config.prompts.unsupportedPolicy, "error");
    assert.deepEqual(config.prompts.phaseOverrides, {});
  });
});

test("full yaml maps every field", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, FULL_CONFIG);
    const config = await loadSpecsKitConfig(dir);

    assert.equal(config.specsDir, "docs/custom-specs");
    assert.equal(config.spec, "docs/custom-specs/active");
    assert.equal(config.mode, "full");
    assert.equal(config.pollIntervalMs, 250);

    assert.deepEqual(config.roles.agent, { model: "provider/fast", thinkingLevel: "high" });
    assert.deepEqual(config.roles.reviewer, { model: "provider/careful", thinkingLevel: undefined });
    assert.deepEqual(config.roles.learner, { model: "auto", thinkingLevel: "low" });
    assert.deepEqual(config.roles.cleaner, { model: "auto", thinkingLevel: undefined });

    assert.equal(config.run.maxAttempts, 7);
    assert.equal(config.run.timeoutMs, 3_600_000);
    assert.equal(config.run.noCommit, false);
    assert.equal(config.run.yolo, false);
    assert.equal(config.run.resume, true);
    assert.equal(config.run.reviewFileRetry, 9);
    assert.equal(config.run.fromTask, "02");
    assert.equal(config.run.toTask, "05");

    assert.equal(config.git.baseBranch, "develop");
    assert.equal(config.hooks.timeoutMs, 240_000);
    assert.deepEqual(config.hooks.implementation, { pre: ["npm run lint"], post: ["npm test", "npm run build"] });
    assert.deepEqual(config.hooks.sync, { pre: [], post: [] });

    assert.deepEqual(config.knowledgeBase.files, ["./docs/a.md", "./docs/b.md"]);

    assert.equal(config.prompts.unsupportedPolicy, "skip");
    assert.deepEqual(config.prompts.phaseOverrides.implementation, {
      mode: "append", source: "file", file: "./extra.md", text: undefined,
    });
    assert.deepEqual(config.prompts.phaseOverrides.review, {
      mode: "replace", source: "text", file: undefined, text: "be strict",
    });
    assert.equal(config.prompts.phaseOverrides.cleanup, undefined);
  });
});

test("unknown fields are tolerated", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, "unknown_top: true\nrun:\n  unknown_run: 1\nagents:\n  other_agent: x\n");
    const config = await loadSpecsKitConfig(dir);
    assert.deepEqual(config.run, DEFAULT_RUN_CONFIG);
    for (const role of ROLE_NAMES) assert.equal(config.roles[role].model, "auto");
  });
});

test("duration strings parse to milliseconds", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, "poll_interval: 100ms\nrun:\n  timeout: 60m\nhooks:\n  timeout: 240s\n");
    const config = await loadSpecsKitConfig(dir);
    assert.equal(config.pollIntervalMs, 100);
    assert.equal(config.run.timeoutMs, 3_600_000);
    assert.equal(config.hooks.timeoutMs, 240_000);
  });
});

test("malformed yaml errors out naming the file", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, "run:\n  - a\n  bad: [unclosed\n");
    await assert.rejects(loadSpecsKitConfig(dir), (err: Error) => err.message.includes(file));
  });
});

test("explicit config path override is honored", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "custom.yaml");
    await writeFile(file, "mode: full\n");
    const config = await loadSpecsKitConfig(dir, file);
    assert.equal(config.configPath, file);
    assert.equal(config.mode, "full");
  });
});

test("writer updates model and thinking level, preserving other fields", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, FULL_CONFIG);
    await updateRoleConfig(file, "reviewer", { model: "provider/new", thinkingLevel: "medium" });

    const doc = YAML.parse(await readFile(file, "utf8"));
    assert.equal(doc.agents.reviewer_model, "provider/new");
    assert.equal(doc.agents.reviewer_thinking_level, "medium");
    // Untouched fields survive the rewrite.
    assert.equal(doc.agents.agent_model, "provider/fast");
    assert.equal(doc.run.max_attempts, 7);
    assert.equal(doc.git.baseBranch, "develop");
    assert.deepEqual(doc.knowledge_base.files, ["./docs/a.md", "./docs/b.md"]);
  });
});

test("writer removes the thinking level on null and leaves it on undefined", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, FULL_CONFIG);
    await updateRoleConfig(file, "agent", { thinkingLevel: null });
    let doc = YAML.parse(await readFile(file, "utf8"));
    assert.equal(doc.agents.agent_model, "provider/fast");
    assert.equal("agent_thinking_level" in doc.agents, false);

    await updateRoleConfig(file, "agent", { model: "provider/other" });
    doc = YAML.parse(await readFile(file, "utf8"));
    assert.equal(doc.agents.agent_model, "provider/other");
    assert.equal("agent_thinking_level" in doc.agents, false);
  });
});

test("writer creates a missing file with a minimal structure", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await updateRoleConfig(file, "learner", { model: "provider/x", thinkingLevel: "low" });
    const doc = YAML.parse(await readFile(file, "utf8"));
    assert.deepEqual(doc, { agents: { learner_model: "provider/x", learner_thinking_level: "low" } });
    // Reloading the written file works and maps the role.
    const config = await loadSpecsKitConfig(dir);
    assert.deepEqual(config.roles.learner, { model: "provider/x", thinkingLevel: "low" });
  });
});

test("hooks writer adds commands creating the section when missing", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, "agents:\n  agent_model: provider/fast\n");
    await updatePhaseHooks(file, "review", "pre", ["npm run lint", "npm test"]);

    const doc = YAML.parse(await readFile(file, "utf8"));
    assert.deepEqual(doc.hooks.review.pre, ["npm run lint", "npm test"]);
    assert.equal(doc.agents.agent_model, "provider/fast");
    // The written file round-trips through the loader.
    const config = await loadSpecsKitConfig(dir);
    assert.deepEqual(config.hooks.review.pre, ["npm run lint", "npm test"]);
    assert.deepEqual(config.hooks.implementation.pre, []);
  });
});

test("hooks writer replaces a stage list preserving sibling stages and phases", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, FULL_CONFIG);
    await updatePhaseHooks(file, "implementation", "pre", ["npm run ci"]);

    const doc = YAML.parse(await readFile(file, "utf8"));
    assert.deepEqual(doc.hooks.implementation.pre, ["npm run ci"]);
    // Untouched fields survive the rewrite.
    assert.deepEqual(doc.hooks.implementation.post, ["npm test", "npm run build"]);
    assert.equal(doc.hooks.timeout, "240s");
    assert.equal(doc.run.max_attempts, 7);
  });
});

test("hooks writer clears a stage with an empty list", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, FULL_CONFIG);
    await updatePhaseHooks(file, "implementation", "post", []);

    const config = await loadSpecsKitConfig(dir);
    assert.deepEqual(config.hooks.implementation.post, []);
    assert.deepEqual(config.hooks.implementation.pre, ["npm run lint"]);
  });
});

test("timeout writer updates hooks.timeout keeping the phase hooks", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, FULL_CONFIG);
    await updateHooksTimeout(file, "5m");

    const doc = YAML.parse(await readFile(file, "utf8"));
    assert.equal(doc.hooks.timeout, "5m");
    assert.deepEqual(doc.hooks.implementation.post, ["npm test", "npm run build"]);
    const config = await loadSpecsKitConfig(dir);
    assert.equal(config.hooks.timeoutMs, 300_000);
  });
});

test("run writer updates scalars keeping the rest of the config", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, FULL_CONFIG);
    await updateRunConfig(file, [
      { field: "max_attempts", value: 3 },
      { field: "timeout", value: "40m" },
      { field: "no_commit", value: true },
      { field: "yolo", value: true },
      { field: "debug_stream", value: true },
      { field: "no_log_files", value: false },
      { field: "show_prompt", value: true },
      { field: "skill_content", value: true },
    ]);

    const doc = YAML.parse(await readFile(file, "utf8"));
    assert.equal(doc.run.max_attempts, 3);
    assert.equal(doc.run.timeout, "40m");
    assert.equal(doc.run.no_commit, true);
    assert.equal(doc.run.yolo, true);
    assert.equal(doc.run.debug_stream, true);
    assert.equal(doc.run.no_log_files, false);
    assert.equal(doc.run.show_prompt, true);
    assert.equal(doc.run.skill_content, true);
    // Untouched fields survive the rewrite.
    assert.equal(doc.agents.agent_model, "provider/fast");
    assert.equal(doc.git.baseBranch, "develop");
    assert.deepEqual(doc.hooks.implementation.post, ["npm test", "npm run build"]);

    const config = await loadSpecsKitConfig(dir);
    assert.equal(config.run.maxAttempts, 3);
    assert.equal(config.run.timeoutMs, 2_400_000);
    assert.equal(config.run.noCommit, true);
    assert.equal(config.run.skillContent, true);
  });
});

test("run writer deletes a key on null, reverting to the default", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, FULL_CONFIG);
    await updateRunConfig(file, [{ field: "yolo", value: null }]);

    const doc = YAML.parse(await readFile(file, "utf8"));
    assert.equal("yolo" in doc.run, false);
    assert.equal(doc.run.max_attempts, 7);
    const config = await loadSpecsKitConfig(dir);
    assert.equal(config.run.yolo, DEFAULT_RUN_CONFIG.yolo);
  });
});

test("run writer creates a missing file with a minimal structure", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await updateRunConfig(file, [{ field: "timeout", value: "40m" }]);
    const doc = YAML.parse(await readFile(file, "utf8"));
    assert.deepEqual(doc, { run: { timeout: "40m" } });
    const config = await loadSpecsKitConfig(dir);
    assert.equal(config.run.timeoutMs, 2_400_000);
  });
});

test("hooks writer creates a missing file with a minimal structure", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await updatePhaseHooks(file, "sync", "post", ["git status"]);
    const doc = YAML.parse(await readFile(file, "utf8"));
    assert.deepEqual(doc, { hooks: { sync: { post: ["git status"] } } });
  });
});

test("writer refuses a malformed config instead of dropping the unparseable part", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    const broken = "agents:\n  agent_model: keep-me\n   bad_indent: oops\n";
    await writeFile(file, broken);

    await assert.rejects(
      () => updateActiveSpec(file, "docs/specs/001-x"),
      /invalid YAML/,
      "a config the loader would reject must not be rewritten",
    );
    assert.equal(await readFile(file, "utf8"), broken, "the file is left untouched");
  });
});

test("concurrent writers do not lose each other's mutation", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, "agents:\n  agent_model: original\n");

    await Promise.all([
      updateActiveSpec(file, "docs/specs/001-x"),
      updateRunConfig(file, [{ field: "timeout", value: "40m" }]),
    ]);

    const doc = YAML.parse(await readFile(file, "utf8"));
    assert.equal(doc.spec, "docs/specs/001-x");
    assert.equal(doc.run.timeout, "40m");
    assert.equal(doc.agents.agent_model, "original");
  });
});

test("writer snapshots the original content in a .bak only once", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, "agents:\n  agent_model: original\n");
    await updateRoleConfig(file, "agent", { model: "second" });
    await updateRoleConfig(file, "agent", { model: "third" });

    const backup = YAML.parse(await readFile(`${file}.bak`, "utf8"));
    assert.equal(backup.agents.agent_model, "original");
    const current = YAML.parse(await readFile(file, "utf8"));
    assert.equal(current.agents.agent_model, "third");
  });
});

test("max_attempts below 1 falls back to the default", async () => {
  await withTempDir(async (dir) => {
    for (const value of ["0", "-3", "0.5"]) {
      await writeFile(path.join(dir, CONFIG_FILE_NAME), `run:\n  max_attempts: ${value}\n`, "utf8");
      const config = await loadSpecsKitConfig(dir);
      // A zero (or negative) budget would fail every task without running a
      // single phase, and continue_on_failure would call that run a success.
      assert.equal(config.run.maxAttempts, DEFAULT_RUN_CONFIG.maxAttempts, `max_attempts: ${value}`);
    }

    await writeFile(path.join(dir, CONFIG_FILE_NAME), "run:\n  max_attempts: 2\n", "utf8");
    assert.equal((await loadSpecsKitConfig(dir)).run.maxAttempts, 2);
  });
});

test("a zero duration is refused instead of read as no limit", async () => {
  await withTempDir(async (dir) => {
    // A phase subprocess with no wall-clock limit is how an agent that never
    // returns keeps spending tokens until somebody notices the bill.
    for (const [field, yaml] of [
      ["run.timeout", "run:\n  timeout: 0\n"],
      ["run.max_run_duration", "run:\n  max_run_duration: 0s\n"],
      ["hooks.timeout", "hooks:\n  timeout: 0ms\n"],
    ]) {
      await writeFile(path.join(dir, CONFIG_FILE_NAME), yaml, "utf8");
      await assert.rejects(loadSpecsKitConfig(dir), new RegExp(`${field.replace(".", "\\.")} must be greater than zero`));
    }
  });
});

test("the run ceilings are read from the config and default when out of range", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, CONFIG_FILE_NAME),
      "run:\n  max_spawns_per_task: 4\n  max_spawns_per_run: 20\n  max_run_duration: 90m\n",
      "utf8",
    );
    const config = await loadSpecsKitConfig(dir);
    assert.equal(config.run.maxSpawnsPerTask, 4);
    assert.equal(config.run.maxSpawnsPerRun, 20);
    assert.equal(config.run.maxRunDurationMs, 90 * 60_000);

    // Zero would disable the ceiling, which is the state the ceilings exist to
    // prevent: it falls back to the default rather than switching them off.
    await writeFile(path.join(dir, CONFIG_FILE_NAME), "run:\n  max_spawns_per_task: 0\n  max_spawns_per_run: -1\n", "utf8");
    const fallback = await loadSpecsKitConfig(dir);
    assert.equal(fallback.run.maxSpawnsPerTask, DEFAULT_RUN_CONFIG.maxSpawnsPerTask);
    assert.equal(fallback.run.maxSpawnsPerRun, DEFAULT_RUN_CONFIG.maxSpawnsPerRun);
  });
});

test("ensureConfigFile creates a default file that loads back as the defaults", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    assert.equal(await ensureConfigFile(file), true);

    const written = await readFile(file, "utf8");
    const doc = YAML.parse(written) as Record<string, unknown>;
    assert.equal(doc.specs_dir, "docs/specs");
    // Durations are written with their unit: a bare number would be read as
    // milliseconds and cut every phase short.
    assert.equal((doc.run as Record<string, unknown>).timeout, "1h");
    assert.equal((doc.run as Record<string, unknown>).max_run_duration, "6h");

    const config = await loadSpecsKitConfig(dir);
    const bare = await loadSpecsKitConfig(path.join(dir, "empty"));
    assert.deepEqual(config.run, bare.run);
    assert.deepEqual(config.hooks, bare.hooks);
    assert.equal(config.specsDir, bare.specsDir);
    assert.equal(config.mode, bare.mode);
    assert.equal(config.version, bare.version);
    assert.equal(config.git.baseBranch, bare.git.baseBranch);
    for (const role of ROLE_NAMES) {
      assert.equal(config.roles[role].model, "auto");
    }
    // No spec is picked yet: the authoring tool writes it later.
    assert.equal(config.spec, undefined);
  });
});

test("the review panel is read as an ordered list of reviewers", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, CONFIG_FILE_NAME),
      [
        "adversarial_review:",
        "  panel:",
        "    - model: provider-a/first",
        "    - model: provider-b/second",
        "      thinking: high",
        "    - model: provider-c/third",
        "",
      ].join("\n"),
      "utf8",
    );
    const config = await loadSpecsKitConfig(dir);
    // Order is meaningful: it decides which reviewer gets which critique angle.
    assert.deepEqual(config.reviewPanel, [
      { model: "provider-a/first" },
      { model: "provider-b/second", thinkingLevel: "high" },
      { model: "provider-c/third" },
    ]);
  });
});

test("a review panel that is absent or malformed reads as empty", async () => {
  await withTempDir(async (dir) => {
    for (const yaml of [
      "",
      "adversarial_review: {}\n",
      "adversarial_review:\n  panel: not-a-list\n",
      // Entries without a model name nothing to spawn, so they are dropped
      // instead of becoming a reviewer the run cannot start.
      "adversarial_review:\n  panel:\n    - thinking: high\n    - {}\n",
    ]) {
      await writeFile(path.join(dir, CONFIG_FILE_NAME), yaml, "utf8");
      assert.deepEqual((await loadSpecsKitConfig(dir)).reviewPanel, [], yaml);
    }
  });
});

test("a review panel entry may be written as a bare model string", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, CONFIG_FILE_NAME),
      "adversarial_review:\n  panel: [provider-a/first, provider-b/second]\n",
      "utf8",
    );
    assert.deepEqual((await loadSpecsKitConfig(dir)).reviewPanel, [
      { model: "provider-a/first" },
      { model: "provider-b/second" },
    ]);
  });
});

test("updateReviewPanel replaces the list and leaves the rest of the file alone", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, "specs_dir: docs/custom-specs\nagents:\n  agent_model: provider/fast\n", "utf8");

    await updateReviewPanel(file, [
      { model: "provider-a/first" },
      { model: "provider-b/second", thinkingLevel: "high" },
    ]);

    const config = await loadSpecsKitConfig(dir);
    assert.deepEqual(config.reviewPanel, [
      { model: "provider-a/first" },
      { model: "provider-b/second", thinkingLevel: "high" },
    ]);
    assert.equal(config.specsDir, "docs/custom-specs");
    assert.equal(config.roles.agent.model, "provider/fast");

    // The list is replaced wholesale: a reviewer removed from the panel must
    // not survive in the file, or the next run spends on a model the operator
    // just took out.
    await updateReviewPanel(file, [{ model: "provider-a/first" }]);
    assert.deepEqual((await loadSpecsKitConfig(dir)).reviewPanel, [{ model: "provider-a/first" }]);

    await updateReviewPanel(file, []);
    assert.deepEqual((await loadSpecsKitConfig(dir)).reviewPanel, []);
  });
});

test("ensureConfigFile leaves an existing file untouched", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, "specs_dir: docs/custom-specs\n", "utf8");
    assert.equal(await ensureConfigFile(file), false);
    assert.equal(await readFile(file, "utf8"), "specs_dir: docs/custom-specs\n");
  });
});
