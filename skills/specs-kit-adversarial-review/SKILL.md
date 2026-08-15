---
name: specs-kit-adversarial-review
description: "Stress-tests a specification and its generated task set with a panel of independent models acting as hostile reviewers. Findings are cross-compared: agreement marks real defects, disagreement marks contested areas. Use after /skill:specs-kit-spec-to-tasks and before /skill:specs-kit-task-implementation."
argument-hint: "[ --spec=\"docs/specs/XXX-feature\" ] [ --models=\"a,b,c\" ] [ --force ]"
---

# Adversarial Review — Multi-Model Panel

Submits the specification, the technical plan and the generated tasks to a panel of
independent models, each instructed to break the work rather than approve it. The
individual critiques are then cross-compared: what several models find independently is
almost certainly a real defect, what they disagree about marks a genuinely contested
decision that a single reviewer would have hidden behind a confident answer.

## Why a panel

A single reviewer — however capable — is accommodating by construction and has stable
blind spots. Models trained on different data fail in different places, so:

- **Convergent findings** (found by 2+ reviewers, independently) are treated as real defects.
- **Divergent findings** (found by exactly one, or actively contradicted) are treated as
  contested areas: they are reported as open questions, not as defects.

The panel never negotiates. Each reviewer works in isolation, without seeing the others'
output; the comparison happens afterwards, in this session.

**Input**: the spec folder produced by the upstream workflow
**Output**: `docs/specs/[id]/adversarial-review/` — raw critiques, merged report, verdict

### Workflow Position

```
brainstorm → spec-check → technical-plan → spec-to-tasks → adversarial-review (this) → task-implementation
                                                                    ↑
                                                    last gate before writing code
```

## Usage

```bash
# Review a spec folder with the panel declared in specs-kit.yaml
/skill:specs-kit-adversarial-review docs/specs/001-user-auth/

# Override the declared panel for one run
/skill:specs-kit-adversarial-review --spec=docs/specs/001-user-auth/ --models="provider-a/model-x,provider-b/model-y,provider-c/model-z"

# Proceed despite blocker findings (recorded in the report)
/skill:specs-kit-adversarial-review --spec=docs/specs/001-user-auth/ --force
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--spec` | No | Spec folder (default: auto-detect from CWD) |
| `--models` | No | Comma-separated panel, overriding the declared one. Default: `adversarial_review.panel` in `specs-kit.yaml`. Models are never chosen automatically — see Phase 2 |
| `--force` | No | Do not block on BLOCKER findings; record the override in the report |
| `--rounds` | No | `1` (default) or `2`. Round 2 is rebuttal, see Phase 5 |

## Current Context

If `--spec` is omitted, infer the spec folder from the current working directory (the
nearest folder containing a dated spec-like markdown file plus a `tasks/` directory). If
no spec folder can be determined, stop and inform the user.

## Core Principles

- **Isolation before comparison**: reviewers never see each other's findings in round 1.
- **Hostile by mandate**: a reviewer that returns "looks good" has failed its job. Each
  persona is told to produce findings or to state explicitly, per section, why an attack
  it attempted does not land.
- **Falsifiable findings only**: every finding carries a concrete failure scenario. A
  finding that cannot be phrased as "given X, the implementation will do Y, which
  contradicts Z" is dropped during merge.
- **Consensus is evidence, not authority**: three models agreeing raises severity; it
  never overrides the user's decision.
- **Everything on disk, next to the spec**: raw critiques and the merged report live
  inside the spec folder so they are read together with the specification, in review and
  in future sessions.
- **Best-effort panel**: a reviewer that fails to spawn or returns unparseable output is
  recorded as missing and the panel continues, provided at least two reviewers answered.

---

## Phase 1: Discovery

**Goal**: Locate the review target and confirm the workflow position.

**Actions**:

