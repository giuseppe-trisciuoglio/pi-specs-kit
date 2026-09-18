/**
 * How a hook target is run and what it is told. The executor owns when the
 * hooks of a phase run; this module owns the two things every hook stage
 * shares — the label its output is streamed under, and the list of changed
 * files the commands scope themselves with.
 */

import type { HookTarget, SpecsKitConfig } from "../config/specs-kit-config.ts";
import type { ChangedFilesProvider, HookResult, runPhaseHooks } from "./hooks.ts";
import { changedWorkspaceFiles, loopArtifactExclusions } from "./workspace.ts";

/**
 * The reader the hooks of a run are told about, bound to the project and the
 * active spec. Lazy by construction: `runPhaseHooks` calls it only when the
 * stage has a command, so a target with no hooks never pays for the git calls.
 */
export function changedFilesProvider(
  config: SpecsKitConfig,
  specDir: string,
  read: typeof changedWorkspaceFiles = changedWorkspaceFiles,
): ChangedFilesProvider {
  // The same exclusions the fingerprint uses: the loop's own state file and
  // phase logs are written while the phase runs, and a gate has no reason to
  // widen its scope because the fix plan moved.
  return () => read(config.projectRoot, loopArtifactExclusions(config.projectRoot, specDir));
}

/**
 * Run one stage of one target, streaming its output under a label that names
 * the stage: the pre hooks of this attempt and the post hooks of the previous
 * one both end up in the same log, and only the label tells them apart.
 */
export async function runStageHooks(
  runHooks: typeof runPhaseHooks,
  config: SpecsKitConfig,
  target: HookTarget,
  stage: "pre" | "post",
  onLogLine: (line: string) => void,
  changedFiles: ChangedFilesProvider,
): Promise<HookResult[]> {
  const label = target === "checkpoint" ? "checkpoint" : `${stage}-${target}`;
  return runHooks(
    config.hooks,
    target,
    stage,
    config.projectRoot,
    {
      onStdoutLine: (line) => onLogLine(`[${label}] ${line}`),
      onStderrLine: (line) => onLogLine(`[${label}] ! ${line}`),
    },
    changedFiles,
  );
}
