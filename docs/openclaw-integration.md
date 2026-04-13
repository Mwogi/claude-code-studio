# OpenClaw ↔ Claude Code Studio Integration

## Overview

Claude Code Studio exposes a REST API for task/kanban management. OpenClaw (or any external automation) can create, monitor, and chain BMAD workflow tasks through this API — making Claude Studio the single execution engine for all coding and planning work.

**Key principle:** All coding and BMAD tasks MUST go through Claude Studio's API. Never run Claude Code CLI directly — it bypasses the kanban, session management, and workflow engine entirely.

## Architecture

```
┌─────────────┐     POST /api/tasks      ┌──────────────────────┐
│   OpenClaw   │ ──────────────────────►  │  Claude Code Studio  │
│  (Gateway)   │                          │   (localhost:3000)   │
│              │  ◄──────────────────────  │                      │
│              │   Webhook events          │  ┌──────────────┐   │
│  - Discord   │   (openclaw-bridge.js)    │  │ Task Worker   │   │
│  - Telegram  │                          │  │ (Claude Code) │   │
│  - Signal    │                          │  └──────────────┘   │
└─────────────┘                          │  ┌──────────────┐   │
                                         │  │ Kanban Board  │   │
                                         │  └──────────────┘   │
                                         └──────────────────────┘
```

### Flow
1. User requests a feature/task via any OpenClaw channel (Discord, Telegram, etc.)
2. OpenClaw creates a task via `POST http://localhost:3000/api/tasks`
3. Claude Studio's task worker picks it up, runs Claude Code, manages the session
4. Task appears on the kanban board with real-time status
5. On completion, `openclaw-bridge.js` fires a webhook event back to OpenClaw
6. OpenClaw notifies the user on their channel

## Authentication

Claude Studio uses cookie-based auth. Store the auth cookie:

```bash
# Login and save cookie
curl -s -c /tmp/ccs.cookie -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"your-password"}'

# All subsequent requests use the cookie
curl -s -b /tmp/ccs.cookie http://localhost:3000/api/tasks
```

## Creating Tasks

### Basic Task

```bash
curl -s -b /tmp/ccs.cookie -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fix login bug",
    "description": "Users get 401 error on login...",
    "workdir": "/home/ubuntu/projects/my-project",
    "status": "todo",
    "model": "sonnet",
    "mode": "auto"
  }'
```

### BMAD Workflow Task

Add `notes` with a `[bmad-workflow:<type>]` tag and set `status: "bmad_workflow"`:

```bash
curl -s -b /tmp/ccs.cookie -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "OTC Sales - Domain Research",
    "description": "Research OTC pharmacy sales in HMIS systems...",
    "workdir": "/home/ubuntu/projects/hmis-lite",
    "status": "bmad_workflow",
    "notes": "[bmad-workflow:domain-research]",
    "model": "opus",
    "mode": "auto"
  }'
```

### Available BMAD Workflows

| Workflow Tag | Label | Agent | Description |
|---|---|---|---|
| `domain-research` | 🌐 Domain Research | analyst | Domain/industry research |
| `market-research` | 📊 Market Research | analyst | Competition and customer research |
| `technical-research` | 🔭 Technical Research | analyst | Technology and architecture research |
| `analysis` | 🔍 Analysis | analyst | Product brief creation |
| `planning` | 📋 Planning → PRD | product-manager | PRD creation |
| `ux-design` | 🎨 UX Design | ux-designer | UX wireframes and specs |
| `solutioning` | 🏗️ Solutioning | architect | Architecture + Epics |
| `sprint-planning` | 📐 Sprint Planning | scrum-master | sprint-status.yaml + story tasks |
| `create-story` | 📝 Create Story | product-manager | Detailed story from epic |
| `dev-story` | 💻 Dev Story | developer | Implement a story |
| `code-review` | 🔍 Code Review | developer | Senior dev review |
| `readiness-check` | ✅ Readiness Check | architect | Validate artifacts before impl |
| `playwright-qa` | 🎭 Playwright QA | qa | Browser-based testing |
| `retrospective` | 🔮 Retrospective | scrum-master | Epic completion retrospective |

### Task Chaining

Chain tasks so they execute in sequence using `chain_id`, `sort_order`, and `after`:

```bash
# Task 1: Domain Research
curl -s -b /tmp/ccs.cookie -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Feature X - Domain Research",
    "workdir": "/path/to/project",
    "status": "bmad_workflow",
    "notes": "[bmad-workflow:domain-research]",
    "model": "opus",
    "chain_id": "feature-x-planning",
    "sort_order": 1
  }'
# Returns: { "id": "abc123", ... }

# Task 2: PRD (after research)
curl -s -b /tmp/ccs.cookie -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Feature X - PRD",
    "workdir": "/path/to/project",
    "status": "bmad_workflow",
    "notes": "[bmad-workflow:planning]",
    "model": "opus",
    "chain_id": "feature-x-planning",
    "sort_order": 2,
    "after": "abc123"
  }'

# Task 3: UX Design (after PRD)
curl -s -b /tmp/ccs.cookie -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Feature X - UX Design",
    "workdir": "/path/to/project",
    "status": "bmad_workflow",
    "notes": "[bmad-workflow:ux-design]",
    "model": "opus",
    "chain_id": "feature-x-planning",
    "sort_order": 3,
    "after": "<prd-task-id>"
  }'
```

