/**
 * Golden prompts: pin the exact string each phase hands to the agent
 * subprocess. The real executor runs with scripted spawn/hook dependencies
 * that capture the prompt, and each scenario asserts string equality against
 * the prompt rebuilt in the test from the same declared values. Skill and
 * project learnings resolve on both sides within the same run, so
 * machine-dependent paths cancel out.
 *
 * Every scenario builds its ingress as a flat literal of the declared
 * per-phase input type — no fix plan document is fabricated, because none
 * crosses the node → executor boundary anymore. These tests are the oracle
 * that proves the executor narrowing left every prompt byte-identical, and
 * they double as executable documentation of the contracts.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSpecsKitConfig, type PhaseName, type SpecsKitConfig } from "../src/config/specs-kit-config.ts";
import { parseTaskFile, type TaskFile } from "../src/tasks/task-parser.ts";
import { PhaseExecutor, type PhaseStepResult } from "../src/loop/phases.ts";
import { LoopBudget } from "../src/loop/budget.ts";
import type { HookResult } from "../src/loop/hooks.ts";
import type {
  CleanupPhaseInput,
  FinalSyncPhaseInput,
  ImplementationPhaseInput,
  PhaseSpawnInput,
  ReviewPhaseInput,
  SyncPhaseInput,
  TaskSyncPhaseInput,
} from "../src/loop/phase-inputs.ts";
import { loadProjectLearnings } from "../src/loop/learner.ts";
import type { PhaseRunOutcome, PhaseSpawnOptions } from "../src/agent/spawner.ts";
import { buildPhasePrompt } from "../src/prompt/prompt-builder.ts";
import { resolvePhaseSkill } from "../src/prompt/skill-resolver.ts";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
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

const FAILING_PREHOOK: HookResult = {
  command: "npm test",
  ok: false,
  exitCode: 1,
  timedOut: false,
  output: "1 failing test",
};

type PhaseInput = ImplementationPhaseInput | ReviewPhaseInput | CleanupPhaseInput | SyncPhaseInput;

interface Harness {
  config: SpecsKitConfig;
  specDir: string;
  specId: string;
  /** Loop learnings of the spec, injected as task memory. */
  learnings: string[];
  /** Scripted pre-hook results; post hooks return none unless configured. */
  preHooks: HookResult[];
  /** Scripted post-hook results; empty by default. */
  postHooks: HookResult[];
  executor: PhaseExecutor;
  /** The prompt of every spawn, in order. */
  prompts: string[];
}

/** Real executor over a tmp project, with the spawn and hooks scripted out. */
async function harness(opts: { preHooks?: HookResult[]; postHooks?: HookResult[] } = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "phase-prompts-"));
  tmpDirs.push(root);
  const specDir = path.join(root, "docs/specs/001-spec");
  await mkdir(path.join(specDir, "tasks"), { recursive: true });
  await writeFile(path.join(root, "docs/specs/learnings.md"), "# Project Learnings\n\n- keep modules small\n", "utf8");

  const config = await loadSpecsKitConfig(root);
  config.run.noLogFiles = true;
  const preHooks = opts.preHooks ?? [];
  const postHooks = opts.postHooks ?? [];

  const prompts: string[] = [];
  const executor = new PhaseExecutor({
    config,
    specDir,
    budget: new LoopBudget({ maxSpawnsPerTask: 50, maxSpawnsPerRun: 50, maxRunDurationMs: 3_600_000 }),
    spawnPhase: async (opts: PhaseSpawnOptions) => {
      prompts.push(opts.prompt);
      return okOutcome;
    },
    runHooks: async (_hooks, _phase, stage) => (stage === "pre" ? preHooks : postHooks),
    onNotify: () => {},
    onStream: () => {},
    onLogPath: () => {},
    onPhaseStart: () => {},
    onLogLine: () => {},
  });
  return { config, specDir, specId: "001-spec", learnings: ["always validate input"], preHooks, postHooks, executor, prompts };
}

/** The declared ingress every phase shares, as the node builds it at the boundary. */
function baseInput(h: Harness, attempt = 1): PhaseSpawnInput {
  return { task: TASK, learnings: h.learnings, specId: h.specId, attempt };
}

