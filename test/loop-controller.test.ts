import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_FILE_NAME } from "../src/config/specs-kit-config.ts";
import { LoopController } from "../src/loop/loop-controller.ts";

/** Temp project with a specs-kit.yaml and two spec directories. */
async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loop-controller-"));
  await writeFile(path.join(root, CONFIG_FILE_NAME), "specs_dir: docs/specs\n");
  await mkdir(path.join(root, "docs/specs/001-alpha"), { recursive: true });
  await mkdir(path.join(root, "docs/specs/002-beta"), { recursive: true });
  return root;
}

test("setActiveSpec persists the spec and refreshes the cached config", async () => {
  const root = await project();
  try {
    const controller = new LoopController();
    const initial = await controller.loadConfig(root);
    assert.equal(initial.spec, undefined);

    await controller.setActiveSpec("docs/specs/002-beta");

    // The cached config is what every later command reads: a write without
    // the reload leaves the rest of the session on the previous spec.
    assert.equal(controller.config?.spec, "docs/specs/002-beta");
    const onDisk = YAML.parse(await readFile(path.join(root, CONFIG_FILE_NAME), "utf8"));
    assert.equal(onDisk.spec, "docs/specs/002-beta");

    await controller.setActiveSpec("docs/specs/001-alpha");
    assert.equal(controller.config?.spec, "docs/specs/001-alpha");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setActiveSpec requires a loaded config", async () => {
  await assert.rejects(() => new LoopController().setActiveSpec("docs/specs/001-alpha"), /config not loaded/);
});

test("start warns when graphify is missing and stays silent when it is installed", async () => {
  const root = await project();
  try {
    // The spec directories have no tasks/, so prepareRun halts before any
    // subprocess is spawned: that lets the graphify pre-flight (which runs
    // earlier, in start itself) be observed without a fake agent on the PATH.
    const warnings: string[] = [];

    const missing = new LoopController(
      { onNotify: (message, type) => { if (type === "warning") warnings.push(message); } },
      { findGraphifySkill: async () => null },
    );
    await missing.loadConfig(root);
    await assert.rejects(() => missing.start({ specDir: "docs/specs/001-alpha" }), /no task files/);
    assert.ok(
      warnings.some((w) => /graphify/.test(w)),
      "a missing graphify must warn before the loop runs",
    );

    const present = new LoopController(
      { onNotify: (message, type) => { if (type === "warning") warnings.push(message); } },
      {
        findGraphifySkill: async () => ({
          name: "graphify",
          dir: "/skills/graphify",
          skillPath: "/skills/graphify/SKILL.md",
          content: "",
        }),
      },
    );
    await present.loadConfig(root);
    const before = warnings.length;
    await assert.rejects(() => present.start({ specDir: "docs/specs/001-alpha" }), /no task files/);
    assert.equal(warnings.length, before, "no graphify warning when the skill is installed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