1. Create the todo list with all phases.
2. Resolve the spec folder from `--spec` or from the current working directory.
3. Collect the review inputs:
   - `YYYY-MM-DD--feature-name.md` — the functional specification (required)
   - `technical-plan.md` — architectural decisions, if present
   - `tasks/TASK-*.md` — the generated tasks (required)
   - `tasks.md` or the dated task index, if present
   - `data-model.md`, `contracts/` — if present
   - `docs/specs/architecture.md`, `docs/specs/ontology.md` — project-level, if present

   These documents are the **entire** review surface. The panel does not read the
   codebase: no source files, no codebase graph, no tests. The question it answers is
   "does this specification hold together", not "does the code match it" — the latter is
   what `/skill:specs-kit-sync` is for, and it only has an answer once code exists.
4. **Abort conditions**:
   - No spec file: stop, suggest `/skill:specs-kit-brainstorm`.
   - No `tasks/` directory: stop, suggest `/skill:specs-kit-spec-to-tasks`. This skill
     reviews a task set; there is nothing to attack before one exists.
   - Unresolved `[NEEDS CLARIFICATION: ...]` markers in the spec: warn and suggest
     `/skill:specs-kit-spec-check` first, then ask whether to continue. Reviewing a spec
     with known holes produces findings that restate the holes.
5. Create `docs/specs/[id]/adversarial-review/` if missing.

---

## Phase 2: Panel Assembly

**Goal**: Take the reviewer models from a declared list — never from what happens to be
available.

The panel is **always** drawn from an explicit allowlist. The model catalogue is not a
menu to pick from: it mixes free and metered models, and several providers bill per
token on every id they expose, so selecting automatically would let the skill spend money
on models the operator never chose. The catalogue is used only to check that a declared
model is spelled correctly.

**Actions**:

1. **Read the declared panel**, in this order of precedence:
   1. `--models="a,b,c"` on the invocation — an explicit, one-off panel.
   2. `adversarial_review.panel` in the project's `specs-kit.yaml`:
      ```yaml
      adversarial_review:
        panel:
          - model: <provider/model>   # persona 1 — The Adversary
          - model: <provider/model>   # persona 2 — The Operator
            thinking: high            # optional, per reviewer
          - model: <provider/model>   # persona 3 — The Executor
      ```
      Order matters: personas are assigned in list order. An entry may also be a bare
      model string when no thinking level is needed. Unknown fields are ignored, so the
      list stays forward-compatible.

      The panel is editable from `/specs-kit-config` → **Adversarial review panel**: the
      same searchable model picker the loop roles use, one slot per persona, with add,
      remove and reorder. Reordering changes which reviewer holds which critique angle.
   3. Nothing declared → **stop**. Do not fall back to a guessed panel: print the yaml
      block above and ask the operator to declare the models they are willing to pay for.
2. **Validate, do not select**. Query the catalogue once, best-effort:
   ```bash
   pi --list-models
   ```
   The output is tabular — provider in the first column, model in the second, plus a
   header row. It is a display format, not a contract: skip lines that do not parse.
   - Declared model missing from the catalogue → hard stop naming the model and the
     reviewer slot. Never substitute a different model: a substitution is a charge the
     operator did not authorise.
   - Catalogue unobtainable → warn and proceed with the declared panel as-is. A model id
     that turns out to be wrong then fails at spawn time and is recorded as an
     unavailable reviewer.
3. **Never grow the panel.** The number of reviewers is exactly what was declared, capped
   at 4. Do not add a reviewer to break a tie, to replace a failed one, or to raise
   confidence — every extra reviewer is another metered run.
4. **Warn on redundancy, do not fix it.** If two declared models share a provider, note
   in the report that their agreement is weaker evidence — same family, shared blind
   spots — but respect the declared list.
5. **Panel size rules**:
   - 3 reviewers is the target.
   - 2 reviewers is acceptable; note in the report that consensus is weaker.
   - 1 reviewer declared: stop. A one-model panel is a single opinion with extra
     ceremony — tell the user and suggest `/skill:specs-kit-task-review` instead.
