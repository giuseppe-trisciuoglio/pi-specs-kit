# Task List: ${FEATURE_NAME}

**Specification**: ${SPEC_PATH}
**Generated**: ${DATE}
**Language**: ${LANG}

## Codebase Analysis Summary

- **Project Structure**: ${PROJECT_STRUCTURE_SUMMARY}
- **Key Patterns**: ${KEY_PATTERNS}
- **Integration Points**: ${INTEGRATION_POINTS}

## Task Index

| Task ID | Title | Technical Focus | Status | Dependencies |
|---------|-------|-----------------|--------|--------------|
| [TASK-001](tasks/TASK-001.md) | ${TASK_TITLE_1} | ${TASK_FOCUS_1} | [ ] | - |
| [TASK-002](tasks/TASK-002.md) | ${TASK_TITLE_2} | ${TASK_FOCUS_2} | [ ] | TASK-001 |
| ... | ... | ... | ... | ... |
| [TASK-N-1](tasks/TASK-N-1.md) | Documentation | [doc files] | [ ] | TASK-001, TASK-002, ... |
| [TASK-N](tasks/TASK-N.md) | Code Cleanup & Hygiene | [all modified files] | [ ] | TASK-N-1 |

**Legend**:
- [DOCS] = Documentation task (produces README, AGENTS, and technical notes)
- [CLEANUP] = Code cleanup task (uses specs-kit-code-cleanup skill)

## Tasks

Each task has its own detailed file with technical context:
- [TASK-001](tasks/TASK-001.md): ${TASK_TITLE_1}
- [TASK-002](tasks/TASK-002.md): ${TASK_TITLE_2}
- ...
- [TASK-N-1](tasks/TASK-N-1.md): Documentation (produces README, AGENTS, and technical notes)
- [TASK-N](tasks/TASK-N.md): Code Cleanup & Workspace Hygiene (final cleanup)

## Task Type Summary

- **Implementation Tasks** (TASK-001 to TASK-N-2): Core feature implementation
- **Documentation Task** (TASK-N-1): README, AGENTS, and technical notes for the feature
- **Cleanup Task** (TASK-N): Final code quality and hygiene cleanup
