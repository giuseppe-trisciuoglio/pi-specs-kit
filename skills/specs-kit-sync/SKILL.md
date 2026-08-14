---
name: specs-kit-sync
description: "Synchronizes specification context (codebase graph, tasks) with implementation reality. Detects spec-to-code drift, proposes and applies spec updates, creates missing tasks. Full sync closes the SDD triangle (Spec <-> Test <-> Code). Use after task implementation or when drift is detected."
argument-hint: "[ --spec=docs/specs/XXX-feature ] [ --kg-only ] [ --code-only ] [ --after-task=TASK-XXX ]"
---

# Spec Synchronization

Synchronizes specification context (codebase graph, Tasks) with implementation reality and detects/applies spec-to-code drift. This is the close-the-loop step of the specification workflow.

## Overview

This command solves four problems:

1. **Inconsistent Technical Context**: Tasks lose technical context or don't reflect actual patterns used in the codebase
2. **Specs-Tasks Misalignment**: User request, specification, and tasks are not aligned
3. **Stale Codebase Graph**: `graphify-out/graph.json` is not refreshed after implementations
4. **Spec-Code Drift**: The functional specification diverges from what was actually implemented, with decisions lost

It closes the SDD triangle by keeping synchronized:

- **Spec** → The functional specification (WHAT)
- **Test** → Tasks and acceptance criteria (verification)
- **Code** → The actual implementation (HOW)

### Workflow Position

```
brainstorm → spec-to-tasks → task-implementation → task-review → sync (this) → done
                                    ↑                     ↓
                                    └── optionally --kg-only after spec-to-tasks ──┘
```

## Usage

```bash
# Full sync (recommended after task-implementation or task-review)
/skill:specs-kit-sync docs/specs/001-feature/

# Sync after a specific task
/skill:specs-kit-sync docs/specs/001-feature/ --after-task=TASK-003

# Graph-only mode (lighter, used after spec-to-tasks codebase analysis)
/skill:specs-kit-sync docs/specs/001-feature/ --kg-only

# Code drift detection only
/skill:specs-kit-sync docs/specs/001-feature/ --code-only

```

## Modes

| Flag | What it does | Phases executed | When to use |
|------|-------------|-----------------|-------------|
| (none) | Full sync: graph refresh → gap analysis → task enrichment → drift detection → spec update | 1-9 | Default after implementation |
| `--kg-only` | Refresh the codebase graph + task enrichment | 1, 2, 3, 4, 9 | After spec-to-tasks, to ground tasks in the current codebase |
| `--code-only` | Spec-to-code drift detection + spec update | 1, 5, 6, 7, 8, 9 | When you suspect drift |

In every mode that touches the graph (default and `--kg-only`), Phase 3 refreshes
`graphify-out/graph.json` before any later phase reads it. The graph is the
single source of truth: there is no per-spec projected file, every consumer
reads `graph.json` directly. Running `--kg-only` against a missing graphify
output aborts before Phase 2 just like the default mode — there is no manual
short-circuit.


## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--spec` | No | Path to spec folder (e.g., `docs/specs/XXX-feature`). Auto-detected from git branch if omitted. |
| `--kg-only` | No | Refresh the codebase graph and enrich tasks only. Skip drift detection and spec updates. |
| `--code-only` | No | Detect spec-to-code drift and apply spec updates only. Skip the graph refresh and task enrichment. |
| `--after-task` | No | Sync after a specific task (e.g., `TASK-003`). Narrows the analysis to task-related files. |


## Core Principles

- **Incremental updates**: Only update what has changed, don't rewrite everything
- **Single graph source**: `graphify-out/graph.json` is the only codebase graph; it is read, never projected or hand-rolled
- **Codebase-first**: Actual implementation is the final authority
- **Non-destructive**: Preserve manual edits and annotations in task files
- **Traceability**: All changes are logged and reported
- **Idempotent**: Running multiple times produces the same result
- **Living specification**: The spec should reflect what the system DOES, not what we planned it would do

---

## Prerequisite: graphify is a hard dependency

The codebase graph this skill reads is produced by the `graphify` skill, not by
this skill. Treat `graphify` as a required dependency: when it is missing the
sync still runs (its documentation duties do not need the graph), but the loop
marks the result **partial** and graph-backed validation is skipped. graphify
owns `graphify-out/graph.json`; this skill only refreshes and reads it.