6. Assign one **persona** per reviewer, in this order (persona 1 to the first model, and
   so on). The personas attack different axes so that overlap between them is meaningful:

   | # | Persona | Attacks |
   |---|---------|---------|
   | 1 | **The Adversary** | Requirements that cannot be falsified, acceptance criteria that pass trivially, implicit assumptions, scope that quietly grew or shrank between spec and tasks |
   | 2 | **The Operator** | What happens when it fails: partial writes, concurrency, retries, unavailable dependencies, migration and rollback, observability of the failure |
   | 3 | **The Executor** | Whether the task set is actually runnable: ordering, missing prerequisite tasks, hidden coupling between "independent" tasks, DoD that cannot be checked, work no task covers |
   | 4 | **The Historian** | Whether the work contradicts what the project already decided: architecture document, ontology terms, recorded decisions |

   Personas are assigned by position, so a panel of 2 uses personas 1 and 2. Persona 4
   is only worth a slot in a project that keeps architecture and ontology documents.

---

## Phase 3: Critique Prompt Construction

**Goal**: Build one prompt per reviewer, self-contained and hostile.

Each reviewer runs as a fresh subprocess with no session and no memory of this
conversation, so the prompt must carry everything it needs.

**Prompt skeleton** (per reviewer):

```
You are reviewing a software specification and its task breakdown BEFORE any code is
written. Your role: <persona name> — <persona mandate from the table above>.

Your job is to find defects, not to approve. Approval is worthless here: the work has
already been read by its author and by a quality pass. You are the last chance to catch
what they missed. If you conclude a section is sound, say which specific attack you
tried on it and why it did not land — do not simply omit it.

Rules:
- Every finding must be falsifiable: state a concrete scenario (given X, the
  implementation will do Y, which contradicts Z). A finding you cannot phrase this way
  must be dropped.
- Do not invent requirements the specification never claimed. Judge the work against
  what it says it does.
- Do not report style, wording or formatting.
- You are reviewing documents only. No code exists yet for this work, and you have not
  been shown the codebase: do not speculate about implementation details, existing
  source files, or how the code will be written. Judge what the documents commit to.
- Severity: BLOCKER (implementation would produce wrong or unsafe behaviour, or a task
  cannot be executed as written) | MAJOR (real defect, discovered late it costs rework)
  | MINOR (worth fixing, does not endanger the implementation).

<inline content of: specification, technical plan, task files, data model, contracts,
 architecture and ontology documents when present>

Answer with JSON only, no prose around it:
{
  "findings": [
    {
      "severity": "BLOCKER|MAJOR|MINOR",
      "target": "<file or task id the finding is about>",
      "claim": "<one sentence: what is wrong>",
      "scenario": "<concrete failure scenario>",
      "suggested_fix": "<one sentence>"
    }
  ],
  "attacks_that_did_not_land": [
    { "target": "<file or task id>", "attack": "<what you tried>", "why_not": "<why the work holds>" }
  ],
  "confidence": "high|medium|low"
}
```

**Content budget**: if the inlined material would exceed a reasonable prompt size, inline
the specification and the technical plan in full and summarise the task files down to
id, title, dependencies, acceptance criteria and DoD. Never drop a task silently — a
reviewer that cannot see a task cannot find the gap it leaves.

---

## Phase 4: Panel Execution

**Goal**: Run every reviewer in isolation and persist the raw output.

**Actions**:

1. For each reviewer, spawn a subprocess:
   ```bash
   pi --print --mode json --no-session --model "<declared model>" \
      [--thinking <level, when the panel entry declares one>] \
      --append-system-prompt "<persona mandate>" \
      "<critique prompt>"
   ```
   Reviewers are independent: nothing from one run enters another.
2. Persist each raw result to
   `docs/specs/[id]/adversarial-review/raw--<provider>-<model>.json`, with a header
   recording model, persona, timestamp and the exit status. Raw output is kept even when
   it fails to parse: it is the evidence behind the merged report.