/**
 * Rebuild the expected prompt from the same declared values the scenario
 * used, mirroring what the executor feeds the builder: the phase skill
 * resolved here, the scripted pre-hook results and the project learnings
 * loaded from the same file the executor reads.
 */
async function expectedPrompt(h: Harness, phase: PhaseName, input: PhaseInput): Promise<string> {
  const skill = await resolvePhaseSkill(phase);
  const projectLearnings = await loadProjectLearnings(h.config.projectRoot, h.config.specsDir);
  return buildPhasePrompt({
    config: h.config,
    specDir: h.specDir,
    phase,
    task: input.task,
    learnings: input.learnings,
    skill,
    preHookResults: h.preHooks,
    postHookFailures: "postHookFailures" in input ? input.postHookFailures : undefined,
    reviewFeedback: "reviewFeedback" in input ? input.reviewFeedback : null,
    reviewFormatError: "reviewFormatError" in input ? input.reviewFormatError : null,
    priorAttemptArchives: "priorAttemptArchives" in input ? input.priorAttemptArchives : undefined,
    upstreamProvides: "upstreamProvides" in input ? input.upstreamProvides : undefined,
    routedSuggestions: "routedSuggestions" in input ? input.routedSuggestions : undefined,
    projectLearnings: projectLearnings.length > 0 ? projectLearnings : undefined,
  });
}

/** Run one phase through the real executor and return the captured prompt. */
async function capturePrompt(h: Harness, run: () => Promise<PhaseStepResult>): Promise<string> {
  const before = h.prompts.length;
  const result = await run();
  assert.equal(result.preHooksOk, true, "the phase spawned");
  assert.equal(h.prompts.length, before + 1, "exactly one spawn per phase run");
  return h.prompts[before];
}

test("implementation on retry carries review feedback, upstream contracts and routed suggestions", async () => {
  const h = await harness();
  const input: ImplementationPhaseInput = {
    ...baseInput(h, 2),
    reviewFeedback: "Found problems\n- Missing input validation",
    postHookFailures: null,
    upstreamProvides: ["parseSpec(text: string): Spec"],
    routedSuggestions: [{ to: "TASK-001", text: "extract the retry helper", from: "TASK-000" }],
    // What the node declares on a retry: the pre-hook output becomes context.
    firstAttempt: false,
  };

  const prompt = await capturePrompt(h, () => h.executor.run("implementation", input));
  assert.equal(prompt, await expectedPrompt(h, "implementation", input));

  assert.ok(prompt.includes("<review_feedback>\nFound problems\n- Missing input validation\n</review_feedback>"));
  assert.ok(prompt.includes("<upstream_contracts>\n- parseSpec(text: string): Spec\n</upstream_contracts>"));
  assert.ok(prompt.includes("(from TASK-000 review) extract the retry helper"));
  assert.ok(prompt.includes("<memory>\n- always validate input\n</memory>"));
  assert.ok(prompt.includes("<project_learnings>\n- keep modules small\n</project_learnings>"));
  assert.ok(!prompt.includes("<review_format_error>"), "implementation never sees the review format channel");
});

test("implementation on the first attempt has no feedback block at all", async () => {
  const h = await harness();
  const input: ImplementationPhaseInput = {
    ...baseInput(h),
    reviewFeedback: null,
    postHookFailures: null,
    upstreamProvides: [],
    routedSuggestions: [],
    firstAttempt: true,
  };

  const prompt = await capturePrompt(h, () => h.executor.run("implementation", input));
  assert.equal(prompt, await expectedPrompt(h, "implementation", input));

  assert.ok(!prompt.includes("<review_feedback>"), "no failed review has run yet");
  assert.ok(!prompt.includes("<upstream_contracts>"), "no dependency completed before this task");
  assert.ok(!prompt.includes("<routed_suggestions>"), "nothing was routed to this task");
});

test("a failing pre-hook blocks the phase on the first attempt: no spawn at all", async () => {
  const h = await harness({ preHooks: [FAILING_PREHOOK] });
  const input: ImplementationPhaseInput = {
    ...baseInput(h),
    reviewFeedback: null,
    postHookFailures: null,
    upstreamProvides: [],
    routedSuggestions: [],
    firstAttempt: true,
  };

  const result = await h.executor.run("implementation", input);
  assert.equal(result.preHooksOk, false);
  assert.equal(result.outcome, null);
  assert.equal(h.prompts.length, 0, "a blocked phase never reaches the agent");
});

