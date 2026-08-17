import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSpecsKitConfig, type SpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { loadFixPlan } from "../src/fixplan/fix-plan.ts";
import { LoopEngine } from "../src/loop/engine.ts";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../src/agent/spawner.ts";
import { reviewFilePath } from "../src/loop/review-report.ts";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

function taskContent(n: number): string {
  return [
    "---",
    `id: TASK-00${n}`,
    `title: Task number ${n}`,
    "status: pending",
    "dependencies: []",
    "ac-mapping: []",
    "imp-requirements: []",
    "---",
    "",
    `Body of task ${n}.`,
    "",
  ].join("\n");
}

async function createSpec(): Promise<{ root: string; specDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "phase-interrupt-"));
  tmpDirs.push(root);
  const specDir = path.join(root, "docs/specs/001-spec");
  await mkdir(path.join(specDir, "tasks"), { recursive: true });
  for (let n = 1; n <= 2; n++) {
    await writeFile(path.join(specDir, "tasks", `TASK-00${n}.md`), taskContent(n), "utf8");
  }
  return { root, specDir };
}

function okOutcome(exitCode: number | null, aborted = false): PhaseRunOutcome {
  return { exitCode, timedOut: false, aborted, stopReason: "stop", errorMessage: null, elapsedMs: 1, stderr: "" };
}

const REVIEW_OK = "---\nreview_status: PASSED\nsummary: Looks good\nissues: []\n---\n\nAll good.\n";

/** Recognize the phase from the markers of its prompt (all roles included). */
function phaseOf(prompt: string): string {
  if (prompt.includes("Write your verdict to tasks/")) return "review";
  if (prompt.includes("reusable learnings")) return "learner";
  if (prompt.includes("Update the specification documentation")) return "sync";
  if (prompt.includes("Clean up the code")) return "cleanup";
  return "implementation";
}

test("interrupt during implementation counts as a failed attempt and the loop retries", async () => {
  const { root, specDir } = await createSpec();
  const config = await loadSpecsKitConfig(root);
  config.mode = "fast";

  const calls: string[] = [];
  let interrupted = false;
  let engine: LoopEngine;
  const spawnPhase = async (opts: PhaseSpawnOptions): Promise<PhaseRunOutcome> => {
    const task = /TASK-\d{3}/.exec(opts.prompt)?.[0] ?? "?";
    const phase = phaseOf(opts.prompt);
    calls.push(`${task}:${phase}`);
    if (phase === "implementation" && task === "TASK-001" && !interrupted) {
      interrupted = true;
      setTimeout(() => engine.interruptPhase(), 10);
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) resolve();
        else opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return okOutcome(null, true);
    }
    if (phase === "review") {
      await writeFile(reviewFilePath(specDir, task), REVIEW_OK, "utf8");
    }
    return okOutcome(0);
  };

  engine = new LoopEngine({ config, spawnPhase, runHooks: async () => [], commitCheckpoint: async () => ({ committed: false }), refreshCodebaseGraph: async () => ({ status: "unavailable" as const, detail: "" }) });
  const result = await engine.start({ specDir });

  assert.equal(result.reason, "completed");
  assert.equal(calls.filter((c) => c === "TASK-001:implementation").length, 2);
  assert.equal(calls.filter((c) => c === "TASK-001:review").length, 1);
  const plan = await loadFixPlan(specDir);
  assert.deepEqual(plan?.done, ["TASK-001", "TASK-002"]);
});

// An interrupted review judged nothing, so the implementation it would have
// judged is still the one to judge: the reviewer is spawned again and the
// working code is not re-implemented to get back to the same tree.
test("interrupt during review spawns the reviewer again, not the implementation", async () => {
  const { root, specDir } = await createSpec();
  const config = await loadSpecsKitConfig(root);
  config.mode = "fast";

  const calls: string[] = [];
  let interrupted = false;
  let engine: LoopEngine;
  const spawnPhase = async (opts: PhaseSpawnOptions): Promise<PhaseRunOutcome> => {
    const task = /TASK-\d{3}/.exec(opts.prompt)?.[0] ?? "?";
    const phase = phaseOf(opts.prompt);
    calls.push(`${task}:${phase}`);
    if (phase === "review" && task === "TASK-001" && !interrupted) {
      interrupted = true;
      setTimeout(() => engine.interruptPhase(), 10);
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) resolve();
        else opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return okOutcome(null, true);
    }
    if (phase === "review") {
      await writeFile(reviewFilePath(specDir, task), REVIEW_OK, "utf8");
    }
    return okOutcome(0);
  };

  engine = new LoopEngine({ config, spawnPhase, runHooks: async () => [], commitCheckpoint: async () => ({ committed: false }), refreshCodebaseGraph: async () => ({ status: "unavailable" as const, detail: "" }) });
  const result = await engine.start({ specDir });

  assert.equal(result.reason, "completed");
  assert.equal(calls.filter((c) => c === "TASK-001:implementation").length, 1);
  assert.equal(calls.filter((c) => c === "TASK-001:review").length, 2);
  const plan = await loadFixPlan(specDir);
  assert.deepEqual(plan?.done, ["TASK-001", "TASK-002"]);
});

test("interruptPhase on an idle engine is a no-op", () => {
  const config = { projectRoot: "/tmp" } as unknown as SpecsKitConfig;
  const engine = new LoopEngine({ config, spawnPhase: async () => okOutcome(0) });
  assert.doesNotThrow(() => engine.interruptPhase());
});
