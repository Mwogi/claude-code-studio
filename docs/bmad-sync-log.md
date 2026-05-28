# BMAD Sync Log

Daily automated sync log tracking BMAD METHOD repository updates.

---

## 2026-03-23T17:00:00Z

**Version checked:** v6.2.0 (latest: v6.2.0 — no upgrade needed for claude-code-studio)
**Latest release date:** 2026-03-15

### Recent Commits (last 24h — since 2026-03-22)

| SHA | Date | Message |
|-----|------|---------|
| 48152507 | 2026-03-23 | fix(quick-dev): remove redundant H1 title from spec template |
| b3cf3381 | 2026-03-23 | refactor(quick-dev): rename tech-spec prefix to spec |
| fc2b253a | 2026-03-23 | fix(quick-dev): preserve tracking identifiers in spec slug derivation |
| ac5cb9de | 2026-03-23 | refactor(quick-dev): replace unconditional artifact scan with intent cascade |
| 980d2904 | 2026-03-22 | fix(quick-dev): add self-check gate for task completion tracking |
| 76fb7e06 | 2026-03-22 | docs(zh-cn): refine established project guides |
| ad2eb0e1 | 2026-03-22 | docs(zh-cn): refine install and non-interactive guides |
| 7e97b7e7 | 2026-03-22 | fix(docs): correct skill names in getting-started tutorials |
| ba2a5cc6 | 2026-03-22 | docs(zh-cn): align getting-started tutorial workflows |
| 347f459d | 2026-03-22 | docs(zh-cn): refine entry copy and navigation |

### Analysis

**Breaking changes:** None. All commits are internal quick-dev workflow fixes/refactors and zh-cn documentation updates.

**New agents/workflows:** None detected.

**Impact to server.js integration:** None — all changes are internal to `bmad-quick-dev` skill workflow files (spec template, step files). No new BMAD_WORKFLOWS entries or WORKFLOW_TO_PHASE mappings required.

**Notable changes in quick-dev skill:**
- `tech-spec` mode renamed to `spec` internally in workflow files
- Added self-check gate at task completion
- Replaced unconditional artifact scan with intent cascade
- Spec template H1 title removed (reduces redundancy)

### Changes Implemented

1. **No server.js changes required** — no new agents or workflows
2. **Project BMAD installations updated** — 5 projects upgraded from v6.0.4 → v6.2.0:
   - `/home/ubuntu/frappe-bench/apps/golf_casino` ✅ v6.2.0
   - `/home/ubuntu/flutter` ✅ v6.2.0
   - `/home/ubuntu/frappe-bench/apps/hmis_frontend` ✅ v6.2.0
   - `/home/ubuntu/frappe-bench/apps/hmis_setup` ✅ v6.2.0
   - `/home/ubuntu/.openclaw/workspace/vue-apps/hmis-lite` ✅ v6.2.0

### NOT Implemented (manual review recommended)

- zh-cn documentation updates — docs-only, no action needed
- quick-dev spec template changes — installed via `npx bmad-method install --action update -y`; will be picked up on next agent invocation

---

## 2026-03-22T19:48:58Z

**Version checked:** v6.2.0 (latest: v6.2.0 — no upgrade needed)
**Current install:** 2026-03-18 | Latest release: 2026-03-15

### Recent Commits (since install date 2026-03-18)

| SHA | Date | Message |
|-----|------|---------|
| 76fb7e06 | 2026-03-22 | docs(zh-cn): refine established project guides |
| ad2eb0e1 | 2026-03-22 | docs(zh-cn): refine install and non-interactive guides |
| 7e97b7e7 | 2026-03-22 | fix(docs): correct skill names in getting-started tutorials |
| 10282a4a | 2026-03-21 | fix(quick-dev): use absolute paths in code -r invocations |
| a59ae5c8 | 2026-03-21 | fix(quick-dev): make file path references clickable |
| ad9cb7a1 | 2026-03-21 | refactor(installer): remove dead .agent.yaml/.xml fallback logic |
| 93a1e1dc | 2026-03-21 | refactor(installer): remove dead task/tool/workflow manifest code |
| 31ae226b | 2026-03-21 | refactor(installer): discover skills by SKILL.md instead of manifest YAML |
| 6a73623f | 2026-03-20 | refactor(core-skills): flatten 7 skills by inlining workflow.md into SKILL.md |
| 18255040 | 2026-03-20 | fix(code-review): update sprint-status to done after review completes |

### Analysis

**Breaking changes:** None. Commits are docs, refactors, and fixes — no API-breaking changes.

**New skills detected in `.claude/skills/` not previously integrated:**

| Skill | Type |
|-------|------|
| `bmad-domain-research` | Research |
| `bmad-market-research` | Research |
| `bmad-technical-research` | Research |
| `bmad-product-brief-preview` | Analysis |
| `bmad-quick-dev-new-preview` | Implementation |
| `bmad-quick-flow-solo-dev` | Implementation |

