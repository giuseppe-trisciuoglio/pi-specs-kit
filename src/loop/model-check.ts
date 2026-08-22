/**
 * Pre-flight validation of the models configured for the five roles against
 * the catalogue the agent CLI actually knows. A mistyped model id is only
 * discovered at spawn time today, once per attempt; checking it before the
 * loop starts turns an infrastructure failure into a cheap refusal. The CLI
 * query is injectable so tests can pin a deterministic catalogue without
 * touching the real binary.
 */

import { ROLE_NAMES, type RoleName, type SpecsKitConfig } from "../config/specs-kit-config.ts";
import { spawnProcess } from "../util/process.ts";

/** Model value meaning "let the agent CLI choose"; nothing to validate. */
const AUTO_MODEL = "auto";

/**
 * How long the catalogue query may take. The check is a pre-flight: it must
 * never be the reason a run does not start, and on expiry the query counts as
 * unavailable and the loop proceeds with a warning.
 */
export const MODEL_LIST_TIMEOUT_MS = 10_000;

/** One row of the agent CLI model catalogue, `provider/model` as configured. */
export interface ListedModel {
  provider: string;
  model: string;
}

/** A configured model with the role that carries it, for error messages. */
export interface ConfiguredModel {
  role: RoleName;
  model: string;
}

/**
 * Parse the tabular output of `pi --list-models`: a header row, then provider
 * and model as the first two whitespace-separated columns of each line.
 * Unparseable lines are skipped: the catalogue is a display format, not a
 * contract, and a stray line must not fail the check.
 */
export function parseModelList(output: string): ListedModel[] {
  const models: ListedModel[] = [];
  for (const line of output.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2 || tokens[0] === "provider") continue;
    models.push({ provider: tokens[0], model: tokens[1] });
  }
  return models;
}

/**
 * The models configured for the five roles, with "auto" and empty values
 * dropped: both mean the CLI picks the model, so there is nothing to check.
 */
export function configuredModels(config: SpecsKitConfig): ConfiguredModel[] {
  const models: ConfiguredModel[] = [];
  for (const role of ROLE_NAMES) {
    const model = config.roles[role].model;
    if (model !== "" && model !== AUTO_MODEL) models.push({ role, model });
  }
  return models;
}

/**
 * The escalation models configured, one per role that declares one distinct
 * from its primary. Checked like the primaries but only warned about: a
 * fallback the catalogue does not know costs nothing until the day it is
 * needed — and then it fails exactly like any other unknown model, with a
 * diagnosis naming it.
 */
export function configuredFallbackModels(config: SpecsKitConfig): ConfiguredModel[] {
  const models: ConfiguredModel[] = [];
  for (const role of ROLE_NAMES) {
    const { model, fallbackModel } = config.roles[role];
    if (fallbackModel && fallbackModel !== model) models.push({ role, model: fallbackModel });
  }
  return models;
}

/**
 * The configured models the CLI catalogue does not know about, i.e. the ones
 * that would fail at spawn time on every attempt. Comparison is exact: the
 * catalogue is case-sensitive.
 */
export function findMissingModels(
  configured: readonly ConfiguredModel[],
  listed: readonly ListedModel[],
): ConfiguredModel[] {
  const known = new Set(listed.map((m) => `${m.provider}/${m.model}`));
  return configured.filter((m) => !known.has(m.model));
}

/**
 * Query the agent CLI for its model catalogue. Empty on any failure — missing
 * binary, non-zero exit, timeout or a blank answer: all of them mean the
 * check cannot be performed, and the caller warns instead of blocking.
 */
export async function listModels(): Promise<ListedModel[]> {
  const res = await spawnProcess("pi", ["--list-models"], { timeoutMs: MODEL_LIST_TIMEOUT_MS });
  if (res.exitCode !== 0 || res.timedOut) return [];
  return parseModelList(res.stdout);
}

/**
 * Warning shown when the catalogue cannot be read: the configured models go
 * unchecked, so a mistyped id would still fail at spawn time. Surfaced as a
 * warning, not a blocker — uncertainty does not stop the operator, the same
 * choice made for a missing graphify.
 */
export function modelListUnavailableWarning(): string {
  return (
    "[specs-kit] could not read the model catalogue (pi --list-models failed, " +
    "timed out or returned nothing): the configured models were not checked. " +
    "The loop starts anyway; a mistyped model id will still fail at spawn time."
  );
}

/**
 * Error naming every configured model the CLI does not know. This is a
 * certainty — the spawn would fail the same way on every attempt — so the run
 * refuses to start instead of spending its budget on it.
 */
export function unknownModelsError(missing: readonly ConfiguredModel[]): string {
  const entries = missing.map((m) => `${m.role}: ${m.model}`).join(", ");
  return (
    `cannot start the loop: model(s) not known to the agent CLI: ${entries}. ` +
    "Check the agents.*_model values in specs-kit.yaml."
  );
}

/**
 * Warning for a declared fallback the CLI does not know. Advisory on purpose:
 * the run starts, and the gap is named so it can be fixed before an outage
 * ever needs the fallback.
 */
export function unknownFallbackModelsWarning(missing: readonly ConfiguredModel[]): string {
  const entries = missing.map((m) => `${m.role}: ${m.model}`).join(", ");
  return (
    `[specs-kit] escalation model(s) not known to the agent CLI: ${entries}. ` +
    "The loop starts anyway; when a phase falls back it will fail like any other unknown model."
  );
}