### Pre-flight checks (run before Phase 1)

1. **Skill installed**: confirm `/graphify` is reachable. Look in this order:
   - `~/.agents/skills/graphify/SKILL.md`
   - `~/.pi/agent/skills/graphify/SKILL.md`
   - any other `graphify` skill folder visible to the active pi install

   If none of these exist: **abort** with a message naming the skill, the
   canonical install location, and the fact that without it no codebase graph is
   available. Do not start Phase 1.

2. **Graph output present**: from the project root, check
   `graphify-out/graph.json`. Phase 3 refreshes it (re-running
   `/graphify --update` when stale), so here it is enough to know whether a
   graph exists at all:
   - **exists**: reuse it; Phase 3 decides whether to refresh.
   - **does not exist**: this is the normal first-run path — Phase 3 runs
     `/graphify <project-root>` once to materialise it.

   Re-running graphify inside sync is the only acceptable way to refresh the
   graph — editing `graph.json` by hand or replacing it with a stub will
   silently drop every entity and edge the rest of the loop relies on.

3. **Loud, not silent, but not blocking**: a missing or broken graph means
   graph-backed dependency validation is skipped — it does **not** abort the
   sync. The phase still completes its documentation duties (drift detection,
   spec updates, traceability). The loop marks the run **partial** and warns at
   sync time and again in its final summary, so the gap is visible instead of
   degrading silently. Re-running graphify before the next sync is the fix.
   Feeding later prompts from an empty graph means each agent re-discovers
   patterns the codebase already encoded — which is why the partial flag
   exists, not why the loop should stop.

---

## Phase 1: Discovery

**Goal**: Identify spec folder, load context, determine execution mode

**Always runs** regardless of mode.

**Actions**:

1. Create todo list with all phases:
   ```
   [ ] Phase 1: Discovery
   [ ] Phase 2: Codebase Gap Analysis
   [ ] Phase 3: Graph Refresh
   [ ] Phase 4: Task Enrichment
   [ ] Phase 5: Spec Drift Detection
   [ ] Phase 6: Spec Update Proposal & Approval
   [ ] Phase 7: Apply Updates & Task Creation
   [ ] Phase 8: Sync Verification
   [ ] Phase 9: Summary
   ```

2. Resolve inputs from the invocation context (skill arguments, or the spec
   provided by the loop):
   - `spec` → spec folder path (required)
   - `--kg-only`, `--code-only` → scope flags
   - `--after-task` → restrict sync to tasks after this one, when present

3. Determine the spec folder:
   - If `--spec=` is provided: use it
   - Otherwise: use the spec from the loop context, or ask the user
   - Validate the path contains spec files (at least one markdown file matching spec patterns)

4. Resolve the functional specification file with this priority:
   1. `YYYY-MM-DD--feature-name.md`
   2. Legacy `*-specs.md`
   3. The only dated spec-like markdown file in the folder excluding task and metadata files

5. Load current state:
   - Read the resolved functional specification file
   - Read `decision-log.md` if exists → extract all DEC entries
   - **Resolve the graph source**: note the path of `graphify-out/graph.json`
     from the project root and its `updated_at` for the summary. Phase 3
     refreshes it; every later phase reads it directly. If the prerequisite
     failed, abort here — Phase 2 cannot proceed without a graph to read from.
   - List all task files in `tasks/` directory
   - Read `user-request.md` if exists
   - Identify completed tasks (status: completed in frontmatter)
   - Detect language from existing tasks or source files

6. Determine execution mode:
   - If `--kg-only`: execute Phases 1, 2, 3, 4, 9
   - If `--code-only`: execute Phases 1, 5, 6, 7, 8, 9
   - If no flag: execute all phases (1-9)

---

## Phase 2: Codebase Gap Analysis

**Goal**: Identify discrepancies between the graph, tasks, and actual codebase

**Runs unless**: `--code-only`

**Actions**:

### 2.1 Graph Gap Analysis

1. **Graph vs Codebase**:
   - For each component in the graph: check if the file actually exists
   - For each API in the graph: check if the endpoint exists
   - Find new files not documented in the graph (these signal a stale graph: Phase 3 refreshes it)

2. **Tasks vs Graph**:
   - Check if task technical context matches the graph's patterns
   - Identify tasks referencing non-existent components
   - Find tasks missing expected technical details

3. **Requirements Traceability**:
   - Compare `user-request.md` with task descriptions
   - Identify requirements mentioned but not in tasks
   - Find tasks without clear requirement origin

