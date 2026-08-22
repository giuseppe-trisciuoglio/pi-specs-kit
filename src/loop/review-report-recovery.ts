/**
 * Salvage of a review verdict whose frontmatter is not valid YAML.
 *
 * Reviewers write the block by hand, and the values they fill it with are
 * prose: a summary or a routed fix that mentions a path, a ratio or any other
 * text containing a colon followed by a space makes the whole document fail to
 * parse. The verdict itself is always on its own line and readable, so throwing
 * the report away for a quoting slip costs a full re-spawn of the phase to
 * recover a value that was right there. This module reads the block one line at
 * a time instead, with no YAML involved: a shape the loop understands is worth
 * more than a shape the loop can validate.
 *
 * Deliberately conservative — it recognises the four keys the loop consumes and
 * ignores everything else, so a report that also happens to be valid YAML is
 * never routed through here.
 */

export interface RecoveredEntry {
  to: string;
  text: string;
}

export interface RecoveredFrontmatter {
  status: "PASSED" | "FAILED";
  summary: string;
  issues: string[];
  routed: RecoveredEntry[];
  specConflicts: string[];
}

/** Keys whose value is a list of lines rather than a scalar. */
type ListKey = "issues" | "routed" | "spec_conflicts";

const LIST_KEYS: ReadonlySet<string> = new Set<ListKey>(["issues", "routed", "spec_conflicts"]);

/** Strip the quoting and the trailing inline comment a hand-written value carries. */
function scalar(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** An inline `[]` or `[a, b]` list, or null when the value is not one. */
function inlineList(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((part) => scalar(part))
    .filter((part) => part !== "");
}

/**
 * Read a `key: value` header off a line, when the key is one the loop consumes.
 * The value keeps every colon after the first: only the key is delimited.
 */
function header(line: string): { key: string; value: string } | null {
  // Indentation is read by the caller, not here: a routed entry continues on
  // indented lines that carry the same `key: value` shape.
  const match = /^\s*([A-Za-z_]\w*)\s*:(.*)$/.exec(line);
  if (!match) return null;
  return { key: match[1].toLowerCase(), value: match[2] };
}

/** Where the recovered values accumulate while the block is scanned. */
interface Scan {
  status: "PASSED" | "FAILED" | null;
  summary: string;
  issues: string[];
  routed: RecoveredEntry[];
  specConflicts: string[];
  /** The list section currently being filled, when any. */
  list: ListKey | null;
  /** The routed entry currently open, when inside one. */
  entry: Partial<RecoveredEntry> | null;
}

/** Close the open routed entry: a half-filled one (only a target, no text)
 * is dropped rather than guessed at. */
function closeEntry(scan: Scan): void {
  const entry = scan.entry;
  if (entry?.to && entry.text) scan.routed.push({ to: entry.to, text: entry.text });
  scan.entry = null;
}

/** Fill the open routed entry with one of its two fields; other keys are
 * ignored so prose the reviewer added does not become data. */
function readEntryField(scan: Scan, key: string | undefined, value: string | undefined): void {
  const entry = scan.entry;
  if (!entry || key === undefined || value === undefined) return;
  if (key === "to") entry.to = scalar(value);
  else if (key === "text") entry.text = scalar(value);
}

function addToList(scan: Scan, key: string, value: string): void {
  if (key === "issues") scan.issues.push(value);
  else if (key === "spec_conflicts") scan.specConflicts.push(value);
}

/** Apply one `- ` bullet line to the active list section. */
function applyBullet(scan: Scan, item: string): void {
  if (scan.list === null) return;
  if (scan.list === "routed") {
    // A routed entry opens on its bullet and may continue on the lines below
    // it, so the previous one closes here rather than at the next key.
    closeEntry(scan);
    scan.entry = {};
    const inner = header(item);
    readEntryField(scan, inner?.key, inner?.value);
    return;
  }
  const value = scalar(item);
  if (value !== "") addToList(scan, scan.list, value);
}

/** Apply one `key: value` line to the scan, switching sections when the key
 * is one the loop consumes. */
function applyHeader(scan: Scan, head: { key: string; value: string }, indented: boolean): void {
  // Inside a routed entry the continuation lines are indented and belong to
  // the entry, not to the document.
  if (scan.list === "routed" && scan.entry && indented) {
    readEntryField(scan, head.key, head.value);
    return;
  }
  closeEntry(scan);

  if (head.key === "review_status") {
    const value = scalar(head.value).toUpperCase();
    if (value === "PASSED" || value === "FAILED") scan.status = value;
    scan.list = null;
    return;
  }
  if (head.key === "summary") {
    scan.summary = scalar(head.value);
    scan.list = null;
    return;
  }
  if (!LIST_KEYS.has(head.key)) {
    scan.list = null;
    return;
  }
  const inline = inlineList(head.value);
  if (inline !== null) {
    for (const value of inline) addToList(scan, head.key, value);
    scan.list = null;
    return;
  }
  scan.list = head.key as ListKey;
}

/**
 * Recover the verdict and the lists the loop reads from a frontmatter block
 * that is not parseable YAML. Returns null when no verdict can be found: an
 * unreadable status is still "no report", which the loop already handles.
 */
export function recoverFrontmatter(block: string): RecoveredFrontmatter | null {
  const scan: Scan = {
    status: null,
    summary: "",
    issues: [],
    routed: [],
    specConflicts: [],
    list: null,
    entry: null,
  };

  for (const raw of block.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const bullet = /^\s*-\s*(.*)$/.exec(line);
    if (bullet) {
      applyBullet(scan, bullet[1]);
      continue;
    }
    const head = header(line);
    if (!head) continue;
    applyHeader(scan, head, /^\s/.test(line));
  }
  closeEntry(scan);

  if (scan.status === null) return null;
  return {
    status: scan.status,
    summary: scan.summary,
    issues: scan.issues,
    routed: scan.routed,
    specConflicts: scan.specConflicts,
  };
}
