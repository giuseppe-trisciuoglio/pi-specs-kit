# Objective

Review the specification and task breakdown at /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/ BEFORE any code is written, as The Operator, and report every defect you can substantiate.

# Review surface

Read these files, and only these (all paths absolute):

- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/2026-08-17--auto-pr-at-loop-end.md — the functional specification
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/2026-08-17--technical-plan.md — the technical plan (architectural decisions)
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/data-model.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/contracts/README.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/contracts/forge-cli.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/contracts/git-subprocess.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/2026-08-17--auto-pr-at-loop-end--tasks.md — the task index
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/traceability-matrix.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/tasks/TASK-001.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/tasks/TASK-002.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/tasks/TASK-003.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/tasks/TASK-004.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/tasks/TASK-005.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/tasks/TASK-006.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/tasks/TASK-007.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/001-auto-pr-at-loop-end/tasks/TASK-008.md
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/architecture.md — project-level architecture
- /Volumes/Disco_Dati/project/GT/pi-specs-kit/docs/specs/ontology.md — project-level ontology

No code exists yet for this work. Do not read source files, tests or the codebase graph: the question is "does this specification hold together", not "does the code match it".

# Rules

- Every finding must be falsifiable: state a concrete scenario (given X, the implementation will do Y, which contradicts Z). A finding you cannot phrase this way must be dropped.
- Do not invent requirements the specification never claimed. Judge the work against what it says it does.
- Do not report style, wording or formatting.
- If you conclude a section is sound, say which specific attack you tried on it and why it did not land — record it under attacks_that_did_not_land, do not simply omit it.
- Severity: BLOCKER (implementation would produce wrong or unsafe behaviour, or a task cannot be executed as written) | MAJOR (real defect, discovered late it costs rework) | MINOR (worth fixing, does not endanger the implementation).

# Acceptance criteria

- [ ] Every file in the review surface has been read, tasks included
- [ ] Every finding carries a concrete failure scenario
- [ ] The answer is a single JSON object, nothing else

# Output contract

Answer with this JSON object and nothing else — no preamble, no trailing commentary, no code fences:

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

The deliverable is the JSON, not an explanation of it. You are autonomous: read, judge, emit.
