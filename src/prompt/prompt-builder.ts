/**
 * Phase prompt builder: assembles the XML-like prompt handed to the phase
 * subprocess from the task file, the phase skill, the knowledge base, the
 * fix plan memory, pre-hook outcomes and the phase exit contract. Empty or
 * non-applicable blocks are omitted.
 */

import path from "node:path";
import type { PhaseName, SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { HookResult } from "../loop/hooks.ts";
import type { RoutedSuggestion } from "../loop/review-report.ts";
import type { TaskFile } from "../tasks/task-parser.ts";
import type { ContextFileSet } from "./context-files.ts";
import type { ResolvedSkill } from "./skill-resolver.ts";

export interface PreHookResult {
  command: string;
  ok: boolean;
  output: string;
}

export interface PromptContext {
  config: SpecsKitConfig;
  /** Absolute path of the active spec directory. */
  specDir: string;
  phase: PhaseName;
  task: TaskFile;
  /** Loop learnings for this spec, injected as task memory. */
  learnings?: string[];
  skill?: ResolvedSkill | null;
  preHookResults?: PreHookResult[];
  /** Failed post hooks of the previous attempt of the same phase, fed to
   * the retry; rendered inside the hooks block, labeled with the gate and
   * the attempt they belong to. */
  postHookFailures?: HookResult[] | null;
  /** Verbatim feedback from a failed review, set on implementation retries. */
  reviewFeedback?: string | null;
  /** What was wrong with the previous review report, set on review re-spawns. */
  reviewFormatError?: string | null;
  /** Archived reports of this task's earlier attempts, set when a retry
   * exists: where earlier verdicts live, not what they concluded. */
  priorAttemptArchives?: string[];
  /** Public API contracts from upstream tasks that are already done. */
  upstreamProvides?: string[];
  /** Fixes reviewers routed to this task from earlier completed tasks. */
  routedSuggestions?: RoutedSuggestion[];
  /** Project-level learnings accumulated across specs. */
  projectLearnings?: string[];
  /** Spec documents inlined for the phases that read the spec folder. */
  contextFiles?: ContextFileSet;
}

/** Cap for a single hook output in the prompt, in characters. */
const HOOK_OUTPUT_LIMIT = 6000;
/** Characters to keep from the head when truncating (the tail carries the build summary). */
const HOOK_TAIL = 4500;

/**
 * Test discipline for the phases that edit code. Left unscoped, an agent runs
 * the whole suite after every edit: the cost of that grows with the suite while
 * the answer it needs — did the thing I just touched work — does not. The two
 * runs answer different questions, so they belong at different moments. Phrased
 * without naming a build tool: the project's own commands are the agent's to
 * find.
 */
const TEST_SCOPE_RULE: readonly string[] = [
  "While you iterate, run only the tests covering what you just changed, unit and",
  "integration alike, rather than the whole suite. The full suite answers a different",
  "question — whether the change broke something elsewhere — and that question does",
  "not need an answer after every edit.",
  "Run the full suite once at the end, when every affected test is green: that pass is",
  "the regression check, and the phase is not finished without it.",
];

/**
 * Batching rule, appended to every phase. A turn costs the whole conversation
 * prefix, not just its answer, so a phase that opens twelve files one per turn
 * pays the prefix twelve times to learn what one turn could have asked for.
 * Scoped to reads that do not depend on each other: a lookup whose target the
 * previous answer decides cannot be batched, and asking for it would only
 * trade round trips for guesses.
 */
const BATCHING_RULE: readonly string[] = [
  "Group independent reads into a single turn: when you already know which files or",
  "searches you need, request them together instead of one per turn. Only a lookup",
  "whose target depends on the result of the previous one belongs in a turn of its own.",
];

/** Static exit contract per phase (the learner never goes through here). */
function phaseInstructions(phase: PhaseName, taskId: string, reconcile: boolean): string {
  switch (phase) {
    case "implementation":
      return [
        "Modify the code in the workspace to fully implement the task above.",
        "Keep changes focused on the task and verify them with the project's build and tests.",
        ...TEST_SCOPE_RULE,
        "Learnings about the project are collected by the loop after the task passes review:",
        "never write them to the project learnings file yourself — anything appended there",
        "reaches the prompts of the phases that follow, so the loop reverts it.",
        "The phase ends when the implementation is complete in the workspace.",
      ].join("\n");
    case "review":
      // The skill above carries its own, much longer report template. These
      // instructions come last and say so explicitly: a report in any other
      // shape is unreadable to the loop, which then has to spawn the phase
      // again for a verdict that was already reached.
      return [
        "Review the implementation of the task above against its description.",
        `Write your verdict to tasks/${taskId}--review.md. The file must begin with a`,
        "YAML frontmatter block, before any heading or prose:",
        "",
        "---",
        "review_status: PASSED",
        "summary: one line on the outcome",
        "issues: []",
        "---",
        "",
        "review_status is PASSED or FAILED and admits no other value: a review that",
        "found anything worth fixing is FAILED, and its issues go in the issues list.",
        "This frontmatter is the only part the loop reads, and it overrides any other",
        "report format the skill above describes; the rest of the report goes after",
        "the closing --- in whatever shape the skill asks for.",
        "Do not modify the implementation and do not run other phases of the loop.",
      ].join("\n");
    case "cleanup":
      return [
        "Clean up the code touched by the task above: remove debug logging, dead code,",
        "leftover scaffolding and stale comments; optimize imports and readability.",
        "Do not change the behavior of the implementation.",
        ...TEST_SCOPE_RULE,
      ].join("\n");
    case "sync": {
      const lines = [
        "Update the specification documentation to reflect the implemented task above:",
        "spec text, design notes and any related docs that went stale.",
        "Do not touch implementation code.",
      ];
      // The memory channel is advisory by default: learnings flow into prompts
      // but nothing writes them back to the documents that asserted the
      // disproved instruction. When the opt-in flag is on and there is at least
      // one learning to reconcile against, sync owns that back-edge and patches
      // the source-of-truth docs so the next task is not misled again.
      if (reconcile) {
        lines.push(
          "Reconcile the source-of-truth context documents with the consolidated learnings:",
          "when a learning in <memory> or <project_learnings> contradicts an instruction in",
          "AGENTS.md, architecture.md, ontology.md or a .pi/rules file, correct that one",
          "instruction so future tasks are not misled. Edit only the contradicted line, never",
          "rewrite a whole document for this, and list every correction (file and change) in",
          "your summary.",
        );
      }
      return lines.join("\n");
    }
  }
}

/** Resolve a path against the project root when it is relative. */
function absoluteFromRoot(projectRoot: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(projectRoot, p);
}

/** Trim hook output to a bounded size, keeping the tail where the build summary lives. */
function truncateOutput(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= HOOK_OUTPUT_LIMIT) return trimmed;
  // Keep the tail: the last lines carry the build result (e.g. "BUILD SUCCESS", "Tests run: N")
  const tail = trimmed.slice(-HOOK_TAIL);
  const omitted = trimmed.length - HOOK_TAIL;
  return `…[${omitted} characters omitted]…\n${tail}`;
}

