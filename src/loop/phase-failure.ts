/**
 * Why a phase subprocess did not deliver. The loop used to ask a single yes/no
 * question — did the spawn fail — and every answer routed the same way: spend
 * an attempt and implement again. That conflates two unrelated worlds. An agent
 * that wrote bad code deserves another attempt with the feedback; a provider
 * that refused the request (no budget left, bad credentials, a model id that
 * does not exist) will refuse the next one identically, and re-implementing
 * working code cannot change its mind.
 *
 * The distinction is read off the text the CLI and the provider already emit:
 * pi puts the transport error verbatim into the closing message, so a rate
 * limit arrives as `429 {"type":"error","error":{"type":"rate_limit_error",…}}`
 * and a mistyped model as a `not found` line on stderr.
 */

import type { PhaseRunOutcome } from "../agent/spawner.ts";

export type PhaseFailureKind =
  /** The provider has no budget left for this model. */
  | "quota"
  /** The provider rejected the credentials. */
  | "auth"
  /** The configured model id is not one the CLI can reach. */
  | "model"
  /** The subprocess outlived its wall-clock ceiling. */
  | "timeout"
  /** A stop request or a phase interrupt cut the subprocess short. */
  | "aborted"
  /** Anything else the agent reported as an error. */
  | "agent-error";

export interface PhaseFailure {
  kind: PhaseFailureKind;
  /** Verbatim CLI or provider text, shown to the operator unedited. */
  detail: string;
  /**
   * True when the same phase, spawned again against the same configuration,
   * fails the same way. These are the failures no retry can absorb: the loop
   * stops and names them instead of spending the task's attempts on them.
   */
  environment: boolean;
}

/** Longest failure text carried into a notification; the tail is dropped. */
const DETAIL_LIMIT = 300;

/**
 * Patterns matched against the error text, most specific first. A message can
 * satisfy more than one — a 429 body often names both a limit and a plan — so
 * the order is the priority, not a filter.
 */
const SIGNATURES: readonly { kind: PhaseFailureKind; pattern: RegExp }[] = [
  { kind: "model", pattern: /\bmodel\b[^\n]*\bnot found\b|\bunknown model\b|\bmodel_not_found\b/i },
  { kind: "auth", pattern: /\b40[13]\b|\bunauthori[sz]ed\b|\bforbidden\b|\bauthentication\b|invalid[\s_-]*api[\s_-]*key/i },
  {
    kind: "quota",
    pattern: /\b429\b|rate[\s_-]*limit|\bquota\b|usage limit|insufficient[\s_-]*(quota|credit|balance|funds)|purchase credits/i,
  },
];

function trim(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_LIMIT ? `${flat.slice(0, DETAIL_LIMIT)}…` : flat;
}

/**
 * Classify a finished phase, or null when it delivered. Structural flags are
 * read before the error text: a timeout and an abort are facts about the
 * subprocess, whatever the agent managed to say before it went.
 */
export function classifyPhaseFailure(outcome: PhaseRunOutcome | null): PhaseFailure | null {
  // No outcome at all means the subprocess never produced one, which is the
  // same dead end as a spawn that could not start.
  if (!outcome) return { kind: "agent-error", detail: "the phase produced no outcome", environment: false };
  if (outcome.timedOut) return { kind: "timeout", detail: "the phase outlived its timeout", environment: false };
  if (outcome.aborted) return { kind: "aborted", detail: "the phase was interrupted", environment: false };
  if (outcome.exitCode === 0 && outcome.stopReason !== "error") return null;

  const text = `${outcome.errorMessage ?? ""}\n${outcome.stderr}`;
  for (const { kind, pattern } of SIGNATURES) {
    if (pattern.test(text)) return { kind, detail: trim(outcome.errorMessage ?? outcome.stderr), environment: true };
  }
  return { kind: "agent-error", detail: trim(outcome.errorMessage ?? outcome.stderr) || "agent error", environment: false };
}

/** A phase subprocess outcome counts as failed on any of these conditions. */
export function spawnFailed(outcome: PhaseRunOutcome | null): boolean {
  return classifyPhaseFailure(outcome) !== null;
}

/**
 * Operator-facing line for a failure no retry can absorb. It names the role
 * whose model is at fault, quotes the provider verbatim and says plainly that
 * running the phase again changes nothing — the sentence that was missing when
 * a rate limit read as a one-line warning about a failed attempt.
 */
export function environmentFailureMessage(phase: string, taskId: string, failure: PhaseFailure): string {
  const cause = {
    quota: "the provider reports no budget left for this model",
    auth: "the provider rejected the credentials",
    model: "the configured model is not one the agent CLI can reach",
    timeout: "the phase outlived its timeout",
    aborted: "the phase was interrupted",
    "agent-error": "the agent reported an error",
  }[failure.kind];
  return (
    `${phase} could not run for ${taskId}: ${cause}. ${failure.detail} — ` +
    "spawning it again against the same configuration fails identically, so the task stops here " +
    "instead of spending its attempts; change the model for this role, or restore its access, before resuming."
  );
}