**New agent detected:** `quick-flow-solo-dev.md` in `_bmad/bmm/agents/`

### Changes Implemented

1. **`server.js` — `BMAD_WORKFLOWS` additions:**
   - `domain-research` — 🌐 Domain Research (analyst agent, opus)
   - `market-research` — 📊 Market Research (analyst agent, opus)
   - `technical-research` — 🔭 Technical Research (analyst agent, opus)
   - `product-brief-preview` — 📄 Product Brief (Preview) (analyst agent, opus)
   - `quick-dev-new-preview` — 🚀 Quick Dev (New Preview) (developer agent, sonnet, maxTurns:100)
   - `quick-flow-solo-dev` — 🎯 Quick Flow Solo Dev (developer agent, sonnet, maxTurns:100)

2. **`server.js` — `WORKFLOW_TO_PHASE` additions:**
   - `domain-research`, `market-research`, `technical-research` → `bmad_brainstorm`
   - `product-brief-preview` → `bmad_brainstorm`
   - `quick-dev-new-preview`, `quick-flow-solo-dev` → `bmad_implementation`

3. **`public/kanban.html` — Workflow dropdown additions:**
   - Analysis group: `product-brief-preview`, `domain-research`, `market-research`, `technical-research`
   - Implementation group: `quick-dev-new-preview`, `quick-flow-solo-dev`

### NOT Implemented (manual review recommended)

- Installer refactoring (remove dead manifest code) — affects `npx bmad-method install` internals, not our integration
- Docs-only changes (zh-cn translations, tutorial fixes)

---

## 2026-04-26 — BMM 6.2.0 → 6.5.0

### Version
- **Previous:** BMad Core 6.5.0 (no change), BMM 6.2.0
- **Updated to:** BMM 6.5.0
- 42 skills installed to `.claude/skills`

### New Skills (10 added, 4 removed)

**Added:**
- `bmad-customize` (core) — Customization overrides for installed skills
- `bmad-agent-analyst` (bmm) — Agent: Mary the business analyst
- `bmad-agent-tech-writer` (bmm) — Agent: Paige the tech writer
- `bmad-agent-pm` (bmm) — Agent: John the product manager
- `bmad-agent-ux-designer` (bmm) — Agent: Sally the UX designer
- `bmad-agent-architect` (bmm) — Agent: Winston the system architect
- `bmad-agent-dev` (bmm) — Agent: Amelia the developer
- `bmad-prfaq` (bmm) — Working Backwards PRFAQ challenge
- `bmad-product-brief` (bmm) — Replaces `bmad-create-product-brief` + `bmad-product-brief-preview`
- `bmad-checkpoint-preview` (bmm) — Human-in-the-loop review checkpoints

**Removed (merged/renamed):**
- `bmad-create-product-brief` → merged into `bmad-product-brief`
- `bmad-product-brief-preview` → merged into `bmad-product-brief`
- `bmad-quick-dev-new-preview` → removed
- `bmad-quick-spec` → removed

### Structural Changes
- Skill paths restructured: `_bmad/core/skills/X/` → `_bmad/core/X/`, `_bmad/bmm/workflows/` → `_bmad/bmm/`
- `install_to_bmad` column removed from manifests
- Agent and workflow manifests: unchanged

### server.js Integration Recommendations

1. **`BMAD_WORKFLOWS` updates needed:**
   - `product-brief-preview` — skill `bmad-product-brief-preview` no longer exists; replace with `bmad-product-brief`
   - `quick-dev-new-preview` — skill `bmad-quick-dev-new-preview` removed; consider removing or mapping to `bmad-agent-dev`
   - `analysis` — prompt references old path `workflows/1-analysis/create-product-brief/`; may need path update to `1-analysis/bmad-product-brief/`
   - **New workflow candidates:**
     - `prfaq` — map to `bmad-prfaq` skill (analyst agent)
     - `checkpoint` — map to `bmad-checkpoint-preview` skill (review agent)
   - **Agent skills** (`bmad-agent-*`) are persona skills, not workflow skills — no BMAD_WORKFLOWS entries needed

2. **`public/kanban.html` dropdown:**
   - Consider adding `prfaq` (📝 PRFAQ Challenge) to Analysis group
   - `product-brief-preview` label could be updated to just "Product Brief" since it's now the only one
   - `quick-dev-new-preview` dropdown entry references removed skill

### Project Installations Updated
- ✅ `/home/ubuntu/claude-code-studio/` (main)
- ✅ `/home/ubuntu/frappe-bench/apps/hmis_frontend/`
- ✅ `/home/ubuntu/.openclaw/workspace/vue-apps/hmis-lite/`
- ⚠️ `/home/ubuntu/frappe-bench/apps/golf_casino/` — directory not found
- ⚠️ `/home/ubuntu/flutter/` — directory not found
- ⚠️ `/home/ubuntu/frappe-bench/apps/hmis_setup/` — directory not found

