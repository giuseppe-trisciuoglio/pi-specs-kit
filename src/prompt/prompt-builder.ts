/**
 * Phase prompt builder: assembles the XML-like prompt handed to the phase
 * subprocess from the task file, the phase skill, the knowledge base, the
 * fix plan memory, pre-hook outcomes and the phase exit contract. Empty or
 * non-applicable blocks are omitted; the rendering of each block lives in
 * prompt-blocks.
 */

import {
  contextFilesBlock,
  hookBlock,
  knowledgeBaseBlock,
  memoryBlocks,
  priorAttemptsBlock,
  reviewFeedbackBlock,
  reviewFormatErrorBlock,
  routedSuggestionsBlock,
  skillBlocks,
  taskBlock,
  upstreamContractsBlock,
  type PromptContext,
} from "./prompt-blocks.ts";
import type { PhaseName } from "../config/specs-kit-config.ts";

export type { PreHookResult, PromptContext } from "./prompt-blocks.ts";

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

export function buildPhasePrompt(ctx: PromptContext): string {
  const memory = memoryBlocks(ctx);
  const candidateBlocks = [
    taskBlock(ctx.specDir, ctx.task),
    ...skillBlocks(ctx.config, ctx.skill),
    knowledgeBaseBlock(ctx.config),
    contextFilesBlock(ctx.contextFiles),
    ...memory.blocks,
    hookBlock(ctx),
    reviewFeedbackBlock(ctx.reviewFeedback),
    reviewFormatErrorBlock(ctx.reviewFormatError),
    priorAttemptsBlock(ctx.priorAttemptArchives),
    upstreamContractsBlock(ctx.upstreamProvides),
    routedSuggestionsBlock(ctx.routedSuggestions),
  ];
  const blocks = candidateBlocks.filter((block): block is string => block !== null);

  const instructions = [
    phaseInstructions(ctx.phase, ctx.task.frontmatter.id, ctx.config.run.reconcileContext && memory.hasMemory),
    ...BATCHING_RULE,
  ].join("\n");
  blocks.push(`<phase_instructions>\n${instructions}\n</phase_instructions>`);

  return `${blocks.join("\n\n")}\n`;
}
