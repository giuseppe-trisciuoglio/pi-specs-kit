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

const LIST_KEYS: readonly string[] = ["issues", "routed", "spec_conflicts"];

/** Strip the quoting and the trailing inline comment a hand-written value carries. */
function scalar(raw: string): string {
  const trimmed = raw.trim();
  const unquoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  return (unquoted ? unquoted[2] : trimmed).trim();
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
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/.exec(line);
  if (!match) return null;
  return { key: match[1].toLowerCase(), value: match[2] };
}

/**
 * Recover the verdict and the lists the loop reads from a frontmatter block
 * that is not parseable YAML. Returns null when no verdict can be found: an
 * unreadable status is still "no report", which the loop already handles.
 */
export function recoverFrontmatter(block: string): RecoveredFrontmatter | null {
  let status: "PASSED" | "FAILED" | null = null;
  let summary = "";
  const issues: string[] = [];
  const routed: RecoveredEntry[] = [];
  const specConflicts: string[] = [];
  let list: ListKey | null = null;
  let pendingRouted: Partial<RecoveredEntry> | null = null;

  const closeRouted = (): void => {
    if (pendingRouted?.to && pendingRouted.text) {
      routed.push({ to: pendingRouted.to, text: pendingRouted.text });
    }
    pendingRouted = null;
  };

  for (const raw of block.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const indented = /^\s/.test(line);
    const bullet = /^\s*-\s*(.*)$/.exec(line);

    if (bullet) {
      const item = bullet[1];
      if (list === "routed") {
        // A routed entry opens on its bullet and may continue on the lines
        // below it, so the previous one closes here rather than at the key.
        const inner = header(item);
        closeRouted();
        pendingRouted = {};
        if (inner?.key === "to") pendingRouted.to = scalar(inner.value);
        else if (inner?.key === "text") pendingRouted.text = scalar(inner.value);
        continue;
      }
      const value = scalar(item);
      if (value === "") continue;
      if (list === "issues") issues.push(value);
      else if (list === "spec_conflicts") specConflicts.push(value);
      continue;
    }

    const head = header(line);
    if (!head) continue;
    // Inside a routed entry the continuation lines are indented and belong to
    // the entry, not to the document.
    if (list === "routed" && pendingRouted && indented) {
      if (head.key === "to") pendingRouted.to = scalar(head.value);
      else if (head.key === "text") pendingRouted.text = scalar(head.value);
      continue;
    }
    closeRouted();

    if (head.key === "review_status") {
      const value = scalar(head.value).toUpperCase();
      if (value === "PASSED" || value === "FAILED") status = value;
      list = null;
      continue;
    }
    if (head.key === "summary") {
      summary = scalar(head.value);
      list = null;
      continue;
    }
    if (LIST_KEYS.includes(head.key)) {
      const inline = inlineList(head.value);
      if (inline !== null) {
        if (head.key === "issues") issues.push(...inline);
        else if (head.key === "spec_conflicts") specConflicts.push(...inline);
        list = null;
        continue;
      }
      list = head.key as ListKey;
      continue;
    }
    list = null;
  }
  closeRouted();

  if (status === null) return null;
  return { status, summary, issues, routed, specConflicts };
}