### 2.2 Generate Gap Report

```markdown
## Gap Analysis Report

### Missing in Graph
- NewFile.java (discovered in codebase)

### Outdated in Graph
- OldComponent.java (file removed from codebase)

### Tasks Needing Update
- TASK-003: References outdated pattern
- TASK-007: Missing technical context

### Orphaned Requirements
- User request mentions "X" but no task covers it
```

---

## Phase 3: Graph Refresh

**Goal**: Ensure `graphify-out/graph.json` is current before any later phase reads it

**Runs unless**: `--code-only`

**Actions**:

1. **Re-verify freshness** (defence against races):
   - If the graph is older than 30 minutes, or missing, re-run
     `/graphify <project-root> --update` so every later phase works on fresh
     data. The graph is the single source the gap analysis and task enrichment
     read; skipping this risks validating tasks against an outdated codebase and
     labelling the result as "verified".

2. **Load the graph**:
   - Parse `graphify-out/graph.json` (the path recorded in Phase 1). This is the
     **canonical and only** graph: components, APIs, integration points and
     patterns all live here.

3. **Read-only by contract**:
   - Do not project, copy, or derive a per-spec file from the graph. There is no
     `knowledge-graph.json` to write; consumers query `graph.json` directly.
   - Do not hand-edit `graph.json`. If the graph seems wrong, re-run
     `/graphify <project-root> --update` with appropriate flags and let graphify
     fix it. Editing it here desyncs the next graphify run.

4. **Record provenance**: note the graph path and its `updated_at` for the
   Phase 9 summary (whether it was refreshed or reused as-is).

---

## Phase 4: Task Enrichment

**Goal**: Update task files with improved technical context from the graph

**Runs unless**: `--code-only`

**Actions**:

1. **Identify tasks needing update** from Phase 2.2 gap report

2. **For each task file**:
   - Read current content
   - Parse YAML frontmatter
   - Identify "Technical Context" section

3. **Enrich technical context** with data read from the graph:
   - Add relevant patterns
   - Reference existing components to integrate with
   - Document APIs to use or extend
   - Note conventions to follow

4. **Preserve manual content**:
   - Don't overwrite custom notes or annotations
   - Preserve acceptance criteria
   - Keep manual edits to descriptions

5. **Write updated task file** back to disk

---

## Phase 5: Spec Drift Detection

**Goal**: Detect deviations between the functional specification and the actual implementation

**Runs unless**: `--kg-only`

**Actions**:

1. **Extract spec claims**:
   - Read the resolved specification file
   - Extract all acceptance criteria
   - List all user stories, functional requirements, and non-functional requirements

2. **Extract implementation reality**:
   - Read all completed tasks (status: completed)
   - Extract acceptance criteria from each completed task
   - Identify what was actually implemented vs what was planned

3. **Analyze decision-log.md** (if exists):
   - Read all DEC entries
   - Identify decisions that caused spec changes
   - Categorize each decision reference

4. **Compare and classify deviations**:

   - **Acceptance criteria comparison**:
     - Criteria in spec but NOT implemented → Unmet requirement
     - Criteria implemented but NOT in spec → Scope expansion
     - Criteria modified during implementation → Requirement refinement

   - **Decision-log cross-reference**:
     - DEC entries not reflected in spec → Undocumented deviation
     - Scope changes documented but not applied → Pending update

5. **Generate deviation report**:
   ```markdown
   ## Deviation Analysis

   ### Scope Expansions (added beyond original spec)
   - Added pagination to search results (DEC-003)
   - Added filtering by rating

   ### Requirement Refinements (changed from original spec)
   - Changed "instant search" to "search with caching" (DEC-005)

   ### Scope Reductions (removed during implementation)
   - Dropped "search by proximity" feature (DEC-007)

   ### Unmet Requirements (in spec but not implemented)
   - Export results as CSV — no task covers this
   ```

---

## Phase 6: Spec Update Proposal & Approval

**Goal**: Present proposed spec updates to the user and get approval

**Runs unless**: `--kg-only`
**Skipped if**: No deviations detected in Phase 5 (log "Spec and implementation are aligned, no drift detected" and skip to Phase 8)

**Actions**:

1. **Generate diff-style proposal** showing:
   - **Additions** (+): New content to add to spec
   - **Modifications** (~): Content to change
   - **Deletions** (-): Content to remove or mark as deferred

