/**
 * Failure memory: what stopped an attempt, kept per task for the attempts that
 * follow. Learnings are harvested only from a task that passed review, so a
 * task that keeps failing re-derives the same wall at every retry — the same
 * missing decision, the same verified fact, at full price each time. Blockers
 * are the other channel: run memory, written by the failure learner after a
 * failed attempt, injected into the next attempt's prompt and discarded when
 * the task passes. Only the sanctioned learner may promote one to project
 * memory.
 *
 * Pure module: types, parsing and bounds only, so both the loop and the tests
 * can import it without dragging in the agent CLI.
 */

/**
 * Why the attempt stopped. The split is what decides the answer: a fact is
 * handed back to the next attempt and pays for itself, while a contradiction
 * or a decision nobody made cannot be solved by the agent trying harder — it
 * is escalated to the operator instead.
 */
export type BlockerKind =
  | "spec_contradiction"
  | "verified_fact"
  | "unowned_decision"
  | "operator_action"
  | "env";

/** The kinds no retry can resolve on its own: hitting one twice ends the task. */
export const WALL_KINDS: readonly BlockerKind[] = [
  "spec_contradiction",
  "unowned_decision",
  // An action only a person can perform is the purest of the three: no spawn
  // of any model has the account, the credential or the hands to close it.
  "operator_action",
];

export interface Blocker {
  /** Task the blocker belongs to; blockers are per task, never global. */
  task: string;
  /** Attempt that hit it, 1-based. */
  attempt: number;
  kind: BlockerKind;
  text: string;
  /** True once the task passed review; resolved entries are pruned there. */
  resolved: boolean;
}

/** Upper bound of blockers kept in the fix plan, all tasks together. The
 * coldest here are simply the oldest: unlike learnings, a blocker has no
 * warmth to score — it belongs to one task and dies with it. */
export const MAX_BLOCKERS = 12;

/**
 * Character budget of the blockers block, mirroring MAX_LEARNINGS_CHARS: the
 * prompt is resent at every turn, so one agent answering with a paragraph
 * must lose its own place rather than the places of the short useful ones.
 */
export const MAX_BLOCKERS_CHARS = 3000;

/** Per-entry cap, applied when the blocker is recorded. */
export const MAX_BLOCKER_TEXT = 400;

/** Prefixes the failure learner uses to classify what it found. */
const KIND_BY_LABEL: Readonly<Record<string, BlockerKind>> = {
  SPEC_CONTRADICTION: "spec_contradiction",
  VERIFIED_FACT: "verified_fact",
  UNOWNED_DECISION: "unowned_decision",
  OPERATOR_ACTION: "operator_action",
  ENV: "env",
};

/** The labels, in the order the prompt lists them. */
export const BLOCKER_LABELS: readonly string[] = Object.keys(KIND_BY_LABEL);

/** Label of a kind, for the prompt and for operator-facing messages. */
export function blockerLabel(kind: BlockerKind): string {
  return BLOCKER_LABELS.find((label) => KIND_BY_LABEL[label] === kind) ?? "ENV";
}

/** Identity used to tell two blockers apart: the wording an agent produces
 * twice is never byte-identical, so the comparison ignores case, punctuation
 * runs and whitespace. */
function identity(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_BLOCKER_TEXT ? trimmed : `${trimmed.slice(0, MAX_BLOCKER_TEXT - 1)}…`;
}

/**
 * Parse the failure learner's answer: bullets labelled with one of the kinds.
 * An unlabelled bullet is dropped rather than guessed at — the kind decides
 * whether the loop hands the entry back to the agent or escalates it, so a
 * wrong guess is worse than a missing entry.
 */
