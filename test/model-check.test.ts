import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONFIG_FILE_NAME, loadSpecsKitConfig } from "../src/config/specs-kit-config.ts";
import {
  configuredModels,
  findMissingModels,
  modelListUnavailableWarning,
  parseModelList,
  unknownModelsError,
  type ConfiguredModel,
} from "../src/loop/model-check.ts";
import { LoopController } from "../src/loop/loop-controller.ts";

/** Temp project with a specs-kit.yaml and one spec directory without tasks. */
async function project(configYaml: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "model-check-"));
  await writeFile(path.join(root, CONFIG_FILE_NAME), configYaml, "utf8");
  await mkdir(path.join(root, "docs/specs/001-alpha"), { recursive: true });
  return root;
}

/** The catalogue as `pi --list-models` would print it, header included. */
const CATALOGUE = [
  "provider     model",
  "opencode-go  deepseek-v4-pro",
  "opencode-go  deepseek-v4-flash",
  "zai          glm-5.2",
].join("\n");

test("parseModelList reads provider and model columns and skips the header", () => {
  assert.deepEqual(parseModelList(CATALOGUE), [
    { provider: "opencode-go", model: "deepseek-v4-pro" },
    { provider: "opencode-go", model: "deepseek-v4-flash" },
    { provider: "zai", model: "glm-5.2" },
  ]);
  assert.deepEqual(parseModelList(""), []);
  // Blank lines and stray output must not poison the parse.
  assert.deepEqual(parseModelList("provider     model\n\nopencode-go  deepseek-v4-pro   \n"), [
    { provider: "opencode-go", model: "deepseek-v4-pro" },
  ]);
});

test("configuredModels collects the five roles and drops auto and empty values", async () => {
  const root = await project(
    "specs_dir: docs/specs\nagents:\n  agent_model: opencode-go/deepseek-v4-pro\n  cleaner_model: \"\"\n",
  );
  try {
    const config = await loadSpecsKitConfig(root);
    // Only the agent role carries a real model: the empty cleaner value and
    // every unset role fall back to "auto", which is nothing to validate.
    assert.deepEqual(configuredModels(config).map((m) => [m.role, m.model]), [
      ["agent", "opencode-go/deepseek-v4-pro"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("findMissingModels reports only the configured models the catalogue lacks", () => {
  const configured: ConfiguredModel[] = [
    { role: "agent", model: "opencode-go/deepseek-v4-pro" },
    { role: "reviewer", model: "pencode-go/deepseek-v4-pro" },
  ];
  const listed = [{ provider: "opencode-go", model: "deepseek-v4-pro" }];
  assert.deepEqual(findMissingModels(configured, listed), [{ role: "reviewer", model: "pencode-go/deepseek-v4-pro" }]);
  assert.deepEqual(findMissingModels(configured, []), configured);
});

test("unknownModelsError names the roles and the models it rejects", () => {
  const message = unknownModelsError([{ role: "reviewer", model: "pencode-go/deepseek-v4-pro" }]);
  assert.match(message, /reviewer: pencode-go\/deepseek-v4-pro/);
  assert.match(message, /specs-kit.yaml/);
});

test("modelListUnavailableWarning is self-identifying and lets the run proceed", () => {
  assert.match(modelListUnavailableWarning(), /\[specs-kit\]/);
  assert.match(modelListUnavailableWarning(), /starts anyway/);
});

test("start refuses to run when a configured model is absent from the catalogue", async () => {
  const root = await project(
    "specs_dir: docs/specs\nagents:\n  agent_model: opencode-go/deepseek-v4-pro\n",
  );
  try {
    const controller = new LoopController(
      {},
      {
        findGraphifySkill: async () => null,
        listModels: async () => [{ provider: "opencode-go", model: "deepseek-v4-flash" }],
      },
    );
    await controller.loadConfig(root);
    await assert.rejects(
      () => controller.start({ specDir: "docs/specs/001-alpha" }),
      /agent: opencode-go\/deepseek-v4-pro/,
      "the error names the role and the model the CLI does not know",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("start warns and proceeds when the catalogue is unobtainable", async () => {
  const root = await project(
    "specs_dir: docs/specs\nagents:\n  agent_model: opencode-go/deepseek-v4-pro\n",
  );
  try {
    const warnings: string[] = [];
    const controller = new LoopController(
      { onNotify: (message, type) => { if (type === "warning") warnings.push(message); } },
      { findGraphifySkill: async () => null, listModels: async () => [] },
    );
    await controller.loadConfig(root);
    // The spec has no tasks/, so the engine itself halts with its own error:
    // the model check must not be the reason this run fails.
    await assert.rejects(() => controller.start({ specDir: "docs/specs/001-alpha" }), /no task files/);
    assert.ok(
      warnings.some((w) => /model catalogue/.test(w)),
      "an unobtainable catalogue must warn before the loop runs",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("start proceeds silently when every configured model is known", async () => {
  const root = await project(
    "specs_dir: docs/specs\nagents:\n  agent_model: opencode-go/deepseek-v4-pro\n",
  );
  try {
    const warnings: string[] = [];
    const controller = new LoopController(
      { onNotify: (message, type) => { if (type === "warning") warnings.push(message); } },
      {
        findGraphifySkill: async () => null,
        listModels: async () => [{ provider: "opencode-go", model: "deepseek-v4-pro" }],
      },
    );
    await controller.loadConfig(root);
    await assert.rejects(() => controller.start({ specDir: "docs/specs/001-alpha" }), /no task files/);
    assert.equal(
      warnings.filter((w) => /model catalogue/.test(w)).length,
      0,
      "a known model must not trigger the catalogue warning",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("start never queries the catalogue when every role is on auto", async () => {
  const root = await project("specs_dir: docs/specs\n");
  try {
    let queries = 0;
    const controller = new LoopController(
      {},
      {
        findGraphifySkill: async () => null,
        listModels: async () => {
          queries++;
          return [];
        },
      },
    );
    await controller.loadConfig(root);
    await assert.rejects(() => controller.start({ specDir: "docs/specs/001-alpha" }), /no task files/);
    assert.equal(queries, 0, "nothing to validate, so the CLI is not queried");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