2. **Categorize changes by impact**:
   - **Scope expansion**: Features added beyond original spec
   - **Requirement refinement**: Clarifications or corrections
   - **Scope reduction**: Features dropped or deferred

3. **Present proposal to user via ask_user_question**:
   ```
   Deviation Summary:
   - N scope expansions
   - N requirement refinements
   - N scope reductions
   - N unmet requirements

   Options:
   - "Approve all" — Apply all spec changes AND create missing tasks
   - "Spec only" — Apply spec changes, skip task creation
   - "Review each" — Review each change individually
   - "Skip" — Don't update spec or create tasks
   ```

4. **If user chooses "Approve all"**:
   - Proceed to Phase 7 (apply all spec updates + create missing tasks)

5. **If user chooses "Spec only"**:
   - Proceed to Phase 7 (apply spec updates only, skip task creation)

6. **If user chooses "Review each"**:
   - Present each deviation category one by one
   - For each: show original vs proposed change, ask approve/reject
   - Track which changes need task creation
   - Proceed to Phase 7 with approved subset

7. **If user chooses "Skip"**:
   - Log pending deviations for future reference
   - Skip to Phase 9 (Summary)

---

## Phase 7: Apply Updates & Task Creation

**Goal**: Apply approved spec updates and optionally create missing tasks

**Runs unless**: `--kg-only` or user chose "Skip" in Phase 6

### 7.1 Backup Original Spec

1. Create backup next to the resolved spec file:
   ```bash
   cp [resolved-spec-file] [resolved-spec-file].backup
   ```

### 7.2 Apply Spec Changes

2. For each approved change:
   - **Scope expansions**: Add new sections/content to spec
   - **Requirement refinements**: Update existing content
   - **Scope reductions**: Remove content or mark as deferred with reason

3. **Add Revision History section** at end of spec (append to existing if present):
   ```markdown
   ## Revision History

   | Date | Change | Reason | Decision Ref |
   |------|--------|--------|--------------|
   | YYYY-MM-DD | Added pagination to search results | Implementation revealed need | DEC-003 |
   | YYYY-MM-DD | Clarified search caching behavior | Technical refinement | DEC-005 |
   ```

4. **Update spec metadata**:
   - Update "Last Modified" date
   - Increment version number if tracking versions

### 7.3 Automatic Task Creation

**Runs only if**: User chose "Approve all" in Phase 6 (or approved individual tasks in "Review each" mode)

5. **Analyze deviations for task creation**:
   - For each **scope expansion**: Create task for new feature/component
   - For each **requirement refinement**: Create task if it requires implementation changes
   - For each **scope reduction**: Mark related tasks as superseded (no new task)
   - Skip refinements that don't require new implementation (e.g., documentation clarifications)

6. **Generate task proposals**:
   ```markdown
   ## Task Creation Proposals

   | Deviation | Suggested Task Title | Priority |
   |-----------|---------------------|----------|
   | Scope Expansion: Pagination | Implement pagination for search results | High |
   | Scope Expansion: Rating filter | Add rating filter to search | Medium |
   ```

7. **If user chose "Approve all"**: Create all proposed tasks automatically
   **If user chose "Review each"**: Create only individually approved tasks

8. **For each task to create**, follow this pattern:
   - Generate task title from deviation
   - Generate task description from deviation context
   - Generate acceptance criteria from deviation details
   - Determine dependencies from related existing tasks
   - Read task index to get next task ID
   - Create task file using standard template:
     ```markdown
     ---
     id: TASK-XXX
     title: "[Title]"
     status: pending
     priority: high|medium|low
     dependencies: [TASK-YYY]
     ---

     # [Title]

     ## Description
     [From deviation context]

     ## Acceptance Criteria
     - [ ] [From deviation details]

     ## Technical Context
     [Relevant patterns read from graphify-out/graph.json]
     ```
   - Add to task index
   - Show created task with implementation command

9. **For scope reductions**: Find tasks that implement dropped features and update their status to "superseded" with reason

---

## Phase 8: Sync Verification

**Goal**: Verify that all tasks still map correctly to the updated specification

**Runs unless**: `--kg-only`

**Actions**:

1. **Re-validate task list**:
   - Check if all tasks still map to updated spec sections
   - Identify tasks with obsolete references
   - Flag tasks whose acceptance criteria conflict with updated spec

