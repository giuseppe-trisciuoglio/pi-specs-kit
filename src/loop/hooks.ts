import { stripControlChars } from "../util/control-chars.ts";
import { spawnProcess } from "../util/process.ts";
import type { HooksConfig, HookTarget } from "../config/specs-kit-config.ts";
import { openHookEnv } from "./hook-env.ts";

export interface HookResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Combined stdout+stderr, trimmed and stripped of control characters. */
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
  opts: { cwd: string; timeoutMs: number; stream?: HookStreamCallbacks; env?: Record<string, string> },
): Promise<HookResult> {
  // spawnProcess captures stdout/stderr itself and returns them in the result,
  // so we only forward each chunk to the streaming callbacks here.
  const res = await spawnProcess("/bin/sh", ["-c", command], {
    cwd: opts.cwd,
    // Added to the inherited environment, never substituted for it: a hook is
    // a project command and needs the PATH the loop itself was started with.
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    timeoutMs: opts.timeoutMs,
    onStdout: (chunk: string) => opts.stream?.onStdoutLine?.(chunk),
    onStderr: (chunk: string) => opts.stream?.onStderrLine?.(chunk),
  });
  return {
    command,
    ok: !res.timedOut && res.exitCode === 0,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    // Sanitized here, at the one place the output is composed, so every
    // consumer gets text that can travel in an argv: a red gate feeds the next
    // attempt's prompt, and a NUL from a tool printing binary would otherwise
    // make the spawn of that attempt impossible.
    output: stripControlChars(`${res.stdout}\n${res.stderr}`).trim(),
  };
}

/**
 * The files the attempt stands on, read only when there is a hook to tell.
 * A provider rather than a list because reading it costs a handful of git
 * calls: a target with no commands must not pay for them.
 */
export type ChangedFilesProvider = () => Promise<readonly string[] | null>;

/**
 * Run the pre or post hooks of a target sequentially, stopping at the first
 * failure. Callers decide what a failure means: a failed pre hook blocks the
 * phase, a failed post hook is reported as a gate outcome the caller routes
 * (a red implementation gate costs the attempt; the tail phases record it).
 */
export async function runPhaseHooks(
  hooks: HooksConfig,
  target: HookTarget,
  stage: "pre" | "post",
  cwd: string,
  stream?: HookStreamCallbacks,
  changedFiles?: ChangedFilesProvider,
): Promise<HookResult[]> {
  const commands = hooks[target][stage];
  if (commands.length === 0) return [];
  // Read once per stage, not once per command: the commands of one stage run
  // back to back and see the same tree.
  const env = await openHookEnv(changedFiles ? await changedFiles() : null);
  try {
    const results: HookResult[] = [];
    for (const command of commands) {
      const result = await runHook(command, { cwd, timeoutMs: hooks.timeoutMs, stream, env: env.vars });
      results.push(result);
      if (!result.ok) break;
    }
    return results;
  } finally {
    await env.release();
  }
}
