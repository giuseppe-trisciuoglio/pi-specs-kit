import { spawn } from "node:child_process";

/**
 * Grace window between a soft (SIGTERM) and a hard (SIGKILL) termination of a
 * spawned process tree, in milliseconds. Gives the subprocess a chance to flush
 * output and exit cleanly before we force-kill the whole group.
 */
const TERMINATE_GRACE_MS = 2000;

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Abort the run early: the whole process tree is terminated when the signal fires. */
  signal?: AbortSignal;
  /** Hard wall-clock limit. On expiry the tree gets SIGTERM then SIGKILL. */
  timeoutMs?: number;
  /** Streaming callback for each stdout chunk (utf8). */
  onStdout?: (chunk: string) => void;
  /** Streaming callback for each stderr chunk (utf8). */
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/**
 * Format a duration in milliseconds as a compact, human-readable string.
 * Examples: 0ms, 456ms, 1.2s, 23s, 4m 05s, 1h 30m.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (totalMinutes < 60) {
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Send a signal to an entire process group (negative pid). The caller must have
 * spawned the child with `detached: true` so its pid is also its group id.
 * Returns false (no throw) when the group is already gone.
 */
export function killProcessTree(pgid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
  // A failed spawn leaves no pid: there is nothing to signal, and passing the
  // resulting NaN to process.kill would throw from inside an event listener.
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw err;
  }
}

/**
 * Spawn a command as the leader of its own process group and run it to
 * completion, capturing stdout/stderr and enforcing timeout/abort. The group
 * semantics let us tear the whole tree down reliably on stop or timeout.
 */
export function spawnProcess(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    // Undefined when the spawn itself failed (missing binary, EACCES): the
    // 'error' event settles the promise and every kill below becomes a no-op.
    const pgid = child.pid;
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let timedOut = false;
    let settled = false;

    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (extra?: Partial<RunResult>): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
        ...extra,
      });
    };

    // SIGTERM the group, then escalate to SIGKILL, then guarantee resolution
    // even if the 'close' event is slow to fire.
    const terminate = (): void => {
      if (pgid === undefined) {
        finish();
        return;
      }
      killProcessTree(pgid, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessTree(pgid, "SIGKILL");
        setTimeout(() => finish(), TERMINATE_GRACE_MS);
      }, TERMINATE_GRACE_MS);
    };

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        options.onStdout?.(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        options.onStderr?.(chunk);
      });
    }

    child.on("exit", (code, sig) => {
      exitCode = code;
      signal = sig;
    });
    child.on("close", () => finish());
    child.on("error", (err) => {
      finish({
        stderr: stderr + (stderr ? "\n" : "") + err.message,
        exitCode: null,
        signal: null,
      });
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
    }

    if (options.signal) {
      if (options.signal.aborted) {
        terminate();
      } else {
        options.signal.addEventListener("abort", () => terminate(), { once: true });
      }
    }
  });
}
