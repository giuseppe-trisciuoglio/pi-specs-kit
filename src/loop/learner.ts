/**
 * Learnings extraction and persistence helpers. The learner role produces a
 * textual bullet list at the end of a task; bullets are merged into the fix
 * plan so later tasks receive them as memory, and persisted to a project-level
 * file under the specs directory so future specs benefit from them.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Upper bound of learnings kept in the fix plan; the coldest entries rotate
 * out. Fifteen, not fifty: memory is resent whole at every turn of every
 * phase, so its cost is the list times the turns of the whole run, and a run
 * that filled the old cap paid for a memory nobody could still act on. The
 * scoring already sorts the list by what the project keeps re-teaching, which
 * is what makes a short cap safe — what survives is the warm head.
 */
export const MAX_LEARNINGS = 15;

/**
 * Second bound on the same list, in characters. The count cap assumes bullets
 * are roughly the same size; one learner that answers with a paragraph breaks
 * that assumption and a single entry eats the room of five useful ones. Held
 * against the rendered bullet, so what is bounded is what the prompt pays for.
 */
export const MAX_LEARNINGS_CHARS = 6000;

/** What one learning costs in the prompt: the text plus its "- " bullet. */
function bulletCost(learning: string): number {
  return learning.length + 3;
}

/**
 * Maximum learnings kept in the project-level file (compacted by the learner).
 * Higher than the per-spec cap because this file is what a spec starting with
 * an empty memory inherits; the character budget above applies to it too, so
 * the count is the looser of the two bounds, not the only one.
 */
export const MAX_PROJECT_LEARNINGS = 30;

/** File name relative to the specs directory. */
const LEARNINGS_FILE = "learnings.md";

export function projectLearningsPath(projectRoot: string, specsDir: string): string {
  return path.join(projectRoot, specsDir, LEARNINGS_FILE);
}

/**
 * Prefix a learner uses to point at an insight the project already recorded.
 * It lives here, next to the memory it points into, so the reader of the
 * memory can tell a citation from an insight without importing the spawner.
 */
export const CONFIRMED_PREFIX = "CONFIRMED:";

/**
 * Parse bullet lines from free-form learner output. Accepts "-", "*", "•"
 * and numbered bullets; ignores headings, blank lines and prose.
 */
export function parseLearnings(text: string): string[] {
  const learnings: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1];
    if (value && !learnings.includes(value)) learnings.push(value);
  }
  return learnings;
}

/**
 * The insights a learner actually added, with its citations removed.
 *
 * A citation is written as a bullet like everything else, and the bullet
 * parser cannot tell one from a new insight. Kept in, every citation stored a
 * second copy of the entry it was pointing at: the memory filled up with what
 * the project had already learnt, worded as a pointer, and every later prompt
 * paid for both copies.
 */
export function parseNewLearnings(text: string): string[] {
  return parseLearnings(text).filter((learning) => !learning.toUpperCase().startsWith(CONFIRMED_PREFIX));
}

/**
 * What the loop has observed about one insight. Nothing here is a judgement an
 * agent declared about its own output: `hits` counts the tasks that met the
 * insight again, `fromRejection` records that a review had to reject the task
 * that produced it, and `lastSeen` is the iteration that last touched it.
 */
export interface LearningStat {
  hits: number;
  fromRejection: boolean;
  lastSeen: number;
}

/**
 * Both weights are denominated in tasks, because the decay is one point per
 * task: an insight survives roughly `score` more tasks before a fresh one
 * outranks it. Six buys a stretch long enough to matter in a range of a dozen
 * or so tasks, while still letting a tip nobody meets again fall behind the
 * newcomers within a handful. Weighting them any lower — the first pass tried
 * two and three — lets the decay eat the reinforcement outright: a rule met
 * three times and paid for with a rejection still died within nine tasks,
 * which is the failure this scoring exists to prevent.
 */
const HIT_WEIGHT = 6;
/** Weight of having been paid for with a rejected review. */
const REJECTION_WEIGHT = 6;

export function neutralStat(iteration: number): LearningStat {
  return { hits: 1, fromRejection: false, lastSeen: iteration };
}

/**
 * How warm an insight is at a given iteration. Everything cools as the run
 * moves on; only a later task meeting it again reheats it. A convention the
 * project keeps re-teaching, or one a review had to enforce, outlives a
 * stylistic tip that was mentioned once — which is the whole point, because
 * dropping by age alone evicted an architectural invariant to make room for
 * a note about a JPA default.
 */
