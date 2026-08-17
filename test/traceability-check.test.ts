import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkTraceabilityMatrix,
  TRACEABILITY_FILE,
  traceabilityWarning,
} from "../src/loop/traceability-check.ts";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

/** Project with a spec folder and the given matrix. */
async function createProject(matrix: string): Promise<{ root: string; specDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "traceability-"));
  tmpDirs.push(root);
  const specDir = path.join(root, "docs/specs/001-spec");
  await mkdir(path.join(root, "test"), { recursive: true });
  await mkdir(specDir, { recursive: true });
  await writeFile(path.join(specDir, TRACEABILITY_FILE), matrix, "utf8");
  await writeFile(path.join(root, "test/delivery.test.ts"), 'test("clean tree: commit skipped", () => {});\n', "utf8");
  return { root, specDir };
}

const HEADER = "| AC ID | Type | Task(s) | Test Files | Status |\n|---|---|---|---|---|\n";

test("a row citing a test file that exists passes the check", async () => {
  const { root, specDir } = await createProject(
    `${HEADER}| AC-001 | [IMP] | TASK-002 | test/delivery.test.ts | Implemented |\n`,
  );

  assert.deepEqual(await checkTraceabilityMatrix(root, specDir), []);
});

test("a row citing a file that is not there is reported", async () => {
  // The failure this exists for: a matrix row claiming an end-to-end scenario
  // that was never written, which nothing re-derived because re-deriving the
  // matrix by hand is exactly what the document is meant to spare.
  const { root, specDir } = await createProject(
    `${HEADER}| AC-009 | [SEF] | — | e2e/delivery.e2e.test.ts | Verified |\n`,
  );

  const findings = await checkTraceabilityMatrix(root, specDir);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "AC-009");
  assert.match(findings[0].problem, /does not exist/);
});

test("a citation naming a test that is not in the file is reported", async () => {
  const { root, specDir } = await createProject(
    `${HEADER}| AC-009 | [SEF] | — | test/delivery.test.ts::dirty tree e2e | Verified |\n`,
  );

  const findings = await checkTraceabilityMatrix(root, specDir);

  assert.equal(findings.length, 1);
  assert.match(findings[0].problem, /is not in that file/);
});

test("a citation naming a test that is in the file passes, spaces and all", async () => {
  const { root, specDir } = await createProject(
    `${HEADER}| AC-009 | [SEF] | — | test/delivery.test.ts::clean tree: commit skipped | Verified |\n`,
  );

  assert.deepEqual(await checkTraceabilityMatrix(root, specDir), []);
});

test("a covered row that names no test at all is reported", async () => {
  const { root, specDir } = await createProject(`${HEADER}| AC-017 | [EXT] | — | — | Verified |\n`);

  const findings = await checkTraceabilityMatrix(root, specDir);

  assert.equal(findings.length, 1);
  assert.match(findings[0].problem, /without naming a test file/);
});

test("rows that claim nothing are left alone", async () => {
  const { root, specDir } = await createProject(
    `${HEADER}| AC-002 | [IMP] | TASK-005 | e2e/never-written.test.ts | Pending |\n`,
  );

  assert.deepEqual(await checkTraceabilityMatrix(root, specDir), []);
});

test("a spec without a matrix yields no findings", async () => {
  const { root, specDir } = await createProject("");
  await rm(path.join(specDir, TRACEABILITY_FILE));

  assert.deepEqual(await checkTraceabilityMatrix(root, specDir), []);
});

test("the warning names the rows and counts the rest", () => {
  const findings = Array.from({ length: 7 }, (_, i) => ({ id: `AC-00${i}`, problem: "cites x, which does not exist" }));

  const warning = traceabilityWarning(findings);

  assert.match(warning ?? "", /AC-000/);
  assert.match(warning ?? "", /\+2 more/);
  assert.equal(traceabilityWarning([]), null);
});
