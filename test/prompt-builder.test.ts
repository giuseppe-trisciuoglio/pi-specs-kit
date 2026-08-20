import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_RUN_CONFIG,
  defaultHooks,
  defaultRoles,
  type SpecsKitConfig,
} from "../src/config/specs-kit-config.ts";
import type { TaskFile } from "../src/tasks/task-parser.ts";
import { buildPhasePrompt, type PromptContext } from "../src/prompt/prompt-builder.ts";
import { PHASE_SKILL, resolvePhaseSkill, type ResolvedSkill } from "../src/prompt/skill-resolver.ts";

function makeConfig(overrides: Partial<SpecsKitConfig> = {}): SpecsKitConfig {
  return {
    version: "1",
    projectRoot: "/proj",
    configPath: "/proj/specs-kit.yaml",
    specsDir: "specs",
    mode: "full",
    pollIntervalMs: 1000,
    roles: defaultRoles(),
    reviewPanel: [],
    run: { ...DEFAULT_RUN_CONFIG },
    git: { baseBranch: "main" },
    hooks: defaultHooks(),
    knowledgeBase: { files: [] },
    prompts: { unsupportedPolicy: "skip", phaseOverrides: {} },
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    path: "/proj/specs/auth/tasks/TASK-001.md",
    num: 1,
    frontmatter: {
      id: "TASK-001",
      title: "Login endpoint",
      lang: "ts",
      status: "pending",
      dependencies: [],
      acMapping: [],
      impRequirements: [],
      provides: [],
    },
    body: "Implement the login endpoint.\n\nReturn 401 on bad credentials.",
    ...overrides,
  };
}

function makeSkill(overrides: Partial<ResolvedSkill> = {}): ResolvedSkill {
  return {
    name: "specs-kit-task-implementation",
    dir: "skills/specs-kit-task-implementation",
    skillPath: "skills/specs-kit-task-implementation/SKILL.md",
    content: "# Implementation skill\n\nFollow the workflow.",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    config: makeConfig(),
    specDir: "/proj/specs/auth",
    phase: "implementation",
    task: makeTask(),
    ...overrides,
  };
}

test("PHASE_SKILL maps every phase to its skill", () => {
  assert.deepEqual(PHASE_SKILL, {
    implementation: "specs-kit-task-implementation",
    review: "specs-kit-task-review",
    cleanup: "specs-kit-code-cleanup",
    sync: "specs-kit-sync",
  });
});

test("task block carries valued attributes and the verbatim body", () => {
  const prompt = buildPhasePrompt(makeCtx());
  assert.match(prompt, /<task id="TASK-001" file="tasks\/TASK-001\.md" title="Login endpoint">/);
  // The model still carries lang for format compatibility, but it is never surfaced to the agent.
  assert.doesNotMatch(prompt, /lang=/);
  assert.ok(prompt.includes("Implement the login endpoint.\n\nReturn 401 on bad credentials."));
  assert.match(prompt, /<\/task>/);
});

test("task block keeps absolute file when the task lives outside the spec dir", () => {
  const task = makeTask({
    path: "/elsewhere/TASK-009.md",
  });
  const prompt = buildPhasePrompt(makeCtx({ task }));
  assert.match(prompt, /<task id="TASK-001" file="\/elsewhere\/TASK-009\.md" title="Login endpoint">/);
  assert.doesNotMatch(prompt, /lang=/);
});

test("resolved skill yields skill_content and absolute skill_path", () => {
  const prompt = buildPhasePrompt(makeCtx({ skill: makeSkill() }));
  assert.ok(prompt.includes("<skill_content>\n# Implementation skill\n\nFollow the workflow.\n</skill_content>"));
  assert.ok(prompt.includes("<skill_path>/proj/skills/specs-kit-task-implementation</skill_path>"));
});

test("skillContent false keeps only skill_path", () => {
  const config = makeConfig({ run: { ...DEFAULT_RUN_CONFIG, skillContent: false } });
  const prompt = buildPhasePrompt(makeCtx({ config, skill: makeSkill() }));
  assert.ok(!prompt.includes("<skill_content>"));
  assert.ok(prompt.includes("<skill_path>/proj/skills/specs-kit-task-implementation</skill_path>"));
});

test("missing skill yields a valid prompt without skill blocks", () => {
  const prompt = buildPhasePrompt(makeCtx({ skill: null }));
  assert.ok(!prompt.includes("skill_content"));
  assert.ok(!prompt.includes("skill_path"));
  assert.ok(prompt.includes("<task"));
  assert.ok(prompt.includes("<phase_instructions>"));
});

