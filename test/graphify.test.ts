import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findGraphifySkill,
  graphifyGraphExists,
  graphifyGraphMissingWarning,
  graphifyGraphPath,
  graphifyMissingWarning,
  GRAPHIFY_GRAPH_REL,
  GRAPHIFY_SKILL_NAME,
} from "../src/prompt/graphify.ts";

test("findGraphifySkill resolves graphify from the shared ~/.agents/skills location", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "graphify-home-"));
  try {
    // The shared install location mirrors what a real graphify install puts
    // on disk, so resolving through homeDir alone exercises the production
    // lookup path rather than a test-only extra directory.
    const dir = path.join(home, ".agents", "skills", GRAPHIFY_SKILL_NAME);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "# graphify\n", "utf8");

    const skill = await findGraphifySkill({ homeDir: home });
    assert.ok(skill, "expected graphify to be found under ~/.agents/skills");
    assert.equal(skill!.name, GRAPHIFY_SKILL_NAME);
    assert.equal(skill!.dir, dir);
    assert.match(skill!.content, /graphify/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("findGraphifySkill resolves graphify from an extra directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "graphify-home-"));
  const skillsDir = await mkdtemp(path.join(tmpdir(), "graphify-extra-"));
  try {
    // resolveSkill treats each extra dir as a complete skill directory (it
    // appends SKILL.md, not the skill name), so the graphify folder is passed
    // directly rather than its parent.
    const dir = path.join(skillsDir, GRAPHIFY_SKILL_NAME);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "# graphify\n", "utf8");

    const skill = await findGraphifySkill({ homeDir: home, extraDirs: [dir] });
    assert.ok(skill, "expected graphify to be found in the extra directory");
    assert.equal(skill!.dir, dir);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(skillsDir, { recursive: true, force: true });
  }
});

test("findGraphifySkill returns null when graphify is not installed", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "graphify-home-"));
  try {
    const skill = await findGraphifySkill({ homeDir: home });
    assert.equal(skill, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("graphifyMissingWarning is self-identifying and points to the install locations", () => {
  const message = graphifyMissingWarning();
  assert.match(message, /\[specs-kit\]/, "carries the extension prefix");
  assert.match(message, /graphify/);
  assert.match(message, /Knowledge Graph/, "names what becomes unavailable");
  assert.match(message, /sync/, "names the phase that needs it");
  assert.match(message, /\.agents\/skills\/graphify/);
  assert.match(message, /\.pi\/agent\/skills\/graphify/);
});

test("graphifyGraphPath points at the graph file under the project root", () => {
  assert.equal(graphifyGraphPath("/proj"), path.join("/proj", GRAPHIFY_GRAPH_REL));
  assert.match(graphifyGraphPath("/proj"), /graphify-out\/graph\.json$/);
});

test("graphifyGraphExists is true only when the graph file is on disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "graph-exists-"));
  try {
    assert.equal(await graphifyGraphExists(root), false, "absent before graphify runs");
    await mkdir(path.join(root, "graphify-out"), { recursive: true });
    await writeFile(graphifyGraphPath(root), "{}", "utf8");
    assert.equal(await graphifyGraphExists(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graphifyGraphMissingWarning names the partial result and the remediation", () => {
  const message = graphifyGraphMissingWarning();
  assert.match(message, /\[specs-kit\]/);
  assert.match(message, /graphify-out\/graph\.json/);
  assert.match(message, /partial/, "the warning frames the run as partial");
  assert.match(message, /graph-backed dependency validation is skipped/);
  assert.match(message, /\/graphify/);
});