---

## 2026-04-27 — No update needed

- **Installed:** 6.5.0
- **Latest:** 6.5.0
- No action taken.

---

## 2026-04-28 03:00 UTC — Daily Sync Check
- **Installed version:** 6.5.0
- **Latest npm version:** 6.5.0
- **Result:** No update needed — versions match
- **Projects checked:** N/A (no upgrade required)

## 2026-04-29 03:00 UTC — Daily Sync Check
- **Installed version:** 6.5.0
- **Latest npm version:** 6.5.0
- **Result:** No update needed. Versions match.

## 2026-04-30 03:00 UTC — Daily Sync Check
- **Previous version:** 6.5.0
- **Upgraded to:** 6.6.0
- **New agents/workflows/skills:** None (manifests unchanged — bugfix/infra release)
- **Path changes:** None (42 skills in `.claude/skills/`, structure unchanged)
- **Broken path references in server.js:** None detected
- **Projects upgraded:**
  - `/home/ubuntu/claude-code-studio` ✓
  - `/home/ubuntu/frappe-bench/apps/hmis_frontend` ✓
  - `/home/ubuntu/frappe-bench/apps/hmis` ✓
  - `/home/ubuntu/frappe-bench/apps/helpdesk` ✓
  - `/home/ubuntu/projects/devbox` ✓
  - `/home/ubuntu/projects/hmis-lite` ✓
- **server.js integration recommendations:** None — no new workflows to add

## 2026-05-01 (03:00 UTC)
- **Version check:** installed 6.6.0, latest 6.6.0
- **Result:** No update needed
- **Projects:** N/A (no upgrade required)

## 2026-05-02 03:00 UTC
- **Installed:** 6.6.0 | **Latest:** 6.6.0
- No update needed

## 2026-05-03 (03:00 UTC) - Daily Sync Check
- **Latest npm version:** 6.6.0
- **Installed version:** 6.6.0
- **Result:** No update needed
- **Projects checked:** N/A (no upgrade required)

## 2026-05-04 (03:00 UTC) — No Update
- **Installed:** 6.6.0
- **Latest npm:** 6.6.0
- **Result:** No update needed

## 2026-05-05 (03:00 UTC) — Automated Sync Check
- **Latest npm version:** 6.6.0
- **Installed version:** 6.6.0
- **Result:** No update needed
- **Projects checked:** N/A (no upgrade required)

## 2026-05-06 03:00 UTC — No Update Needed
- Installed: 6.6.0 | Latest: 6.6.0
- No action taken.

## 2026-05-07 (03:00 UTC)
- **Checked:** bmad-method v6.6.0
- **Installed:** v6.6.0
- **Result:** No update needed — versions match

## 2026-05-08 (03:00 UTC)
- **Installed:** 6.6.0 | **Latest:** 6.6.0
- No update needed

## 2026-05-09 (03:00 UTC) — No Update
- **Installed:** 6.6.0
- **Latest (npm):** 6.6.0
- **Result:** Versions match. No action taken.

## 2026-05-10 (03:00 UTC)
- **Version check:** installed 6.6.0 = latest 6.6.0
- **Result:** No update needed

## 2026-05-11 03:00 UTC — Daily Sync Check
- **Installed:** 6.6.0 | **Latest:** 6.6.0
- **Result:** No update needed

## 2026-05-12 03:00 UTC — No Update
- Installed: 6.6.0 | Latest: 6.6.0
- No update needed

## 2026-05-13 03:00 UTC — No Update
- Installed: 6.6.0 | Latest: 6.6.0
- Status: No update needed

## 2026-05-14 03:00 UTC — No Update
- Installed: 6.6.0 | Latest: 6.6.0
- No action needed

## 2026-05-15 03:00 UTC — No Update
- Installed: 6.6.0 | Latest: 6.6.0
- No action needed

## 2026-05-16 03:00 UTC — Daily Sync Check
- **Latest npm version:** 6.6.0
- **Installed version:** 6.6.0
- **Result:** No update needed — versions match
- **Projects checked:** N/A (no upgrade required)

## 2026-05-17 03:00 UTC — Daily Sync Check
- **Installed version:** 6.6.0
- **Latest npm version:** 6.6.0
- **Result:** No update needed. Versions match.

## 2026-05-18 — v6.6.0 → v6.7.0 ✅ Upgraded

- **Previous:** 6.6.0 | **New:** 6.7.0
- **Projects updated:** All 6 (Claude Studio + hmis_frontend + hmis + helpdesk + devbox + hmis-lite)
  - hmis-lite jumped from 6.5.0 → 6.7.0