test("a failing pre-hook on a retry feeds its output into the prompt as context", async () => {
  const h = await harness({ preHooks: [FAILING_PREHOOK] });
  const input: ImplementationPhaseInput = {
    ...baseInput(h, 2),
    reviewFeedback: "Found problems\n- Missing input validation",
    postHookFailures: null,
    upstreamProvides: [],
    routedSuggestions: [],
    firstAttempt: false,
  };

  const prompt = await capturePrompt(h, () => h.executor.run("implementation", input));
  assert.equal(prompt, await expectedPrompt(h, "implementation", input));

  assert.ok(prompt.includes("<hooks>\n$ npm test\nstatus: failed\noutput:\n1 failing test\n</hooks>"));
});

test("a failing post hook is exposed and feeds the retry prompt, labeled against the pre hooks", async () => {
  const FAILING_POSTHOOK: HookResult = {
    command: "npm run build",
    ok: false,
    exitCode: 1,
    timedOut: false,
    output: "build failed: 2 errors",
  };
  const h = await harness({ postHooks: [FAILING_POSTHOOK] });
  const input: ImplementationPhaseInput = {
    ...baseInput(h),
    reviewFeedback: null,
    postHookFailures: null,
    upstreamProvides: [],
    routedSuggestions: [],
    firstAttempt: true,
  };

  // The executor exposes the red gate explicitly instead of burying it in the
  // full result list: the node does not re-derive the outcome.
  const first = await h.executor.run("implementation", input);
  assert.equal(first.preHooksOk, true);
  assert.equal(first.postHooksOk, false);
  assert.deepEqual(first.failedPostHooks, [FAILING_POSTHOOK]);

  // The next attempt declares the failures; the prompt renders them inside
  // the hooks block under a label naming gate and attempt, so the model
  // cannot confuse them with the pre hooks of this spawn.
  const retryInput: ImplementationPhaseInput = {
    ...input,
    attempt: 2,
    firstAttempt: false,
    postHookFailures: first.failedPostHooks,
  };
  const retry = await h.executor.run("implementation", retryInput);
  assert.equal(retry.postHooksOk, false, "the scripted gate stays red");
  const prompt = h.prompts[h.prompts.length - 1];
  assert.equal(prompt, await expectedPrompt(h, "implementation", retryInput));
  assert.ok(prompt.includes("post hooks of the previous attempt (failed only):"));
  assert.ok(prompt.includes("$ npm run build\nstatus: failed\noutput:\nbuild failed: 2 errors"));
});

test("review on first spawn has no format error and no routed suggestions", async () => {
  const h = await harness();
  const input: ReviewPhaseInput = { ...baseInput(h), reviewFormatError: null, priorAttemptArchives: [] };

  const prompt = await capturePrompt(h, () => h.executor.run("review", input));
  assert.equal(prompt, await expectedPrompt(h, "review", input));

  assert.ok(prompt.includes("Write your verdict to tasks/TASK-001--review.md"));
  assert.ok(!prompt.includes("<review_format_error>"), "nothing to correct on the first spawn");
  assert.ok(!prompt.includes("<routed_suggestions>"), "the reviewer never receives routed fixes");
  assert.ok(!prompt.includes("<review_feedback>"), "the reviewer never receives its own feedback");
  assert.ok(!prompt.includes("<prior_review_attempts>"), "no retry has happened yet");
});

test("review re-spawn is told what was wrong with the previous report", async () => {
  const h = await harness();
  const formatError = "The review report for TASK-001 is missing or invalid: frontmatter with review_status required.";
  const input: ReviewPhaseInput = { ...baseInput(h), reviewFormatError: formatError, priorAttemptArchives: [] };

  const prompt = await capturePrompt(h, () => h.executor.run("review", input));
  assert.equal(prompt, await expectedPrompt(h, "review", input));

  assert.ok(prompt.includes(`<review_format_error>\n${formatError}\n</review_format_error>`));
  assert.ok(!prompt.includes("<routed_suggestions>"), "the reviewer never receives routed fixes");
});

