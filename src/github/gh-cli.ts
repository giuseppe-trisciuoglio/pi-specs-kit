/**
 * Thin wrapper over the `gh` CLI, the only channel the watcher uses to talk to
 * GitHub. The repository is never configured: `gh` resolves it from the git
 * remote of the working directory, so the same extension serves every project
 * without being told which repo it is in.
 *
 * Every call is a one-shot subprocess with a short timeout. Failures surface as
 * errors carrying the CLI's own message: the watcher decides what is worth a
 * notification and what is worth a retry at the next poll.
 */

import { spawnProcess } from "../util/process.ts";

/** Wall-clock limit for a single gh invocation. */
const GH_TIMEOUT_MS = 30_000;

/** Issues the watcher can act on, reduced to what it reads. */
export interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface GhClient {
  /** Whether gh can be used here at all: installed, authenticated, in a repo. */
  probe(): Promise<{ ok: true } | { ok: false; reason: string }>;
  listOpenIssuesByLabel(label: string): Promise<GhIssue[]>;
  /** Create the labels that do not exist yet; existing ones are left alone. */
  ensureLabels(labels: string[]): Promise<void>;
  editLabels(issue: number, add: string[], remove: string[]): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
}

/** Issues fetched per poll: a label meant as a queue does not grow past this. */
const ISSUE_PAGE_SIZE = 20;

function fail(args: string[], stderr: string, exitCode: number | null): Error {
  const detail = stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit code ${exitCode}`;
  return new Error(`gh ${args[0]} ${args[1] ?? ""}`.trim() + `: ${detail}`);
}

export function createGhClient(cwd: string): GhClient {
  const run = async (args: string[]): Promise<string> => {
    const result = await spawnProcess("gh", args, { cwd, timeoutMs: GH_TIMEOUT_MS });
    if (result.timedOut) throw new Error(`gh ${args[0]}: timed out`);
    if (result.exitCode !== 0) throw fail(args, result.stderr, result.exitCode);
    return result.stdout;
  };

  return {
    async probe() {
      try {
        await run(["auth", "status"]);
      } catch (err) {
        return { ok: false, reason: `GitHub CLI unavailable (${err instanceof Error ? err.message : String(err)})` };
      }
      try {
        await run(["repo", "view", "--json", "nameWithOwner"]);
      } catch {
        return { ok: false, reason: "no GitHub repository resolved from this working directory" };
      }
      return { ok: true };
    },

    async listOpenIssuesByLabel(label) {
      const stdout = await run([
        "issue", "list",
        "--label", label,
        "--state", "open",
        "--json", "number,title,body,labels",
        "--limit", String(ISSUE_PAGE_SIZE),
      ]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout || "[]");
      } catch {
        throw new Error("gh issue list: unreadable JSON output");
      }
      if (!Array.isArray(parsed)) return [];
      const issues: GhIssue[] = [];
      for (const entry of parsed) {
        const item = entry as { number?: unknown; title?: unknown; body?: unknown; labels?: unknown };
        if (typeof item.number !== "number") continue;
        const labels = Array.isArray(item.labels)
          ? item.labels
              .map((l) => (l as { name?: unknown }).name)
              .filter((n): n is string => typeof n === "string")
          : [];
        issues.push({
          number: item.number,
          title: typeof item.title === "string" ? item.title : "",
          body: typeof item.body === "string" ? item.body : "",
          labels,
        });
      }
      // Oldest first: the label is a queue, and the issue that has been waiting
      // longest is the one the operator expects to be picked up next.
      return issues.sort((a, b) => a.number - b.number);
    },

    async ensureLabels(labels) {
      for (const label of labels) {
        // Already-exists is the common case and gh reports it as a failure;
        // there is nothing to repair, so it is swallowed on purpose.
        try {
          await run(["label", "create", label, "--description", "specs-kit loop"]);
        } catch {
          // Existing label, or no permission to create one: either way the
          // watcher keeps working with whatever labels the repo already has.
        }
      }
    },

    async editLabels(issue, add, remove) {
      const args = ["issue", "edit", String(issue)];
      for (const label of add) args.push("--add-label", label);
      for (const label of remove) args.push("--remove-label", label);
      if (args.length === 3) return;
      await run(args);
    },

    async comment(issue, body) {
      await run(["issue", "comment", String(issue), "--body", body]);
    },
  };
}
