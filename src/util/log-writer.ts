/**
 * Per-phase log file writer. Streams formatted agent output to
 * <specDir>/_ralph_loop/logs/<taskId>-<phase>-<timestamp>.log so a finished
 * or killed run can be inspected after the fact. The logs directory is
 * created lazily on the first write; when disabled the writer is a no-op but
 * still exposes the would-be path for status display.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { LOOP_STATE_DIR } from "../fixplan/fix-plan.ts";

export interface PhaseLogWriterOptions {
  /** When true nothing is written to disk. */
  noLogFiles?: boolean;
  /** Called once when logging is given up on, with the reason. */
  onFailure?: (message: string) => void;
}

export class PhaseLogWriter {
  readonly #filePath: string;
  readonly #disabled: boolean;
  readonly #onFailure?: (message: string) => void;
  #stream: WriteStream | null = null;
  /** Set after an I/O failure: logging degrades to a no-op for the rest of the phase. */
  #broken = false;

  constructor(specDir: string, taskId: string, phase: string, opts: PhaseLogWriterOptions = {}) {
    // Colons and dots in ISO timestamps are awkward in file names.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.#filePath = join(specDir, LOOP_STATE_DIR, "logs", `${taskId}-${phase}-${timestamp}.log`);
    this.#disabled = opts.noLogFiles === true;
    this.#onFailure = opts.onFailure;
  }

  get path(): string {
    return this.#filePath;
  }

  /**
   * Logging is best effort: a full disk, a spec directory removed mid-run or a
   * permission error must degrade to "no logs", never take down the host. Both
   * the lazy open and the asynchronous stream errors land in #fail, after which
   * the writer stays silent for the rest of the phase.
   */
  writeLine(line: string): void {
    if (this.#disabled || this.#broken) return;
    try {
      if (!this.#stream) {
        mkdirSync(dirname(this.#filePath), { recursive: true });
        const stream = createWriteStream(this.#filePath, { encoding: "utf8" });
        // Without a listener an 'error' event is re-thrown as an uncaught
        // exception by the EventEmitter itself.
        stream.on("error", (err) => this.#fail(err));
        this.#stream = stream;
      }
      this.#stream.write(line + "\n");
    } catch (err) {
      this.#fail(err);
    }
  }

  #fail(err: unknown): void {
    if (this.#broken) return;
    this.#broken = true;
    const stream = this.#stream;
    this.#stream = null;
    stream?.destroy();
    const message = err instanceof Error ? err.message : String(err);
    this.#onFailure?.(`phase log disabled (${this.#filePath}): ${message}`);
  }

  /** Write an already-formatted stream line; null (non-displayable) is skipped. */
  writeStream(formatted: string | null): void {
    if (formatted !== null) this.writeLine(formatted);
  }

  close(): Promise<void> {
    const stream = this.#stream;
    this.#stream = null;
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => {
      // A stream that fails while flushing must still settle the close.
      stream.once("error", () => resolve());
      try {
        stream.end(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}