2. **Generate verification report**:
   ```markdown
   ## Sync Verification

   ### Tasks Still Valid
   - TASK-001: User registration
   - TASK-002: Login functionality

   ### Tasks Needing Update
   - TASK-003: References removed "proximity search" — needs revision

   ### Superseded Tasks
   - TASK-005: Marked as superseded (scope reduction)
   ```

3. **If tasks need updates**:
   - Ask via ask_user_question:
     - "Update affected tasks now?" — apply automatic fixes
     - "Review manually later" — log for future reference

---

## Phase 9: Summary

**Goal**: Generate comprehensive summary of all changes

**Always runs**.

**Actions**:

1. Mark all todos complete

2. Generate summary report:
   ```markdown
   ## Spec Sync Summary

   **Spec**: docs/specs/[ID]/
   **Timestamp**: [ISO timestamp]
   **Mode**: full | kg-only | code-only

   ### Graph Refresh (if applicable)
   - graph.json refreshed: Yes/No (re-ran /graphify --update)
   - graph updated_at: [timestamp]
   - Components/APIs/patterns available: N

   ### Task Enrichment (if applicable)
   - Enriched TASK-XXX technical context
   - Enriched TASK-YYY technical context

   ### Drift Detection (if applicable)
   - N scope expansions
   - N requirement refinements
   - N scope reductions
   - N unmet requirements

   ### Spec Updates (if applicable)
   - Spec updated: Yes/No
   - Revision history entries added: N
   - Backup created: [path]

   ### Tasks Created (if applicable)
   - TASK-XXX: [title] (new)
   - TASK-YYY: [title] (new)

   ### Sync Verification (if applicable)
   - All tasks valid: Yes/No
   - Tasks needing manual review: N

   ### Files Modified
   - tasks/TASK-001.md
   - YYYY-MM-DD--feature-name.md
   - YYYY-MM-DD--feature-name.md.backup (new)

   ### Files Read (not modified)
   - graphify-out/graph.json (refreshed by graphify, never edited here)
   ```

---

## Integration Points

### Prerequisite in spec-to-tasks

The very first time a spec is touched, the spec-to-tasks skill MUST run
`/graphify <project-root>` before this skill, and keep the resulting
`graphify-out/graph.json` under version control (or at least locally until the
first sync completes). It is the single graph every downstream phase reads;
without it they run blind.

```markdown
## Phase 0: Initialise the Codebase Graph

Before any sync runs, materialise the graph the rest of the workflow will
read from:

/graphify <project-root>

This produces `graphify-out/graph.json`, the single source of truth that
specs-kit-sync refreshes and that every consumer reads directly. There is no
per-spec projected file.
```

### In spec-to-tasks (after codebase analysis)

```markdown
## Phase 3.5: Refresh the Codebase Graph

After codebase analysis completes, refresh the graph and enrich tasks:

/skill:specs-kit-sync [spec-folder] --kg-only

This re-runs /graphify --update when the graph is stale and enriches task
technical context from `graphify-out/graph.json`. If the graph is missing at
this point, sync aborts with an explicit message instead of running against an
empty codebase map.
```

### In task-implementation (after task completion)

```markdown
## T-6.5: Update Spec Context

After task completion and verification, update spec context:

/skill:specs-kit-sync [spec-folder] --after-task=[TASK-ID]

This refreshes the codebase graph (graphify --update) and updates:
- Task file with implementation details
- Technical context for dependent tasks
```

### In task-implementation (when deviation detected)

```markdown
## T-6.6: Spec Deviation Check

When spec deviation is detected during implementation:

/skill:specs-kit-sync [spec-folder] --code-only --after-task=[TASK-ID]

This detects and proposes spec updates without refreshing the graph.
```

### Manual Triggers

Run spec-sync manually when:
- After completing several tasks to sync all context
- Before starting a new feature phase to verify context is current
- When `decision-log.md` has many entries not reflected in spec
- After significant refactoring
- After a normal chat session that used `docs/specs/[id]/` as implementation context and clarified, narrowed, or expanded what should be built
- When context seems stale or inconsistent

### Graph Freshness Indicators

The graph is a single file, `graphify-out/graph.json`, owned by graphify. Its
freshness is simply its age; there is no projected copy to track separately.

