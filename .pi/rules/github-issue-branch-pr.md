---
description: "Feature workflow for GitHub contributions: plan written in an issue first, implementation only from that plan, branch issue-<number>, English PR to main, merge only on explicit request followed by docs update. Cross-cutting: no file scope."
priority: 3
---

# GitHub issue → branch → PR workflow

## Convention

### Case A — Issue first, never implement without a plan
- Any new feature starts with an issue in the main repository containing the plan. Nothing is implemented until the plan exists in the issue; implementation follows only what the plan states.

### Case B — Branch named `issue-<number>`
- Work happens on a branch named `issue-<issuenr>`, where `<issuenr>` is the GitHub issue number (real examples: `issue-12`, `issue-17`, `issue-25`, `issue-32`).

### Case C — Pull request to main, in English
- Once implemented, commit to the `issue-<nr>` branch and open a pull request to `main`. The PR title and description are in English.
- Commit messages follow the existing style: Conventional Commits in English (e.g. `feat: ...`, `fix: ...`).

### Case D — Merge only on request, then update docs
- The PR is merged only when the user explicitly asks. After merging, all relevant documentation in `docs/*.md` (and `AGENTS.md` when applicable) is updated.

### When not to apply
- Trivial fixes or repository chores that need no plan may skip the issue — but any feature or behavior change requires it.

### Examples

**Case B/C** (real history):
```
branch: issue-32
commit: fix: sanitize external output before it reaches argv of a phase spawn
merge:  Merge pull request #33 from giuseppe-trisciuoglio/issue-32
```

## Evidence & Confidence
- **Confidence**: Medium
- **Reference files**: `AGENTS.md` (Feature workflow section), branch list (`issue-12`, `issue-17`, `issue-20`, `issue-25`, `issue-27`, `issue-32`), git log (`Merge pull request #33 ... issue-32`), `.github/workflows/ci.yml`
- **Notes**: branch naming and English Conventional Commits are consistently observed in the history; the docs-update-after-merge step is stated in `AGENTS.md` but its execution frequency was not verified per merge.

## Rationale
The issue carries the plan, so implementation stays traceable to an agreed design and the branch name links every commit and PR back to its plan; keeping issues, PRs and commits in English keeps the whole contribution trail consistent for a public npm-published repository.
