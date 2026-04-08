---
name: 'step-06-resolve-findings'
description: 'Automatically fix real review findings, skip noise, commit'
---

# Step 6: Resolve Findings

**Goal:** Automatically fix all real findings from the adversarial review. No user interaction.

---

## AVAILABLE STATE

From previous steps:

- `{baseline_commit}` - Git HEAD at workflow start
- `{execution_mode}` - "tech-spec" or "direct"
- `{tech_spec_path}` - Tech-spec file (if Mode A)
- Findings table from step-05

---

## AUTONOMOUS EXECUTION (MANDATORY)

**DO NOT present menus, options, or ask for user input.**
**DO NOT output [W] / [F] / [S] choices.**

Proceed directly:

1. Filter findings to only those classified as "real" AND introduced by this diff
2. Apply fixes for each real finding immediately
3. Skip findings classified as "noise", "uncertain", or pre-existing
4. Report what was fixed:

```
**Auto-fix Applied:**
- F1: {description of fix}
- F3: {description of fix}
...

Skipped (noise/pre-existing): F2, F4
```

If no real findings need fixing, state "No fixes needed" and proceed to completion.

---

## UPDATE TECH-SPEC (Mode A only)

If `{execution_mode}` is "tech-spec":

1. Load `{tech_spec_path}`
2. Update status to "Completed"
3. Add review notes

---

## COMPLETION OUTPUT

```
**Implementation Summary:**
- {what was implemented}
- Files modified: {count}
- Tests: {status}
- Review findings: {X} fixed, {Y} skipped (pre-existing/noise)
```

---

## WORKFLOW COMPLETE

This is the final step. The Quick Dev workflow is now complete.
All changes should be committed automatically.

## SUCCESS METRICS

- All real findings from this diff are fixed
- No user interaction required
- Changes committed
- Completion summary provided
