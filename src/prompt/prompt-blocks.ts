/**
 * Blocks of the phase prompt: each builder renders one XML-like section from
 * the prompt context, or returns null when the section does not apply. The
 * assembler in prompt-builder stacks the non-null results, so every block
 * stays independently testable and the assembly itself remains trivial.
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

/** Task block: attributes only when valued, body passed through verbatim. */
export function taskBlock(specDir: string, task: TaskFile): string {
  const fm = task.frontmatter;
  const attrs: string[] = [];
  if (fm.id) attrs.push(`id="${fm.id}"`);
  if (task.path) {
    const rel = path.relative(specDir, task.path);
    attrs.push(`file="${rel && !rel.startsWith("..") ? rel : task.path}"`);
  }
  if (fm.title) attrs.push(`title="${fm.title}"`);
  return `<task ${attrs.join(" ")}>\n${task.body.trim()}\n</task>`;
}

/** Skill blocks: inline content only when enabled; the directory path is
 * always included so referenced skill files stay reachable. */
export function skillBlocks(config: SpecsKitConfig, skill: ResolvedSkill | null | undefined): string[] {
  if (!skill) return [];
  const blocks: string[] = [];
  if (config.run.skillContent) {
    blocks.push(`<skill_content>\n${skill.content.trim()}\n</skill_content>`);
  }
  blocks.push(`<skill_path>${absoluteFromRoot(config.projectRoot, skill.dir)}</skill_path>`);
  return blocks;
}

/** Knowledge base file list, one absolute path per line. */
export function knowledgeBaseBlock(config: SpecsKitConfig): string | null {
  if (config.knowledgeBase.files.length === 0) return null;
  const files = config.knowledgeBase.files.map((f) => absoluteFromRoot(config.projectRoot, f));
  return `<knowledge_base>\n${files.join("\n")}\n</knowledge_base>`;
}

/** Documents of the spec, inlined for the phases that would otherwise open
 * them one per turn. What did not fit is named, so the difference between
 * "this is all there is" and "there is more, go read it" stays visible. */
export function contextFilesBlock(contextFiles: ContextFileSet | undefined): string | null {
  if (!contextFiles || (contextFiles.files.length === 0 && contextFiles.omitted.length === 0)) return null;
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
  return `<context_files>\n${lines.join("\n")}\n</context_files>`;
}

/** The two memory channels are fed by the same learner output, so the project
 * file usually repeats what the spec memory already carries. Both blocks kept
 * every shared insight twice in a prompt that is resent at every turn. The
 * channels stay distinct — the project file is what a spec with an empty
 * memory inherits — they just stop printing each other. Matching is
 * case-insensitive, the same identity mergeLearnings uses to reheat an entry. */
export function memoryBlocks(ctx: PromptContext): { blocks: string[]; hasMemory: boolean } {
  const learnings = ctx.learnings ?? [];
  const blocks: string[] = [];
  if (learnings.length > 0) {
    const bullets = learnings.map((l) => `- ${l}`).join("\n");
    blocks.push(`<memory>\n${bullets}\n</memory>`);
  }
  const spare = new Set(learnings.map((l) => l.toLowerCase()));
  const projectLearnings = (ctx.projectLearnings ?? []).filter((l) => !spare.has(l.toLowerCase()));
  if (projectLearnings.length > 0) {
    const bullets = projectLearnings.map((l) => "- " + l).join("\n");
    blocks.push(`<project_learnings>\n${bullets}\n</project_learnings>`);
  }
  return { blocks, hasMemory: learnings.length > 0 || projectLearnings.length > 0 };
}

/** Pre-hook outcomes. Command and status are shown for every hook — that
 * certifies the gate ran and what verdict it returned. Output enters the
 * prompt only for failed hooks, where it carries the bounded context the
 * next spawn needs to act on; an ok hook's stdout is not actionable. The
 * failed post hooks of the previous attempt ride the same block under a
 * label that names gate and attempt, so the model cannot mistake them for
 * the pre hooks of this spawn; passed post hooks leave nothing behind. */
export function hookBlock(ctx: PromptContext): string | null {
  const failedPostHooks = (ctx.postHookFailures ?? []).filter((hook) => !hook.ok);
  if ((ctx.preHookResults?.length ?? 0) === 0 && failedPostHooks.length === 0) return null;
  const lines: string[] = [];
  for (const hook of ctx.preHookResults ?? []) {
    lines.push(`$ ${hook.command}\nstatus: ${hook.ok ? "ok" : "failed"}`);
    if (!hook.ok && hook.output.trim()) {
      lines.push(`output:\n${truncateOutput(hook.output)}`);
    }
    lines.push("");
  }
  if (failedPostHooks.length > 0) {
    lines.push("post hooks of the previous attempt (failed only):");
    for (const hook of failedPostHooks) {
      lines.push(`$ ${hook.command}\nstatus: failed`);
      if (hook.output.trim()) {
        lines.push(`output:\n${truncateOutput(hook.output)}`);
      }
      lines.push("");
    }
  }
  return `<hooks>\n${lines.join("\n").trimEnd()}\n</hooks>`;
}

/** Feedback from a failed review, present only on retries. */
export function reviewFeedbackBlock(feedback: string | null | undefined): string | null {
  if (!feedback?.trim()) return null;
  return `<review_feedback>\n${feedback.trim()}\n</review_feedback>`;
}

/** Why the previous review report was rejected, present only on re-spawns. */
export function reviewFormatErrorBlock(formatError: string | null | undefined): string | null {
  if (!formatError?.trim()) return null;
  return `<review_format_error>\n${formatError.trim()}\n</review_format_error>`;
}

/** Where the verdicts of earlier attempts are archived, present only once a
 * retry exists. Deliberately paths and nothing else: handing over the
 * conclusions would anchor the fresh evaluation to them, while leaving the
 * reviewer to rediscover the archives by chance wastes the exploration the
 * pointer already pays for. The one question a retry makes urgent — was what
 * the previous review blocked actually fixed — is named so it is not
 * answered by luck. */
export function priorAttemptsBlock(archives: string[] | undefined): string | null {
  if (!archives || archives.length === 0) return null;
  return [
    "<prior_review_attempts>",
    "Earlier attempts of this task were reviewed and retried. Their verdicts are archived:",
    ...archives.map((p) => `- ${p}`),
    "This is a fresh, independent evaluation: consult an archive when useful, and in",
    "particular verify what the retry was asked to fix.",
    "</prior_review_attempts>",
  ].join("\n");
}

/** Contracts from upstream tasks the current task depends on. */
export function upstreamContractsBlock(provides: string[] | undefined): string | null {
  if (!provides || provides.length === 0) return null;
  const bullets = provides.map((c) => `- ${c}`).join("\n");
  return `<upstream_contracts>\n${bullets}\n</upstream_contracts>`;
}

/** Fixes earlier reviews explicitly routed to this task. Unlike memory,
 * these are concrete obligations assigned by a reviewer to this task, so
 * they read as a to-do list the implementation is expected to clear. */
export function routedSuggestionsBlock(suggestions: RoutedSuggestion[] | undefined): string | null {
  if (!suggestions || suggestions.length === 0) return null;
  const bullets = suggestions
    .map((r) => (r.from ? `(from ${r.from} review) ` : "") + r.text)
    .map((text) => `- ${text}`)
    .join("\n");
  return `<routed_suggestions>\n${bullets}\n</routed_suggestions>`;
}