test("knowledge_base lists absolute paths resolved from projectRoot", () => {
  const config = makeConfig({
    knowledgeBase: { files: ["kb/notes.md", "/abs/already.md"] },
  });
  const prompt = buildPhasePrompt(makeCtx({ config }));
  assert.ok(prompt.includes("<knowledge_base>\n/proj/kb/notes.md\n/abs/already.md\n</knowledge_base>"));
});

test("knowledge_base block omitted when no files configured", () => {
  const prompt = buildPhasePrompt(makeCtx());
  assert.ok(!prompt.includes("knowledge_base"));
});

test("memory block lists fix plan learnings as bullets", () => {
  const prompt = buildPhasePrompt(makeCtx({ learnings: ["Prefer early returns.", "Keep prompts small."] }));
  assert.ok(prompt.includes("<memory>\n- Prefer early returns.\n- Keep prompts small.\n</memory>"));
});

test("memory block omitted without learnings", () => {
  const prompt = buildPhasePrompt(makeCtx({ learnings: [] }));
  assert.ok(!prompt.includes("<memory>"));
});

test("project learnings drop what memory already carries", () => {
  const prompt = buildPhasePrompt(
    makeCtx({
      learnings: ["Prefer early returns."],
      projectLearnings: ["prefer early returns.", "Keep modules small."],
    }),
  );
  assert.ok(prompt.includes("<memory>\n- Prefer early returns.\n</memory>"));
  assert.ok(prompt.includes("<project_learnings>\n- Keep modules small.\n</project_learnings>"));
});

test("project learnings block omitted when memory already carries all of it", () => {
  const prompt = buildPhasePrompt(
    makeCtx({ learnings: ["Prefer early returns."], projectLearnings: ["Prefer early returns."] }),
  );
  assert.ok(!prompt.includes("<project_learnings>"));
});

test("hooks block reports command, status and bounded output", () => {
  const long = "x".repeat(7000);
  const prompt = buildPhasePrompt(
    makeCtx({
      preHookResults: [
        { command: "npm test", ok: true, output: "all green" },
        { command: "npm run build", ok: false, output: long },
      ],
    }),
  );
  // A hook that passes certifies the gate ran green; its command and status
  // are enough — its stdout is not context the agent needs to act on.
  assert.ok(prompt.includes("$ npm test\nstatus: ok"));
  assert.ok(!prompt.includes("all green"), "ok hook output must not enter the prompt");
  // A failing hook carries the bounded output so the next spawn has repair context.
  assert.ok(prompt.includes("$ npm run build\nstatus: failed"));
  assert.ok(prompt.includes("characters omitted"));
  assert.ok(prompt.length < 8000);
});

test("hooks block omits output for hooks that pass", () => {
  const prompt = buildPhasePrompt(
    makeCtx({
      preHookResults: [
        { command: "npm test", ok: true, output: "all green\nTests: 42 passed" },
      ],
    }),
  );
  assert.match(prompt, /\$ npm test\nstatus: ok/);
  assert.ok(!prompt.includes("output:"), "an ok hook never carries its stdout");
  assert.ok(!prompt.includes("all green"), "ok hook output must be dropped before the prompt");
});

test("hooks block keeps output (with truncation) for hooks that fail", () => {
  const long = "x".repeat(7000);
  const prompt = buildPhasePrompt(
    makeCtx({
      preHookResults: [{ command: "npm run build", ok: false, output: long }],
    }),
  );
  assert.ok(prompt.includes("$ npm run build\nstatus: failed"));
  assert.ok(prompt.includes("output:"));
  assert.ok(prompt.includes("characters omitted"));
  assert.ok(prompt.length < 8000, "truncation cap is preserved");
});

test("hooks block mixes ok and failed hooks: ok drops output, failed keeps it", () => {
  const prompt = buildPhasePrompt(
    makeCtx({
      preHookResults: [
        { command: "npm test", ok: true, output: "all green" },
        { command: "npm run lint", ok: true, output: "no warnings" },
        { command: "npm run build", ok: false, output: "build failed at step 3" },
      ],
    }),
  );
  // Two passing hooks: only command + status.
  assert.ok(prompt.includes("$ npm test\nstatus: ok"));
  assert.ok(prompt.includes("$ npm run lint\nstatus: ok"));
  assert.ok(!prompt.includes("all green"));
  assert.ok(!prompt.includes("no warnings"));
  // One failing hook: bounded output preserved.
  assert.ok(prompt.includes("$ npm run build\nstatus: failed"));
  assert.ok(prompt.includes("output:"));
  assert.ok(prompt.includes("build failed at step 3"));
});

