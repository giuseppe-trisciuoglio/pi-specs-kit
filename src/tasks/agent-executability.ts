/**
 * Agent-executability check of a task file: every acceptance criterion and
 * every Definition of Done item must be satisfiable by an agent working in
 * the repository — by writing a file, running a command or asserting a test.
 * Work only a person can do (an account, a credential, a signature, physical
 * access) has no ticking condition an agent can reach: the implementation
 * cannot satisfy it, the review keeps rejecting it, and the retries spend the
 * task allowance until the whole run stops on a task nobody could have done.
 *
 * The generator is where such a task is kept out of the list; this is the
 * second line, for task files written by hand or by an older generator. It
 * refuses them at load, before a single agent session is spent, and names the
 * line that has to move into the tasks document's operator preconditions.
 *
 * Pure module: markers, scanning and messages only, so tests import it without
 * dragging in the agent CLI.
 */

/** Title tags of the convention this rule retires: a task needing one of them
 * should never have been generated. */
const TITLE_TAGS: readonly string[] = ["[PROCUREMENT]", "[MANUAL]"];

/**
 * Wording that marks an item as work no agent can close. Deliberately short:
 * a marker fires a refusal, so it names what an operator-only item actually
 * says rather than trying to recognise the intent behind every phrasing.
 */
const ITEM_MARKERS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\boperator step\b/i, reason: "names an operator step" },
  { pattern: /\bmanual curl\b/i, reason: "asks for a manual curl" },
  // "human-readable" is a property of an artifact, not a person doing the work.
  { pattern: /\bhumans?\b(?![- ]readable)/i, reason: "requires a human" },
  { pattern: /\bsupervisor\b/i, reason: "escalates to a supervisor" },
];

/** Headings whose items the loop measures the implementation against. */
const SCANNED_SECTIONS = /^#{2,6}\s*(?:acceptance criteria|definition of done)\b/i;

/** Any other heading of the same or a higher level closes the scanned block. */
const HEADING = /^#{1,6}\s/;

/** One line of a task that no agent session can close. */
export interface OperatorOnlyFinding {
  /** 1-based line number inside the task file, 0 for a finding on the title. */
  line: number;
  /** The offending text, trimmed. */
  text: string;
  /** Why the line was refused, in words. */
  reason: string;
}

/** Longest offending line quoted back in the message; the tail is dropped. */
const QUOTE_LIMIT = 160;

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_LIMIT ? `${flat.slice(0, QUOTE_LIMIT)}…` : flat;
}

/**
 * Work in this task that only a person can perform. The title is checked for
 * the retired tags, and the acceptance criteria and Definition of Done — the
 * two lists the implementation and the review are measured against — for the
 * operator markers. Everything else in the body is prose: a note about an
 * operator is not a ticking condition, so it is left alone.
 */
export function operatorOnlyFindings(title: string, body: string): OperatorOnlyFinding[] {
  const findings: OperatorOnlyFinding[] = [];
  for (const tag of TITLE_TAGS) {
    if (title.toUpperCase().includes(tag)) {
      findings.push({ line: 0, text: quote(title), reason: `carries the ${tag} tag` });
    }
  }

  let scanning = false;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (HEADING.test(line)) {
      scanning = SCANNED_SECTIONS.test(line);
      continue;
    }
    if (!scanning || line.trim() === "") continue;
    for (const marker of ITEM_MARKERS) {
      if (marker.pattern.test(line)) {
        findings.push({ line: i + 1, text: quote(line), reason: marker.reason });
        break;
      }
    }
  }
  return findings;
}

/**
 * Operator-facing refusal for a task that carries work no agent can close.
 * It names every offending line and says where the need belongs instead, so
 * the fix is one edit of the tasks document rather than a guess.
 */
export function operatorOnlyMessage(file: string, findings: readonly OperatorOnlyFinding[]): string {
  const lines = [
    `${file}: this task cannot be completed by an agent and would spend its whole ` +
      "attempt allowance without ever passing review:",
  ];
  for (const finding of findings) {
    const where = finding.line === 0 ? "title" : `line ${finding.line}`;
    lines.push(`  - ${where} ${finding.reason}: ${finding.text}`);
  }
  lines.push(
    "  Move what only a person can do into the \"## Preconditions (operator)\" section of the " +
      "tasks document, and keep here only what an agent can do by writing a file, running a " +
      "command or asserting a test.",
  );
  return lines.join("\n");
}
