import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { emptyFixPlan, type FixPlan } from "../src/fixplan/fix-plan.ts";
import { parseTaskFile, type TaskFile } from "../src/tasks/task-parser.ts";
import type { PhaseExecutor, PhaseStepResult } from "../src/loop/phases.ts";
import { runReviewStep, type ReviewStepDeps, type ReviewVerdict } from "../src/loop/review-runner.ts";
import { reviewAttemptArchivePath, reviewFilePath } from "../src/loop/review-report.ts";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

/** Spec dir with a tasks/ folder and no review report: every read finds none. */
async function createSpec(): Promise<{ root: string; specDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "review-runner-"));
  tmpDirs.push(root);
  const specDir = path.join(root, "docs/specs/001-spec");
  await mkdir(path.join(specDir, "tasks"), { recursive: true });
  return { root, specDir };
}

const TASK: TaskFile = parseTaskFile(
  "tasks/TASK-001.md",
  "---\nid: TASK-001\ntitle: Task number 1\nstatus: pending\n---\n\nBody.\n",
);

const okResult: PhaseStepResult = {
  preHooksOk: true,
  hookResults: [],
  outcome: { exitCode: 0, timedOut: false, aborted: false, stopReason: "stop", errorMessage: null, elapsedMs: 1, stderr: "" },
};
const preHookFailure: PhaseStepResult = { preHooksOk: false, hookResults: [], outcome: null };
const abortedResult: PhaseStepResult = { ...okResult, outcome: { ...okResult.outcome!, aborted: true } };
const crashedResult: PhaseStepResult = { ...okResult, outcome: { ...okResult.outcome!, exitCode: 1, stopReason: "error" } };

interface Harness {
  deps: ReviewStepDeps;
  plan: FixPlan;
  /** Declared input of every review spawn, in order. */
  prompts: { reviewFormatError: string | null }[];
  /** Spawns performed so far, across every review step call. */
  spawns: () => number;
}

/** Review step wired to a scripted executor; the report file is never written. */
async function harness(script: (spawn: number) => PhaseStepResult): Promise<Harness> {
  const { root, specDir } = await createSpec();
  const config = await loadSpecsKitConfig(root);
  config.run.reviewFileRetry = 2;
  const plan = emptyFixPlan("001-spec", "docs/specs/001-spec");

  let spawns = 0;
  const prompts: { reviewFormatError: string | null }[] = [];
  const executor = {
    run: async (_phase: string, input: { reviewFormatError: string | null }): Promise<PhaseStepResult> => {
      prompts.push(input);
      return script(++spawns);
    },
  } as unknown as PhaseExecutor;

  return {
    plan,
    prompts,
    spawns: () => spawns,
    deps: {
      config,
      specDir,
      executor,
      persist: async () => {},
      notify: () => {},
      stopping: () => null,
      signal: () => undefined,
    },
  };
}

test("a failed pre-review hook hands a full review file budget to the next attempt", async () => {
  // First attempt: one spawn without a report, then the hooks start failing.
  const h = await harness((spawn) => (spawn === 2 ? preHookFailure : okResult));
  const first = await runReviewStep(h.deps, h.plan, TASK);

  assert.deepEqual(first, { kind: "attemptFailed" } satisfies ReviewVerdict);
  assert.equal(h.plan.state.review_file_retry, 0, "the budget of the lost attempt is not carried over");

  // Second attempt: the configured retries are all available again, so the
  // budget is spent over three spawns instead of the two left behind. With no
  // readable verdict at the end of it, the reviewer — not the implementation —
  // is what is broken, and the task is abandoned rather than re-implemented.
  const second = await runReviewStep(h.deps, h.plan, TASK);
  assert.equal(second.kind, "reportUnusable");
  assert.equal(h.spawns(), 5);
  assert.match(h.plan.state.review_file_error ?? "", /after 2 new attempts/);
});

test("a review subprocess that failed is not read as a reviewer who forgot the file", async () => {
  // An agent that cannot start (rejected model, expired key, rate limit) fails
  // the same way every time: spending the review file budget on it buys three
  // more identical failures, so one is enough to end the attempt.
  const h = await harness(() => crashedResult);
  const verdict = await runReviewStep(h.deps, h.plan, TASK);

  assert.deepEqual(verdict, { kind: "attemptFailed" } satisfies ReviewVerdict);
  assert.equal(h.spawns(), 1, "the crashed spawn is not retried against the review file budget");
  assert.equal(h.plan.state.review_file_retry, 0);
});

test("a re-spawned reviewer is told what was wrong with its previous report", async () => {
  const h = await harness(() => okResult);
  await runReviewStep(h.deps, h.plan, TASK);

  assert.equal(h.spawns(), 3);
  assert.equal(h.prompts[0].reviewFormatError ?? null, null, "the first spawn has nothing to correct");
  for (const opts of h.prompts.slice(1)) {
    assert.match(opts.reviewFormatError ?? "", /review_status/);
    assert.match(opts.reviewFormatError ?? "", /TASK-001/);
  }
});

test("an interrupted review hands a full review file budget to the next attempt", async () => {
  const h = await harness((spawn) => (spawn === 2 ? abortedResult : okResult));
  const first = await runReviewStep(h.deps, h.plan, TASK);

  assert.deepEqual(first, { kind: "attemptFailed" } satisfies ReviewVerdict);
  assert.equal(h.plan.state.review_file_retry, 0);

  const second = await runReviewStep(h.deps, h.plan, TASK);
  assert.equal(second.kind, "reportUnusable");
  assert.equal(h.spawns(), 5);
});

test("a prior verdict is archived before the canonical report is wiped", async () => {
  // A retry used to silently overwrite the reasoning of the verdict it
  // replaced. The loop must move any readable verdict to a per-attempt archive
  // before clearing the canonical report path.
  const { root, specDir } = await createSpec();
  const config = await loadSpecsKitConfig(root);
  config.run.reviewFileRetry = 2;
  const plan = emptyFixPlan("001-spec", "docs/specs/001-spec");
  plan.state.retry_count = 1;
  const priorVerdict =
    "---\nreview_status: FAILED\nsummary: missing handoff\nissues:\n  - codify the DTO styles\nrouted: []\n---\n\nbody of the failed review\n";
  await writeFile(reviewFilePath(specDir, "TASK-001"), priorVerdict, "utf8");

  // First spawn writes a passing report so the loop returns after one round.
  const executor = {
    run: async (): Promise<PhaseStepResult> => {
      await writeFile(
        reviewFilePath(specDir, "TASK-001"),
        "---\nreview_status: PASSED\nsummary: ok\nissues: []\nrouted: []\n---\n\nbody\n",
        "utf8",
      );
      return okResult;
    },
  } as unknown as PhaseExecutor;
  const deps: ReviewStepDeps = {
    config,
    specDir,
    executor,
    persist: async () => {},
    notify: () => {},
    stopping: () => null,
    signal: () => undefined,
  };

  const verdict = await runReviewStep(deps, plan, TASK);
  assert.equal(verdict.kind, "passed");

  const archive = reviewAttemptArchivePath(specDir, "TASK-001", 1);
  assert.equal(existsSync(archive), true, "the prior verdict was archived");
  assert.equal(await readFile(archive, "utf8"), priorVerdict, "the archive holds the exact prior verdict");
  assert.equal(
    await readFile(reviewFilePath(specDir, "TASK-001"), "utf8"),
    "---\nreview_status: PASSED\nsummary: ok\nissues: []\nrouted: []\n---\n\nbody\n",
    "the canonical path now holds the fresh verdict",
  );
});