test("hooks block emits command and status for an ok hook with empty output", () => {
  // Command + status stay even when an ok hook produced no stdout — the model
  // still needs to see which command ran and that it passed.
  const prompt = buildPhasePrompt(
    makeCtx({
      preHookResults: [{ command: "true", ok: true, output: "" }],
    }),
  );
  assert.ok(prompt.includes("<hooks>"));
  assert.ok(prompt.includes("$ true\nstatus: ok"));
  assert.ok(!prompt.includes("output:"), "no dangling output header for an empty stdout");
});

test("hooks block omitted without hook results", () => {
  assert.ok(!buildPhasePrompt(makeCtx()).includes("<hooks>"));
});

test("failed post hooks of the previous attempt render inside the hooks block, labeled", () => {
  const long = "x".repeat(7000);
  const prompt = buildPhasePrompt(
    makeCtx({
      preHookResults: [{ command: "npm test", ok: true, output: "all green" }],
      postHookFailures: [{ command: "npm run build", ok: false, exitCode: 1, timedOut: false, output: long }],
    }),
  );
  // The gate of the previous attempt is named, so it cannot be confused with
  // the pre hooks of this spawn; the failing hook carries the bounded output.
  assert.ok(prompt.includes("$ npm test\nstatus: ok"));
  assert.ok(prompt.includes("post hooks of the previous attempt (failed only):"));
  assert.ok(prompt.includes("$ npm run build\nstatus: failed"));
  assert.ok(prompt.includes("output:"));
  assert.ok(prompt.includes("characters omitted"));
  assert.ok(prompt.length < 8000, "truncation cap is preserved across both gate sections");
});

test("passed post hooks leave nothing in the prompt", () => {
  const prompt = buildPhasePrompt(
    makeCtx({
      postHookFailures: [
        { command: "npm run build", ok: true, exitCode: 0, timedOut: false, output: "build ok\nTests: 42 passed" },
        { command: "npm test", ok: true, exitCode: 0, timedOut: false, output: "all green" },
      ],
    }),
  );
  // The rule that output enters the prompt only for failed hooks holds here
  // too: an all-green gate is certified by its absence from the retry context.
  assert.ok(!prompt.includes("<hooks>"), "no failed hook, no hooks block at all");
  assert.ok(!prompt.includes("post hooks of the previous attempt"));
  assert.ok(!prompt.includes("build ok"));
});

test("failed post hooks render even when this attempt has no pre-hook results", () => {
  const prompt = buildPhasePrompt(
    makeCtx({
      postHookFailures: [{ command: "npm run build", ok: false, exitCode: 1, timedOut: false, output: "build failed" }],
    }),
  );
  assert.ok(prompt.includes("<hooks>"));
  assert.ok(prompt.includes("post hooks of the previous attempt (failed only):"));
  assert.ok(prompt.includes("$ npm run build\nstatus: failed\noutput:\nbuild failed"));
});

test("failed post hooks stay distinguishable from the pre hooks of this attempt", () => {
  const prompt = buildPhasePrompt(
    makeCtx({
      preHookResults: [{ command: "npm run lint", ok: false, output: "lint error on line 3" }],
      postHookFailures: [{ command: "npm run build", ok: false, exitCode: 1, timedOut: false, output: "build failed" }],
    }),
  );
  // Both gates failed, but each section names its own: the pre hook of this
  // attempt is unlabeled, the post hook of the previous one is labeled, and
  // both outputs survive with their commands attached.
  assert.ok(prompt.includes("$ npm run lint\nstatus: failed\noutput:\nlint error on line 3"));
  const postSection = prompt.slice(prompt.indexOf("post hooks of the previous attempt"));
  assert.ok(postSection.includes("$ npm run build\nstatus: failed"));
  assert.ok(!postSection.includes("npm run lint"), "the labeled section carries only the post hook");
  assert.ok(postSection.indexOf("post hooks of the previous attempt") < postSection.indexOf("$ npm run build"));
});

test("review_feedback appears only when set", () => {
  const base = buildPhasePrompt(makeCtx());
  assert.ok(!base.includes("review_feedback"));
  const retry = buildPhasePrompt(makeCtx({ reviewFeedback: "review_status: FAILED\n\nMissing error handling." }));
  assert.ok(retry.includes("<review_feedback>\nreview_status: FAILED\n\nMissing error handling.\n</review_feedback>"));
});

