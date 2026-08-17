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
import { reviewUnreadablePath, runReviewStep, type ReviewStepDeps, type ReviewVerdict } from "../src/loop/review-runner.ts";
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
  postHooksOk: true,
  failedPostHooks: [],
  outcome: { exitCode: 0, timedOut: false, aborted: false, stopReason: "stop", errorMessage: null, elapsedMs: 1, stderr: "" },
};
const preHookFailure: PhaseStepResult = {
  preHooksOk: false,
  hookResults: [],
  postHooksOk: true,
  failedPostHooks: [],
  outcome: null,
};
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
  // more identical failures, so one is enough to end the attempt. Nothing the
  // implementation does can change the outcome, so the verdict is unusable
  // rather than a lost attempt, and the attempt counter stays put.
  const h = await harness(() => crashedResult);
  const verdict = await runReviewStep(h.deps, h.plan, TASK);

  assert.deepEqual(
    verdict,
    { kind: "reportUnusable", detail: "review agent-error: agent error" } satisfies ReviewVerdict,
  );
  assert.equal(h.spawns(), 1, "the crashed spawn is not retried against the review file budget");
  assert.equal(h.plan.state.review_file_retry, 0);
});

test("a timed-out reviewer is reported as unusable with the real cause", async () => {
  const timedOut: PhaseStepResult = { ...okResult, outcome: { ...okResult.outcome!, timedOut: true } };
  const h = await harness(() => timedOut);
  const verdict = await runReviewStep(h.deps, h.plan, TASK);

  assert.deepEqual(
    verdict,
    { kind: "reportUnusable", detail: "review timeout: the phase outlived its timeout" } satisfies ReviewVerdict,
  );
});

