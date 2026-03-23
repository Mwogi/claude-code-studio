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
