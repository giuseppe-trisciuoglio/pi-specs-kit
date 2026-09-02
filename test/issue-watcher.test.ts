import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GhIssue } from "../src/github/gh-cli.ts";
import type { IssueRunRequest } from "../src/github/issue-spec.ts";
import { IssueWatcher, type IssueWatcherDeps, type WatcherSettings } from "../src/github/issue-watcher.ts";

const SETTINGS: WatcherSettings = {
  labels: { ready: "ready", running: "run", done: "done", failed: "failed" },
  pollIntervalMs: 1000,
  commentOnFinish: true,
  specsDir: "docs/specs",
};

interface Harness {
  watcher: IssueWatcher;
  started: IssueRunRequest[];
  labelEdits: { issue: number; add: string[]; remove: string[] }[];
  comments: { issue: number; body: string }[];
  notices: { message: string; type: string }[];
  issues: GhIssue[];
  running: boolean;
  listFailure: string | null;
}

function issue(number: number, body: string): GhIssue {
  return { number, title: `issue ${number}`, body, labels: ["ready"] };
}

function harness(overrides: Partial<IssueWatcherDeps> = {}, specs = ["docs/specs/001-thing"]): Harness {
  const state: Harness = {
    watcher: null as unknown as IssueWatcher,
    started: [],
    labelEdits: [],
    comments: [],
    notices: [],
    issues: [],
    running: false,
    listFailure: null,
  };
  const deps: IssueWatcherDeps = {
    settings: () => SETTINGS,
    listReady: async () => {
      if (state.listFailure) throw new Error(state.listFailure);
      return state.issues;
    },
    ensureLabels: async () => {},
    editLabels: async (issueNumber, add, remove) => {
      state.labelEdits.push({ issue: issueNumber, add, remove });
    },
    comment: async (issueNumber, body) => {
      state.comments.push({ issue: issueNumber, body });
    },
    runnableSpecs: async () => specs,
    isRunning: () => state.running,
    startLoop: async (request) => {
      state.started.push(request);
      state.running = true;
    },
    notify: (message, type) => {
      state.notices.push({ message, type });
    },
    wait: async () => {},
    ...overrides,
  };
  state.watcher = new IssueWatcher(deps);
  return state;
}

describe("IssueWatcher", () => {
  it("starts the loop on the spec the issue names and swaps the labels", async () => {
    const h = harness();
    h.issues = [issue(7, "spec: docs/specs/001-thing")];

    await h.watcher.pollOnce();

    assert.deepEqual(h.started, [{ specDir: "docs/specs/001-thing" }]);
    assert.deepEqual(h.labelEdits, [{ issue: 7, add: ["run"], remove: ["ready"] }]);
    assert.equal(h.watcher.activeIssue, 7);
  });

  it("carries the range and phase the issue asked for", async () => {
    const h = harness();
    h.issues = [issue(8, "spec: docs/specs/001-thing\nfrom-task: T-2\nphase: cleanup")];

    await h.watcher.pollOnce();

    assert.deepEqual(h.started, [
      { specDir: "docs/specs/001-thing", fromTask: "T-2", phase: "cleanup" },
    ]);
  });

  it("starts nothing while a loop is already running", async () => {
    const h = harness();
    h.running = true;
    h.issues = [issue(9, "spec: docs/specs/001-thing")];

    await h.watcher.pollOnce();

    assert.deepEqual(h.started, []);
    assert.deepEqual(h.labelEdits, []);
  });

  it("starts nothing while its own run is in flight", async () => {
    const h = harness();
    h.issues = [issue(10, "spec: docs/specs/001-thing")];
    await h.watcher.pollOnce();
    h.running = false; // the engine went idle without the watcher being told
    h.issues = [issue(11, "spec: docs/specs/001-thing")];

    await h.watcher.pollOnce();

    assert.equal(h.started.length, 1);
  });

  it("skips an issue naming no spec exactly once", async () => {
    const h = harness();
    h.issues = [issue(12, "no reference at all")];

    await h.watcher.pollOnce();
    await h.watcher.pollOnce();

    assert.deepEqual(h.started, []);
    assert.deepEqual(h.labelEdits, [], "the label of an unusable issue is left in place");
    assert.equal(h.comments.length, 1);
    assert.equal(h.notices.filter((n) => n.message.includes("#12")).length, 1);
  });

  it("skips an issue naming a spec without tasks", async () => {
    const h = harness({}, []);
    h.issues = [issue(13, "spec: docs/specs/001-thing")];

    await h.watcher.pollOnce();

    assert.deepEqual(h.started, []);
    assert.match(h.comments[0].body, /not a spec with tasks/);
  });

  it("moves on to the next issue once one is skipped", async () => {
    const h = harness();
    h.issues = [issue(14, "nothing here"), issue(15, "spec: docs/specs/001-thing")];

    await h.watcher.pollOnce();
    await h.watcher.pollOnce();

    assert.deepEqual(h.started, [{ specDir: "docs/specs/001-thing" }]);
    assert.equal(h.watcher.activeIssue, 15);
  });

  it("does not start when the label swap fails", async () => {
    const h = harness({
      editLabels: async () => {
        throw new Error("no write access");
      },
    });
    h.issues = [issue(16, "spec: docs/specs/001-thing")];

    await h.watcher.pollOnce();

    assert.deepEqual(h.started, []);
    assert.equal(h.watcher.activeIssue, null);
  });

  it("reports a broken listing once, not at every poll", async () => {
    const h = harness();
    h.listFailure = "gh issue list: not authenticated";

    await h.watcher.pollOnce();
    await h.watcher.pollOnce();

    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].type, "warning");
  });

  it("labels and comments a completed run", async () => {
    const h = harness();
    h.issues = [issue(17, "spec: docs/specs/001-thing")];
    await h.watcher.pollOnce();

    await h.watcher.noteFinished("completed", "all good");

    assert.deepEqual(h.labelEdits.at(-1), { issue: 17, add: ["done"], remove: ["run"] });
    assert.deepEqual(h.comments, [{ issue: 17, body: "all good" }]);
    assert.equal(h.watcher.activeIssue, null);
  });

  it("labels a halted run as failed", async () => {
    const h = harness();
    h.issues = [issue(18, "spec: docs/specs/001-thing")];
    await h.watcher.pollOnce();

    await h.watcher.noteFinished("aborted", "it broke");

    assert.deepEqual(h.labelEdits.at(-1), { issue: 18, add: ["failed"], remove: ["run"] });
  });

  it("ignores the end of a run it did not start", async () => {
    const h = harness();

    await h.watcher.noteFinished("completed", "not ours");

    assert.deepEqual(h.labelEdits, []);
    assert.deepEqual(h.comments, []);
  });

  it("skips the comment when the project turned it off", async () => {
    const h = harness({
      settings: () => ({ ...SETTINGS, commentOnFinish: false }),
    });
    h.issues = [issue(19, "spec: docs/specs/001-thing")];
    await h.watcher.pollOnce();

    await h.watcher.noteFinished("completed", "quiet");

    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.labelEdits.at(-1), { issue: 19, add: ["done"], remove: ["run"] });
  });

  it("refuses a second watcher on the same session", () => {
    const h = harness();
    assert.equal(h.watcher.start(), true);
    assert.equal(h.watcher.start(), false);
    assert.equal(h.watcher.stop(), true);
    assert.equal(h.watcher.stop(), false);
  });
});