- **New skills (2):**
  - `bmad-prd` — Consolidated PRD skill (create/update/validate). Replaces deprecated `bmad-create-prd`, `bmad-edit-prd`, `bmad-validate-prd` (removed in v7)
  - `bmad-investigate` — Forensic case investigation with evidence-graded findings (bug traces, incident analysis, code exploration)
- **Modified skills:**
  - `bmad-product-brief` — Description updated (now includes "validate" intent)
  - `bmad-create-prd`, `bmad-edit-prd`, `bmad-validate-prd` — Marked DEPRECATED, consolidated into `bmad-prd`
- **Agents:** No changes
- **Workflows:** No changes
- **Broken paths in server.js:** None (all paths use `.claude/skills/` — correct)
- **server.js integration recommendations:**
  - ⚠️ `bmad-prd` is new and NOT in BMAD_WORKFLOWS — consider adding as a unified PRD workflow replacing separate create/edit/validate entries
  - ⚠️ `bmad-investigate` is new and NOT in BMAD_WORKFLOWS — consider adding for bug investigation tasks
  - Deprecated skills (`bmad-create-prd`, `bmad-edit-prd`, `bmad-validate-prd`) still work but will be removed in v7 — plan migration to `bmad-prd`
- **kanban.html:** No new workflow dropdown entries needed (new skills are not phase-based)

## 2026-05-19 — Patch Update 6.7.0 → 6.7.1

- **Version:** 6.7.0 → 6.7.1 (patch)
- **New agents/workflows/skills:** None (manifests unchanged)
- **Broken path references:** None
- **server.js integration:** No changes needed
- **Projects updated (all successful):**
  - `/home/ubuntu/claude-code-studio` (Claude Studio itself)
  - `/home/ubuntu/frappe-bench/apps/hmis_frontend` (HMIS Frontend)
  - `/home/ubuntu/frappe-bench/apps/hmis` (HMIS Backend)
  - `/home/ubuntu/frappe-bench/apps/helpdesk` (Helpdesk)
  - `/home/ubuntu/projects/devbox` (Tiberbu DevBox)
  - `/home/ubuntu/projects/hmis-lite` (HMIS Lite)
- **kanban.html:** No changes needed

## 2026-05-20 03:00 UTC — No Update
- Installed: 6.7.1 | Latest: 6.7.1 — no update needed

## 2026-05-21 03:00 UTC — No Update
- Installed: 6.7.1 | Latest: 6.7.1 — no update needed

## 2026-05-22 03:00 UTC — No Update
- **Installed:** 6.7.1 | **Latest:** 6.7.1
- No update needed. All installations current.

## 2026-05-23 03:00 UTC — No Update Needed
- **Installed:** 6.7.1 | **Latest:** 6.7.1
- No action taken.

## 2026-05-24 03:00 UTC — No Update Needed
- Latest npm version: 6.7.1
- Installed version: 6.7.1
- Action: None required

## 2026-05-25 03:00 UTC — No Update Needed
- Latest npm version: 6.7.1
- Installed version: 6.7.1
- Action: None required

## 2026-05-26 03:00 UTC — Upgraded to 6.8.0
- Previous: 6.7.1 → New: 6.8.0
- **Skills renamed:**
  - `bmad-distillator` → `bmad-spec` (new path: `.claude/skills/bmad-spec/SKILL.md`)
  - `bmad-create-ux-design` → `bmad-ux` (new path: `.claude/skills/bmad-ux/SKILL.md`)
- **No new workflows/agents added** (just renames)
- **Projects updated:** hmis_frontend, hmis, helpdesk, devbox, hmis-lite (all 5 successful)
- **⚠️ Broken paths in server.js:**
  1. Line 181: `skills: ['bmad-create-ux-design']` → should be `'bmad-ux'`
  2. Line 183: prompt references `.claude/skills/bmad-create-ux-design/SKILL.md` → should be `.claude/skills/bmad-ux/SKILL.md`
  3. Line 314: `skills: ['bmad-distillator']` → should be `'bmad-spec'`
  4. Line 316: prompt references `_bmad/core/bmad-distillator/SKILL.md` → should be `.claude/skills/bmad-spec/SKILL.md`
- **kanban.html:** Dropdown labels still say "UX Design" and "Distillator" — workflow keys (`ux-design`, `distillator`) still work if server.js is fixed, but consider renaming dropdown labels
- **Recommendation:** Update server.js BMAD_WORKFLOWS entries for `ux-design` and `distillator` to reference new skill names and paths

## 2026-05-27 03:00 UTC — No Update
- Latest npm version: 6.8.0
- Installed version: 6.8.0
- Status: versions match, no action taken

## 2026-05-28 03:00 UTC — No Update
- Latest npm version: 6.8.0
- Installed version: 6.8.0
- Status: versions match, no action needed