export function buildPhasePrompt(ctx: PromptContext): string {
  const { config, phase, task } = ctx;
  const fm = task.frontmatter;
  const blocks: string[] = [];

  // Task block: attributes only when valued, body passed through verbatim.
  const attrs: string[] = [];
  if (fm.id) attrs.push(`id="${fm.id}"`);
  if (task.path) {
    const rel = path.relative(ctx.specDir, task.path);
    attrs.push(`file="${rel && !rel.startsWith("..") ? rel : task.path}"`);
  }
  if (fm.title) attrs.push(`title="${fm.title}"`);
  blocks.push(`<task ${attrs.join(" ")}>\n${task.body.trim()}\n</task>`);

  // Skill blocks: inline content only when enabled; the directory path is
  // always included so referenced skill files stay reachable.
  if (ctx.skill) {
    if (config.run.skillContent) {
      blocks.push(`<skill_content>\n${ctx.skill.content.trim()}\n</skill_content>`);
    }
    blocks.push(`<skill_path>${absoluteFromRoot(config.projectRoot, ctx.skill.dir)}</skill_path>`);
  }

  // Knowledge base file list, one absolute path per line.
  if (config.knowledgeBase.files.length > 0) {
    const files = config.knowledgeBase.files.map((f) => absoluteFromRoot(config.projectRoot, f));
    blocks.push(`<knowledge_base>\n${files.join("\n")}\n</knowledge_base>`);
  }

  // Documents of the spec, inlined for the phases that would otherwise open
  // them one per turn. What did not fit is named, so the difference between
  // "this is all there is" and "there is more, go read it" stays visible.
  const contextFiles = ctx.contextFiles;
  if (contextFiles && (contextFiles.files.length > 0 || contextFiles.omitted.length > 0)) {
    const lines = [
      "Documents of this spec, already read for you. Do not open them again unless you",
      "need what a truncated one left out, or you are about to edit one that arrived",
      "truncated: what is here is the head of the file, not the file.",
    ];
    for (const file of contextFiles.files) {
      lines.push(`<file path="${file.path}"${file.truncated ? ' truncated="true"' : ""}>`, file.content, "</file>");
    }
    if (contextFiles.omitted.length > 0) {
      lines.push("Not inlined, read these only if the task needs them:");
      for (const p of contextFiles.omitted) lines.push(`- ${p}`);
    }
    blocks.push(`<context_files>\n${lines.join("\n")}\n</context_files>`);
  }

  // Learnings accumulated by the loop, as a bullet list.
  const learnings = ctx.learnings ?? [];
  if (learnings.length > 0) {
    blocks.push(`<memory>\n${learnings.map((l) => `- ${l}`).join("\n")}\n</memory>`);
  }

  // The two memory channels are fed by the same learner output, so the project
  // file usually repeats what the spec memory already carries. Both blocks kept
  // every shared insight twice in a prompt that is resent at every turn. The
  // channels stay distinct — the project file is what a spec with an empty
  // memory inherits — they just stop printing each other. Matching is
  // case-insensitive, the same identity mergeLearnings uses to reheat an entry.
  const spare = new Set(learnings.map((l) => l.toLowerCase()));
  const projectLearnings = (ctx.projectLearnings ?? []).filter((l) => !spare.has(l.toLowerCase()));

  // Pre-hook outcomes. Command and status are shown for every hook — that
  // certifies the gate ran and what verdict it returned. Output enters the
  // prompt only for failed hooks, where it carries the bounded context the
  // next spawn needs to act on; an ok hook's stdout is not actionable. The
  // failed post hooks of the previous attempt ride the same block under a
  // label that names gate and attempt, so the model cannot mistake them for
  // the pre hooks of this spawn; passed post hooks leave nothing behind.
  const failedPostHooks = (ctx.postHookFailures ?? []).filter((hook) => !hook.ok);
  if ((ctx.preHookResults && ctx.preHookResults.length > 0) || failedPostHooks.length > 0) {
    const lines: string[] = [];
    for (const hook of ctx.preHookResults ?? []) {
      lines.push(`$ ${hook.command}`);
      lines.push(`status: ${hook.ok ? "ok" : "failed"}`);
      if (!hook.ok && hook.output.trim()) {
        lines.push("output:");
        lines.push(truncateOutput(hook.output));
      }
      lines.push("");
    }
    if (failedPostHooks.length > 0) {
      lines.push("post hooks of the previous attempt (failed only):");
      for (const hook of failedPostHooks) {
        lines.push(`$ ${hook.command}`);
        lines.push("status: failed");
        if (hook.output.trim()) {
          lines.push("output:");
          lines.push(truncateOutput(hook.output));
        }
        lines.push("");
      }
    }
    blocks.push(`<hooks>\n${lines.join("\n").trimEnd()}\n</hooks>`);
  }

  // Feedback from a failed review, present only on retries.
  if (ctx.reviewFeedback && ctx.reviewFeedback.trim()) {
    blocks.push(`<review_feedback>\n${ctx.reviewFeedback.trim()}\n</review_feedback>`);
  }

  // Why the previous review report was rejected, present only on re-spawns.
  if (ctx.reviewFormatError && ctx.reviewFormatError.trim()) {
    blocks.push(`<review_format_error>\n${ctx.reviewFormatError.trim()}\n</review_format_error>`);
  }

  // Where the verdicts of earlier attempts are archived, present only once a
  // retry exists. Deliberately paths and nothing else: handing over the
  // conclusions would anchor the fresh evaluation to them, while leaving the
  // reviewer to rediscover the archives by chance wastes the exploration the
  // pointer already pays for. The one question a retry makes urgent — was what
  // the previous review blocked actually fixed — is named so it is not
  // answered by luck.
  if (ctx.priorAttemptArchives && ctx.priorAttemptArchives.length > 0) {
    blocks.push(
      [
        "<prior_review_attempts>",
        "Earlier attempts of this task were reviewed and retried. Their verdicts are archived:",
        ...ctx.priorAttemptArchives.map((p) => `- ${p}`),
        "This is a fresh, independent evaluation: consult an archive when useful, and in",
        "particular verify what the retry was asked to fix.",
        "</prior_review_attempts>",
      ].join("\n"),
    );
  }

  // Contracts from upstream tasks the current task depends on.
  if (ctx.upstreamProvides && ctx.upstreamProvides.length > 0) {
    blocks.push(
      `<upstream_contracts>\n${ctx.upstreamProvides.map((c) => `- ${c}`).join("\n")}\n</upstream_contracts>`,
    );
  }

  // Fixes earlier reviews explicitly routed to this task. Unlike memory,
  // these are concrete obligations assigned by a reviewer to this task, so
  // they read as a to-do list the implementation is expected to clear.
  if (ctx.routedSuggestions && ctx.routedSuggestions.length > 0) {
    blocks.push(
      `<routed_suggestions>\n${ctx.routedSuggestions
        .map((r) => `- ${r.from ? `(from ${r.from} review) ` : ""}${r.text}`)
        .join("\n")}\n</routed_suggestions>`,
    );
  }

  // Project-level learnings accumulated across specs, minus what <memory> said.
  if (projectLearnings.length > 0) {
    blocks.push(
      `<project_learnings>\n${projectLearnings.map((l) => "- " + l).join("\n")}\n</project_learnings>`,
    );
  }

  const hasMemory = learnings.length > 0 || projectLearnings.length > 0;
  const instructions = [
    phaseInstructions(phase, fm.id, ctx.config.run.reconcileContext && hasMemory),
    ...BATCHING_RULE,
  ].join("\n");
  blocks.push(`<phase_instructions>\n${instructions}\n</phase_instructions>`);

  return `${blocks.join("\n\n")}\n`;
}
