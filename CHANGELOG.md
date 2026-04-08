# Claude Code Studio — Tiberbu Fork Changelog

> Fork: [Mwogi/claude-code-studio](https://github.com/Mwogi/claude-code-studio)
> Upstream: [Mwogi/claude-code-studio](https://github.com/Mwogi/claude-code-studio)
> Branch: `feature/bmad-openclaw-integration`

## What This Fork Adds

This fork transforms Claude Code Studio from a basic chat UI into a **full SDLC orchestration platform** with BMAD Method integration, Kanban-driven task management, multi-agent workflows, and OpenClaw/Discord notifications.

---

## 🏗️ Major Features

### 1. BMAD Method Integration (34 Workflows)
- Full [BMAD Method](https://github.com/bmad-method/bmad-method) framework auto-installed on every new project (`npx bmad-method install`)
- All 34 BMAD workflows available: Brainstorm, PRD, Architecture, Implementation, QA, Sprint Planning, Retrospective, etc.
- BMAD Master agent as single orchestrator delegating to specialized agents per phase
- Party Mode for collaborative Brainstorm and Architecture phases
- Advanced elicitation methods for requirements gathering
- Workflow columns on Kanban: `Backlog → 🔮 BMAD Queue → Brainstorm → PRD → Architecture → Implementation → QA → Done`

### 2. Kanban Task Management (Complete Overhaul)
- **Side-by-side layout**: Kanban board + live chat panel
- **Task cards** with status badges, activity timers, task numbers (#N)
- **BMAD workflow columns** that tasks visually move through
- **Auto Mode**: Autonomous task execution with configurable concurrency (per-project, up to 8 global workers)
- **Task chaining**: Sequential execution within chains (sort_order enforced)
- **Auto-incrementing task numbers** per project
- **Archive column**: Auto-moves done tasks after 48h
- **Done for Review column**: AI-completed tasks awaiting human review
- **Mobile responsive**: Snap-scroll columns, full-screen modals on phones

### 3. Multi-Agent Task Workers
- Parallel Claude Code subprocess workers (`MAX_TASK_WORKERS=8`)
- Per-workdir concurrency limits (`MAX_PER_WORKDIR=5`)
- Model routing: Opus for creative/analytical, Sonnet for implementation/QA
- MCP servers passed to task workers (Playwright, Git, GitHub, etc.)
- Autonomous execution: agents never present interactive menus
- Auto-commit for implementation task outputs
- Timed-out task detection + auto-retry (up to 2 retries with continuation context)
- Completion marker detection (checks output tail for `✅ Done`, `VERIFICATION`, etc.)

### 4. QA Pipeline
- Mandatory QA task chaining: every dev task auto-creates a Playwright QA follow-up
- QA tasks are READ-ONLY (no code modifications)
- Playwright MCP browser testing (not code-only review)
- Only P0/P1 issues create fix tasks; P2/P3 are report-only
- ONE consolidated fix task per QA pass (prevents infinite loops)
- Fix tasks don't spawn further QA (depth limit = 1)
- Dedicated `playwright-qa` workflow bypassing BMAD adversarial-review

### 5. Sprint Planning & Story Management
- `sprint-status.yaml` bidirectional sync
- BMAD story files with structured acceptance criteria
- Two-path workflow: full pipeline vs quick-dev
- Auto-epic progression: when all tasks in an epic complete, auto-activate next epic

### 6. OpenClaw / Discord Integration
- Real-time Discord notifications with project name + task numbers (#N)
- Project-specific Discord thread routing
- Interactive task conversations: `awaiting_input` status, reply from Kanban
- OpenClaw bridge (`openclaw-bridge.js`) for CLI notifications

### 7. Document Management
- Document preview/download/upload panel
- Collapsible folder tree sidebar with search
- Image preview + binary file handling
- Shareable read-only document links via web URL
- File sharing with Content-Type headers and clipboard copy (HTTP fallback)
- Support for `.md`, `.docx`, `.pdf`, `.json`, `.csv`, images

### 8. Screenshot Management
- Task-linked naming: `task-{ID}-{NN}-{desc}.png`
- Auto-cleanup on task archive
- 48h purge for orphaned screenshots
- API endpoints for screenshot CRUD

### 9. MCP Server Management
- Pre-configured MCP servers (see below)
- Add/edit/remove via UI modals
- Servers passed to all task workers

---

## 🔧 Pre-Configured MCP Servers

The `config.example.json` ships with these servers. Copy to `config.json` and fill in API keys:

| Server | Purpose | Package |
|--------|---------|---------|
| Git | Branch, commit, diff, log, blame | `mcp-server-git` |
| GitHub | PRs, issues, CI, code review | `@modelcontextprotocol/server-github` |
| Sequential Thinking | Chain-of-thought reasoning | `@modelcontextprotocol/server-sequential-thinking` |
| Memory | Persistent knowledge graph | `@modelcontextprotocol/server-memory` |
| Context7 | Up-to-date library docs | `@upstash/context7-mcp@latest` |
| Playwright | Browser automation, E2E testing | `@playwright/mcp@latest` |

Optional (in example config, needs API keys):
| Server | Purpose |
|--------|---------|
| Tavily Search | Web search |
| Web Search Prime (Z.ai) | Advanced web search |
| Web Reader (Z.ai) | Web page extraction |
| Frappe MCP | ERPNext/Frappe API access |

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Claude CLI (`claude` command available)
- Anthropic API key (set as `ANTHROPIC_API_KEY` environment variable for Claude CLI)

### Setup

```bash
# Clone
git clone https://github.com/Mwogi/claude-code-studio.git
cd claude-code-studio
git checkout feature/bmad-openclaw-integration

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env — set SESSION_SECRET, adjust MAX_TASK_WORKERS if needed

# Configure MCP servers
cp config.example.json config.json
# Edit config.json:
#   - Set GITHUB_PERSONAL_ACCESS_TOKEN for GitHub MCP
#   - Remove or configure optional servers (Tavily, Z.ai, Frappe)
#   - All servers in config.json are auto-enabled for task workers

# Start
node server.js
# or with systemd (see below)

# Open browser
open http://localhost:3000
```

### Default Login
- Password: set via the UI on first visit (stored in `data/auth.json`)

### systemd Service (Production)

```ini
[Unit]
Description=Claude Code Studio
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/claude-code-studio
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp claude-code-studio.service /etc/systemd/system/
sudo systemctl enable claude-code-studio
sudo systemctl start claude-code-studio
```

---

## 📁 Key Files

| File | Purpose |
|------|---------|
| `server.js` | Main server (7600 lines) — API, task workers, BMAD orchestration |
| `claude-cli.js` | Claude subprocess wrapper with MCP injection |
| `public/kanban.html` | Kanban board UI (3700 lines) |
| `public/index.html` | Chat interface |
| `openclaw-bridge.js` | OpenClaw CLI notification bridge |
| `openclaw-notify.js` | Discord notification helper |
| `discord-bmad-bridge.js` | Discord thread routing for BMAD phases |
| `config.json` | MCP servers, skills, slash commands (gitignored) |
| `config.example.json` | Template config with all available MCP servers |
| `data/` | SQLite databases (auth, projects, tasks, chats) |
| `_bmad/` | BMAD Method framework files |
| `skills/` | BMAD agent skill definitions |

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `SESSION_SECRET` | auto-generated | Session encryption key |
| `TRUST_PROXY` | `false` | Set `true` behind nginx/caddy |
| `WORKDIR` | `./workspace` | Default working directory |
| `MAX_TASK_WORKERS` | `5` | Max parallel Claude processes |
| `CLAUDE_TIMEOUT_MS` | `1800000` | Task timeout (30 min default) |

---

## 📊 Architecture

```
Browser (Kanban UI)
  ↕ REST API + SSE
Server.js
  ├── Task Worker Pool (up to 8 parallel Claude subprocesses)
  │   ├── MCP Servers (Git, GitHub, Playwright, Memory, Context7, ...)
  │   └── BMAD Workflows (quick-dev, full pipeline, playwright-qa)
  ├── BMAD Orchestrator (Master agent → specialized agents)
  ├── OpenClaw Bridge → Discord notifications
  └── SQLite (projects, tasks, chats, auth)
```

---

## 🔄 Commit History

304 commits on `feature/bmad-openclaw-integration` branch, including:
- Core BMAD integration + all 34 workflows
- Kanban overhaul (side-by-side, mobile responsive, task numbers)
- QA pipeline (Playwright, fix loops prevention, depth limits)
- Sprint planning + story management
- OpenClaw/Discord bridge
- Document management panel
- Screenshot management
- Auto-retry for timed-out tasks
- Mobile responsive design
- And many bug fixes

---

## License

Same as upstream. See [Mwogi/claude-code-studio](https://github.com/Mwogi/claude-code-studio).
