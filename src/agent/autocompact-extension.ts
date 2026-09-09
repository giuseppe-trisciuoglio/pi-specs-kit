/**
 * Agent extension loaded into a phase subprocess when the run asks for it. A
 * phase is one prompt driven through a long tool loop: its context only grows,
 * and the agent CLI compacts on its own only once the window is nearly full.
 * This extension moves that moment to a configured share of the window by
 * rewriting the request on its way out — the messages before the cut are
 * replaced with a summary, the recent turns are kept whole.
 *
 * Rewriting the request is the only way in: the CLI's manual compaction entry
 * point aborts the running agent first, which for an unattended phase means
 * losing the task instead of shortening it.
 *
 * Everything here is best effort. A phase that cannot compact keeps running on
 * its full context; it never fails because compaction did.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyCompaction,
  estimateConversationTokens,
  keepRecentTokens,
  messageText,
  overThreshold,
  planCut,
  readThresholdPercent,
  renderConversation,
  buildSummaryPrompt,
  SUMMARY_SYSTEM_PROMPT,
  type PlanMessage,
} from "./compaction-plan.ts";

/** The compaction in force, reapplied to every request until it is superseded. */
interface CompactionState {
  summary: string;
  /** Index of the first message kept verbatim. */
  cut: number;
}

function log(message: string): void {
  // The phase log is fed from the subprocess stderr; stdout carries the event
  // stream the loop parses and must not be written to.
  process.stderr.write(`[specs-kit] ${message}\n`);
}

/** Run the summarization as its own request on the phase model. */
async function summarize(
  ctx: ExtensionContext,
  elided: readonly PlanMessage[],
  previousSummary: string | null,
): Promise<string | null> {
  const model = ctx.model;
  if (!model) return null;
  const answer = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildSummaryPrompt(renderConversation(elided), previousSummary),
          timestamp: Date.now(),
        },
      ],
    },
    { signal: ctx.signal },
  );
  const summary = messageText(answer as unknown as PlanMessage).trim();
  return summary === "" ? null : summary;
}

export default function autoCompactExtension(pi: ExtensionAPI): void {
  const percent = readThresholdPercent(process.env);
  if (percent === null) return;

  let state: CompactionState | null = null;

  pi.on("context", async (event, ctx) => {
    // The runtime message type is named by a package this extension does not
    // depend on, so the replacement is typed off the event it answers.
    type Replacement = { messages: typeof event.messages };
    const replacement = (list: readonly PlanMessage[]): Replacement => ({
      messages: list as unknown as typeof event.messages,
    });
    const messages = event.messages as unknown as PlanMessage[];
    // The compaction in force is reapplied on every request: the session keeps
    // the original messages, so without this the next request would go out at
    // full size again.
    const current = (): Replacement | undefined =>
      state === null ? undefined : replacement(applyCompaction(messages, state.cut, state.summary));

    try {
      const usage = ctx.getContextUsage();
      const window = usage?.contextWindow ?? 0;
      if (window <= 0) return current();

      const inFlight = state === null ? messages : applyCompaction(messages, state.cut, state.summary);
      const used = usage?.tokens ?? estimateConversationTokens(inFlight);
      if (!overThreshold(used, window, percent)) return current();

      // A new cut always starts after the previous one: summarizing the same
      // stretch twice would spend a request to say what is already said.
      const cut = planCut(messages, keepRecentTokens(window, percent), (state?.cut ?? 0) + 1);
      if (cut === null) return current();

      const summary = await summarize(ctx, messages.slice(0, cut), state?.summary ?? null);
      if (summary === null) {
        log("auto-compact skipped: the summarization returned nothing");
        return current();
      }

      state = { summary, cut };
      const compacted = applyCompaction(messages, cut, summary);
      const before = estimateConversationTokens(inFlight);
      const after = estimateConversationTokens(compacted);
      log(
        `auto-compact at ${Math.round((used / window) * 100)}% of the context window: ` +
          `${cut} messages summarized, about ${before} to ${after} tokens`,
      );
      return replacement(compacted);
    } catch (err) {
      log(`auto-compact failed: ${err instanceof Error ? err.message : String(err)}`);
      return current();
    }
  });
}