### Dependency Groups (dep_group)

For sprint-based parallel execution, use `dep_group` and `depends_on`:

- **`dep_group`**: Groups a story's dev task with its auto-spawned QA and Fix tasks (e.g. `"S1.1"` for Epic 1, Story 1)
- **`depends_on`**: JSON array of dependencies using `"group:S1.1"` syntax — waits for ALL tasks in that group to complete
- Auto-chained QA and Fix tasks **inherit `dep_group`** from their parent automatically
- Tasks without `depends_on` run in parallel; tasks with group deps wait for the full group (dev+QA+fix) to finish

```json
// Story 1.1 — no dependencies, runs immediately
{
  "title": "User Authentication",
  "dep_group": "S1.1",
  "chain_id": "epic-1",
  "sort_order": 1
}

// Story 1.2 — depends on story 1.1 completing (including QA/fixes)
{
  "title": "Account Management",
  "dep_group": "S1.2",
  "depends_on": "[\"group:S1.1\"]",
  "chain_id": "epic-1",
  "sort_order": 2
}

// Story 2.1 — independent epic, runs in parallel with epic 1
{
  "title": "Dashboard Layout",
  "dep_group": "S2.1",
  "chain_id": "epic-2",
  "sort_order": 1
}
```

**Cascade behavior:** If a group dependency fails (task cancelled/failed), dependent tasks are also cancelled.

## Task API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET /api/tasks` | List all tasks | |
| `GET /api/tasks/:id` | Get single task | |
| `POST /api/tasks` | Create task | |
| `PUT /api/tasks/:id` | Full update | |
| `PATCH /api/tasks/:id` | Partial update | |
| `DELETE /api/tasks/:id` | Delete task | |
| `POST /api/tasks/:id/run` | Trigger task | |
| `POST /api/tasks/:id/reply` | Reply to awaiting_input task | |
| `GET /api/tasks/:id/result` | Get task result | |
| `GET /api/tasks/running-sessions` | List active sessions | |

### Task Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `title` | string | "New Task" | Task title (max 200 chars) |
| `description` | string | "" | Task description (max 2000 chars) |
| `notes` | string | "" | Internal notes, BMAD workflow tags |
| `status` | string | "backlog" | `backlog`, `bmad_workflow`, `todo`, `in_progress`, `done`, `done_review` |
| `workdir` | string | null | Project working directory |
| `model` | string | "sonnet" | Claude model: `opus`, `sonnet`, `haiku` |
| `mode` | string | "auto" | Execution mode |
| `max_turns` | number | 30 | Max Claude conversation turns |
| `chain_id` | string | null | Chain identifier for task sequencing |
| `sort_order` | number | 0 | Order within chain |
| `after` | string | null | Dependency task ID (auto-sets chain) |
| `dep_group` | string | null | Dependency group ID (e.g. "S1.1"). Groups a dev task with its auto-spawned QA and Fix tasks. |
| `depends_on` | string (JSON) | null | JSON array of dependencies. Use `"group:S1.1"` to wait for all tasks in a dep_group. |

## OpenClaw Agent Configuration

In your OpenClaw workspace, add this to `TOOLS.md` so the agent knows how to route tasks:

```markdown
## Claude Code Studio (Port 3000)

- **URL:** http://localhost:3000
- **Auth:** Cookie at `/tmp/ccs.cookie`
- **API:** `POST /api/tasks` to create kanban cards
- **BMAD Workflows:** Use `notes: "[bmad-workflow:<type>]"` + `status: "bmad_workflow"`
- **Chaining:** Use `chain_id` + `sort_order` + `after`
- **Parallel deps:** Use `dep_group` + `depends_on` with `"group:S1.1"` syntax

### ⚠️ CRITICAL RULE
ALL coding/BMAD tasks MUST go through Claude Studio's API — NEVER run Claude Code CLI directly.
```

## Monitoring Tasks

### Poll task status
```bash
curl -s -b /tmp/ccs.cookie http://localhost:3000/api/tasks/<id> | jq '{status, worker_pid, failure_reason}'
```

### Get task result
```bash
curl -s -b /tmp/ccs.cookie http://localhost:3000/api/tasks/<id>/result
```

## Webhook Events (Studio → OpenClaw)

Configure `openclaw-bridge.js` to send events back to OpenClaw on task completion/failure. Set environment variables:

```bash
OPENCLAW_API_URL=http://localhost:18789/api
OPENCLAW_API_KEY=your-key
OPENCLAW_EVENTS=task_complete,task_failed,task_started
```

## Common Pitfalls

1. **Don't run Claude Code CLI directly** — it bypasses the kanban and workflow engine
2. **Don't use OpenClaw ACP sessions for BMAD tasks** — they're invisible to Claude Studio
3. **Always include `workdir`** — BMAD workflows need it to find project files
4. **Use `status: "bmad_workflow"` not `"todo"`** for BMAD tasks — auto-correction exists but be explicit
5. **Cookie expiry** — if API returns 401, re-login and save a fresh cookie
6. **Model choice** — use `opus` for planning/research, `sonnet` for implementation/stories
