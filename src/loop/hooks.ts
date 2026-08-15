import { spawnProcess } from "../util/process.ts";
import type { HooksConfig, PhaseName } from "../config/specs-kit-config.ts";

export interface HookResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Combined stdout+stderr, trimmed. */
  output: string;
}

export interface HookStreamCallbacks {
  /** Called for each stdout line as it arrives. */
  onStdoutLine?: (line: string) => void;
  /** Called for each stderr line as it arrives. */
  onStderrLine?: (line: string) => void;
}

/** Run a single hook command through the system shell with a timeout. */
export async function runHook(
  command: string,
  opts: { cwd: string; timeoutMs: number; stream?: HookStreamCallbacks },
): Promise<HookResult> {
  // spawnProcess captures stdout/stderr itself and returns them in the result,
  // so we only forward each chunk to the streaming callbacks here.
  const res = await spawnProcess("/bin/sh", ["-c", command], {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    onStdout: (chunk: string) => opts.stream?.onStdoutLine?.(chunk),
    onStderr: (chunk: string) => opts.stream?.onStderrLine?.(chunk),
  });
  return {
    command,
    ok: !res.timedOut && res.exitCode === 0,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    output: `${res.stdout}\n${res.stderr}`.trim(),
  };
}

/**
 * Run the pre or post hooks of a phase sequentially, stopping at the first
 * failure. Callers decide what a failure means: a failed pre hook blocks the
 * phase, a failed post hook is reported as a gate outcome the caller routes
 * (a red implementation gate costs the attempt; the tail phases record it).
 */
export async function runPhaseHooks(
  hooks: HooksConfig,
  phase: PhaseName,
  stage: "pre" | "post",
  cwd: string,
  stream?: HookStreamCallbacks,
): Promise<HookResult[]> {
  const results: HookResult[] = [];
  for (const command of hooks[phase][stage]) {
    const result = await runHook(command, { cwd, timeoutMs: hooks.timeoutMs, stream });
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}
