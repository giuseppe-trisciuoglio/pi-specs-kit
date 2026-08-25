/**
 * End-to-end of the issue-triggered run, with a fake `gh` on the PATH: the
 * watcher talks to the real client, so the arguments it builds and the JSON it
 * parses are exercised for real. The loop itself is stubbed — the loop has its
 * own e2e; what is under test here is everything between a labeled issue and
 * the call that starts a run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGhClient } from "../src/github/gh-cli.ts";
import type { IssueRunRequest } from "../src/github/issue-spec.ts";
import { IssueWatcher, type WatcherSettings } from "../src/github/issue-watcher.ts";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN_DIR = path.join(E2E_DIR, "fake-bin");
const SPEC_REL = "docs/specs/e2e-watch";

const SETTINGS: WatcherSettings = {
  labels: { ready: "ready", running: "specs-kit:running", done: "specs-kit:done", failed: "specs-kit:failed" },
  pollIntervalMs: 1000,
  commentOnFinish: true,
  specsDir: "docs/specs",
};

const FAKE_VARS = ["FAKE_GH_ISSUES", "FAKE_GH_LOG"];

async function withFakeGh<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const savedPath = process.env.PATH;
  const saved = new Map(FAKE_VARS.map((k) => [k, process.env[k]]));
  process.env.PATH = `${FAKE_BIN_DIR}${path.delimiter}${savedPath ?? ""}`;
  for (const k of FAKE_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Throwaway project holding one runnable spec, plus the fake gh fixtures. */
async function setup(issues: unknown[]): Promise<{ root: string; issuesFile: string; logFile: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "e2e-watch-"));
  await mkdir(path.join(root, SPEC_REL, "tasks"), { recursive: true });
  await writeFile(
    path.join(root, SPEC_REL, "tasks", "TASK-001.md"),
    "---\nid: TASK-001\ntitle: First\nstatus: pending\ndependencies: []\n---\n\nDo it.\n",
    "utf8",
  );
  const issuesFile = path.join(root, "issues.json");
  await writeFile(issuesFile, JSON.stringify(issues), "utf8");
  return { root, issuesFile, logFile: path.join(root, "gh.log") };
}

test("a labeled issue starts the loop on the spec it names and moves the labels", async () => {
  const { root, issuesFile, logFile } = await setup([
    {
      number: 42,
      title: "Run the e2e spec",
      body: "Please run [the spec](docs/specs/e2e-watch) now.",
      labels: [{ name: "ready" }],
    },
  ]);

  try {
    await withFakeGh({ FAKE_GH_ISSUES: issuesFile, FAKE_GH_LOG: logFile }, async () => {
      const gh = createGhClient(root);
      assert.deepEqual(await gh.probe(), { ok: true });

      const started: IssueRunRequest[] = [];
      let running = false;
      const watcher = new IssueWatcher({
        settings: () => SETTINGS,
        listReady: (label) => gh.listOpenIssuesByLabel(label),
        ensureLabels: (labels) => gh.ensureLabels(labels),
        editLabels: (issue, add, remove) => gh.editLabels(issue, add, remove),
        comment: (issue, body) => gh.comment(issue, body),
        runnableSpecs: async () => [SPEC_REL],
        isRunning: () => running,
        startLoop: async (request) => {
          started.push(request);
          running = true;
        },
        notify: () => {},
        wait: async () => {},
      });

      await watcher.pollOnce();
      assert.deepEqual(started, [{ specDir: SPEC_REL }]);
      assert.equal(watcher.activeIssue, 42);

      running = false;
      await watcher.noteFinished("completed", "[specs-kit] Loop completed on `e2e-watch` — 1/1 tasks.");
      assert.equal(watcher.activeIssue, null);
    });

    const log = await readFile(logFile, "utf8");
    assert.match(log, /issue list --label ready --state open --json number,title,body,labels/);
    assert.match(log, /issue edit 42 --add-label specs-kit:running --remove-label ready/);
    assert.match(log, /issue edit 42 --add-label specs-kit:done --remove-label specs-kit:running/);
    assert.match(log, /issue comment 42 --body \[specs-kit\] Loop completed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an issue naming no spec is left alone", async () => {
  const { root, issuesFile, logFile } = await setup([
    { number: 43, title: "Just a question", body: "How does the loop work?", labels: [{ name: "ready" }] },
  ]);

  try {
    await withFakeGh({ FAKE_GH_ISSUES: issuesFile, FAKE_GH_LOG: logFile }, async () => {
      const gh = createGhClient(root);
      let startCalls = 0;
      const watcher = new IssueWatcher({
        settings: () => SETTINGS,
        listReady: (label) => gh.listOpenIssuesByLabel(label),
        ensureLabels: (labels) => gh.ensureLabels(labels),
        editLabels: (issue, add, remove) => gh.editLabels(issue, add, remove),
        comment: (issue, body) => gh.comment(issue, body),
        runnableSpecs: async () => [SPEC_REL],
        isRunning: () => false,
        startLoop: async () => {
          startCalls += 1;
        },
        notify: () => {},
        wait: async () => {},
      });

      await watcher.pollOnce();
      assert.equal(startCalls, 0);
      assert.equal(watcher.activeIssue, null);
    });

    const log = await readFile(logFile, "utf8");
    assert.doesNotMatch(log, /issue edit/, "the labels of an unusable issue are untouched");
    assert.match(log, /issue comment 43/, "the issue is told why nothing happened");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
