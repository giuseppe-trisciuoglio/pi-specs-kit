/**
 * Task file model: a markdown file with YAML frontmatter living in the
 * `tasks/` directory of a spec. The markdown body is passed through to the
 * prompt builder unchanged.
 */

import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Recognized task statuses. The loop writes `reviewed` as the canonical
 * terminal value, but a cleanup hook may also stamp `completed`: admitting
 * both keeps the parser (and therefore the fix-plan refresh) from rejecting
 * a task file the loop itself produced.
 */
export type TaskStatus = "pending" | "implemented" | "reviewed" | "completed";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "implemented",
  "reviewed",
  "completed",
];

/** A status the task will not move out of without a new task run. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["reviewed", "completed"];

export interface TaskFrontmatter {
  /** Mandatory, format TASK-NNN. */
  id: string;
  /** Mandatory. */
  title: string;
  spec?: string;
  lang?: string;
  status: TaskStatus;
  dependencies: string[];
  /** Pass-through traceability fields. */
  acMapping: string[];
  impRequirements: string[];
  implementedDate?: string;
  reviewedDate?: string;
  /** Public API contracts this task provides for downstream tasks. */
  provides: string[];
}

export interface TaskFile {
  /** Absolute path of the task file. */
  path: string;
  /** Numeric suffix of the id, used only to order tasks within a spec. */
  num: number;
  frontmatter: TaskFrontmatter;
  /** Markdown body after the frontmatter, unparsed. */
  body: string;
}

/** Error thrown for invalid task files; carries file and field for reporting. */
export class TaskParseError extends Error {
  public readonly file: string;
  public readonly field: string;

  constructor(file: string, field: string, message: string) {
    super(`${file}: field "${field}": ${message}`);
    this.name = "TaskParseError";
    this.file = file;
    this.field = field;
  }
}

/** Extract the numeric part of a task id; null when the id is malformed. */
export function taskIdNumber(id: string): number | null {
  const match = /^TASK-(\d+)$/.exec(id.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Render a frontmatter value without leaking '[object Object]' into messages. */
function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Coerce a frontmatter value to a string array: scalar -> [scalar], missing -> []. */
function toStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(describe);
  return [describe(value)];
}

/** Normalize a date-ish frontmatter value to an ISO yyyy-mm-dd string. */
function toDateString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return describe(value);
}

/**
 * Split a task file into its raw frontmatter map (unmodeled keys included)
 * and its markdown body. This is the lossless view of the file; the typed
 * view is parseTaskFile.
 */
function splitTaskFile(path: string, content: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) throw new TaskParseError(path, "frontmatter", "--- delimiters not found");

  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch (err) {
    throw new TaskParseError(path, "frontmatter", `invalid YAML: ${(err as Error).message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new TaskParseError(path, "frontmatter", "must be a YAML map");
  }
  // Drop a single blank line separating the closing delimiter from the body.
  const body = match[2].replace(/^\r?\n/, "");
  return { data: data as Record<string, unknown>, body };
}

/**
 * Parse a task file: YAML frontmatter between `---` delimiters plus the
 * markdown body that follows. Unknown fields are ignored; missing optional
 * fields get sensible defaults. Throws TaskParseError on invalid mandatory
 * fields, carrying file and field for reporting.
 */
export function parseTaskFile(path: string, content: string): TaskFile {
  const { data: fm, body } = splitTaskFile(path, content);

  if (typeof fm.id !== "string" || taskIdNumber(fm.id) === null) {
    throw new TaskParseError(path, "id", "required, format TASK-NNN");
  }
  if (typeof fm.title !== "string" || fm.title.trim() === "") {
    throw new TaskParseError(path, "title", "required");
  }
  const status = fm.status ?? "pending";
  if (typeof status !== "string" || !TASK_STATUSES.includes(status as TaskStatus)) {
    throw new TaskParseError(path, "status", `invalid value: ${describe(status)}`);
  }
  // Treat the cleanup hook's terminal stamp as equivalent to the canonical
  // reviewed one so downstream comparisons do not need to know about both.
  const normalized: TaskStatus = status === "completed" ? "reviewed" : (status as TaskStatus);

  const frontmatter: TaskFrontmatter = {
    id: fm.id.trim(),
    title: fm.title,
    status: normalized,
    dependencies: toStringArray(fm.dependencies),
    acMapping: toStringArray(fm["ac-mapping"]),
    impRequirements: toStringArray(fm["imp-requirements"]),
    provides: toStringArray(fm.provides),
  };
  if (typeof fm.spec === "string") frontmatter.spec = fm.spec;
  if (typeof fm.lang === "string") frontmatter.lang = fm.lang;
  const implementedDate = toDateString(fm.implemented_date);
  if (implementedDate !== undefined) frontmatter.implementedDate = implementedDate;
  const reviewedDate = toDateString(fm.reviewed_date);
  if (reviewedDate !== undefined) frontmatter.reviewedDate = reviewedDate;

  return { path, num: taskIdNumber(frontmatter.id) as number, frontmatter, body };
}

/** Regenerate the on-disk text of a task file (frontmatter snake_case + body). */
export function serializeTaskFile(task: TaskFile): string {
  const fm = task.frontmatter;
  const doc: Record<string, unknown> = { id: fm.id, title: fm.title };
  if (fm.spec !== undefined) doc.spec = fm.spec;
  if (fm.lang !== undefined) doc.lang = fm.lang;
  doc.status = fm.status;
  doc.dependencies = fm.dependencies;
  doc["ac-mapping"] = fm.acMapping;
  doc["imp-requirements"] = fm.impRequirements;
  doc.provides = fm.provides;
  if (fm.implementedDate !== undefined) doc.implemented_date = fm.implementedDate;
  if (fm.reviewedDate !== undefined) doc.reviewed_date = fm.reviewedDate;
  return `---\n${stringifyYaml(doc)}---\n\n${task.body}`;
}

/**
 * Update the status (and optionally the phase dates) of a task file in place.
 * Only the touched keys are rewritten: unmodeled frontmatter keys and the
 * markdown body survive the rewrite unchanged.
 */
export async function updateTaskStatus(
  path: string,
  status: TaskStatus,
  dates: { implementedDate?: string; reviewedDate?: string } = {},
): Promise<void> {
  const { data, body } = splitTaskFile(path, await readFile(path, "utf8"));
  data.status = status;
  if (dates.implementedDate !== undefined) data.implemented_date = dates.implementedDate;
  if (dates.reviewedDate !== undefined) data.reviewed_date = dates.reviewedDate;
  await writeFile(path, `---\n${stringifyYaml(data)}---\n\n${body}`, "utf8");
}
