/**
 * Decision logic for the context compaction a phase performs on itself: when
 * the conversation has grown past its share of the model window, where the
 * conversation is cut, and how the compacted request is reassembled. Pure on
 * purpose — the extension loaded into the phase subprocess is only the glue
 * around these functions, and the glue cannot be unit-tested without the agent
 * runtime while this can.
 */

/**
 * Environment variable carrying the threshold into the phase subprocess. The
 * agent CLI passes no arguments to a loaded extension, so the spawner hands the
 * value over through the environment; an unset variable means the phase runs
 * with the CLI's own behavior and this module is never consulted.
 */
export const AUTO_COMPACT_ENV = "SPECS_KIT_AUTO_COMPACT_PERCENT";

export const DEFAULT_AUTO_COMPACT_PERCENT = 50;

/**
 * Band the threshold is held in. Below the floor a phase would spend most of
 * its spawns summarizing instead of working; above the ceiling the compaction
 * lands so close to the window that the agent CLI's own overflow handling gets
 * there first, and the option stops meaning anything.
 */
export const MIN_AUTO_COMPACT_PERCENT = 10;
export const MAX_AUTO_COMPACT_PERCENT = 90;

/** Characters per token of the estimate used when no usage figure is available. */
const CHARS_PER_TOKEN = 4;

/** Per-block cap when rendering the elided conversation for the summarizer. */
const RENDERED_BLOCK_CHARS = 4000;

/** A whole threshold percentage inside the supported band. */
export function isThresholdPercent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_AUTO_COMPACT_PERCENT &&
    value <= MAX_AUTO_COMPACT_PERCENT
  );
}

/** Read the threshold out of an environment; null means "leave the phase alone". */
export function readThresholdPercent(env: NodeJS.ProcessEnv): number | null {
  const raw = env[AUTO_COMPACT_ENV];
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  return isThresholdPercent(parsed) ? parsed : null;
}

/**
 * The shape this module needs from a conversation message, described
 * structurally so nothing here depends on the agent runtime types. Content is
 * either a plain string or a list of blocks; only text blocks are read, the
 * rest are measured and rendered by their serialized form.
 */
export interface PlanBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface PlanMessage {
  role: string;
  content?: string | readonly PlanBlock[];
  [key: string]: unknown;
}

/** Characters a block contributes, reading text blocks and serializing the rest. */
function blockChars(block: PlanBlock): number {
  if (typeof block.text === "string") return block.text.length;
  try {
    return JSON.stringify(block)?.length ?? 0;
  } catch {
    return 0;
  }
}

function messageChars(message: PlanMessage): number {
  const { content } = message;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) chars += blockChars(block);
  return chars;
}

/**
 * Token estimate for one message. Deliberately a character heuristic: the
 * exact count is only known after the provider answers, and the estimate is
 * the fallback for the requests where no usage figure exists yet.
 */
export function estimateMessageTokens(message: PlanMessage): number {
  return Math.ceil(messageChars(message) / CHARS_PER_TOKEN);
}

export function estimateConversationTokens(messages: readonly PlanMessage[]): number {
  let tokens = 0;
  for (const message of messages) tokens += estimateMessageTokens(message);
  return tokens;
}

