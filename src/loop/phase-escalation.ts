/**
 * Pure escalation rules: which model an attempt runs on, what the loop
 * concludes when a role's escalation is spent. The spawner owns the
 * subprocesses; the decisions that route and diagnose them live here, so they
 * can be read and tested without an agent.
 *
 * The model rule exists because the attempts of one task are not worth the
 * same. The first one is speculative and cheap; every later one drags another
 * review and another gate behind it, so the error it would make costs more
 * than the model that avoids it.
 *
 * The failure rule answers the mistake of reporting the primary's failure and
 * throwing the fallback's away. The operator read a rate limit against a model
 * that was abandoned minutes earlier, with nothing in the sentence to say the
 * fallback had been tried at all — and the primary's verdict, environmental by
 * nature, ended the run even when the fallback had died of something a second
 * attempt would have survived.
 */

import { DEFAULT_RETRY_FROM_ATTEMPT, type RoleConfig } from "../config/specs-kit-config.ts";
import type { PhaseFailure } from "./phase-failure.ts";

/** The model and thinking level one spawn runs with. */
export interface AttemptModel {
  /** Model id for the agent CLI; "auto" or empty leaves the choice to it. */
  model: string | undefined;
  /** Thinking level flag value; undefined means "agent CLI default". */
  thinkingLevel: string | undefined;
  /** True when the retry model took over from the role's primary. */
  retry: boolean;
}

/**
 * The model a given attempt of a role runs on. Attempts are 1-based, and a
 * role that declares no retry model always answers with its primary — which
 * is what every configuration written before this rule existed does.
 */
export function attemptModel(role: RoleConfig, attempt: number): AttemptModel {
  const from = role.retryFromAttempt ?? DEFAULT_RETRY_FROM_ATTEMPT;
  if (role.retryModel && attempt >= from) {
    // The retry model may be spawned at a different thinking level than the
    // primary; when it names none it inherits the role's, because the level
    // describes how the role works, not which model does the work.
    return { model: role.retryModel, thinkingLevel: role.retryThinkingLevel ?? role.thinkingLevel, retry: true };
  }
  return { model: role.model, thinkingLevel: role.thinkingLevel, retry: false };
}

/** One side of the escalation: what failed, and on which model. */
export interface EscalationSide {
  failure: PhaseFailure;
  model: string | undefined;
}

function name(model: string | undefined): string {
  return model && model !== "auto" ? model : "the default model";
}

/**
 * The diagnosis of a phase that failed on both models. The kind and the
 * environment flag come from the fallback: it is the last state of the path
 * actually taken, and the primary's refusal says nothing about whether
 * spawning the fallback again would work. The detail keeps both, in the order
 * they happened, because the operator has to change something about one of
 * them and cannot choose without seeing both.
 */
export function combineEscalationFailures(primary: EscalationSide, fallback: EscalationSide): PhaseFailure {
  return {
    kind: fallback.failure.kind,
    environment: fallback.failure.environment,
    model: fallback.model,
    detail:
      `primary ${name(primary.model)} ${primary.failure.kind}: ${primary.failure.detail}; ` +
      `fallback ${name(fallback.model)} ${fallback.failure.kind}: ${fallback.failure.detail}`,
  };
}

/**
 * Whether the fallback earns one more spawn. The primary enjoys the agent
 * CLI's own retries; the fallback gets a single shot, and a truncated stream
 * or a silent spawn used to end the task on that one sample. An environmental
 * failure is excluded because it answers identically every time, an interrupt
 * because it was asked for, and a timeout because the retry would cost the
 * whole wall-clock ceiling a second time before saying the same thing.
 */
export function fallbackDeservesRetry(failure: PhaseFailure): boolean {
  return !failure.environment && failure.kind !== "aborted" && failure.kind !== "timeout";
}