test("a retried review is handed where the earlier verdicts are archived, not what they say", async () => {
  const h = await harness();
  const archives = ["tasks/TASK-001--review.attempt-1.md", "tasks/TASK-001--review.attempt-2.md"];
  const input: ReviewPhaseInput = { ...baseInput(h, 3), reviewFormatError: null, priorAttemptArchives: archives };

  const prompt = await capturePrompt(h, () => h.executor.run("review", input));
  assert.equal(prompt, await expectedPrompt(h, "review", input));

  const block = [
    "<prior_review_attempts>",
    "Earlier attempts of this task were reviewed and retried. Their verdicts are archived:",
    ...archives.map((a) => `- ${a}`),
    "This is a fresh, independent evaluation: consult an archive when useful, and in",
    "particular verify what the retry was asked to fix.",
    "</prior_review_attempts>",
  ].join("\n");
  assert.ok(prompt.includes(block), "the pointer is delivered as paths alone, nothing from the verdicts");
  assert.ok(!prompt.includes("<review_feedback>"), "the reviewer still never receives its own feedback");
});

test("cleanup prompt carries contracts and routed fixes but never review feedback", async () => {
  const h = await harness();
  const input: CleanupPhaseInput = {
    ...baseInput(h),
    upstreamProvides: ["parseSpec(text: string): Spec"],
    routedSuggestions: [{ to: "TASK-001", text: "extract the retry helper", from: "TASK-000" }],
    firstAttempt: true,
  };

  const prompt = await capturePrompt(h, () => h.executor.run("cleanup", input));
  assert.equal(prompt, await expectedPrompt(h, "cleanup", input));

  assert.ok(prompt.includes("Clean up the code touched by the task above"));
  assert.ok(prompt.includes("<upstream_contracts>"));
  assert.ok(prompt.includes("<routed_suggestions>"));
  assert.ok(!prompt.includes("<review_feedback>"), "cleanup has no review feedback channel");
  assert.ok(!prompt.includes("<review_format_error>"));
});

test("sync prompt carries contracts and routed fixes but never review feedback", async () => {
  const h = await harness();
  const input: TaskSyncPhaseInput = {
    ...baseInput(h),
    upstreamProvides: ["parseSpec(text: string): Spec"],
    routedSuggestions: [{ to: "TASK-001", text: "extract the retry helper", from: "TASK-000" }],
    firstAttempt: true,
  };

  const prompt = await capturePrompt(h, () => h.executor.run("sync", input));
  assert.equal(prompt, await expectedPrompt(h, "sync", input));

  assert.ok(prompt.includes("Update the specification documentation to reflect the implemented task"));
  assert.ok(prompt.includes("<upstream_contracts>"));
  assert.ok(prompt.includes("<routed_suggestions>"));
  assert.ok(!prompt.includes("<review_feedback>"), "sync has no review feedback channel");
  assert.ok(!prompt.includes("<review_format_error>"));
});

test("the end-of-range sync spawns alone: no upstream contracts, no routed fixes", async () => {
  const h = await harness();
  const input: FinalSyncPhaseInput = baseInput(h);

  const prompt = await capturePrompt(h, () => h.executor.run("sync", input));
  assert.equal(prompt, await expectedPrompt(h, "sync", input));

  assert.ok(prompt.includes("Update the specification documentation to reflect the implemented task"));
  assert.ok(!prompt.includes("<upstream_contracts>"), "the end-of-range sync has no upstream channel");
  assert.ok(!prompt.includes("<routed_suggestions>"), "no routed fixes are collected for it");
  assert.ok(!prompt.includes("<review_feedback>"), "sync has no review feedback channel");
});

test("a failing pre-hook still blocks the end-of-range sync", async () => {
  const h = await harness({ preHooks: [FAILING_PREHOOK] });

  // The end-of-range input cannot declare an attempt kind, so the executor's
  // blocking policy applies, exactly as it did on the wide signature.
  const result = await h.executor.run("sync", baseInput(h));
  assert.equal(result.preHooksOk, false);
  assert.equal(h.prompts.length, 0, "a blocked phase never reaches the agent");
});
