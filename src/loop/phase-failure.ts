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
  /** The subprocess ran clean but the stream carried no assistant message:
   * nothing was produced, so a phase whose contract is a written artifact
   * cannot have delivered it. */
  | "no-output"
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
 * Classify a finished phase, or null when it delivered.
 *
 * The question is answered from evidence, and the evidence list is a
 * disjunction: a termination signal, a nonzero exit, a timeout, an interrupt,
 * an error message on the closing message, or a stream that carried no
 * completed assistant message at all — each on its own is enough to call the
 * phase failed. The stop reason names the failure but no longer gates whether
 * one exists: an error that fires before the first token travels in the error
 * field with the stop reason unset, and reading only the taxonomy let exactly
 * that shape walk past as a delivered phase.
 */
export function classifyPhaseFailure(outcome: PhaseRunOutcome | null): PhaseFailure | null {
  // No outcome at all means the subprocess never produced one, which is the
  // same dead end as a spawn that could not start.
  if (!outcome) return { kind: "agent-error", detail: "the phase produced no outcome", environment: false };
  if (outcome.timedOut) return { kind: "timeout", detail: "the phase outlived its timeout", environment: false };
  if (outcome.aborted) return { kind: "aborted", detail: "the phase was interrupted", environment: false };
  if (outcome.signal) {
    return { kind: "agent-error", detail: `terminated by ${outcome.signal}`, environment: false };
  }
  // Silence is positive evidence and must be reported by the counter: an
  // outcome that does not carry the count at all says nothing either way.
  if (outcome.assistantMessages === 0 && !hasReportedError(outcome)) {
    return {
      kind: "no-output",
      detail: "the phase ended without producing any output",
      environment: false,
    };
  }
  if (isClean(outcome)) return null;

  const text = `${outcome.errorMessage ?? ""}\n${outcome.stderr}`;
  for (const { kind, pattern } of SIGNATURES) {
    if (pattern.test(text)) return { kind, detail: trim(outcome.errorMessage ?? outcome.stderr), environment: true };
  }
  return { kind: "agent-error", detail: trim(outcome.errorMessage ?? outcome.stderr) || "agent error", environment: false };
}

/** The transport-level evidence of something going wrong, independent of taxonomy. */
function hasReportedError(outcome: PhaseRunOutcome): boolean {
  return outcome.exitCode !== 0 || outcome.stopReason === "error" || outcome.errorMessage !== null;
}

/** Nothing in the outcome or the stream says otherwise: the phase delivered. */
function isClean(outcome: PhaseRunOutcome): boolean {
  return outcome.exitCode === 0 && outcome.stopReason !== "error" && outcome.errorMessage === null;
}

/** A phase subprocess outcome counts as failed on any of these conditions. */
export function spawnFailed(outcome: PhaseRunOutcome | null): boolean {
  return classifyPhaseFailure(outcome) !== null;
}

/**
 * Thrown after consecutive phases failed the environmental way — refused, or
 * silent, or both. A provider outage does not respect task boundaries: the
 * task that discovered it stops with a diagnosis, and the one after would
 * discover nothing new. Crossing the streak limit halts the whole run with
 * every reason accumulated, so the operator reads one sentence instead of
 * watching the same failure replay per task.
 */
export class EnvironmentStreakError extends Error {
  /** One line per failed phase, oldest first. */
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(
      `${reasons.length} phase(s) in a row failed against the environment and the escalation model did not help either`,
    );
    this.name = "EnvironmentStreakError";
    this.reasons = reasons;
  }
}

/** Consecutive environmental phase failures the run tolerates before halting. */
export const DEFAULT_ENVIRONMENT_STREAK = 2;

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
    "no-output": "the phase ran but produced no output at all",
    "agent-error": "the agent reported an error",
  }[failure.kind];
  return (
    `${phase} could not run for ${taskId}: ${cause}. ${failure.detail} — ` +
    "spawning it again against the same configuration fails identically, so the task stops here " +
    "instead of spending its attempts; change the model for this role, or restore its access, before resuming."
  );
}
