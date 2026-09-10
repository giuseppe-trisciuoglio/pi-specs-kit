/**
 * External text enters the prompt verbatim — a failed hook's output, a
 * previous phase's stderr, a failure detail — and the prompt leaves as one
 * argv entry of the phase subprocess. Node refuses an argument containing a
 * NUL byte, so a build tool that prints raw binary on stdout would kill the
 * whole run instead of costing one attempt. Nothing downstream of the text
 * wants those bytes anyway: they are noise to a model and unprintable to an
 * operator reading a log.
 *
 * Stripped: NUL and the other non-printable C0 controls plus DEL. Kept: the
 * three whitespace controls that carry meaning in captured output — tab,
 * newline and carriage return.
 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Remove the non-printable control characters, keeping \t, \n and \r. */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}
