import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveIssueRequest } from "../src/github/issue-spec.ts";

const SPECS = "docs/specs";

describe("resolveIssueRequest", () => {
  it("reads an explicit spec line", () => {
    const result = resolveIssueRequest("Please run this.\nspec: docs/specs/001-auto-pr\n", SPECS);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.request.specDir, "docs/specs/001-auto-pr");
  });

  it("accepts the decoration an issue body carries", () => {
    const body = "- **Spec**: `docs/specs/002-sync`.\n";
    const result = resolveIssueRequest(body, SPECS);
    assert.equal(result.ok && result.request.specDir, "docs/specs/002-sync");
  });

  it("falls back to a bare path anywhere in the body", () => {
    const body = "The work is described in docs/specs/003-thing/tasks/T-01.md, have a look.";
    const result = resolveIssueRequest(body, SPECS);
    assert.equal(result.ok && result.request.specDir, "docs/specs/003-thing");
  });

  it("falls back to a markdown link", () => {
    const body = "See [the spec](docs/specs/004-linked/2026-01-01--thing.md).";
    const result = resolveIssueRequest(body, SPECS);
    assert.equal(result.ok && result.request.specDir, "docs/specs/004-linked");
  });

  it("falls back to a GitHub blob URL", () => {
    const body = "https://github.com/acme/proj/blob/main/docs/specs/005-remote/data-model.md";
    const result = resolveIssueRequest(body, SPECS);
    assert.equal(result.ok && result.request.specDir, "docs/specs/005-remote");
  });

  it("skips documents of the specs root and keeps scanning", () => {
    const body = "Constraints in docs/specs/architecture.md apply; run docs/specs/006-real.";
    const result = resolveIssueRequest(body, SPECS);
    assert.equal(result.ok && result.request.specDir, "docs/specs/006-real");
  });

  it("lets the explicit line win over an earlier mention", () => {
    const body = "Related to docs/specs/001-other.\n\nspec: docs/specs/007-wanted\n";
    const result = resolveIssueRequest(body, SPECS);
    assert.equal(result.ok && result.request.specDir, "docs/specs/007-wanted");
  });

  it("honours a non-default specs root", () => {
    const body = "spec: spec/kit/010-elsewhere";
    const result = resolveIssueRequest(body, "spec/kit");
    assert.equal(result.ok && result.request.specDir, "spec/kit/010-elsewhere");
  });

  it("ignores a path under a different root", () => {
    const result = resolveIssueRequest("look at other/specs/001-nope", SPECS);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no-spec-reference");
  });

  it("reads the task range and the phase overrides", () => {
    const body = ["spec: docs/specs/008-range", "from-task: T-003", "to_task: T-007", "phase: review"].join("\n");
    const result = resolveIssueRequest(body, SPECS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.request.fromTask, "T-003");
    assert.equal(result.request.toTask, "T-007");
    assert.equal(result.request.phase, "review");
  });

  it("leaves the range unset when the body does not ask for one", () => {
    const result = resolveIssueRequest("spec: docs/specs/009-plain", SPECS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.request.fromTask, undefined);
    assert.equal(result.request.toTask, undefined);
    assert.equal(result.request.phase, undefined);
  });

  it("refuses an unknown phase instead of starting on the default one", () => {
    const result = resolveIssueRequest("spec: docs/specs/010-bad\nphase: deploy", SPECS);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "invalid-phase");
  });

  it("reports an empty body as a missing reference", () => {
    const result = resolveIssueRequest("", SPECS);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no-spec-reference");
  });

  it("reports a spec line that names no directory", () => {
    const result = resolveIssueRequest("spec: to be decided", SPECS);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no-spec-reference");
  });
});
