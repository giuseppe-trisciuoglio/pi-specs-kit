---
review_status: ${REVIEW_STATUS}
summary: ${REVIEW_SUMMARY}
issues:
  - ${ISSUE}
routed: []
---

# Task Review Report: ${TASK_ID}

**Task**: ${TASK_ID} — ${TASK_TITLE}
**Spec**: ${SPEC_PATH}
**Reviewed**: ${REVIEW_DATE}
**Reviewer**: AI Code Reviewer

> **The frontmatter above is the verdict.** It must be the first thing in the
> file, before this heading, and `review_status` takes one of two values:
>
> - `PASSED` ✅ — all acceptance criteria and DoD met, no critical code issue,
>   no architectural drift. `issues` is an empty list (`issues: []`).
> - `FAILED` ❌ — anything else: an unmet criterion, a critical finding, a
>   spec contradiction or a drift that needs a decision. Every reason goes in
>   `issues`, one entry per line, phrased as something the next implementation
>   pass can act on.
>
> `summary` is a single line. Everything below is the detailed report a human
> reads; it never changes the verdict.
>
> **`routed`** lists fixes you defer to a *later* task rather than to this one
> (an optional suggestion that fits a known downstream task better). Each entry
> is `{ to: "<task-id>", text: "<one-line fix>" }`. Leave it `[]` when there is
> nothing to route. The loop feeds routed entries to the target task's
> implementation prompt automatically, so they are not lost between reviews.
>
> **A routed suggestion left unactioned is a finding.** If a prior review routed
> a fix to *this* task and the implementation did not address it, that is a
> blocking issue (FAILED) — unless a later task still in the range will cover
> it. A deferred fix with no later owner falls through the cracks, and the only
> place to catch it is here. Add it to `issues` and cite where it was routed.

---

## Review Summary

| Aspect | Status | Details |
|--------|--------|---------|
| Acceptance Criteria | ✅/⚠️/❌ | [N/M met] |
| Definition of Done | ✅/⚠️/❌ | [N/M met] |
| Code Quality | ✅/⚠️/❌ | [summary] |
| Spec Compliance | ✅/⚠️/❌ | [summary] |
| Architectural Alignment | ✅/⚠️/❌ | [summary] |

**Overall Status**: **${REVIEW_STATUS}**

---

## Acceptance Criteria & DoD Results

### Acceptance Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| AC-1 | ${CRITERION_TEXT} | ✅ Met / ❌ Not Met / ⚠️ Partial | [file:line or test name] |
| AC-2 | ${CRITERION_TEXT} | ✅ Met / ❌ Not Met / ⚠️ Partial | [file:line or test name] |

### Definition of Done

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | ${DOD_ITEM} | ✅ Met / ❌ Not Met | [evidence] |
| 2 | ${DOD_ITEM} | ✅ Met / ❌ Not Met | [evidence] |

### Definition of Ready (validated post-implementation)

- [x] / [ ] Dependencies were completed before starting
- [x] / [ ] Technical context was understood
- [x] / [ ] Files were identified and accessible
- [x] / [ ] Tooling was available

---

## Code Review Findings

| # | Severity | File | Line(s) | Category | Description | Recommendation |
|---|----------|------|---------|----------|-------------|----------------|
| 1 | 🔴 Critical / 🟡 Warning / 🔵 Info | `${FILE_PATH}` | L${LINE} | Security / Performance / Maintainability / Convention | ${DESCRIPTION} | ${RECOMMENDATION} |
| 2 | ... | | | | | |

<!-- If no findings, state: "No code review findings." -->

---

## Spec Compliance & Architectural Alignment

### Spec Fidelity Check

| AC-ID | Taxonomy | Task Claims | Implementation Matches | Notes |
|-------|----------|-------------|----------------------|-------|
| ${AC_ID} | [IMP]/[SEF]/[EXT] | Yes/No | ✅/❌/⚠️ | ${NOTE} |

### Cross-Boundary Adherence

| File | Expected Context | Actual Context | Status |
|------|-----------------|---------------|--------|
| `${FILE_PATH}` | ${EXPECTED_CONTEXT} | ${ACTUAL_CONTEXT} | ✅ OK / ⚠️ Warning / ❌ Blocking |

<!-- If no cross-boundary issues, state: "All changes within expected bounded context." -->

### Decision Log Check

| DEC-ID | Relevant to Task | Honored in Implementation |
|--------|-----------------|--------------------------|
| ${DEC_ID} | Yes/No | ✅ Yes / ❌ No |

<!-- If no DEC entries, state: "No decision-log entries relevant to this task." -->

### Traceability Matrix Update

- [ ] Test Files column updated in `traceability-matrix.md`
- [ ] Code Files column updated in `traceability-matrix.md`
- [ ] Status updated to "Implemented" for covered REQ-IDs

---

## Required Fixes

> If `review_status` is `PASSED`, state: "No required fixes."
> Every entry listed here must also appear in the `issues` list of the frontmatter.

### Critical (must fix before proceeding)

| # | Issue | File | Action Required |
|---|-------|------|-----------------|
| 1 | ${CRITICAL_ISSUE} | `${FILE_PATH}` | ${ACTION} |

### Warnings (should fix)

| # | Issue | File | Action Required |
|---|-------|------|-----------------|
| 1 | ${WARNING_ISSUE} | `${FILE_PATH}` | ${ACTION} |

### Suggestions (optional improvements)

| # | Suggestion | File | Notes |
|---|-----------|------|-------|
| 1 | ${SUGGESTION} | `${FILE_PATH}` | ${NOTES} |

---

## Next Steps

| If Status | Action |
|-----------|--------|
| `PASSED` | Run Phase T-7 cleanup in `task-implementation`, then proceed to next task |
| `FAILED` | Address every entry of `issues`, re-run the implementation, then re-review |

Findings too large for one implementation pass — an architectural drift, a spec
contradiction, an impossible requirement — are still `FAILED`; say so in the
first `issues` entry so the escalation reaches whoever reads the report.

**Implementation Command** (for re-review after fixes):
```bash
/skill:specs-kit-task-review --task="${TASK_PATH}"
```

**Cleanup Command** (if `PASSED`):
```bash
/skill:specs-kit-task-implementation --task="${TASK_PATH}"
```