export function learningScore(stat: LearningStat, iteration: number): number {
  return stat.hits * HIT_WEIGHT + (stat.fromRejection ? REJECTION_WEIGHT : 0) - (iteration - stat.lastSeen);
}

export interface MergeInput {
  existing: string[];
  /** Positionally aligned with `existing`; missing entries read as neutral. */
  stats?: LearningStat[];
  incoming: string[];
  /** Insights the learner cited as met again, verified against `existing`. */
  confirmed?: readonly string[];
  /** Task counter driving the decay. */
  iteration: number;
  fromRejection?: boolean;
  max?: number;
  /** Character budget for the whole list, bullets included. */
  maxChars?: number;
}

export interface MergeResult {
  learnings: string[];
  stats: LearningStat[];
}

/**
 * Merge a learner's output into the memory. Exact repeats and cited insights
 * reheat the entry that is already there instead of adding a second copy;
 * genuinely new insights are appended. When the result overflows either bound
 * — the entry count or the character budget — the coldest entries go, not the
 * oldest.
 */
export function mergeLearnings(input: MergeInput): MergeResult {
  const { existing, incoming, iteration, max = MAX_LEARNINGS, maxChars = MAX_LEARNINGS_CHARS } = input;
  const learnings = [...existing];
  // A plan written before stats existed reads as neutral rather than failing.
  const stats: LearningStat[] = learnings.map((_, i) => input.stats?.[i] ?? neutralStat(iteration));
  const indexOf = new Map(learnings.map((l, i) => [l.toLowerCase(), i]));

  const reheat = (key: string): boolean => {
    const at = indexOf.get(key.toLowerCase());
    if (at === undefined) return false;
    stats[at] = { ...stats[at], hits: stats[at].hits + 1, lastSeen: iteration };
    return true;
  };

  for (const cited of input.confirmed ?? []) reheat(cited);
  for (const learning of incoming) {
    if (reheat(learning)) continue;
    indexOf.set(learning.toLowerCase(), learnings.length);
    learnings.push(learning);
    stats.push({ hits: 1, fromRejection: input.fromRejection ?? false, lastSeen: iteration });
  }

  const total = learnings.reduce((sum, l) => sum + bulletCost(l), 0);
  if (learnings.length <= max && total <= maxChars) return { learnings, stats };

  // Evict the coldest against both bounds. Ties break on age, so equal scores
  // keep the newer entry and the order of what survives is left untouched.
  // An entry that does not fit the remaining budget is passed over rather than
  // ending the pass: a single outsized bullet loses its own place, not the
  // places of the warm short ones behind it — and that holds however warm the
  // outsized one is, because the budget exists precisely to stop one paragraph
  // from spending the room of five usable rules. Only when nothing fits at all
  // does the warmest entry go in regardless: the budget bounds the memory, it
  // never empties it.
  const byWarmth = learnings
    .map((_, i) => i)
    .sort((a, b) => learningScore(stats[b], iteration) - learningScore(stats[a], iteration) || b - a);
  const keep: number[] = [];
  let spent = 0;
  for (const i of byWarmth) {
    if (keep.length >= max) break;
    const cost = bulletCost(learnings[i]);
    if (spent + cost > maxChars) continue;
    keep.push(i);
    spent += cost;
  }
  if (keep.length === 0) keep.push(byWarmth[0]);
  keep.sort((a, b) => a - b);
  return { learnings: keep.map((i) => learnings[i]), stats: keep.map((i) => stats[i]) };
}

/**
 * Load learnings from the project-level file, returning an empty list when
 * the file is absent or unreadable.
 */
export async function loadProjectLearnings(projectRoot: string, specsDir: string): Promise<string[]> {
  try {
    const content = await readFile(projectLearningsPath(projectRoot, specsDir), "utf8");
    return parseLearnings(content);
  } catch {
    return [];
  }
}

/**
 * Persist learnings to the project-level file. The directory is created when
 * it does not exist, and the list is capped at MAX_PROJECT_LEARNINGS.
 */
export async function saveProjectLearnings(
  projectRoot: string,
  specsDir: string,
  learnings: string[],
): Promise<void> {
  const filePath = projectLearningsPath(projectRoot, specsDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  const capped = learnings.length > MAX_PROJECT_LEARNINGS ? learnings.slice(-MAX_PROJECT_LEARNINGS) : learnings;
  const body = capped.map((l) => `- ${l}`).join("\n");
  await writeFile(filePath, `# Project Learnings\n\n${body}\n`, "utf8");
}
