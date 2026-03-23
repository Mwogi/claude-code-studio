# Story: Fix: Missing testing-info.md + BMAD sync hardening

Status: in-progress
Task ID: mn3fv97jq93gk2
Task Number: #16
Workflow: quick-dev
Model: sonnet
Created: 2026-03-23T17:07:34.880Z

## Description

## QA Findings from Task #14 (Adversarial Review of Task #13)

### P1: Missing docs/testing-info.md
The file docs/testing-info.md does not exist. All QA tasks reference it for login credentials and dev server URL. Without it, no browser-based QA testing is possible. Create this file with:
- Dev server URL (localhost:3000)
- Login credentials
- Any test-specific configuration

### P2: Duplicate recurring BMAD sync tasks
Tasks #12, #13, #15 are all recurring daily sync tasks. Should be consolidated to one.

### P2: Hardcoded project paths in sync
Sync upgrades a static list of 5 project dirs. Should discover projects dynamically from the tasks database (SELECT DISTINCT workdir FROM tasks).

### P2: No post-upgrade validation
After running npx bmad-method install, no smoke test verifies the upgrade succeeded.

### P2: Commit includes unrelated files (tasks.db, story files)
Sync commits should only touch docs/bmad-sync-log.md and integration files.

See full report: docs/qa-report-task-13.md

## Acceptance Criteria

- [ ] Implementation matches task description
- [ ] No regressions introduced
- [ ] Code compiles/builds without errors

## Tasks / Subtasks

- [ ] Implement changes
- [ ] Verify build passes

## Dev Notes



### References

- Task source: Claude Code Studio task #16

## Dev Agent Record

### Agent Model Used

sonnet

### Completion Notes List

_(Updated by agent on completion)_

### Change Log

_(Updated by agent during implementation)_

### File List

_(Updated by agent — list all files created or modified)_