- **< 7 days**: Fresh, reuse as-is (Phase 3 may still refresh if a phase is > 30 min old)
- **7-30 days**: Getting stale, Phase 3 re-runs `/graphify --update`
- **> 30 days**: Old, a full `/graphify` rebuild is recommended before any sync

---

## Error Handling

### Spec Folder Not Found
- **Behavior**: Error and ask for correct path
- **Message**: "Spec folder not found at [path]. Please provide a valid path with --spec="

### graphify Skill Not Installed
- **Behavior**: **Abort before Phase 1**. Do not start the loop on a spec
  whose codebase graph cannot be produced.
- **Message**: "graphify is required to produce the codebase graph for this
  spec. Install it from the canonical location (~/.agents/skills/graphify or
  ~/.pi/agent/skills/graphify) and re-run. Without graphify no
  graphify-out/graph.json is available, and downstream phases will run
  against an empty codebase map."

### graphify Output Missing
- **Behavior**: **Abort Phase 1**. Sync cannot proceed without
  `graphify-out/graph.json`; there is no fallback extraction.
- **Message**: "graphify-out/graph.json not found at [path]. Run
  `/graphify <project-root>` once and re-run sync."

### graph.json Corrupted
- **Behavior**: Do NOT edit `graph.json` by hand. Re-run
  `/graphify <project-root>` to rebuild it, then re-run sync.
- **Message**: "graphify-out/graph.json is unreadable. Re-run
  `/graphify <project-root>` to rebuild the graph (it is graphify's output,
  never hand-edited here)."

### Task File Not Found (with --after-task)
- **Behavior**: Warning, continue with graph refresh and gap analysis only
- **Message**: "Task [TASK-XXX] not found. Continuing with full scan."

### No Deviations Detected
- **Behavior**: Log alignment, skip Phase 6-7, go to Phase 8
- **Message**: "Spec and implementation are aligned. No drift detected."

### File Write Failure
- **Behavior**: Log error, continue with remaining phases, report in summary
- **Message**: "Failed to write [file]: [error]"

### No Spec File Found
- **Behavior**: Error and stop
- **Message**: "No specification file found in [folder]. Expected YYYY-MM-DD--*.md or *-specs.md."

---

## Examples

### Example 1: Full Sync After Implementation

```bash
/skill:specs-kit-sync docs/specs/001-hotel-search/
```

Output:
```
Spec Sync — docs/specs/001-hotel-search/
Mode: full sync

Phase 2: Gap Analysis
- 2 new components discovered in codebase (graph was stale)
- 1 task needs technical context update

Phase 3: Graph Refresh
- Re-ran /graphify --update (graph was > 30 min old)
- graph.json now current

Phase 4: Task Enrichment
- Enriched TASK-003 technical context

Phase 5: Drift Detection
- 1 scope expansion: Pagination added (DEC-003)
- 1 requirement refinement: Search timeout set to 5s (DEC-004)

Phase 6: Proposal
[ask_user_question] 1 scope expansion, 1 refinement
→ User approved all

Phase 7: Applied
- Spec updated with revision history (2 entries)
- Backup: 2026-03-15--hotel-search.md.backup
- Created TASK-009: Implement pagination for search results

Phase 8: Verification
- All tasks valid
```

### Example 2: Graph-Only After spec-to-tasks

```bash
/skill:specs-kit-sync docs/specs/001-hotel-search/ --kg-only
```

Output:
```
Spec Sync — docs/specs/001-hotel-search/
Mode: kg-only

Phase 2: Gap Analysis
- 3 new components discovered (graph was stale)

Phase 3: Graph Refresh
- Re-ran /graphify --update
- graph.json now current

Phase 4: Task Enrichment
- Enriched TASK-001, TASK-002 technical context
```

### Example 3: Code-Only Drift Check

```bash
/skill:specs-kit-sync docs/specs/001-hotel-search/ --code-only
```

Detects spec-to-code deviations and proposes spec updates, without refreshing the graph or touching task files.

---

## Todo Management

Maintain todo list throughout execution:

```
[ ] Phase 1: Discovery
[ ] Phase 2: Codebase Gap Analysis
[ ] Phase 3: Graph Refresh
[ ] Phase 4: Task Enrichment
[ ] Phase 5: Spec Drift Detection
[ ] Phase 6: Spec Update Proposal & Approval
[ ] Phase 7: Apply Updates & Task Creation
[ ] Phase 8: Sync Verification
[ ] Phase 9: Summary
```

Mark phases as skipped when not applicable to current mode.