test("a review spawn failure does not consume a task attempt", async () => {
  // The review step itself never touches the attempt counter, and the gate
  // routes an unusable verdict to the failure funnel without incrementing it:
  // an environment failure must not spend any of the task's attempts, or the
  // next re-implementation would start from a smaller budget for nothing.
  const h = await harness(() => crashedResult);
  h.plan.state.retry_count = 2;
  const verdict = await runReviewStep(h.deps, h.plan, TASK);

  assert.equal(verdict.kind, "reportUnusable");
  assert.equal(h.plan.state.retry_count, 2, "the attempt counter is untouched by a spawn failure");
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

test("an interrupted review is re-spawned rather than paid for with a task attempt", async () => {
  // An interrupt says nothing about the implementation: it was never judged.
  // Re-implementing working code to reach a second opinion costs two agent
  // sessions to arrive where the loop already was, so the reviewer is spawned
  // again inside the same bounded budget and the attempt counter stays put.
  const h = await harness((spawn) => (spawn === 1 ? abortedResult : okResult));
  h.plan.state.retry_count = 1;
  const verdict = await runReviewStep(h.deps, h.plan, TASK);

  assert.equal(verdict.kind, "reportUnusable", "the budget is spent on the missing report, not on the interrupt");
  assert.equal(h.spawns(), 3, "one interrupted spawn plus the two the review file budget allows");
  assert.equal(h.plan.state.retry_count, 1, "the attempt counter is untouched by an interrupt");
});

test("interrupts beyond the review budget end the attempt", async () => {
  const h = await harness(() => abortedResult);
  const verdict = await runReviewStep(h.deps, h.plan, TASK);

  assert.deepEqual(verdict, { kind: "attemptFailed" } satisfies ReviewVerdict);
  assert.equal(h.spawns(), 3, "two retries on top of the first interrupted spawn");
  assert.equal(h.plan.state.review_file_retry, 0, "the budget of the lost attempt is not carried over");
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

test("a red post-hook gate after the review is recorded on the run", async () => {
  // The reviewer writes no code, so nothing it could do differently would turn
  // the gate green, and this phase has no retry path of its own. Recording it
  // is what keeps the range from closing clean over a red gate.
  const { root, specDir } = await createSpec();
  const config = await loadSpecsKitConfig(root);
  const plan = emptyFixPlan("001-spec", "docs/specs/001-spec");
  const executor = {
    run: async (): Promise<PhaseStepResult> => {
      await writeFile(
        reviewFilePath(specDir, "TASK-001"),
        "---\nreview_status: PASSED\nsummary: ok\nissues: []\nrouted: []\n---\n\nbody\n",
        "utf8",
      );
      return {
        ...okResult,
        postHooksOk: false,
        failedPostHooks: [
          { command: "mvn verify", ok: false, output: "BUILD FAILURE", exitCode: 1, timedOut: false },
        ],
      };
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

  assert.equal(verdict.kind, "passed", "a red gate does not change the verdict the reviewer stated");
  assert.equal(plan.state.postHookGateFailed, "review", "the red gate is recorded for the closing notice");
});

/** Review step whose spawns write the given report contents, in order. */
async function reportingHarness(
  reports: string[],
): Promise<{ deps: ReviewStepDeps; plan: FixPlan; specDir: string; prompts: (string | null)[] }> {
  const { root, specDir } = await createSpec();
  const config = await loadSpecsKitConfig(root);
  config.run.reviewFileRetry = 2;
  const plan = emptyFixPlan("001-spec", "docs/specs/001-spec");
  const prompts: (string | null)[] = [];
  let spawn = 0;
  const executor = {
    run: async (_phase: string, input: { reviewFormatError: string | null }): Promise<PhaseStepResult> => {
      prompts.push(input.reviewFormatError);
      const content = reports[spawn++];
      if (content !== undefined) await writeFile(reviewFilePath(specDir, "TASK-001"), content, "utf8");
      return okResult;
    },
  } as unknown as PhaseExecutor;
  return {
    plan,
    specDir,
    prompts,
    deps: { config, specDir, executor, persist: async () => {}, notify: () => {}, stopping: () => null, signal: () => undefined },
  };
}

test("a review that reports a contradicted requirement cannot also pass it", async () => {
  // The reviewer describes the conflict; the loop decides what it costs.
  // Left to the reviewer, the same session both raises the contradiction and
  // absolves it, which is how a requirement ends a run as a note nobody acts on.
  const h = await reportingHarness([
    "---\nreview_status: PASSED\nsummary: all good\nissues: []\nrouted: []\nspec_conflicts:\n  - the guard reuses the stale tip the requirement refuses\n---\n\nbody\n",
  ]);

  const verdict = await runReviewStep(h.deps, h.plan, TASK);

  assert.equal(verdict.kind, "failed", "a reported conflict outranks the verdict the reviewer wrote");
  assert.match(verdict.kind === "failed" ? verdict.feedback : "", /stale tip/);
  assert.match(verdict.kind === "failed" ? verdict.feedback : "", /never\s+reword the requirement/);
});

test("a fix routed to a task that will not run is refused, not deferred", async () => {
  const h = await reportingHarness([
    '---\nreview_status: PASSED\nsummary: ok\nissues: []\nrouted:\n  - to: TASK-404\n    text: "align the contract"\n---\n\nbody\n',
  ]);

  const verdict = await runReviewStep(h.deps, h.plan, TASK);

  assert.equal(verdict.kind, "failed");
  assert.match(verdict.kind === "failed" ? verdict.feedback : "", /TASK-404/);
});

test("a fix routed to a task still pending in the range is a legitimate deferral", async () => {
  const h = await reportingHarness([
    '---\nreview_status: PASSED\nsummary: ok\nissues: []\nrouted:\n  - to: TASK-007\n    text: "align the contract"\n---\n\nbody\n',
  ]);
  h.plan.tasks = [
    { id: "TASK-001", file: "tasks/TASK-001.md", title: "one", lang: null, status: "pending" },
    { id: "TASK-007", file: "tasks/TASK-007.md", title: "seven", lang: null, status: "pending" },
  ];

  const verdict = await runReviewStep(h.deps, h.plan, TASK);

  assert.equal(verdict.kind, "passed");
});

test("an unreadable report is preserved and the next spawn is sent to repair it", async () => {
  // The findings are the expensive half of a review. Deleting them made the
  // retry review the task again from scratch to recover a verdict that had
  // already been reached.
  const unreadable = "---\nreview_status\n  broken: [\n---\n\nfindings worth keeping\n";
  const h = await reportingHarness([
    unreadable,
    "---\nreview_status: PASSED\nsummary: ok\nissues: []\nrouted: []\n---\n\nbody\n",
  ]);

  const verdict = await runReviewStep(h.deps, h.plan, TASK);

  assert.equal(verdict.kind, "passed");
  assert.equal(h.prompts[0], null, "the first spawn has nothing to repair");
  assert.match(h.prompts[1] ?? "", /--review\.unreadable\.md/, "the repair spawn is told where its findings are");
  assert.equal(
    existsSync(reviewUnreadablePath(h.specDir, "TASK-001")),
    false,
    "the salvage copy is dropped once a readable verdict exists",
  );
});