3. **Failure handling** (each is best-effort, never fatal on its own):
   - Non-zero exit or timeout: record the reviewer as `unavailable` with the reason.
   - Output that is not valid JSON: attempt to extract the JSON object; if that fails,
     record the reviewer as `unparseable` and keep the raw text.
   - Fewer than 2 usable reviewers: stop before the merge and report why. A merge over
     one critique cannot distinguish consensus from opinion.

---

## Phase 5: Rebuttal Round (optional, `--rounds=2`)

**Goal**: Let each reviewer answer the findings it did not raise.

Only worth running when round 1 produced findings the reviewers disagree about.

**Actions**:

1. Build, per reviewer, the list of findings raised by the *others*.
2. Spawn each reviewer again, with the same persona, asking only:
   *for each of these findings, does it hold? Answer AGREE, DISAGREE or UNSURE with one
   sentence of reasoning. You did not raise these; say plainly if you now think they are
   right.*
3. Persist as `rebuttal--<provider>-<model>.json`.
4. A finding that survives rebuttal with 2+ AGREE is promoted to convergent even if only
   one reviewer raised it originally. A finding with 2+ DISAGREE is demoted to a
   contested area.

---

## Phase 6: Merge & Consensus

**Goal**: Turn N independent critiques into one ranked, deduplicated verdict.

**Actions**:

1. **Normalise** every finding to `(target, claim, scenario, severity, source model)`.
2. **Cluster** semantically equivalent findings across reviewers — same target and same
   underlying defect, regardless of wording. When clustering, keep the sharpest scenario
   and record every model that raised it.
3. **Classify** each cluster:

   | Class | Condition | Meaning |
   |-------|-----------|---------|
   | **Convergent** | raised independently by 2+ reviewers | treated as a real defect |
   | **Contested** | raised by 1, and contradicted by another reviewer or by an `attacks_that_did_not_land` entry on the same target | a genuine open decision, surfaced as a question |
   | **Singleton** | raised by 1, uncontradicted | a real finding from one angle; kept, at its stated severity |

4. **Severity resolution**: a convergent cluster takes the highest severity any reviewer
   assigned it. A singleton keeps its own.
5. **Drop** findings without a concrete scenario, findings about style, and findings that
   demand requirements the specification never claimed.
6. **Rank**: convergent BLOCKER → singleton BLOCKER → convergent MAJOR → the rest.

---

## Phase 7: Report

**Goal**: Write the merged report next to the specification.

Write `docs/specs/[id]/adversarial-review/YYYY-MM-DD--adversarial-review.md`:

```markdown
# Adversarial Review — <feature name>

Date: YYYY-MM-DD
Panel: <model> (The Adversary), <model> (The Operator), <model> (The Executor)
Rounds: 1 | 2
Reviewed: <spec file>, technical-plan.md, N task files

## Verdict

**BLOCKED** — 2 blocker, 5 major, 3 minor
<or> **PASSED WITH FINDINGS** — 0 blocker, 4 major
<or> **PASSED** — no blocker or major findings
<or> **OVERRIDDEN** — 2 blocker, proceeding on --force

## Convergent findings (agreement between reviewers)

### F1 — BLOCKER — TASK-004
Raised by: <model A>, <model C>
**Claim**: ...
**Scenario**: ...
**Suggested fix**: ...

## Singleton findings

### F7 — MAJOR — spec §Functional Requirements
Raised by: <model B>
...

## Contested areas (reviewers disagree)

### C1 — TASK-002, retry semantics
<model A> considers it a defect; <model B> explicitly judged it sound.
**Open question**: ...

## Panel health

| Reviewer | Persona | Status | Findings | Confidence |
|----------|---------|--------|----------|------------|
| <model>  | The Adversary | ok | 6 | high |
| <model>  | The Operator  | unavailable (timeout) | — | — |

## Coverage

| Input | Reviewed |
|-------|----------|
| Specification | yes |
| Technical plan | yes |
| Tasks | 12/12 |
| Contracts | n/a |
```

