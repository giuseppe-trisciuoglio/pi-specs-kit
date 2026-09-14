/**
 * What the loop concludes when a role's escalation is spent. The spawner owns
 * the subprocesses; the two decisions that follow a failed fallback are pure
 * and live here, so they can be read and tested without an agent.
 *
 * Both answer the same mistake: the escalation path used to report the
 * primary's failure and throw the fallback's away. The operator read a rate
 * limit against a model that was abandoned minutes earlier, with nothing in
 * the sentence to say the fallback had been tried at all — and the primary's
 * verdict, environmental by nature, ended the run even when the fallback had
 * died of something a second attempt would have survived.
 */

import type { PhaseFailure } from "./phase-failure.ts";

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
