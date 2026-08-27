/**
 * Runs one loop phase as an ephemeral agent subprocess in JSON streaming
 * mode. The stdout event stream is translated into typed events as it
 * arrives; the run outcome collects exit code, timeout/abort flags and the
 * final stop reason reported by the agent.
 */

import { spawnProcess } from "../util/process.ts";
import { createJsonlParser, type PiStreamEvent } from "./json-stream.ts";
import { agentEndOutcome } from "./stream-format.ts";

export interface PhaseSpawnOptions {
  prompt: string;
  /** Model pattern/id; "auto" (or unset) leaves the choice to the agent CLI. */
  model?: string;
  /** Thinking level flag value; undefined means "agent CLI default". */
  thinkingLevel?: string;
  /** Extra system prompt text appended for this phase. */
  appendSystemPrompt?: string;
  /** System prompt replacing the agent CLI default for this phase. */
  systemPrompt?: string;
  cwd: string;
  /** Hard wall-clock limit for the phase subprocess. */
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Agent CLI binary; defaults to "pi" on PATH. */
  piBin?: string;
  onEvent?: (e: PiStreamEvent) => void;
  onStderrLine?: (line: string) => void;
}

export interface PhaseRunOutcome {
  exitCode: number | null;
  /** Termination signal reported by the OS, when the process died by signal.
   * Optional so older constructors (tests, fixtures) stay valid; absent reads
   * as "no signal", which is what they mean. */
  signal?: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stopReason: string | null;
  errorMessage: string | null;
  elapsedMs: number;
  stderr: string;
  /** Completed assistant messages the stream carried; absent reads as "the
   * caller does not know", which the empty-output check treats as nonzero
   * rather than inventing evidence of silence. */
  assistantMessages?: number;
}

/**
 * Tools withheld from every phase agent. The loop runs its phases as detached
 * subprocesses with nobody watching their stdin: an agent that stops to ask the
 * operator a question blocks until the phase timeout and then dies having done
 * nothing, and the answer it waited for was never coming. Both spellings are
 * listed because the interactive tool appears under either name depending on
 * whether the CLI or an extension registers it; an id the CLI does not know is
 * ignored, so naming both costs nothing.
 */
export const WITHHELD_TOOLS: readonly string[] = ["ask_user_question", "ask_question"];

export async function runAgentPhase(opts: PhaseSpawnOptions): Promise<PhaseRunOutcome> {
  const args = ["--print", "--mode", "json", "--no-session", "--exclude-tools", WITHHELD_TOOLS.join(",")];
  if (opts.model && opts.model !== "auto") args.push("--model", opts.model);
  if (opts.thinkingLevel) args.push("--thinking", opts.thinkingLevel);
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  args.push(opts.prompt);

  let stopReason: string | null = null;
  let errorMessage: string | null = null;
  let assistantMessages = 0;
  const parser = createJsonlParser((event) => {
    const ended = agentEndOutcome(event);
    if (ended) {
      stopReason = ended.stopReason;
      errorMessage = ended.errorMessage;
    }
    // Counted off the parsed stream, not off the formatted log: the two can
    // diverge, and the empty-output classification must not inherit a
    // formatter's blind spots.
    if (event.type === "message_end") {
      const message = (event as { message?: { role?: unknown } }).message;
      if (message?.role === "assistant") assistantMessages++;
    }
    opts.onEvent?.(event);
  });

  // stderr arrives in arbitrary chunks; reassemble lines before forwarding.
  let stderrBuf = "";
  const onStderr = (chunk: string): void => {
    if (!opts.onStderrLine) return;
    stderrBuf += chunk;
    let newline: number;
    while ((newline = stderrBuf.indexOf("\n")) !== -1) {
      opts.onStderrLine(stderrBuf.slice(0, newline));
      stderrBuf = stderrBuf.slice(newline + 1);
    }
  };

  const res = await spawnProcess(opts.piBin ?? "pi", args, {
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onStdout: (chunk) => parser.push(chunk),
    onStderr,
  });
  parser.flush();
  if (stderrBuf.trim().length > 0) opts.onStderrLine?.(stderrBuf);

  return {
    exitCode: res.exitCode,
    signal: res.signal,
    timedOut: res.timedOut,
    aborted: opts.signal?.aborted ?? false,
    stopReason,
    errorMessage,
    elapsedMs: res.elapsedMs,
    stderr: res.stderr,
    assistantMessages,
  };
}