Then print a short `[specs-kit]`-prefixed summary to the user: verdict, counts, report
path.

---

## Phase 8: Gate

**Goal**: Stop the workflow when the panel found something that must not reach code.

**Rules**:

1. **BLOCKER findings present, no `--force`**: the run ends BLOCKED. Do not proceed to
   implementation and do not offer to. Tell the user, per blocker, which skill resolves
   it:
   - ambiguity or gap in the specification → `/skill:specs-kit-spec-check`
   - the specification is wrong about what the feature should do → re-run
     `/skill:specs-kit-brainstorm` on the affected area
   - architectural defect → `/skill:specs-kit-technical-plan`
   - defect in the task set → re-run `/skill:specs-kit-spec-to-tasks`, or edit the
     affected `tasks/TASK-*.md` directly when the fix is contained to one or two tasks
     (a missing dependency, an acceptance criterion that cannot be checked)
2. **`--force`**: the verdict becomes OVERRIDDEN. The blockers stay in the report, with
   the override and its date recorded. The gate is advisory to the user, never silent.
3. **MAJOR only**: the run passes with findings. Present them and let the user decide.
4. **Clean**: report and proceed.
5. **Idempotent**: re-running produces a new dated report; earlier reports are never
   overwritten, so the history of what the panel said is preserved alongside the spec.

---

## Error Handling

### No panel declared
```
[specs-kit] No review panel declared. Adversarial review never picks models on its own:
several providers bill per token on every model they expose.
Declare the models you want to spend on in specs-kit.yaml:

  adversarial_review:
    panel:
      - model: <provider/model>   # The Adversary
      - model: <provider/model>   # The Operator
      - model: <provider/model>   # The Executor

or pass them for one run with --models="a,b,c".
```

### Declared model not in the catalogue
```
[specs-kit] Reviewer 2 (The Operator) declares model <model>, which the agent CLI does not know.
Fix the id in specs-kit.yaml. No substitute is chosen: that would bill a model you did not declare.
```

### Model catalogue unavailable
```
[specs-kit] Model catalogue unavailable: the declared panel cannot be validated up front.
Proceeding with the declared models; a wrong id will surface as a failed reviewer.
```

### Panel too small
```
[specs-kit] Only one usable reviewer (<model>). A single-model panel is one opinion, not a panel.
Use /skill:specs-kit-task-review for a single-reviewer pass, or declare a second provider in specs-kit.yaml.
```

### Reviewer failed
```
[specs-kit] Reviewer <model> (The Operator) failed: timeout after Ns. Continuing with 2 reviewers.
Consensus for this run is weaker: findings on failure and recovery are likely under-covered.
```

### No tasks found
```
[specs-kit] No tasks/ directory in <spec folder>. Adversarial review runs on a generated task set.
Run /skill:specs-kit-spec-to-tasks first.
```

---

## Todo Management

```
[ ] Phase 1: Discovery
[ ] Phase 2: Panel Assembly
[ ] Phase 3: Critique Prompt Construction
[ ] Phase 4: Panel Execution (0/3 reviewers)
[ ] Phase 5: Rebuttal Round (optional)
[ ] Phase 6: Merge & Consensus
[ ] Phase 7: Report
[ ] Phase 8: Gate
```

---

## Notes

- The panel reviews **documents, not code**. It runs before implementation; for reviewing
  an implemented task use `/skill:specs-kit-task-review`.
- Reviewer cost scales with the panel size and the amount of inlined material. Three
  reviewers over a large spec is the expensive step of the workflow — it is meant to be,
  since it replaces rework discovered after implementation. The panel is declared, never
  inferred, precisely so that cost is a decision the operator made once and can see in
  `specs-kit.yaml`.
- A panel entry may name a free or locally hosted model. Mixing a metered model with
  cheaper ones is a legitimate configuration: what matters for consensus is that the
  reviewers come from different families, not what they cost.
- The report is an artefact of the specification, not of the session: it is written
  inside the spec folder and is expected to be read alongside the spec.