test("routed_suggestions lists handoffs aimed at this task and is omitted when empty", () => {
  const base = buildPhasePrompt(makeCtx());
  assert.ok(!base.includes("routed_suggestions"));

  const prompt = buildPhasePrompt({
    ...makeCtx(),
    routedSuggestions: [
      { to: "TASK-001", text: "codify the DTO styles in architecture", from: "TASK-002" },
      { to: "TASK-001", text: "record the eviction deviation", from: "TASK-003" },
    ],
  });
  assert.ok(prompt.includes("<routed_suggestions>"));
  assert.match(prompt, /\(from TASK-002 review\) codify the DTO styles in architecture/);
  assert.match(prompt, /\(from TASK-003 review\) record the eviction deviation/);
});

test("phase instructions match each phase contract", () => {
  const impl = buildPhasePrompt(makeCtx({ phase: "implementation" }));
  assert.ok(impl.includes("fully implement the task above"));

  const review = buildPhasePrompt(makeCtx({ phase: "review" }));
  assert.ok(review.includes("tasks/TASK-001--review.md"));
  assert.ok(review.includes("review_status: PASSED"));
  assert.ok(review.includes("PASSED or FAILED"));
  // The skill inlined above carries a report template of its own, so the
  // contract has to say which one wins where they disagree.
  assert.ok(review.includes("overrides any other"));

  const cleanup = buildPhasePrompt(makeCtx({ phase: "cleanup" }));
  assert.ok(cleanup.includes("remove debug logging, dead code"));

  const sync = buildPhasePrompt(makeCtx({ phase: "sync" }));
  assert.ok(sync.includes("Update the specification documentation"));
});

test("the phases that edit code are told to scope their test runs, the ones that do not are left alone", () => {
  for (const phase of ["implementation", "cleanup"] as const) {
    const prompt = buildPhasePrompt(makeCtx({ phase }));
    assert.ok(prompt.includes("run only the tests covering what you just changed"), `${phase} scopes the inner loop`);
    assert.ok(prompt.includes("Run the full suite once at the end"), `${phase} still owes a regression pass`);
  }
  // Review and sync do not edit code: review verifies a finished tree and sync
  // touches documentation, so neither has an inner loop to scope.
  for (const phase of ["review", "sync"] as const) {
    const prompt = buildPhasePrompt(makeCtx({ phase }));
    assert.ok(!prompt.includes("run only the tests covering"), `${phase} carries no test scope rule`);
  }
});

test("sync phase instructions include the reconcile mandate only when opted in and learnings exist", () => {
  // Default: flag off, so the back-edge stays silent even with learnings present.
  const offByDefault = buildPhasePrompt(
    makeCtx({ phase: "sync", learnings: ["No ./mvnw wrapper exists — use mvn."] }),
  );
  assert.ok(!offByDefault.includes("Reconcile the source-of-truth"));

  // Flag on but nothing to reconcile against: still silent, no wasted scan.
  const config = makeConfig({ run: { ...DEFAULT_RUN_CONFIG, reconcileContext: true } });
  const noLearnings = buildPhasePrompt(makeCtx({ config, phase: "sync" }));
  assert.ok(!noLearnings.includes("Reconcile the source-of-truth"));

  // Flag on and learnings present: the mandate appears and names the docs it owns.
  const on = buildPhasePrompt(
    makeCtx({ config, phase: "sync", learnings: ["No ./mvnw wrapper exists — use mvn."] }),
  );
  assert.ok(on.includes("Reconcile the source-of-truth context documents"));
  assert.ok(on.includes("AGENTS.md"));
  assert.ok(on.includes("<memory>"));
});

test("resolvePhaseSkill searches extraDirs first and reads SKILL.md", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-resolver-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const skillDir = path.join(root, "custom", "specs-kit-task-review");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "review skill body");

  const resolved = await resolvePhaseSkill("review", { extraDirs: [skillDir], bundledDir: null });
  assert.ok(resolved);
  assert.equal(resolved.name, "specs-kit-task-review");
  assert.equal(resolved.dir, skillDir);
  assert.equal(resolved.content, "review skill body");
});

test("resolvePhaseSkill falls back to the home directory layout", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const skillDir = path.join(home, ".pi", "agent", "skills", "specs-kit-sync");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "sync skill body");

  const resolved = await resolvePhaseSkill("sync", { homeDir: home, bundledDir: null });
  assert.ok(resolved);
  assert.equal(resolved.skillPath, path.join(skillDir, "SKILL.md"));
  assert.equal(resolved.content, "sync skill body");
});

test("resolvePhaseSkill returns null when the skill is missing", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-empty-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(await resolvePhaseSkill("cleanup", { homeDir: home, extraDirs: [path.join(home, "none")], bundledDir: null }), null);
});
