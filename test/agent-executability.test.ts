import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { operatorOnlyFindings, operatorOnlyMessage } from "../src/tasks/agent-executability.ts";
import { loadTasks } from "../src/tasks/task-loader.ts";

const BODY = `# TASK-005

**Functional Description**: procure the provider.

## Acceptance Criteria

- [ ] The credential exists in the vault and a manual curl against /v1/messages returns 200.
- [ ] An ADR records the chosen provider.

## Definition of Ready (DoR)

- [ ] The operator step of provisioning the account is done.

## Definition of Done (DoD)

- [ ] A human has signed the provider contract.
`;

test("operatorOnlyFindings names the criteria no agent can close", () => {
  const findings = operatorOnlyFindings("Procure a provider", BODY);
  assert.deepEqual(
    findings.map((f) => f.reason),
    ["asks for a manual curl", "requires a human"],
  );
  // The DoR is not what the implementation is measured against: a
  // precondition named there is exactly where such work belongs.
  assert.ok(findings.every((f) => !f.text.includes("provisioning the account")));
});

test("operatorOnlyFindings flags the retired title tags", () => {
  const findings = operatorOnlyFindings("Procure a provider [PROCUREMENT]", "");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 0);
  assert.match(findings[0].reason, /\[PROCUREMENT\]/);
  assert.equal(operatorOnlyFindings("Wire the client [MANUAL]", "").length, 1);
});

test("operatorOnlyFindings leaves an agent-executable task alone", () => {
  const body = `## Acceptance Criteria

- [ ] The report is human-readable and the snapshot test covers it.

## Definition of Done (DoD)

- [ ] Tests pass.
`;
  assert.deepEqual(operatorOnlyFindings("Render the report", body), []);
});

test("operatorOnlyMessage names every line and where the work belongs", () => {
  const message = operatorOnlyMessage("/x/TASK-005.md", operatorOnlyFindings("Procure", BODY));
  assert.match(message, /\/x\/TASK-005\.md/);
  assert.match(message, /line \d+ asks for a manual curl/);
  assert.match(message, /Preconditions \(operator\)/);
});

test("loadTasks refuses a task only an operator could complete", async () => {
  const specDir = await mkdtemp(path.join(tmpdir(), "exec-"));
  try {
    const dir = path.join(specDir, "tasks");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "TASK-001.md"),
      `---\nid: TASK-001\ntitle: Ordinary work\n---\n\n## Acceptance Criteria\n\n- [ ] The parser rejects an empty id.\n`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "TASK-005.md"),
      `---\nid: TASK-005\ntitle: Procure a provider\n---\n\n${BODY}`,
      "utf8",
    );
    await assert.rejects(
      () => loadTasks(specDir),
      (err: Error) => {
        assert.match(err.message, /TASK-005\.md/);
        assert.match(err.message, /manual curl/);
        assert.doesNotMatch(err.message, /TASK-001\.md/);
        return true;
      },
    );
  } finally {
    await rm(specDir, { recursive: true, force: true });
  }
});
