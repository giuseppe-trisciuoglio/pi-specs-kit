/**
 * Verification of the coverage matrix a spec closes with.
 *
 * The matrix is written by agents and read by humans as if it were evidence:
 * each row claims a criterion is implemented or verified and names the test
 * files that prove it. Nothing checked those names, so a row could cite a
 * scenario that was never written and the claim survived every later reading —
 * the whole point of the document is that nobody re-derives it by hand.
 *
 * This check re-derives the cheap half programmatically: the cited files must
 * exist, and a citation naming a specific test (`file::name`) must find that
 * name inside it. It runs no test and judges no wording — it only refuses to
 * let a row claim coverage from a file that is not there. Best-effort: an
 * absent or unreadable matrix yields no findings.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/** File name of the matrix inside a spec folder. */
export const TRACEABILITY_FILE = "traceability-matrix.md";

/** Statuses that claim the row is covered; anything else claims nothing. */
const COVERED = /\b(implemented|verified|covered|done)\b/i;

/** Identifier shape of a row: the criterion the row is about. */
const ROW_ID = /^[A-Z]{2,6}-\d{1,4}$/;

/**
 * A cited source file, with the optional test name after `::`. Extensions are
 * deliberately open-ended: the loop drives projects in several languages and
 * has no business deciding what a test file looks like.
 */
const CITATION = /(?:^|[\s(`|])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]\w{0,4})(::[^|;`]+)?/g;

export interface TraceabilityFinding {
  /** Row identifier, as written in the matrix. */
  id: string;
  /** What is wrong with the row, in operator-facing words. */
  problem: string;
}

/** One row of the matrix, reduced to what the check needs. */
interface MatrixRow {
  id: string;
  covered: boolean;
  citations: { file: string; test: string | null }[];
}

function parseRow(line: string): MatrixRow | null {
  if (!line.trimStart().startsWith("|")) return null;
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length < 2) return null;
  const id = cells[0].replace(/[`*]/g, "").trim();
  if (!ROW_ID.test(id)) return null;
  const citations: MatrixRow["citations"] = [];
  // Cell by cell: the boundary between them is what ends a test name, so
  // joining them first would let one swallow the status column next to it.
  for (const match of cells.slice(1).join("|").matchAll(CITATION)) {
    // A test name is written as it reads in the source, spaces and all, so it
    // runs to the end of the cell rather than to the first space.
    const test = match[2] ? match[2].slice(2).trim() : "";
    citations.push({ file: match[1], test: test === "" ? null : test });
  }
  return { id, covered: cells.some((cell) => COVERED.test(cell)), citations };
}

/** Every row of every table in the document that carries an identifier. */
export function parseTraceabilityRows(content: string): { id: string; covered: boolean; citations: number }[] {
  const rows: { id: string; covered: boolean; citations: number }[] = [];
  for (const line of content.split("\n")) {
    const row = parseRow(line);
    if (row) rows.push({ id: row.id, covered: row.covered, citations: row.citations.length });
  }
  return rows;
}

/**
 * Check the coverage claims of a spec's matrix against the files they cite.
 * `readSource` is injected so the check is testable without a fixture tree.
 */
export async function checkTraceabilityMatrix(
  projectRoot: string,
  specDir: string,
  readSource: (file: string) => Promise<string> = (file) => readFile(file, "utf8"),
): Promise<TraceabilityFinding[]> {
  let content: string;
  try {
    content = await readFile(path.join(specDir, TRACEABILITY_FILE), "utf8");
  } catch {
    return [];
  }

  const findings: TraceabilityFinding[] = [];
  const cache = new Map<string, string | null>();
  const source = async (file: string): Promise<string | null> => {
    if (!cache.has(file)) {
      try {
        cache.set(file, await readSource(path.resolve(projectRoot, file)));
      } catch {
        cache.set(file, null);
      }
    }
    return cache.get(file) ?? null;
  };

  for (const line of content.split("\n")) {
    const row = parseRow(line);
    if (!row || !row.covered) continue;
    if (row.citations.length === 0) {
      findings.push({ id: row.id, problem: "claims coverage without naming a test file" });
      continue;
    }
    for (const citation of row.citations) {
      const text = await source(citation.file);
      if (text === null) {
        findings.push({ id: row.id, problem: `cites ${citation.file}, which does not exist` });
        continue;
      }
      if (citation.test && !text.includes(citation.test)) {
        findings.push({ id: row.id, problem: `cites ${citation.file}::${citation.test}, which is not in that file` });
      }
    }
  }
  return findings;
}

/** The findings as one operator-facing warning, or null when there are none. */
export function traceabilityWarning(findings: readonly TraceabilityFinding[]): string | null {
  if (findings.length === 0) return null;
  const shown = findings.slice(0, 5).map((f) => `${f.id} ${f.problem}`);
  const rest = findings.length > shown.length ? ` (+${findings.length - shown.length} more)` : "";
  return `coverage matrix claims verification the files do not back: ${shown.join("; ")}${rest}`;
}
