/**
 * Which model an attempt is spawned on, decided from the role configuration
 * and the attempt number alone. Pure and free of SDK imports so the rule can
 * be read and tested without a subprocess: the spawner applies it, it does not
 * own it.
 *
 * The rule exists because the attempts of one task are not worth the same. The
 * first one is speculative and cheap; every later one drags another review and
 * another gate behind it, so the error it would make costs more than the model
 * that avoids it.
 */

import { DEFAULT_RETRY_FROM_ATTEMPT, type RoleConfig } from "../config/specs-kit-config.ts";

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