export function parseBlockers(text: string, task: string, attempt: number): Blocker[] {
  const found: Blocker[] = [];
  const seen = new Set<string>();
  // The list marker and its trailing whitespace live in the same optional
  // group, so the alternation does not also have to backtrack against the
  // whitespace that follows it.
  const line = /^(?:[-*•][ \t]*|\d+[.)][ \t]*)?([A-Z_]+)[ \t]*[:\-—][ \t]*(\S.*?)$/;
  for (const raw of text.split("\n")) {
    const match = line.exec(raw.trim());
    if (!match) continue;
    const kind = KIND_BY_LABEL[match[1].toUpperCase()];
    if (!kind) continue;
    const value = truncate(match[2]);
    if (!value) continue;
    const key = `${kind}:${identity(value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ task, attempt, kind, text: value, resolved: false });
  }
  return found;
}

/**
 * Add what an attempt found to the memory. One entry per attempt, so the same
 * wall recorded twice stays two entries: that is exactly what makes a repeat
 * visible to the escalation. The oldest entries rotate out when the list
 * overflows.
 */
export function addBlockers(existing: readonly Blocker[], incoming: readonly Blocker[]): Blocker[] {
  const merged = [...existing.map((b) => ({ ...b })), ...incoming.map((b) => ({ ...b, text: truncate(b.text) }))];
  return merged.length > MAX_BLOCKERS ? merged.slice(merged.length - MAX_BLOCKERS) : merged;
}

/** The unresolved blockers of one task, oldest first. */
export function blockersForTask(blockers: readonly Blocker[] | undefined, task: string): Blocker[] {
  return (blockers ?? []).filter((b) => b.task === task && !b.resolved);
}

/**
 * Blockers to inject, deduplicated and within the character budget. A wall hit
 * by three attempts is one entry in the prompt, not three; and the newest are
 * chosen first when the budget bites — the last attempt's wall is the one the
 * next attempt is about to walk into — while the rendering keeps the order
 * they were found in.
 */
export function injectableBlockers(blockers: readonly Blocker[]): Blocker[] {
  const keep: number[] = [];
  const seen = new Set<string>();
  let spent = 0;
  for (let i = blockers.length - 1; i >= 0; i--) {
    const blocker = blockers[i];
    const key = `${blocker.kind}:${identity(blocker.text)}`;
    if (seen.has(key)) continue;
    const cost = blocker.text.length + blockerLabel(blocker.kind).length + 6;
    if (spent + cost > MAX_BLOCKERS_CHARS) continue;
    seen.add(key);
    keep.push(i);
    spent += cost;
  }
  return keep.toSorted((a, b) => a - b).map((i) => blockers[i]);
}

/**
 * The wall this attempt hit for the second consecutive time, if any. Only the
 * kinds no retry can resolve count: handing an ambiguous requirement back to
 * the agent a third time buys the same deliberation again, so the loop stops
 * and the operator gets the text.
 */
export function repeatedWall(blockers: readonly Blocker[], task: string, attempt: number): Blocker | null {
  const mine = blockers.filter((b) => b.task === task && !b.resolved);
  const previous = new Set(
    mine.filter((b) => b.attempt === attempt - 1).map((b) => `${b.kind}:${identity(b.text)}`),
  );
  for (const blocker of mine) {
    if (blocker.attempt !== attempt) continue;
    if (!WALL_KINDS.includes(blocker.kind)) continue;
    if (previous.has(`${blocker.kind}:${identity(blocker.text)}`)) return blocker;
  }
  return null;
}

/** Facts a passing task may hand to the learner: paid for once, worth keeping. */
export function promotableFacts(blockers: readonly Blocker[] | undefined, task: string): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const blocker of blockersForTask(blockers, task)) {
    if (blocker.kind !== "verified_fact") continue;
    const key = identity(blocker.text);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(blocker.text);
  }
  return facts;
}

/** Mark this task's blockers as resolved: the task passed, they served. */
export function resolveTaskBlockers(blockers: readonly Blocker[] | undefined, task: string): Blocker[] {
  return (blockers ?? []).map((b) => (b.task === task ? { ...b, resolved: true } : b));
}

/** Drop this task's blockers: run memory never outlives the task it explains. */
export function pruneTaskBlockers(blockers: readonly Blocker[] | undefined, task: string): Blocker[] {
  return (blockers ?? []).filter((b) => b.task !== task);
}

/**
 * Read blockers off a persisted plan, dropping anything that does not have the
 * shape: the field is advisory and a plan written by an older version, or by
 * hand, must not break the load.
 */
export function normalizeBlockers(value: unknown): Blocker[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blockers: Blocker[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.kind !== "string") continue;
    if (typeof raw.task !== "string" || typeof raw.text !== "string") continue;
    if (!Object.values(KIND_BY_LABEL).includes(raw.kind as BlockerKind)) continue;
    blockers.push({
      task: raw.task,
      attempt: typeof raw.attempt === "number" ? raw.attempt : 1,
      kind: raw.kind as BlockerKind,
      text: truncate(raw.text),
      resolved: raw.resolved === true,
    });
  }
  return blockers;
}

/**
 * Prompt of the failure learner. It runs on a dead attempt, so it is shown
 * what failed rather than a diff that passed: the point is to name the wall
 * before the next spawn walks into it, and to name it as one of the five
 * kinds, because the kind is what the loop routes on.
 */
export function buildFailureLearnerPrompt(input: {
  taskId: string;
  title: string;
  attempt: number;
  detail: string;
  known: readonly string[];
}): string {
  const lines = [
    `Attempt ${input.attempt} of the task ${input.taskId} "${input.title}" did not complete.`,
    `What the loop observed: ${input.detail}`,
    "",
    "Inspect the workspace and the task, and write down what stopped this attempt, so the",
    "next one does not pay for it again. One entry per line, each starting with \"- \" and",
    "one of these labels followed by a colon:",
    `- ${BLOCKER_LABELS[0]}: the task or its documents contradict themselves or the code.`,
    `- ${BLOCKER_LABELS[1]}: a technical fact established at cost (a value, a signature, an`,
    "  API behaviour verified by reading the source), stated so it can be reused verbatim.",
    `- ${BLOCKER_LABELS[2]}: a design decision the task leaves to whoever implements it.`,
    `- ${BLOCKER_LABELS[3]}: an action only a human can perform: a credential, an account,`,
    "  a signature, a purchase, physical or console access.",
    `- ${BLOCKER_LABELS[4]}: something about the environment (build, network, tooling).`,
    "",
    "Report only what actually stopped this attempt. Do not propose a plan, do not modify",
    "any file, and do not restate the task.",
  ];
  if (input.known.length > 0) {
    lines.push(
      "",
      "Earlier attempts of this task already recorded the entries below. Repeat one verbatim",
      "if this attempt hit it again; otherwise list only what is new.",
      "",
      ...input.known.map((k) => `- ${k}`),
    );
  }
  return lines.join("\n") + "\n";
}