/** Whether the context in flight has crossed the configured share of the window. */
export function overThreshold(usedTokens: number, contextWindow: number, percent: number): boolean {
  if (!Number.isFinite(usedTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  return usedTokens >= (contextWindow * percent) / 100;
}

/**
 * Recent tokens kept whole below the cut: half the budget the threshold buys.
 * Keeping the whole budget would cut nothing, and keeping too little throws
 * away the turns the agent is actually working in.
 */
export function keepRecentTokens(contextWindow: number, percent: number): number {
  return Math.floor((contextWindow * percent) / 200);
}

/**
 * Index the conversation is cut at: everything before it is summarized, from it
 * onward is kept verbatim. The cut always lands on an assistant message, which
 * is what keeps the result well-formed — a tool result whose call was elided
 * would be dangling, while an assistant message references nothing before it.
 * Returns null when no cut both keeps the recent budget and leaves enough
 * behind to be worth a summary.
 */
export function planCut(
  messages: readonly PlanMessage[],
  keepRecent: number,
  minCut = 1,
): number | null {
  let kept = 0;
  let boundary = messages.length;
  while (boundary > 0 && kept < keepRecent) {
    boundary--;
    kept += estimateMessageTokens(messages[boundary]);
  }
  for (let index = boundary; index >= minCut; index--) {
    if (messages[index].role === "assistant") return index;
  }
  return null;
}

/** Plain text of a message, used for the phase prompt and the summarizer answer. */
export function messageText(message: PlanMessage | undefined): string {
  if (!message) return "";
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/**
 * The elided conversation as text for the summarizer. Blocks are capped
 * individually: a single tool result of half a million characters would
 * otherwise decide the size of the summarization request on its own.
 */
export function renderConversation(messages: readonly PlanMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const { content } = message;
    const parts: string[] = [];
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const text = typeof block.text === "string" ? block.text : safeJson(block);
        parts.push(block.type && block.type !== "text" ? `[${block.type}] ${text}` : text);
      }
    }
    const body = truncate(parts.join("\n"), RENDERED_BLOCK_CHARS);
    if (body.trim() !== "") lines.push(`## ${message.role}\n${body}`);
  }
  return lines.join("\n\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[... ${text.length - limit} characters elided]`;
}

/** System prompt of the summarization call. */
export const SUMMARY_SYSTEM_PROMPT = [
  "You compress the transcript of a coding session so that the agent can keep working",
  "without the original messages. You never continue the work yourself and you never",
  "invent facts: everything you write must come from the transcript.",
].join(" ");

/**
 * The summarization request. The instructions ask for what a resumed attempt
 * actually needs — the state of the work, not a narrative of it — because the
 * summary replaces the transcript for every request that follows.
 */
export function buildSummaryPrompt(conversation: string, previousSummary?: string | null): string {
  const lines: string[] = [];
  if (previousSummary) {
    lines.push(
      "Below is the summary of an earlier part of the session, followed by the transcript",
      "of what happened after it. Merge both into one summary that replaces them.",
      "",
      "# Earlier summary",
      previousSummary,
      "",
      "# Transcript",
      conversation,
    );
  } else {
    lines.push("Below is the transcript of a coding session.", "", "# Transcript", conversation);
  }
  lines.push(
    "",
    "# What to write",
    "Write the state of the work as a compact briefing:",
    "- what was asked and what has been done so far, with the files created or edited;",
    "- decisions taken and the reason for each;",
    "- commands run and what they reported, especially failures still open;",
    "- what is left to do next.",
    "Output only the briefing.",
  );
  return lines.join("\n");
}

/**
 * The head of the compacted conversation: the phase prompt and the summary in
 * a single user message. Kept as one message rather than two so the compacted
 * request keeps the shape every provider accepts — one user turn, then the
 * assistant messages that were kept.
 */
export function buildCompactedHead(prompt: string, summary: string): string {
  return [
    prompt,
    "",
    "# Context compacted by specs-kit",
    "The earlier part of this session was summarized to stay inside the context window.",
    "What follows is that summary; the messages after it are the recent turns, kept whole.",
    "",
    summary,
  ].join("\n");
}

/**
 * The message list to send: the compacted head, then the kept turns. The head
 * is the phase prompt rewritten in place — copying the original message rather
 * than building a new one keeps whatever else the runtime put on it.
 */
export function applyCompaction(
  messages: readonly PlanMessage[],
  cut: number,
  summary: string,
): PlanMessage[] {
  const prompt = messages.find((message) => message.role === "user");
  const head: PlanMessage = {
    ...prompt,
    role: "user",
    content: buildCompactedHead(messageText(prompt), summary),
  };
  return [head, ...messages.slice(cut)];
}
