const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const os = require('os');
const url = require('url');
const { execSync, spawn: spawnProc } = require('child_process');
const crypto = require('crypto');
const multer = require('multer');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const auth = require('./auth');
const ClaudeCLI = require('./claude-cli');
const ClaudeSSH = require('./claude-ssh');
const { testSshConnection } = require('./claude-ssh');
const TelegramBot = require('./telegram-bot');
const TunnelManager = require('./tunnel-manager');
// Task 17: OpenClaw bridge — external event forwarding and REST API helpers
const openclawBridge = require('./openclaw-bridge');
const openclawNotify = require('./openclaw-notify');

// ─── Load .env file (no external dependency needed) ───────────────────────
{
  const envPath = path.join(process.env.APP_DIR || __dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      if (k && !(k in process.env)) process.env[k] = v;
    }
    console.log('✅ .env loaded');
  }
}

// ─── Structured Logger ────────────────────────────────────────────────────────
// Reads LOG_LEVEL + NODE_ENV from process.env (already populated from .env above).
// Production: emits newline-delimited JSON for log aggregators (Loki, Datadog, etc.)
// Development: human-readable output with icons.
// ---- Runtime-editable BMAD config (persisted in DB) -----------------------
// These constants define the DEFAULTS. Actual runtime values come from the
// `studio_config` table via getBmadConfig() below. Users can override them via
// the Settings dialog on the kanban (GET/PUT /api/config/bmad).
const BMAD_CONFIG_DEFAULTS = {
  models: {
    bmad_brainstorm:     'opus',
    bmad_prd:            'opus',
    bmad_architecture:   'opus',
    bmad_implementation: 'opus',
    bmad_qa:             'opus',
  },
  efforts: {
    bmad_brainstorm:     'high',
    bmad_prd:            'high',
    bmad_architecture:   'xhigh',
    bmad_implementation: 'xhigh',
    bmad_qa:             'xhigh',
  },
  playwright: {
    enforceForImplementation: true,  // require Playwright on frontend dev-story/quick-dev tasks
    enforceForQA:             true,  // require Playwright on QA tasks
  },
};

const BMAD_PHASE_MODEL_MAP = {
  'bmad_brainstorm': 'opus',
  'bmad_prd': 'opus',
  'bmad_architecture': 'opus',
  'bmad_implementation': 'opus',
  'bmad_qa': 'opus',
};

// Per-phase thinking effort level (adaptive thinking on Opus 4.7 / Sonnet 4.6+).
// xhigh = Opus 4.7 only (between high and max). Falls back to high on Opus 4.6 / Sonnet.
// Coding and QA phases get xhigh because they benefit most from deeper reasoning.
const BMAD_PHASE_EFFORT_MAP = {
  'bmad_brainstorm':     'high',
  'bmad_prd':            'high',
  'bmad_architecture':   'xhigh',  // architecture benefits from deep reasoning
  'bmad_implementation': 'xhigh',  // all coding uses xhigh effort
  'bmad_qa':             'xhigh',  // QA analysis + test writing
};

const BMAD_WORKFLOWS = {
  analysis: {
    label: '🔍 Analysis → Product Brief',
    agent: 'analyst',
    skills: ['bmad-brainstorming', 'bmad-party-mode'],
    model: 'opus',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/analyst.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the product brief workflow from ${workdir}/_bmad/bmm/workflows/1-analysis/create-product-brief/\n\nProject: ${title}\nDirectory: ${workdir}\n\nPARTY MODE ACTIVE: Facilitate a multi-agent discussion.\n\nSave output to ${workdir}/_bmad-output/planning-artifacts/product-brief.md`
  },
  research: {
    label: '🔬 Research (Domain/Market/Tech)',
    agent: 'analyst',
    skills: ['bmad-brainstorming'],
    model: 'opus',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/analyst.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the research workflow from ${workdir}/_bmad/bmm/workflows/1-analysis/research/\n\nProject: ${title}\nDirectory: ${workdir}\n\nConduct domain research, market research, and technical research. Save findings to ${workdir}/_bmad-output/planning-artifacts/research.md`
  },
  'domain-research': {
    label: '🌐 Domain Research',
    agent: 'analyst',
    skills: ['bmad-domain-research'],
    model: 'opus',
    prompt: (title, workdir) => `Read the bmad-domain-research skill from ${workdir}/_bmad/core/skills/bmad-domain-research/SKILL.md if it exists, otherwise use ${workdir}/.claude/skills/bmad-domain-research/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nConduct domain and industry research. Save findings to ${workdir}/_bmad-output/planning-artifacts/domain-research.md`
  },
  'market-research': {
    label: '📊 Market Research',
    agent: 'analyst',
    skills: ['bmad-market-research'],
    model: 'opus',
    prompt: (title, workdir) => `Read the bmad-market-research skill from ${workdir}/_bmad/core/skills/bmad-market-research/SKILL.md if it exists, otherwise use ${workdir}/.claude/skills/bmad-market-research/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nConduct market research on competition and customers. Save findings to ${workdir}/_bmad-output/planning-artifacts/market-research.md`
  },
  'technical-research': {
    label: '🔭 Technical Research',
    agent: 'analyst',
    skills: ['bmad-technical-research'],
    model: 'opus',
    prompt: (title, workdir) => `Read the bmad-technical-research skill from ${workdir}/_bmad/core/skills/bmad-technical-research/SKILL.md if it exists, otherwise use ${workdir}/.claude/skills/bmad-technical-research/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nConduct technical research on technologies and architecture. Save findings to ${workdir}/_bmad-output/planning-artifacts/technical-research.md`
  },
  'product-brief-preview': {
    label: '📄 Product Brief (Preview)',
    agent: 'analyst',
    skills: ['bmad-product-brief-preview'],
    model: 'opus',
    prompt: (title, workdir) => `Read the bmad-product-brief-preview skill from ${workdir}/.claude/skills/bmad-product-brief-preview/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nCreate or update the product brief through guided discovery. Save output to ${workdir}/_bmad-output/planning-artifacts/product-brief.md`
  },
  planning: {
    label: '📋 Planning → PRD',
    agent: 'product-manager',
    skills: ['bmad-create-prd', 'bmad-party-mode'],
    model: 'opus',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/pm.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the PRD creation workflow from ${workdir}/_bmad/bmm/workflows/2-plan-workflows/create-prd/\n\nProject: ${title}\nDirectory: ${workdir}\n\nRead the product brief from ${workdir}/_bmad-output/planning-artifacts/product-brief.md if it exists.\n\nSave output to ${workdir}/_bmad-output/planning-artifacts/prd.md`
  },
  'edit-prd': {
    label: '✏️ Edit PRD',
    agent: 'product-manager',
    skills: ['bmad-create-prd'],
    model: 'opus',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/pm.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the PRD edit workflow from ${workdir}/_bmad/bmm/workflows/2-plan-workflows/create-prd/\n\nProject: ${title}\nDirectory: ${workdir}\n\nEdit the existing PRD at ${workdir}/_bmad-output/planning-artifacts/prd.md based on the task description.`
  },
  'validate-prd': {
    label: '🔎 Validate PRD',
    agent: 'product-manager',
    skills: ['bmad-create-prd'],
    model: 'sonnet',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/pm.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the PRD validation workflow from ${workdir}/_bmad/bmm/workflows/2-plan-workflows/create-prd/\n\nProject: ${title}\nDirectory: ${workdir}\n\nValidate the PRD at ${workdir}/_bmad-output/planning-artifacts/prd.md against standards. Report issues and recommendations.`
  },
  'ux-design': {
    label: '🎨 UX Design',
    agent: 'ux-designer',
    skills: ['bmad-party-mode'],
    model: 'opus',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/ux-designer.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the UX design workflow from ${workdir}/_bmad/bmm/workflows/2-plan-workflows/create-ux-design/\n\nProject: ${title}\nDirectory: ${workdir}\n\nRead the PRD from ${workdir}/_bmad-output/planning-artifacts/prd.md if it exists.\n\nSave output to ${workdir}/_bmad-output/planning-artifacts/ux-design-specification.md`
  },
  solutioning: {
    label: '🏗️ Solutioning → Architecture + Epics',
    agent: 'architect',
    skills: ['bmad-create-architecture', 'bmad-create-epics', 'bmad-party-mode'],
    model: 'opus',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/architect.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nRead the PRD from ${workdir}/_bmad-output/planning-artifacts/prd.md if it exists.\n\n1. Run the architecture workflow from ${workdir}/_bmad/bmm/workflows/3-solutioning/create-architecture/ and save to ${workdir}/_bmad-output/planning-artifacts/architecture.md\n2. Run the epics workflow from ${workdir}/_bmad/bmm/workflows/3-solutioning/create-epics-and-stories/ and save to ${workdir}/_bmad-output/planning-artifacts/epics.md`
  },
  'readiness-check': {
    label: '✅ Implementation Readiness Check',
    agent: 'architect',
    skills: ['bmad-master'],
    model: 'sonnet',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/architect.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the implementation readiness check from ${workdir}/_bmad/bmm/workflows/3-solutioning/check-implementation-readiness/\n\nProject: ${title}\nDirectory: ${workdir}\n\nValidate that PRD, UX, Architecture, and Epics are complete and ready for implementation. Report any gaps.`
  },
  'sprint-planning': {
    label: '📐 Sprint Planning → sprint-status.yaml',
    agent: 'scrum-master',
    skills: ['bmad-sprint-planning'],
    model: 'opus',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/sm.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the sprint planning workflow from ${workdir}/_bmad/bmm/workflows/4-implementation/sprint-planning/\n\nProject: ${title}\nDirectory: ${workdir}\n\nRead the epics from ${workdir}/_bmad-output/planning-artifacts/epics.md\nRead the architecture from ${workdir}/_bmad-output/planning-artifacts/architecture.md\nRead the PRD from ${workdir}/_bmad-output/planning-artifacts/prd.md\n\nIMPORTANT CALIBRATION: All time estimates must be calibrated for AI dev agents, NOT human developers. AI agents complete a 3-point story in ~30-90 minutes (vs 1-2 days for humans). Sprint length = 1 day. Velocity = 30-50 points/sprint. Include both AI timeline (days) and human-equivalent (weeks) in the overview.

Generate sprint-status.yaml following the template at ${workdir}/_bmad/bmm/workflows/4-implementation/sprint-planning/sprint-status-template.yaml\n\nSave to ${workdir}/_bmad-output/sprint-status.yaml\n\nIMPORTANT: For each story in sprint-status.yaml, also create a Kanban task via POST http://localhost:3000/api/tasks with:\n- title: story title\n- description: story acceptance criteria and tasks\n- workdir: "${workdir}"\n- status: "bmad_workflow"\n- notes: "[bmad-workflow:create-story]"\n- chain_id: the epic slug (e.g. "epic-1-authentication")\n- sort_order: story sequence number within the epic\n- dep_group: the story ID e.g. "S1.1", "S1.2", "S2.1" (Epic.Story format). This groups a dev task with its auto-spawned QA and Fix tasks so dependent stories can wait for the entire group to complete.\n- depends_on: JSON array of group dependencies e.g. ["group:S1.1"] means this story waits until ALL tasks in dep_group S1.1 (dev+QA+fix) are done. Use this for stories that depend on prior stories. Stories within the same epic that can run in parallel should NOT have depends_on. Only add depends_on when there is a real dependency (e.g. story 1.3 needs story 1.2 complete). First story in each epic has no depends_on.\n\nDEPENDENCY RULES:\n- Independent stories (no cross-story dependency) → set dep_group only, no depends_on → they run in parallel\n- Sequential stories → set dep_group AND depends_on with group refs → they wait for prior groups\n- Cross-epic dependencies → use depends_on: ["group:S1.3"] to depend on stories from other epics\n- The server auto-inherits dep_group to QA and Fix tasks, so only set it on the create-story task\n\nThis creates the Kanban board tasks that will be picked up for create-story → dev-story execution.\n\nUse curl to POST: curl -b /tmp/ccs.cookie -X POST http://localhost:3000/api/tasks -H "Content-Type: application/json" -d '{"title":"...","description":"...","workdir":"${workdir}","status":"bmad_workflow","notes":"[bmad-workflow:create-story]","chain_id":"...","sort_order":N,"dep_group":"S1.1","depends_on":"[\\"group:S1.0\\"]"}'`
  },
  'quick-spec': {
    label: '⚡ Quick Spec',
    agent: 'architect',
    skills: ['bmad-master'],
    model: 'opus',
    effort: 'xhigh',
    prompt: (title, workdir) => `Read config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the quick-spec workflow from ${workdir}/_bmad/bmm/workflows/bmad-quick-flow/quick-spec/\n\nProject: ${title}\nDirectory: ${workdir}\n\nCreate a quick implementation-ready spec for this change. Save to ${workdir}/_bmad-output/implementation-artifacts/quick-spec-${Date.now()}.md`
  },
  'quick-dev': {
    label: '⚡ Quick Dev',
    agent: 'developer',
    skills: ['bmad-master'],
    model: 'opus',
    effort: 'xhigh',
    maxTurns: 100,
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/dev.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the quick-dev workflow from ${workdir}/_bmad/bmm/workflows/bmad-quick-flow/quick-dev/\n\nProject: ${title}\nDirectory: ${workdir}\n\nImplement the quick spec. Read any existing spec from the task description.`
  },
  'quick-dev-new-preview': {
    label: '🚀 Quick Dev (New Preview)',
    agent: 'developer',
    skills: ['bmad-quick-dev-new-preview'],
    model: 'opus',
    effort: 'xhigh',
    maxTurns: 100,
    prompt: (title, workdir) => `Read the bmad-quick-dev-new-preview skill from ${workdir}/.claude/skills/bmad-quick-dev-new-preview/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nImplement the user request using the new preview quick-dev workflow. Read the task description for the requirement.`
  },
  'quick-flow-solo-dev': {
    label: '🎯 Quick Flow Solo Dev',
    agent: 'developer',
    skills: ['bmad-quick-flow-solo-dev'],
    model: 'opus',
    effort: 'xhigh',
    maxTurns: 100,
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/quick-flow-solo-dev.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nRun the quick flow solo dev workflow. Read the task description for context.`
  },
  'generate-context': {
    label: '📑 Generate Project Context',
    agent: 'master',
    skills: ['bmad-master'],
    model: 'sonnet',
    prompt: (title, workdir) => `Read config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the generate-project-context workflow from ${workdir}/_bmad/bmm/workflows/generate-project-context/\n\nProject: ${title}\nDirectory: ${workdir}\n\nAnalyze the codebase and create project-context.md with AI rules and project structure. Save to ${workdir}/_bmad-output/project-context.md`
  },
  'e2e-tests': {
    label: '🧪 Generate E2E Tests',
    agent: 'qa',
    skills: ['bmad-master'],
    model: 'sonnet',
    effort: 'xhigh',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/qa.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the QA E2E test generation workflow from ${workdir}/_bmad/bmm/workflows/qa-generate-e2e-tests/\n\nProject: ${title}\nDirectory: ${workdir}\n\nGenerate end-to-end automated tests for existing features.`
  },
  shard: {
    label: '✂️ Shard Document',
    agent: 'master',
    skills: ['bmad-master'],
    model: 'sonnet',
    prompt: (title, workdir) => `Run the BMAD shard-doc task. Split this document: ${title}\n\nDirectory: ${workdir}\n\nUse: npx @kayvan/markdown-tree-parser explode [source-file] [destination-folder]`
  },
  'document-project': {
    label: '📚 Document Project',
    agent: 'master',
    skills: ['bmad-master'],
    model: 'opus',
    prompt: (title, workdir) => `Read config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the document-project workflow from ${workdir}/_bmad/bmm/workflows/document-project/\n\nProject: ${title}\nDirectory: ${workdir}\n\nScan the project codebase and generate comprehensive documentation. Save output to ${workdir}/docs/`
  },
  'code-review': {
    label: '🔍 Code Review',
    agent: 'developer',
    skills: ['bmad-master'],
    model: 'opus',
    effort: 'xhigh',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/dev.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the code review checklist from ${workdir}/_bmad/bmm/workflows/4-implementation/code-review/\n\nProject: ${title}\nDirectory: ${workdir}\n\nPerform a senior developer review using the validation checklist.`
  },
  'correct-course': {
    label: '🔄 Correct Course',
    agent: 'scrum-master',
    skills: ['bmad-master'],
    model: 'opus',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/sm.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the correct-course workflow from ${workdir}/_bmad/bmm/workflows/4-implementation/correct-course/\n\nProject: ${title}\nDirectory: ${workdir}\n\nNavigate the sprint change. Ask what issue or change requires course correction.`
  },
  'create-story': {
    label: '📝 Create Story',
    agent: 'product-manager',
    skills: ['bmad-master'],
    model: 'opus',
    effort: 'xhigh',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/pm.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nUse the create-story workflow from ${workdir}/_bmad/bmm/workflows/4-implementation/create-story/\nUse the story template from ${workdir}/_bmad/bmm/workflows/4-implementation/create-story/template.md\n\nProject: ${title}\nDirectory: ${workdir}\n\nRead the sprint status: ${workdir}/_bmad-output/sprint-status.yaml\nRead the epics: ${workdir}/_bmad-output/planning-artifacts/epics.md\nRead the architecture: ${workdir}/_bmad-output/planning-artifacts/architecture.md\nRead the PRD: ${workdir}/_bmad-output/planning-artifacts/prd.md\n\nCreate a detailed story file for this task using the template. Include:\n- Acceptance criteria derived from epics and PRD\n- Subtasks with AC references\n- Dev notes with architecture patterns and file references\n- Project structure notes\n\nSave the story file to ${workdir}/_bmad-output/implementation-artifacts/\n\nDo NOT update this task's workflow or status via curl. The server automatically creates a dev-story implementation task when this create-story task completes. Just create the story file and finish.`
  },
  'dev-story': {
    label: '💻 Dev Story (Implement)',
    agent: 'developer',
    skills: ['bmad-master'],
    model: 'opus',
    effort: 'xhigh',
    maxTurns: 100,
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/dev.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nFollow the dev-story workflow and checklist from ${workdir}/_bmad/bmm/workflows/4-implementation/dev-story/\n\nProject: ${title}\nDirectory: ${workdir}\n\nSTORY FILES: Look for your story file in ${workdir}/_bmad-output/implementation-artifacts/ (story-*.md matching this task title).\nAlso check the sprint status at ${workdir}/_bmad-output/sprint-status.yaml for context on what's done and what's next.\n\nRead the story file FIRST — it contains your acceptance criteria, subtask checklist, and dev notes.\nDuring implementation:\n- Check off subtasks as you complete them\n- Update the Change Log with what you changed\n- Update the File List with all files created/modified\n- Update Completion Notes with a summary when done\n\nImplement the story fully. All acceptance criteria must pass.`
  },
  'retrospective': {
    label: '🔮 Retrospective',
    agent: 'scrum-master',
    skills: ['bmad-master'],
    model: 'opus',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/sm.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the retrospective workflow from ${workdir}/_bmad/bmm/workflows/4-implementation/retrospective/\n\nProject: ${title}\nDirectory: ${workdir}\n\nFacilitate an epic completion retrospective. No blame, no time estimates. Focus on lessons learned and action items.`
  },
  'sprint-status': {
    label: '📊 Sprint Status',
    agent: 'scrum-master',
    skills: ['bmad-master'],
    model: 'sonnet',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/sm.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nRun the sprint-status workflow from ${workdir}/_bmad/bmm/workflows/4-implementation/sprint-status/\n\nProject: ${title}\nDirectory: ${workdir}\n\nProvide interactive sprint status review. No time estimates.`
  },
  // ── Core Tools ──
  'distillator': {
    label: '🗜️ Distillator (Compress Document)',
    agent: 'master',
    skills: ['bmad-distillator'],
    model: 'sonnet',
    prompt: (title, workdir) => `Read the bmad-distillator skill from ${workdir}/_bmad/core/skills/bmad-distillator/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nCompress the document(s) described in the task into a lossless, LLM-optimized distillate. Save output to ${workdir}/_bmad-output/planning-artifacts/`
  },
  'advanced-elicitation': {
    label: '🧠 Advanced Elicitation (Refine Content)',
    agent: 'master',
    skills: ['bmad-advanced-elicitation'],
    model: 'opus',
    prompt: (title, workdir) => `Read the bmad-advanced-elicitation skill from ${workdir}/_bmad/core/skills/bmad-advanced-elicitation/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nApply iterative elicitation techniques to refine and deepen the content described in the task.`
  },
  'adversarial-review': {
    label: '😈 Adversarial Review (Find Problems)',
    agent: 'master',
    skills: ['bmad-review-adversarial-general'],
    model: 'opus',
    prompt: (title, workdir) => `Read the bmad-review-adversarial-general skill from ${workdir}/_bmad/core/skills/bmad-review-adversarial-general/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nPerform a cynical adversarial review of the artifact described in the task. Find at least 10 issues — focus on what's missing, not just what's wrong.`
  },
  'playwright-qa': {
    label: '🎭 Playwright QA (Browser Testing)',
    agent: 'qa',
    skills: [],
    model: 'opus',
    effort: 'xhigh',
    prompt: (title, workdir) => `You are a QA engineer. Your ONLY job is to test the application by writing and running Playwright test scripts via the Bash tool.\n\nProject: ${title}\nDirectory: ${workdir}\n\n## CRITICAL INSTRUCTIONS\n\nYou MUST write and execute Playwright scripts using the Bash tool. MCP tools are NOT available in --print mode.\n\nExample: cat > /tmp/qa-test.mjs << 'S'\nimport { chromium } from \\"playwright\\";\nconst browser = await chromium.launch({ headless: true });\nconst page = await browser.newPage();\n// ... test code ...\nawait browser.close();\nS\nnode /tmp/qa-test.mjs\n\n## YOUR FIRST ACTION MUST BE:\n1. Read docs/testing-info.md to get the CORRECT test URL and credentials for THIS project\n2. Write a Playwright script that navigates to the URL from testing-info.md\n\n⚠️ NEVER hardcode or assume a URL. ALWAYS read docs/testing-info.md first.\n\nDo this RIGHT NOW before reading any other files. If navigation fails, try again. If it truly fails after 3 attempts, document the error.\n\nAfter navigating, login with credentials from docs/testing-info.md.\n\nThen test each acceptance criterion from the story file by actually interacting with the UI.\n\n## SCREENSHOT RULES — FOCUSED SCREENSHOTS ONLY\nDo NOT screenshot login, OTP, sidebar navigation, or loading states.\nOnly screenshot what directly verifies acceptance criteria:\n- ✅ The feature UI after it loads\n- ✅ Test results or data displayed by the feature\n- ✅ Error states being verified\n- ❌ Login page, OTP screen, navigation steps, spinners\nAim for 2-5 focused screenshots per task. Save to test-screenshots/ with descriptive names.\n\nDo NOT skip browser testing. Do NOT substitute curl for Playwright. Do NOT just review code.\n\nRead the task description for the full QA checklist.`
  },
  'edge-case-review': {
    label: '🔬 Edge Case Hunter',
    agent: 'master',
    skills: ['bmad-review-edge-case-hunter'],
    model: 'opus',
    prompt: (title, workdir) => `Read the bmad-review-edge-case-hunter skill from ${workdir}/_bmad/core/skills/bmad-review-edge-case-hunter/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nWalk every branching path and boundary condition in the artifact described. Report only unhandled edge cases as JSON findings.`
  },
  'editorial-prose': {
    label: '✍️ Editorial Review — Prose',
    agent: 'master',
    skills: ['bmad-editorial-review-prose'],
    model: 'sonnet',
    prompt: (title, workdir) => `Read the bmad-editorial-review-prose skill from ${workdir}/_bmad/core/skills/bmad-editorial-review-prose/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nPerform clinical copy-editing on the document described in the task. Output a three-column fix table: Original | Revised | Changes.`
  },
  'editorial-structure': {
    label: '🏗️ Editorial Review — Structure',
    agent: 'master',
    skills: ['bmad-editorial-review-structure'],
    model: 'sonnet',
    prompt: (title, workdir) => `Read the bmad-editorial-review-structure skill from ${workdir}/_bmad/core/skills/bmad-editorial-review-structure/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nPerform structural editing on the document — propose cuts, merges, moves, and condensing. Estimate total reduction.`
  },
  'index-docs': {
    label: '📇 Index Documents',
    agent: 'master',
    skills: ['bmad-index-docs'],
    model: 'sonnet',
    prompt: (title, workdir) => `Read the bmad-index-docs skill from ${workdir}/_bmad/core/skills/bmad-index-docs/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nScan the project docs directory and generate an organized index.md with links and descriptions. Save to ${workdir}/docs/index.md`
  },
  // ── Technical Writer Agent Workflows ──
  'write-document': {
    label: '📝 Write Document (Tech Writer)',
    agent: 'tech-writer',
    skills: ['bmad-master'],
    model: 'opus',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/tech-writer/agent.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nWrite the document described in the task. Follow the tech writer agent's WD trigger workflow. Save output to ${workdir}/docs/`
  },
  'validate-doc': {
    label: '✅ Validate Document (Tech Writer)',
    agent: 'tech-writer',
    skills: ['bmad-master'],
    model: 'sonnet',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/tech-writer/agent.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nValidate the document described in the task using the tech writer VD trigger. Check for completeness, accuracy, and consistency.`
  },
  'mermaid-generate': {
    label: '🧜 Generate Mermaid Diagram',
    agent: 'tech-writer',
    skills: ['bmad-master'],
    model: 'sonnet',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/tech-writer/agent.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nGenerate a Mermaid diagram as described in the task using the tech writer MG trigger. Output valid Mermaid syntax.`
  },
  'explain-concept': {
    label: '💡 Explain Concept (Tech Writer)',
    agent: 'tech-writer',
    skills: ['bmad-master'],
    model: 'sonnet',
    prompt: (title, workdir) => `Read your agent definition from ${workdir}/_bmad/bmm/agents/tech-writer/agent.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nExplain the concept described in the task using the tech writer EC trigger. Make it clear and accessible.`
  },
  'bmad-help': {
    label: '❓ BMAD Help (What\'s Next?)',
    agent: 'master',
    skills: ['bmad-help'],
    model: 'sonnet',
    prompt: (title, workdir) => `Read the bmad-help skill from ${workdir}/_bmad/core/skills/bmad-help/SKILL.md and config from ${workdir}/_bmad/bmm/config.yaml\n\nProject: ${title}\nDirectory: ${workdir}\n\nInspect the project state, detect what's been done, and recommend the next required or optional steps.`
  }
};

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const _logLevel  = LOG_LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LOG_LEVELS.info;
const _isProd    = process.env.NODE_ENV === 'production';
const log = (() => {
  function write(level, msg, meta = {}) {
    if (LOG_LEVELS[level] > _logLevel) return;
    const time = new Date().toISOString();
    if (_isProd) {
      process.stdout.write(JSON.stringify({ level, time, msg, ...meta }) + '\n');
    } else {
      const icons = { error: '❌', warn: '⚠️ ', info: 'ℹ️ ', debug: '🔍' };
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      process.stdout.write(`${icons[level] || ''} [${time}] ${msg}${metaStr}\n`);
    }
  }
  return {
    error: (msg, meta = {}) => write('error', msg, meta),
    warn:  (msg, meta = {}) => write('warn',  msg, meta),
    info:  (msg, meta = {}) => write('info',  msg, meta),
    debug: (msg, meta = {}) => write('debug', msg, meta),
  };
})();


const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 3000;
// When launched via npx/global install, cli.js sets APP_DIR to cwd so user
// data persists in the user's directory, not inside the npm cache.
const APP_DIR = process.env.APP_DIR || __dirname;
const WORKDIR = process.env.WORKDIR || path.join(APP_DIR, 'workspace');
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
const CONFIG_DEFAULT_PATH = path.join(APP_DIR, 'config.default.json');

// Auto-create config.json from config.default.json on first run
if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(CONFIG_DEFAULT_PATH)) {
  fs.copyFileSync(CONFIG_DEFAULT_PATH, CONFIG_PATH);
  console.log('[init] Created config.json from config.default.json — edit to add API keys');
}

// ─── Security config ──────────────────────────────────────────────────────────
// Trust X-Forwarded-For when behind nginx/Caddy (needed for rate limiting)
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

// Brute-force protection on auth mutation endpoints (login / setup)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});
// Set secure flag on cookies only when served over HTTPS (behind a proxy)
const SECURE_COOKIES = process.env.TRUST_PROXY === 'true';
// Directories that authenticated users may browse/create projects in
const ALLOWED_BROWSE_ROOTS = [
  path.resolve(os.homedir()),
  path.resolve(WORKDIR),
  path.resolve(APP_DIR),
  path.resolve(__dirname),
];
const SKILLS_DIR = path.join(APP_DIR, 'skills');
const DB_PATH = path.join(APP_DIR, 'data', 'chats.db');
const PROJECTS_FILE = path.join(APP_DIR, 'data', 'projects.json');
const REMOTE_HOSTS_FILE = path.join(APP_DIR, 'data', 'remote-hosts.json');
const HOSTS_KEY_FILE    = path.join(APP_DIR, 'data', 'hosts.key');
const UPLOADS_DIR   = path.join(APP_DIR, 'data', 'uploads');

// Category map for bundled skills — used when skill is auto-discovered (not in config)
const BUNDLED_SKILL_META = {
  'auto-mode':         { label:'🎯 Auto-Skill Mode',           category:'system'      },
  // ─── BMAD Agents ─────────────────────────────────────────────────────────
  'bmad-master':       { label:'🧙 BMad Master',               category:'bmad', description:'BMAD orchestrator, workflow routing, agent selection' },
  'analyst':           { label:'📊 Business Analyst (Mary)',    category:'bmad', description:'Market research, requirements elicitation, product briefs' },
  'architect':         { label:'🏗️ Architect (Winston)',         category:'bmad', description:'System architecture, tech decisions, implementation readiness' },
  'developer':         { label:'💻 Developer (Amelia)',         category:'bmad', description:'Story execution, TDD, code implementation, code review' },
  'product-manager':   { label:'📋 Product Manager (John)',     category:'bmad', description:'PRD creation, epics, stories, stakeholder alignment' },
  'qa-engineer':       { label:'🧪 QA Engineer (Quinn)',        category:'bmad', description:'Test automation, API testing, E2E testing, coverage' },
  'scrum-master':      { label:'🏃 Scrum Master (Bob)',         category:'bmad', description:'Sprint planning, story preparation, agile ceremonies' },
  'tech-writer':       { label:'📚 Tech Writer (Paige)',        category:'bmad', description:'Documentation, Mermaid diagrams, concept explanation' },
  'ux-designer':       { label:'🎨 UX Designer (Sally)',        category:'bmad', description:'User research, interaction design, UX design specs' },
  'quick-flow':        { label:'🚀 Quick Flow (Barry)',         category:'bmad', description:'Rapid spec + implementation for solo developers' },
  // ─── Engineering ─────────────────────────────────────────────────────────
  'backend':           { label:'⚙️ Backend Engineer',           category:'engineering' },
  'api-designer':      { label:'🔌 API Designer',              category:'engineering' },
  'frontend':          { label:'🎨 Frontend Engineer',          category:'engineering' },
  'fullstack':         { label:'🔗 Fullstack Engineer',         category:'engineering' },
  'devops':            { label:'🐳 DevOps Engineer',            category:'engineering' },
  'postgres-wizard':   { label:'🗄️ PostgreSQL Wizard',          category:'engineering' },
  'data-engineer':     { label:'📊 Data Engineer',              category:'engineering' },
  'llm-architect':     { label:'🧠 LLM Architect',              category:'ai'          },
  'prompt-engineer':   { label:'✍️ Prompt Engineer',            category:'ai'          },
  'rag-engineer':      { label:'🔍 RAG Engineer',               category:'ai'          },
  'code-quality':      { label:'💎 Code Quality',               category:'quality'     },
  'debugging-master':  { label:'🐛 Debugging Master',           category:'quality'     },
  'code-review':       { label:'👁️ Code Reviewer',              category:'quality'     },
  'system-designer':   { label:'🏗️ System Designer',            category:'quality'     },
  'security':          { label:'🔒 Security Expert',            category:'security'    },
  'auth-specialist':   { label:'🛡️ Auth Specialist',            category:'security'    },
  'ui-design':         { label:'🎭 UI Designer',                category:'design'      },
  'ux-design':         { label:'🧩 UX Designer',                category:'design'      },
  'product-management':{ label:'📋 Product Manager',            category:'product'     },
  'docs-engineer':     { label:'📚 Docs Engineer',              category:'product'     },
  'technical-writer':  { label:'✒️ Technical Writer',           category:'product'     },
  'investment-banking':{ label:'💼 Investment Banking Analyst', category:'finance'     },
  'researcher':        { label:'🔬 Deep Researcher',            category:'research'    },
};

// ─── Server-side i18n for user-facing defaults ──────────────────────────────
const SERVER_I18N = {
  uk: { newSession: 'Нова сесія', newTask: 'Нова задача' },
  en: { newSession: 'New session', newTask: 'New task' },
  ru: { newSession: 'Новая сессия', newTask: 'Новая задача' },
};
// All possible default session titles across languages (used to detect "untitled" sessions)
const DEFAULT_SESSION_TITLES = new Set(Object.values(SERVER_I18N).map(v => v.newSession));
const DEFAULT_TASK_TITLES    = new Set(Object.values(SERVER_I18N).map(v => v.newTask));

/** Get user's preferred language from config (cached via loadMergedConfig). */
function getUserLang() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).lang || 'en'; } catch { return 'en'; }
}
function i18nSession() { return SERVER_I18N[getUserLang()]?.newSession || SERVER_I18N.en.newSession; }
function i18nTask()    { return SERVER_I18N[getUserLang()]?.newTask    || SERVER_I18N.en.newTask; }

// ─── Global Claude Code directory (priority: global → local) ─────────────────
const GLOBAL_CLAUDE_DIR  = path.join(os.homedir(), '.claude');
const GLOBAL_SKILLS_DIR  = path.join(GLOBAL_CLAUDE_DIR, 'skills');
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CLAUDE_DIR, 'config.json');

const claudeCli = new ClaudeCLI({ cwd: WORKDIR });

// Expand leading ~ to os.homedir() — works on macOS, Linux and Windows
function expandTilde(v) {
  if (typeof v !== 'string') return v;
  if (v === '~') return os.homedir();
  if (v.startsWith('~/') || v.startsWith('~\\')) return path.join(os.homedir(), v.slice(2));
  return v;
}
// Recursively expand ~ in all string values of an object (used for MCP env maps)
function expandTildeInObj(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = expandTilde(v);
  return out;
}

// Kill a process by PID. On Windows uses `taskkill /T /F` to kill the entire
// process tree (cmd.exe → node.exe chains). On Unix sends SIGTERM.
function killByPid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${n} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(n, 'SIGTERM');
    }
  } catch {} // Process may already be dead (ESRCH)
}

[WORKDIR, SKILLS_DIR, path.dirname(DB_PATH), UPLOADS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ============================================
// MODELS
// ============================================
// CLI uses its own MODEL_MAP with short aliases (haiku/sonnet/opus)

// ============================================
// CLAUDE MAX LIMITS
// ============================================
const CLAUDE_MAX_LIMITS = {
  daily:  45,   // ~45 messages per day on Claude Max
  weekly: 225,  // ~225 messages per week on Claude Max
};

// ============================================
// DATABASE MAINTENANCE SETTINGS
// ============================================
const SESSION_TTL_DAYS      = parseInt(process.env.SESSION_TTL_DAYS || '30', 10);      // delete sessions older than N days
const CLEANUP_INTERVAL_HOURS = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '24', 10); // run cleanup every N hours

// ============================================
// DATABASE MAINTENANCE FUNCTIONS
// ============================================

/**
 * Delete sessions older than SESSION_TTL_DAYS.
 * Messages are auto-deleted via ON DELETE CASCADE.
 */
function cleanOldSessions() {
  try {
    const result = db.prepare(`DELETE FROM sessions WHERE updated_at < datetime('now', '-' || ? || ' days')`).run(SESSION_TTL_DAYS);
    if (result.changes > 0) {
      log.info(`[cleanup] Deleted ${result.changes} sessions older than ${SESSION_TTL_DAYS} days`);
    }
    return result.changes;
  } catch (err) {
    log.error('[cleanup] Failed to clean old sessions:', err.message);
    return 0;
  }
}

/**
 * Run WAL checkpoint to merge WAL file into main database.
 * Prevents unbounded WAL growth and keeps DB file compact.
 */
function checkpointDatabase() {
  try {
    // TRUNCATE mode: blocks writers briefly but fully resets WAL file
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    if (result[0]?.checkpointed > 0) {
      log.info(`[cleanup] WAL checkpoint: moved ${result[0].checkpointed} pages to main DB`);
    }
    return result;
  } catch (err) {
    log.error('[cleanup] WAL checkpoint failed:', err.message);
    return null;
  }
}

/**
 * Full cleanup routine: old sessions + checkpoint.
 */
function runDatabaseMaintenance() {
  const deleted = cleanOldSessions();
  if (deleted > 0) {
    // Only checkpoint if we actually deleted something
    checkpointDatabase();
  }
}

// ============================================
// SESSION ID SANITIZATION
// ============================================
// Extracts a clean UUID string from potentially corrupted claude_session_id values.
// Bug: runMultiAgent fallback could store { cid, completed } objects or nested JSON
// like {"cid":"{\"cid\":\"uuid\",\"completed\":true}","completed":false}
// This helper recursively unwraps to find the actual UUID.
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function sanitizeSessionId(val) {
  if (!val) return null;
  // Already a clean UUID
  if (typeof val === 'string' && UUID_RE.test(val)) return val;
  // Object with .cid field (from runCliSingle return value)
  if (typeof val === 'object' && val !== null && val.cid) return sanitizeSessionId(val.cid);
  // JSON string — try to parse and extract
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === 'object' && parsed.cid) return sanitizeSessionId(parsed.cid);
    } catch {}
    // Maybe a UUID is embedded somewhere in the string
    const m = val.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    if (m) return m[1];
  }
  return null;
}

// ============================================
// DATABASE
// ============================================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// Performance pragmas — safe with WAL mode
db.pragma('synchronous = NORMAL');   // WAL durability guarantees make FULL unnecessary
db.pragma('cache_size = -32000');    // 32 MB page cache
db.pragma('temp_store = MEMORY');    // Temp tables in RAM
db.pragma('foreign_keys = ON');      // Enforce FK constraints (was silently off)
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New session',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    claude_session_id TEXT,
    active_mcp TEXT DEFAULT '[]',
    active_skills TEXT DEFAULT '[]',
    mode TEXT DEFAULT 'auto',
    agent_mode TEXT DEFAULT 'single',
    model TEXT DEFAULT 'sonnet',
    workdir TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    content TEXT NOT NULL,
    tool_name TEXT,
    agent_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New task',
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    sort_order REAL DEFAULT 0,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
  );
`);
// Safe migration for existing databases
try { db.exec(`ALTER TABLE sessions ADD COLUMN workdir TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id)`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN last_user_msg TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN workdir TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN notes TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN model TEXT DEFAULT 'sonnet'`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN mode TEXT DEFAULT 'auto'`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN agent_mode TEXT DEFAULT 'single'`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN max_turns INTEGER DEFAULT 30`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN retry_count INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN worker_pid INTEGER`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN attachments TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN engine TEXT`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN partial_text TEXT`); } catch {}
// Task Dispatch: chain dependencies + auto-recovery columns
try { db.exec(`ALTER TABLE tasks ADD COLUMN depends_on TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN chain_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN source_session_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN failure_reason TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN task_retry_count INTEGER DEFAULT 0`); } catch {}
// Scheduled tasks: time-based triggers + recurring runs
try { db.exec(`ALTER TABLE tasks ADD COLUMN scheduled_at INTEGER`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN recurrence TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN recurrence_end_at INTEGER`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN task_number INTEGER`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN dep_group TEXT`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_dep_group ON tasks(dep_group)`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN remote_host TEXT`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN remote_workdir TEXT`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN sort_order REAL`); } catch {}
// Performance indexes — safe to re-run (IF NOT EXISTS)
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_status   ON tasks(status)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_session  ON tasks(session_id)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_msg_created   ON messages(created_at)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_chain    ON tasks(chain_id)`); } catch {}
// Telegram bot: telegram_devices table is created by TelegramBot constructor (single source of truth)
// Telegram Phase 2: session persistence + message source tracking
try { db.exec(`ALTER TABLE telegram_devices ADD COLUMN last_session_id TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE telegram_devices ADD COLUMN last_workdir TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'web'`); } catch(e) {}
// Shared docs: public read-only document links
db.exec(`
  CREATE TABLE IF NOT EXISTS shared_docs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    created_by TEXT DEFAULT 'user'
  );
  CREATE INDEX IF NOT EXISTS idx_shared_docs_project ON shared_docs(project_id);
`);

// Studio-wide runtime config (key/value JSON store).
// Used by BMAD config dialog for per-phase model/effort/Playwright settings.
db.exec(`
  CREATE TABLE IF NOT EXISTS studio_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---- BMAD runtime config helpers ----
function getBmadConfig() {
  try {
    const row = db.prepare(`SELECT value FROM studio_config WHERE key='bmad_config'`).get();
    if (!row) return JSON.parse(JSON.stringify(BMAD_CONFIG_DEFAULTS));
    const stored = JSON.parse(row.value);
    // Deep-merge with defaults so new keys auto-appear
    return {
      models:     { ...BMAD_CONFIG_DEFAULTS.models,     ...(stored.models || {}) },
      efforts:    { ...BMAD_CONFIG_DEFAULTS.efforts,    ...(stored.efforts || {}) },
      playwright: { ...BMAD_CONFIG_DEFAULTS.playwright, ...(stored.playwright || {}) },
    };
  } catch (e) {
    log.warn('getBmadConfig: failed to read/parse, returning defaults', { err: e.message });
    return JSON.parse(JSON.stringify(BMAD_CONFIG_DEFAULTS));
  }
}

function setBmadConfig(cfg) {
  const merged = {
    models:     { ...BMAD_CONFIG_DEFAULTS.models,     ...(cfg.models || {}) },
    efforts:    { ...BMAD_CONFIG_DEFAULTS.efforts,    ...(cfg.efforts || {}) },
    playwright: { ...BMAD_CONFIG_DEFAULTS.playwright, ...(cfg.playwright || {}) },
  };
  db.prepare(`INSERT OR REPLACE INTO studio_config (key, value, updated_at) VALUES ('bmad_config', ?, datetime('now'))`)
    .run(JSON.stringify(merged));
  return merged;
}

// Sanitize a value for better-sqlite3 bind parameters.
// better-sqlite3 EXPANDS arrays: each element counts as a separate bind value.
// An empty array [] contributes 0 binds, causing "Too few parameter values".
// This guard ensures only primitive types reach .run()/.get()/.all().
function sqlVal(v) {
  if (v === undefined) return null;
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Buffer.isBuffer(v)) return v;
  // Array or object — stringify it (and log a warning for debugging)
  log.warn('sqlVal: coerced non-primitive to string', { type: typeof v, isArray: Array.isArray(v), preview: JSON.stringify(v)?.substring(0, 100) });
  return JSON.stringify(v);
}

// Wrap a prepared statement so .run()/.get()/.all() auto-sanitize all args via sqlVal().
// This catches the "Too few parameter values" RangeError at the source — no matter
// which code path triggers it — by ensuring arrays/objects never reach better-sqlite3.
function wrapStmt(stmt, label) {
  const origRun = stmt.run.bind(stmt);
  const origGet = stmt.get.bind(stmt);
  const origAll = stmt.all.bind(stmt);
  stmt.run = function(...args) {
    const safe = args.map(sqlVal);
    try { return origRun(...safe); }
    catch (e) {
      log.error(`stmt.run FAILED [${label}]`, { args: safe.map(a => a === null ? 'NULL' : typeof a === 'string' ? a.substring(0,60) : a), err: e.message, stack: e.stack });
      throw e;
    }
  };
  stmt.get = function(...args) {
    const safe = args.map(sqlVal);
    try { return origGet(...safe); }
    catch (e) {
      log.error(`stmt.get FAILED [${label}]`, { args: safe.map(a => a === null ? 'NULL' : typeof a === 'string' ? a.substring(0,60) : a), err: e.message });
      throw e;
    }
  };
  stmt.all = function(...args) {
    // named-param objects ({w: ...}) — pass through, don't map
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && !Buffer.isBuffer(args[0])) {
      return origAll(args[0]);
    }
    const safe = args.map(sqlVal);
    try { return origAll(...safe); }
    catch (e) {
      log.error(`stmt.all FAILED [${label}]`, { args: safe.map(a => a === null ? 'NULL' : typeof a === 'string' ? a.substring(0,60) : a), err: e.message });
      throw e;
    }
  };
  return stmt;
}

const stmts = {
  createSession: db.prepare(`INSERT INTO sessions (id,title,active_mcp,active_skills,mode,agent_mode,model,engine,workdir) VALUES (?,?,?,?,?,?,?,?,?)`),
  updateTitle: db.prepare(`UPDATE sessions SET title=?,updated_at=datetime('now') WHERE id=?`),
  updateClaudeId: (() => {
    const _stmt = db.prepare(`UPDATE sessions SET claude_session_id=?,updated_at=datetime('now') WHERE id=?`);
    const _origRun = _stmt.run.bind(_stmt);
    _stmt.run = (cid, sessionId) => {
      const clean = sanitizeSessionId(cid);
      if (cid && !clean) log.warn('updateClaudeId: rejected non-UUID session_id', { raw: String(cid).substring(0, 80), sessionId });
      return _origRun(clean, sessionId);
    };
    return _stmt;
  })(),
  updateConfig: db.prepare(`UPDATE sessions SET active_mcp=?,active_skills=?,mode=?,agent_mode=?,model=?,workdir=?,updated_at=datetime('now') WHERE id=?`),
  getSessions: db.prepare(`SELECT id,title,created_at,updated_at,mode,agent_mode,model,workdir,claude_session_id FROM sessions ORDER BY CASE WHEN sort_order IS NULL THEN 0 ELSE 1 END ASC, sort_order ASC, updated_at DESC LIMIT 100`),
  getSessionsByWorkdir: db.prepare(`SELECT id,title,created_at,updated_at,mode,agent_mode,model,workdir,claude_session_id FROM sessions WHERE workdir=? ORDER BY CASE WHEN sort_order IS NULL THEN 0 ELSE 1 END ASC, sort_order ASC, updated_at DESC LIMIT 100`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE id=?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE id=?`),
  addMsg: db.prepare(`INSERT INTO messages (session_id,role,type,content,tool_name,agent_id,reply_to_id,attachments) VALUES (?,?,?,?,?,?,?,?)`),
  addTelegramMsg: db.prepare(`INSERT INTO messages (session_id,role,type,content,tool_name,agent_id,reply_to_id,attachments,source) VALUES (?,?,?,?,?,?,?,?,'telegram')`),
  getMsgs: db.prepare(`SELECT * FROM messages WHERE session_id=? ORDER BY id ASC`),
  // Lightweight: strip tool content (frontend only needs tool_name + agent_id for badge counts)
  getMsgsLite: db.prepare(`SELECT id, session_id, role, type, CASE WHEN type='tool' THEN '' ELSE content END AS content, tool_name, agent_id, created_at, reply_to_id, attachments, source FROM messages WHERE session_id=? ORDER BY id ASC`),
  getMsgsPaginated: db.prepare(`SELECT * FROM messages WHERE session_id=? AND (type IS NULL OR type != 'tool') ORDER BY id ASC LIMIT ? OFFSET ?`),
  countMsgs: db.prepare(`SELECT COUNT(*) AS total FROM messages WHERE session_id=? AND (type IS NULL OR type != 'tool')`),
  setLastUserMsg: db.prepare(`UPDATE sessions SET last_user_msg=? WHERE id=?`),
  clearLastUserMsg: db.prepare(`UPDATE sessions SET last_user_msg=NULL, retry_count=0 WHERE id=?`),
  setPartialText: db.prepare(`UPDATE sessions SET partial_text=? WHERE id=?`),
  getInterrupted: db.prepare(`SELECT id, title, last_user_msg FROM sessions WHERE last_user_msg IS NOT NULL`),
  incrementRetry: db.prepare(`UPDATE sessions SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id=?`),
  // Tasks (Kanban)
  getTasks: db.prepare(`
    SELECT t.*, s.title as sess_title, s.claude_session_id, s.model as sess_model,
           s.updated_at as sess_updated_at, COALESCE(s.retry_count, 0) as retry_count
    FROM tasks t LEFT JOIN sessions s ON t.session_id = s.id
    WHERE (@w IS NULL OR t.workdir = @w)
    ORDER BY t.sort_order ASC, t.created_at ASC
  `),
  getTask: db.prepare(`SELECT * FROM tasks WHERE id=?`),
  createTask: db.prepare(`INSERT INTO tasks (id,title,description,notes,status,sort_order,session_id,workdir,model,mode,agent_mode,max_turns,attachments,depends_on,chain_id,source_session_id,scheduled_at,recurrence,recurrence_end_at,task_number,dep_group) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateTask: db.prepare(`UPDATE tasks SET title=?,description=?,notes=?,status=?,sort_order=?,session_id=?,workdir=?,model=?,mode=?,agent_mode=?,max_turns=?,attachments=?,depends_on=?,chain_id=?,source_session_id=?,scheduled_at=?,recurrence=?,recurrence_end_at=?,dep_group=?,updated_at=datetime('now') WHERE id=?`),
  patchTaskStatus: db.prepare(`UPDATE tasks SET status=?,sort_order=?,updated_at=datetime('now') WHERE id=?`),
  deleteTask: db.prepare(`DELETE FROM tasks WHERE id=?`),
  deleteTasksBySession: db.prepare(`DELETE FROM tasks WHERE session_id=?`),
  countTasksBySession: db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE session_id=?`),
  getTasksEtag: db.prepare(`SELECT COALESCE(MAX(updated_at),'') as ts, COUNT(*) as n FROM tasks`),
  nextTaskNumber: db.prepare(`SELECT COALESCE(MAX(task_number), 0) + 1 as next_num FROM tasks WHERE workdir=?`),
  // processQueue hot-path — prepared once, reused every 60 s
  getTodoTasks:      db.prepare(`SELECT * FROM tasks WHERE ((status='todo' OR status='bmad_workflow') AND notes LIKE '%[bmad-workflow:%') AND (scheduled_at IS NULL OR scheduled_at <= unixepoch()) ORDER BY sort_order ASC, created_at ASC`),
  getInProgressTasks: db.prepare(`SELECT * FROM tasks WHERE status IN ('in_progress','bmad_brainstorm','bmad_prd','bmad_architecture','bmad_implementation','bmad_qa')`),
  getTasksByChain:   db.prepare(`SELECT * FROM tasks WHERE chain_id=? ORDER BY sort_order ASC`),
  // startTask hot-path
  setTaskSession:    db.prepare(`UPDATE tasks SET session_id=?, updated_at=datetime('now') WHERE id=?`),
  setTaskInProgress: db.prepare(`UPDATE tasks SET status='in_progress', updated_at=datetime('now') WHERE id=?`),
  // Stats queries
  activeAgents: db.prepare(`
    SELECT DISTINCT agent_id
    FROM messages
    WHERE role = 'assistant'
      AND agent_id IS NOT NULL
      AND datetime(created_at) >= datetime('now', '-5 minutes')
  `),
  dailyMessages: db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE role = 'user'
      AND date(created_at) = date('now')
  `),
  weeklyMessages: db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE role = 'user'
      AND datetime(created_at) >= datetime('now', '-7 days')
  `),
  contextTokens: db.prepare(`
    SELECT COALESCE(SUM(LENGTH(content)), 0) AS total
    FROM messages
    WHERE session_id = ?
  `),
  // getSession endpoint helpers — pre-compiled to avoid re-prepare on every load
  hasRunningTask: db.prepare(`SELECT id FROM tasks WHERE session_id=? AND status='in_progress' LIMIT 1`),
  getChainTasks:  db.prepare(`SELECT id, title, status, depends_on, chain_id FROM tasks WHERE source_session_id=? ORDER BY sort_order ASC`),
};
// Auto-sanitize ALL prepared statements — prevents "Too few parameter values"
// on every code path (chat, tasks, queue, reconnect, telegram, etc.)
for (const [name, stmt] of Object.entries(stmts)) wrapStmt(stmt, name);

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ─── BMAD Story & Sprint Status Integration ──────────────────────────────
// Generates story files for dev tasks and maintains sprint-status.yaml per project.
// Story files provide structured acceptance criteria, task tracking, and dev records.
// Sprint-status.yaml provides a single source of truth for all task statuses.

const STORY_TEMPLATE = `# Story: {{title}}

Status: {{status}}
Task ID: {{task_id}}
Task Number: #{{task_number}}
Workflow: {{workflow}}
Model: {{model}}
Created: {{created_at}}

## Description

{{description}}

## Acceptance Criteria

{{acceptance_criteria}}

## Tasks / Subtasks

{{subtasks}}

## Dev Notes

{{dev_notes}}

### References

- Task source: Claude Code Studio task #{{task_number}}

## Dev Agent Record

### Agent Model Used

{{model}}

### Completion Notes List

_(Updated by agent on completion)_

### Change Log

_(Updated by agent during implementation)_

### File List

_(Updated by agent — list all files created or modified)_
`;

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
}

/**
 * Extract acceptance criteria from task description.
 * Looks for numbered lists, checkbox lists, or "acceptance criteria" sections.
 */
function extractAcceptanceCriteria(description) {
  if (!description) return '- [ ] Implementation matches task description\n- [ ] No regressions introduced\n- [ ] Code compiles/builds without errors';
  
  // Look for explicit AC section
  const acMatch = description.match(/(?:acceptance criteria|requirements|expected behavior)[:\s]*\n([\s\S]*?)(?:\n##|\n---|\n\n\n|$)/i);
  if (acMatch) {
    const lines = acMatch[1].trim().split('\n').filter(l => l.trim());
    return lines.map(l => {
      const cleaned = l.replace(/^[\s]*[-*\d.]+[\s.)\]]*/, '').trim();
      return cleaned ? `- [ ] ${cleaned}` : '';
    }).filter(Boolean).join('\n') || '- [ ] Implementation matches task description';
  }

  // Look for numbered/bulleted lists
  const listLines = description.split('\n').filter(l => /^\s*[-*\d]+[.)]\s/.test(l));
  if (listLines.length >= 2) {
    return listLines.map(l => {
      const cleaned = l.replace(/^[\s]*[-*\d.]+[\s.)\]]*/, '').trim();
      return `- [ ] ${cleaned}`;
    }).join('\n');
  }

  return '- [ ] Implementation matches task description\n- [ ] No regressions introduced\n- [ ] Code compiles/builds without errors';
}

/**
 * Extract subtasks from description (## Tasks, ## Steps, ## Fix sections)
 */
function extractSubtasks(description) {
  if (!description) return '- [ ] Implement changes\n- [ ] Verify build passes';
  
  const taskMatch = description.match(/(?:## (?:Tasks|Steps|Fix|Implementation|Changes))[:\s]*\n([\s\S]*?)(?:\n##|$)/i);
  if (taskMatch) {
    const lines = taskMatch[1].trim().split('\n').filter(l => l.trim());
    return lines.map(l => {
      if (/^\s*[-*]\s*\[[ x]\]/.test(l)) return l; // already checkbox
      const cleaned = l.replace(/^[\s]*[-*\d.]+[\s.)\]]*/, '').trim();
      return cleaned ? `- [ ] ${cleaned}` : '';
    }).filter(Boolean).join('\n') || '- [ ] Implement changes';
  }

  // Numbered steps
  const steps = description.split('\n').filter(l => /^\s*\d+[.)]\s/.test(l));
  if (steps.length >= 2) {
    return steps.map(l => {
      const cleaned = l.replace(/^\s*\d+[.)]\s*/, '').trim();
      return `- [ ] ${cleaned}`;
    }).join('\n');
  }

  return '- [ ] Implement changes\n- [ ] Verify build passes';
}

/**
 * Generate a story file for a task before it starts.
 * Returns the path to the generated story file.
 */
function generateStoryFile(task) {
  const workdir = task.workdir || WORKDIR;
  const outputDir = path.join(workdir, '_bmad-output', 'implementation-artifacts');
  fs.mkdirSync(outputDir, { recursive: true });

  const slug = slugify(task.title);
  const storyFilename = `story-${task.task_number || 0}-${slug}.md`;
  const storyPath = path.join(outputDir, storyFilename);

  // Don't regenerate if story already exists (e.g. task retry)
  if (fs.existsSync(storyPath)) return storyPath;

  const wfType = task._bmadWorkflowType || 'quick-dev';
  const content = STORY_TEMPLATE
    .replace(/\{\{title\}\}/g, task.title || 'Untitled')
    .replace(/\{\{status\}\}/g, 'in-progress')
    .replace(/\{\{task_id\}\}/g, task.id || '')
    .replace(/\{\{task_number\}\}/g, String(task.task_number || 0))
    .replace(/\{\{workflow\}\}/g, wfType)
    .replace(/\{\{model\}\}/g, task.model || 'sonnet')
    .replace(/\{\{created_at\}\}/g, new Date().toISOString())
    .replace(/\{\{description\}\}/g, task.description || task.title || '')
    .replace(/\{\{acceptance_criteria\}\}/g, extractAcceptanceCriteria(task.description))
    .replace(/\{\{subtasks\}\}/g, extractSubtasks(task.description))
    .replace(/\{\{dev_notes\}\}/g, task.notes ? task.notes.replace(/\[bmad-workflow:[\w-]+\]/g, '').trim() : '_(none)_');

  fs.writeFileSync(storyPath, content, 'utf8');
  log.info(`[bmad-story] Generated story file: ${storyFilename}`);
  return storyPath;
}

/**
 * Update story file status and completion notes after task finishes.
 */
function updateStoryOnCompletion(task, status, completionText) {
  const workdir = task.workdir || WORKDIR;
  const outputDir = path.join(workdir, '_bmad-output', 'implementation-artifacts');
  const slug = slugify(task.title);
  const storyPath = path.join(outputDir, `story-${task.task_number || 0}-${slug}.md`);

  if (!fs.existsSync(storyPath)) return;

  try {
    let content = fs.readFileSync(storyPath, 'utf8');
    
    // Update status
    content = content.replace(/^Status: .+$/m, `Status: ${status}`);
    
    // Add completion notes
    if (completionText) {
      const summary = completionText.slice(-1500).trim();
      content = content.replace(
        '_(Updated by agent on completion)_',
        `**Completed:** ${new Date().toISOString()}\n\n${summary}`
      );
    }

    fs.writeFileSync(storyPath, content, 'utf8');
    log.info(`[bmad-story] Updated story status → ${status}: story-${task.task_number}-${slug}.md`);
  } catch (e) {
    log.warn(`[bmad-story] Failed to update story: ${e.message}`);
  }
}

/**
 * Extract file paths from the story File List section.
 * Returns an array of absolute paths, or null if section is empty/placeholder.
 *
 * Handles agent output formats like:
 *   - `path/to/file.py`
 *   - `path/to/file.py` (modified)
 *   - path/to/file.py — description
 *   - path/to/file.py (dev + bench)
 */
function extractFileListFromStory(storyContent, workdir) {
  const fileListMatch = storyContent.match(/###\s+File List\s*\n([\s\S]*?)(?:\n###|\n##|$)/);
  if (!fileListMatch) return null;

  const section = fileListMatch[1].trim();
  const PLACEHOLDER = '_(Updated by agent — list all files created or modified)_';
  if (!section || section === PLACEHOLDER) return null;

  const files = [];
  for (const rawLine of section.split('\n')) {
    // Strip leading list markers (-, *, numbers) and whitespace
    let line = rawLine.replace(/^[\s]*[-*\d]+[.)]\s*/, '').trim();
    // Strip backtick wrapping
    line = line.replace(/^`+/, '').replace(/`.*$/, '').trim();
    // Strip trailing description: everything after first space, em-dash, or parenthesis
    line = line.replace(/[\s\u2014(].*$/, '').trim();
    // Must look like a file path: contains a slash or a dot-extension, no remaining spaces
    if (!line || line.startsWith('_') || line.startsWith('#') || line.startsWith('(')) continue;
    if (!line.includes('/') && !/\.\w+$/.test(line)) continue;
    if (/\s/.test(line)) continue;  // spaces indicate it's still a description fragment

    const absPath = path.isAbsolute(line) ? line : path.join(workdir, line);
    files.push(absPath);
  }

  return files.length > 0 ? files : null;
}

/**
 * Generate/update sprint-status.yaml for a project workdir.
 * 
 * TWO MODES:
 * A) Full pipeline (epics.md exists): Sprint-planning workflow generates the authoritative
 *    sprint-status.yaml. We only UPDATE task statuses within it, never overwrite the structure.
 * B) Quick-dev (no epics.md): Auto-generate from DB tasks (lightweight path).
 */
function updateSprintStatus(workdir) {
  if (!workdir) return;
  const outputDir = path.join(workdir, '_bmad-output');
  fs.mkdirSync(outputDir, { recursive: true });
  const statusPath = path.join(outputDir, 'sprint-status.yaml');
  const epicsPath = path.join(workdir, '_bmad-output', 'planning-artifacts', 'epics.md');
  const hasEpics = fs.existsSync(epicsPath);

  try {
    const tasks = db.prepare(`
      SELECT id, title, status, notes, task_number, chain_id, sort_order, created_at, updated_at
      FROM tasks WHERE workdir=? 
      ORDER BY chain_id NULLS LAST, sort_order ASC, created_at ASC
    `).all(workdir);

    if (!tasks.length) return;

    // Map statuses to BMAD sprint statuses
    const STATUS_MAP = {
      'backlog': 'backlog',
      'todo': 'backlog',
      'bmad_workflow': 'ready-for-dev',
      'in_progress': 'in-progress',
      'bmad_brainstorm': 'in-progress',
      'bmad_prd': 'in-progress',
      'bmad_architecture': 'in-progress',
      'bmad_implementation': 'in-progress',
      'bmad_qa': 'review',
      'awaiting_input': 'in-progress',
      'done_review': 'review',
      'done': 'done',
      'archived': 'done',
      'cancelled': 'cancelled',
      'failed': 'failed',
    };

    // PATH A: Full pipeline — update statuses in existing BMAD sprint-status.yaml
    if (hasEpics && fs.existsSync(statusPath)) {
      let content = fs.readFileSync(statusPath, 'utf8');
      let updated = false;
      
      for (const t of tasks) {
        const bmadStatus = STATUS_MAP[t.status] || 'backlog';
        const taskSlug = `${t.task_number || t.id}-${slugify(t.title)}`;
        
        // Try to find and update this task's status line in the YAML
        // Match pattern: "  slug: old-status" or "  slug: old-status  # comment"
        const regex = new RegExp(`^(\\s+${taskSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*)\\S+(.*)$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `$1${bmadStatus}$2`);
          updated = true;
        }
      }
      
      // Append any tasks not found in the existing YAML
      const missingTasks = tasks.filter(t => {
        const taskSlug = `${t.task_number || t.id}-${slugify(t.title)}`;
        return !content.includes(taskSlug);
      });
      
      if (missingTasks.length) {
        content += `\n`;
        for (const t of missingTasks) {
          const wfMatch = (t.notes || '').match(/\[bmad-workflow:([\w-]+)\]/);
          const wfType = wfMatch ? wfMatch[1] : 'task';
          content += `  ${t.task_number || t.id}-${slugify(t.title)}: ${STATUS_MAP[t.status] || 'backlog'}  # [${wfType}] ${t.title.substring(0, 60)}\n`;
        }
        updated = true;
      }
      
      // Update summary counts
      const counts = { backlog: 0, 'ready-for-dev': 0, 'in-progress': 0, review: 0, done: 0, cancelled: 0, failed: 0 };
      for (const t of tasks) {
        const s = STATUS_MAP[t.status] || 'backlog';
        counts[s] = (counts[s] || 0) + 1;
      }
      // Replace or add summary block
      const summaryBlock = `summary:\n  total: ${tasks.length}\n${Object.entries(counts).filter(([,v])=>v>0).map(([k,v])=>`  ${k}: ${v}`).join('\n')}`;
      if (content.includes('summary:')) {
        content = content.replace(/summary:\n(?:\s+\w[\w-]*:\s*\d+\n?)*/m, summaryBlock + '\n');
      }
      
      if (updated) {
        // Update the generated timestamp
        content = content.replace(/^# Generated: .+$/m, `# Generated: ${new Date().toISOString()}`);
        fs.writeFileSync(statusPath, content, 'utf8');
        log.info(`[bmad-sprint] Updated sprint-status.yaml (full pipeline mode) for ${path.basename(workdir)}`);
      }
      return;
    }

    // PATH B: Quick-dev — auto-generate from DB tasks
    // Group by chain
    const chains = new Map();
    const standalone = [];
    for (const t of tasks) {
      if (t.chain_id) {
        if (!chains.has(t.chain_id)) chains.set(t.chain_id, []);
        chains.get(t.chain_id).push(t);
      } else {
        standalone.push(t);
      }
    }

    let yaml = `# Sprint Status\n`;
    yaml += `# Generated: ${new Date().toISOString()}\n`;
    yaml += `# Project: ${path.basename(workdir)}\n`;
    yaml += `# Tracking: Claude Code Studio\n`;
    yaml += `# Mode: auto-generated (no epics.md found)\n\n`;

    // Summary counts
    const counts = { backlog: 0, 'ready-for-dev': 0, 'in-progress': 0, review: 0, done: 0, cancelled: 0, failed: 0 };
    for (const t of tasks) {
      const s = STATUS_MAP[t.status] || 'backlog';
      counts[s] = (counts[s] || 0) + 1;
    }
    yaml += `summary:\n`;
    yaml += `  total: ${tasks.length}\n`;
    for (const [k, v] of Object.entries(counts)) {
      if (v > 0) yaml += `  ${k}: ${v}\n`;
    }
    yaml += `\n`;

    // Development status — chains as epics
    yaml += `development_status:\n`;
    
    for (const [chainId, chainTasks] of chains) {
      yaml += `\n  # Chain: ${chainId}\n`;
      const chainDone = chainTasks.every(t => ['done', 'archived', 'done_review'].includes(t.status));
      const chainStarted = chainTasks.some(t => !['backlog', 'todo', 'bmad_workflow'].includes(t.status));
      yaml += `  ${chainId}: ${chainDone ? 'done' : chainStarted ? 'in-progress' : 'backlog'}\n`;
      for (const t of chainTasks) {
        const wfMatch = (t.notes || '').match(/\[bmad-workflow:([\w-]+)\]/);
        const wfType = wfMatch ? wfMatch[1] : 'task';
        yaml += `  ${t.task_number || t.id}-${slugify(t.title)}: ${STATUS_MAP[t.status] || 'backlog'}  # [${wfType}] ${t.title.substring(0, 60)}\n`;
      }
    }

    if (standalone.length) {
      yaml += `\n  # Standalone tasks\n`;
      for (const t of standalone) {
        const wfMatch = (t.notes || '').match(/\[bmad-workflow:([\w-]+)\]/);
        const wfType = wfMatch ? wfMatch[1] : 'task';
        yaml += `  ${t.task_number || t.id}-${slugify(t.title)}: ${STATUS_MAP[t.status] || 'backlog'}  # [${wfType}] ${t.title.substring(0, 60)}\n`;
      }
    }

    fs.writeFileSync(statusPath, yaml, 'utf8');
    log.info(`[bmad-sprint] Updated sprint-status.yaml for ${path.basename(workdir)} (${tasks.length} tasks)`);
  } catch (e) {
    log.warn(`[bmad-sprint] Failed to update sprint status: ${e.message}`);
  }
}

// ─── Active task registry ─────────────────────────────────────────────────
// Keeps running Claude subprocesses alive when the browser tab closes/reloads.
// Key: localSessionId, Value: { proxy, abortController, cleanupTimer }
const activeTasks = new Map();
const TASK_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // abort orphaned tasks after 30 min

// ─── Session Watchers (real-time task worker → chat streaming) ────────────
// When chat client opens a session, it subscribes via WS. Task worker broadcasts
// text/tool/done events to all watchers of that session.
const sessionWatchers = new Map(); // sessionId → Set<WebSocket>
const taskBuffers = new Map();     // taskId → accumulated text (for late subscribers)
const chatBuffers = new Map();     // sessionId → accumulated text for direct chat (for catch-up on reconnect)
const MAX_CHAT_BUFFER = 2 * 1024 * 1024; // 2 MB cap per session — prevents unbounded growth
const sessionQueues = new Map();   // sessionId → [msg, ...] — queue persistence across WS reconnects (page refresh)

// ─── Ask User (Internal MCP) ─────────────────────────────────────────────
// Pending user questions: requestId → { resolve, sessionId, timer, question, options, inputType }
const pendingAskUser = new Map();
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const ASK_USER_SECRET = require('crypto').randomBytes(16).toString('hex');


// ─── Notify User (Internal MCP) ──────────────────────────────────────────
const NOTIFY_SECRET = require('crypto').randomBytes(16).toString('hex');

// ─── Set UI State (Internal MCP) ──────────────────────────────────────────
const SET_UI_STATE_SECRET = require('crypto').randomBytes(16).toString('hex');

function broadcastToSession(sessionId, data) {
  const watchers = sessionWatchers.get(sessionId);
  if (!watchers?.size) return;
  const msg = JSON.stringify(data);
  for (const w of watchers) {
    if (w.readyState === 1) {
      try { w.send(msg); } catch { watchers.delete(w); }
    } else if (w.readyState > 1) {
      watchers.delete(w); // CLOSING/CLOSED — won't recover
    }
  }
  if (!watchers.size) sessionWatchers.delete(sessionId);
}

// ─── Kanban Task Queue Worker ─────────────────────────────────────────────
const MAX_TASK_WORKERS = Math.max(1, parseInt(process.env.MAX_TASK_WORKERS || '15', 10));
const MAX_PER_WORKDIR = Math.max(1, parseInt(process.env.MAX_PER_WORKDIR || '8', 10));
const taskRunning = new Set();        // task IDs currently executing
const runningTaskAborts = new Map();  // taskId → AbortController
const stoppingTasks = new Set();      // task IDs being manually stopped (onDone must not overwrite status)
const restartingTasks = new Set();    // task IDs being restarted (worker exit must NOT set status=cancelled)

async function startTask(task) {
  if (taskRunning.has(task.id)) return;
  taskRunning.add(task.id);
  console.log(`[taskWorker] starting "${task.title}" (${task.id})`);
  let _retryBackoffMs = 0; // Set by auto-retry logic, used by finally for processQueue delay
  let sessionId = task.session_id;
  let _taskStartedAt = Date.now();
  // Override model based on BMAD phase tag
  const bmadPhaseTagMatch = (task.notes || '').match(/\[bmad-phase:(\w+)\]/);
  if (bmadPhaseTagMatch && BMAD_PHASE_MODEL_MAP[bmadPhaseTagMatch[1]]) {
    task.model = BMAD_PHASE_MODEL_MAP[bmadPhaseTagMatch[1]];
    // Also update the session model so cli.send picks it up
    if (task.session_id) {
      db.prepare(`UPDATE sessions SET model=?, updated_at=datetime('now') WHERE id=?`).run(task.model, task.session_id);
    }
  }
  // Override model and skills based on BMAD workflow tag.
  // NOTE: we deliberately skip copying wf.model onto task.model here. The runtime
  // config (Settings dialog) is the source of truth for per-phase model/effort;
  // see the resolver in the auto-continue loop below (_modelFromPhase wins).
  // wf.model/wf.effort remain available via task._bmadWorkflow for workflows that
  // genuinely require a specific model (none do currently).
  const bmadWorkflowTagMatch = (task.notes || '').match(/\[bmad-workflow:([\w-]+)\]/);
  if (bmadWorkflowTagMatch && BMAD_WORKFLOWS[bmadWorkflowTagMatch[1]]) {
    const wf = BMAD_WORKFLOWS[bmadWorkflowTagMatch[1]];
    // task.model = wf.model;  // DISABLED: phase config wins over workflow defaults
    task._bmadWorkflow = wf;
    task._bmadWorkflowType = bmadWorkflowTagMatch[1];
  }
  try {
    // Create session + link task + mark in_progress — all atomic
    db.transaction(() => {
      if (!sessionId) {
        sessionId = genId();
        stmts.createSession.run(sessionId, task.title.substring(0, 200), '[]', '[]', task.mode || 'auto', task.agent_mode || 'single', task.model || 'sonnet', 'cli', task.workdir || null);
        stmts.setTaskSession.run(sessionId, task.id);
      }
      // For BMAD chain tasks, set status to BMAD phase column instead of generic 'in_progress'
      const bmadPhaseMatch = (task.notes || '').match(/\[bmad-phase:(\w+)\]/);
      if (bmadPhaseMatch) {
        db.prepare(`UPDATE tasks SET status=?, updated_at=datetime('now') WHERE id=?`).run(bmadPhaseMatch[1], task.id);
      } else if (task._bmadWorkflow) {
        // Map BMAD workflow type to the appropriate phase column
        const wfType = task._bmadWorkflowType || '';
        const WORKFLOW_TO_PHASE = {
          'analysis': 'bmad_brainstorm', 'research': 'bmad_brainstorm', 'brainstorming': 'bmad_brainstorm',
          'domain-research': 'bmad_brainstorm', 'market-research': 'bmad_brainstorm', 'technical-research': 'bmad_brainstorm',
          'product-brief-preview': 'bmad_brainstorm',
          'planning': 'bmad_prd', 'edit-prd': 'bmad_prd', 'validate-prd': 'bmad_prd', 'ux-design': 'bmad_prd',
          'solutioning': 'bmad_architecture', 'readiness-check': 'bmad_architecture',
          'sprint-planning': 'bmad_architecture', 'create-story': 'bmad_implementation',
          'dev-story': 'bmad_implementation', 'quick-dev': 'bmad_implementation', 'quick-spec': 'bmad_implementation',
          'quick-dev-new-preview': 'bmad_implementation', 'quick-flow-solo-dev': 'bmad_implementation',
          'code-review': 'bmad_qa', 'e2e-tests': 'bmad_qa', 'retrospective': 'bmad_qa',
          'correct-course': 'bmad_implementation', 'sprint-status': 'bmad_implementation',
          'document-project': 'bmad_implementation', 'generate-context': 'bmad_implementation', 'shard': 'bmad_implementation',
          'distillator': 'bmad_implementation', 'advanced-elicitation': 'bmad_brainstorm',
          'adversarial-review': 'bmad_qa', 'playwright-qa': 'bmad_qa', 'edge-case-review': 'bmad_qa',
          'editorial-prose': 'bmad_qa', 'editorial-structure': 'bmad_qa', 'index-docs': 'bmad_implementation',
          'write-document': 'bmad_implementation', 'validate-doc': 'bmad_qa', 'mermaid-generate': 'bmad_implementation',
          'explain-concept': 'bmad_implementation', 'bmad-help': 'bmad_implementation',
        };
        const phase = WORKFLOW_TO_PHASE[wfType] || 'bmad_implementation';
        // Auto-enhance title with BMAD phase label for kanban readability
        const WORKFLOW_TO_LABEL = {
          'domain-research': 'Domain Research', 'market-research': 'Market Research',
          'technical-research': 'Technical Research', 'analysis': 'Analysis',
          'brainstorming': 'Brainstorming', 'product-brief-preview': 'Product Brief',
          'planning': 'PRD', 'edit-prd': 'Edit PRD', 'validate-prd': 'Validate PRD',
          'ux-design': 'UX Design', 'solutioning': 'Architecture & Epics',
          'readiness-check': 'Readiness Check', 'sprint-planning': 'Sprint Planning',
          'create-story': 'Story', 'dev-story': 'Dev',
          'code-review': 'Code Review', 'e2e-tests': 'QA Tests',
          'playwright-qa': 'QA', 'quick-dev': 'Quick Dev', 'quick-spec': 'Quick Spec',
          'quick-dev-new-preview': 'Quick Dev', 'quick-flow-solo-dev': 'Solo Dev',
          'retrospective': 'Retro', 'correct-course': 'Course Correction',
          'sprint-status': 'Sprint Status', 'generate-context': 'Gen Context',
          'document-project': 'Docs', 'adversarial-review': 'Adversarial Review',
          'edge-case-review': 'Edge Case Review', 'distillator': 'Distill',
          'advanced-elicitation': 'Elicitation',
        };
        const phaseLabel = WORKFLOW_TO_LABEL[wfType];
        if (phaseLabel && !task.title.toLowerCase().startsWith(phaseLabel.toLowerCase())) {
          // Only prepend if not already prefixed (e.g. by auto-pipeline)
          const hasAnyPrefix = Object.values(WORKFLOW_TO_LABEL).some(l => task.title.toLowerCase().startsWith(l.toLowerCase() + ':') || task.title.toLowerCase().startsWith(l.toLowerCase() + ' —'));
          // Don't mangle auto-generated Fix:/QA: tasks — they have special semantics
          // for the QA/Fix depth guards in autoCreateQATask and autoCreateFixFromQA
          const isAutoGenTask = /^(Fix:|QA:|🧪)/.test(task.title);
          if (!hasAnyPrefix && !isAutoGenTask) {
            const newTitle = `${phaseLabel}: ${task.title}`.substring(0, 200);
            db.prepare(`UPDATE tasks SET title=?, updated_at=datetime('now') WHERE id=?`).run(newTitle, task.id);
            task.title = newTitle;
            log.info(`[taskWorker] Enhanced title: "${newTitle}"`);
          }
        }
        log.info(`[taskWorker] Setting BMAD phase: ${task.id} ("${task.title}") workflow=${wfType} → status=${phase}`);
        db.prepare(`UPDATE tasks SET status=?, updated_at=datetime('now') WHERE id=?`).run(phase, task.id);
        // Notify kanban immediately so the card moves to the correct column
        wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
      } else {
        stmts.setTaskInProgress.run(task.id);
      }
    })();
    // For BMAD workflow tasks, create output directory and use workflow-specific prompt
    // Also generate story file for implementation/QA workflows
    let storyPath = null;
    const STORY_WORKFLOWS = ['quick-dev', 'dev-story', 'quick-spec', 'quick-dev-new-preview', 'quick-flow-solo-dev',
      'code-review', 'adversarial-review', 'playwright-qa', 'e2e-tests', 'edge-case-review', 'correct-course'];
    if (task._bmadWorkflow) {
      const wf = task._bmadWorkflow;
      if (wf.outputDir) {
        const outDir = path.join(task.workdir || WORKDIR, wf.outputDir);
        fs.mkdirSync(outDir, { recursive: true });
      }
      // Generate story file for dev/QA workflows
      if (STORY_WORKFLOWS.includes(task._bmadWorkflowType)) {
        try {
          storyPath = generateStoryFile(task);
        } catch (e) {
          log.warn(`[bmad-story] Failed to generate story: ${e.message}`);
        }
      }
      // Update sprint-status.yaml
      try { updateSprintStatus(task.workdir || WORKDIR); } catch (e) { log.warn(`[bmad-sprint] ${e.message}`); }
    }
    // Capture pre-task dirty state for commit-scope isolation (fallback when File List is empty)
    try {
      const _preDirtyRaw = execSync('git status --porcelain', { cwd: task.workdir || WORKDIR, timeout: 5000 }).toString();
      task._preTaskDirtyFiles = new Set(
        _preDirtyRaw.split('\n').filter(l => l.trim()).map(l => l.slice(3).trim())
      );
    } catch (_preErr) {
      task._preTaskDirtyFiles = null;
    }
    // Build prompt
    let parts;
    if (task._bmadWorkflow) {
      // Use the workflow-defined prompt + include task description if provided
      const wfPrompt = task._bmadWorkflow.prompt(task.title, task.workdir || WORKDIR);
      parts = [wfPrompt];
      if (task.description?.trim()) parts.push(`\n---\nTask Description:\n${task.description.trim()}`);
      // Inject story file reference for dev/QA workflows
      if (storyPath) {
        parts.push(`\n---\nSTORY FILE: ${storyPath}\nRead this story file for acceptance criteria and task checklist. During implementation:\n- Check off completed subtasks in the story file\n- Update the "Change Log" section with what you changed\n- Update the "File List" section with all files created/modified\n- On completion, update "Completion Notes List" with a summary\nThe story file is your structured tracking document for this task.`);
      }
    } else {
      parts = [task.title];
      if (task.description?.trim()) parts.push(task.description.trim());
      if (task.notes?.trim()) parts.push(`---\nУточнення:\n${task.notes.trim()}`);
    }
    // Write attachment files to workspace so Claude Code can read them
    if (task.attachments) {
      try {
        const atts = JSON.parse(task.attachments);
        if (Array.isArray(atts) && atts.length) {
          const attDir = path.join(task.workdir || WORKDIR, '.kanban-attachments', task.id);
          fs.mkdirSync(attDir, { recursive: true });
          const names = [];
          for (const att of atts) {
            if (att.base64 && att.name) {
              // Sanitize filename: strip directory traversal, keep only the base name
              const safeName = path.basename(att.name);
              if (!safeName) continue;
              fs.writeFileSync(path.join(attDir, safeName), Buffer.from(att.base64, 'base64'));
              names.push(safeName);
            }
          }
          if (names.length) {
            parts.push(`---\nAttached files (in .kanban-attachments/${task.id}/):\n${names.map(n => `- ${n}`).join('\n')}`);
          }
        }
      } catch (e) { console.error('[taskWorker] attachments write error:', e); }
    }
    // Chain task: add dependency context as safety net (primary context via --resume)
    if (task.depends_on) {
      try {
        const deps = JSON.parse(task.depends_on);
        const depNames = deps.map(depId => { const dep = stmts.getTask.get(depId); return dep ? dep.title : null; }).filter(Boolean);
        if (depNames.length) {
          parts.push(`---\nPrevious tasks completed: ${depNames.join(', ')}\nTheir results are in your session context via --resume.`);
        }
      } catch {}
    }
    let prompt = parts.join('\n\n') + TASK_VERIFICATION_SUFFIX;
    _taskStartedAt = Date.now(); // reset to accurate time after prompt building
    // Check if this is a restart: only skip saving if the LAST user message
    // has the exact same prompt (crash recovery). Previously checked for ANY
    // user message which broke when a new task reused an existing session.
    const lastUserMsg = db.prepare(`SELECT id, content FROM messages WHERE session_id=? AND role='user' ORDER BY id DESC LIMIT 1`).get(sessionId);
    const isRetry = lastUserMsg && lastUserMsg.content === prompt;
    if (!isRetry) {
      // New task or different prompt — save user message
      try { stmts.addMsg.run(sessionId, 'user', 'text', prompt, null, null, null, null); }
      catch (e) { log.error('startTask addMsg failed', { sessionId, promptLen: prompt.length, err: e.message, stack: e.stack }); throw e; }
    } else {
      // Restart after crash with same prompt — increment retry counter, don't duplicate
      try { stmts.incrementRetry.run(sessionId); } catch (e) { log.error('startTask incrementRetry failed', { err: e.message }); }
    }
    // Resume existing claude session if any
    const session = stmts.getSession.get(sessionId);
    const claudeSessionId = sanitizeSessionId(session?.claude_session_id) || null;
    
    // Check if this is a resumed task with user reply (awaiting_input → todo)
    if (claudeSessionId && sessionId) {
      const _lastAssist = db.prepare(
        `SELECT created_at FROM messages WHERE session_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1`
      ).get(sessionId);
      if (_lastAssist) {
        const _userReply = db.prepare(
          `SELECT content FROM messages WHERE session_id=? AND role='user' AND created_at > ? ORDER BY created_at DESC LIMIT 1`
        ).get(sessionId, _lastAssist.created_at);
        if (_userReply) {
          prompt = _userReply.content;
          log.info(`[taskWorker] task ${task.id}: resuming with user reply`);
        }
      }
    }
    
    const cli = new ClaudeCLI({ cwd: task.workdir || WORKDIR });
    const taskAbort = new AbortController();
    runningTaskAborts.set(task.id, taskAbort);
      let fullText = '', newCid = claudeSessionId, hasError = false;
      // Capture bash command bodies so the Playwright enforcement can see scripts
      // the agent wrote via `cat > file.mjs <<SCRIPT ... SCRIPT` heredocs.
      // These don't appear in fullText (which is only natural-language assistant text).
      let toolCommandBodies = '';
    taskBuffers.set(task.id, '');
    // Notify watchers — use task_retrying for restarts, task_started for first run
    // Include prompt so client can show user message bubble during live streaming
    if (isRetry) {
      const retryCount = session?.retry_count || 1;
      broadcastToSession(sessionId, { type: 'task_retrying', taskId: task.id, title: task.title, prompt, retryCount, tabId: sessionId });
    } else {
      broadcastToSession(sessionId, { type: 'task_started', taskId: task.id, title: task.title, prompt, tabId: sessionId });
      openclawNotify.taskStarted(task, getProjectName(task.workdir));
    }
    // Task 10: Inject BMAD agent skill context for scheduled tasks.
    // If the task description contains a <!-- bmad-skills: [...] --> annotation,
    // extract the skill IDs and build + inject a system prompt.
    let taskSystemPrompt = null;
    // For BMAD workflow tasks, use their defined skills
    if (task._bmadWorkflow && task._bmadWorkflow.skills && task._bmadWorkflow.skills.length) {
      try {
        let _skillIds = [...task._bmadWorkflow.skills];
        if (!_skillIds.includes('bmad-master')) _skillIds = ['bmad-master', ..._skillIds];
        const _skillConfig = loadMergedConfig();
        taskSystemPrompt = buildSystemPrompt(_skillIds, _skillConfig);
        log.info(`[taskWorker] injecting BMAD workflow skills for "${task.title}" (${task._bmadWorkflowType}): ${_skillIds.join(', ')}`);
      } catch (e) { log.warn('[taskWorker] bmad-workflow skills injection error', { error: e.message }); }
    }
    const _skillAnnotation = !taskSystemPrompt && (task.description || '').match(/<!--\s*bmad-skills:\s*(\[[\s\S]*?\])\s*-->/);
    if (_skillAnnotation) {
      try {
        let _skillIds = JSON.parse(_skillAnnotation[1]);
        // Always include bmad-master as orchestrator
        if (!_skillIds.includes('bmad-master')) _skillIds = ['bmad-master', ..._skillIds];
        if (Array.isArray(_skillIds) && _skillIds.length) {
          const _skillConfig = loadMergedConfig();
          taskSystemPrompt = buildSystemPrompt(_skillIds, _skillConfig);
          log.info(`[taskWorker] injecting BMAD skills for task "${task.title}": ${_skillIds.join(', ')}`);
        }
      } catch (e) { log.warn('[taskWorker] bmad-skills parse error', { error: e.message }); }
    }
    // If no explicit skill annotation, still use bmad-master as default
    if (!taskSystemPrompt) {
      const _skillConfig = loadMergedConfig();
      if (_skillConfig.skills['bmad-master']) {
        taskSystemPrompt = buildSystemPrompt(['bmad-master'], _skillConfig);
        log.info(`[taskWorker] using BMAD Master as default orchestrator for task "${task.title}"`);
      }
    }

    // Auto-continue loop: keep resuming until agent completes or budget exhausted
    let taskContinueCount = 0;
    let currentTaskPrompt = prompt;
    let currentTaskCid = claudeSessionId;
    let lastTaskResult = null;
    const effectiveTaskMaxTurns = task._bmadWorkflow?.maxTurns || task.max_turns || 30;

    while (true) {
      lastTaskResult = null;
      hasError = false; // Reset per iteration — only the LAST iteration's error state matters for final status
      // Resolve effort level: runtime phase config > workflow default > undefined.
      // Live config (Settings dialog) wins over workflow hardcoded values so changes
      // take effect immediately on subsequent dispatches.
      const _liveBmadCfg = getBmadConfig();
      const _bmadPhaseTag = (task.notes || '').match(/\[bmad-phase:(\w+)\]/);
      // Derive phase from workflow type if no explicit phase tag (most BMAD tasks)
      const _phaseFromWorkflow = task._bmadWorkflowType ? ({
        'create-story': 'bmad_implementation', 'dev-story': 'bmad_implementation',
        'quick-dev': 'bmad_implementation', 'quick-spec': 'bmad_implementation',
        'quick-dev-new-preview': 'bmad_implementation', 'quick-flow-solo-dev': 'bmad_implementation',
        'code-review': 'bmad_qa', 'e2e-tests': 'bmad_qa', 'playwright-qa': 'bmad_qa',
        'adversarial-review': 'bmad_qa', 'edge-case-review': 'bmad_qa',
        'solutioning': 'bmad_architecture', 'readiness-check': 'bmad_architecture',
        'sprint-planning': 'bmad_architecture',
        'planning': 'bmad_prd', 'edit-prd': 'bmad_prd', 'validate-prd': 'bmad_prd', 'ux-design': 'bmad_prd',
        'analysis': 'bmad_brainstorm', 'research': 'bmad_brainstorm', 'brainstorming': 'bmad_brainstorm',
        'domain-research': 'bmad_brainstorm', 'market-research': 'bmad_brainstorm',
        'technical-research': 'bmad_brainstorm', 'product-brief-preview': 'bmad_brainstorm',
      })[task._bmadWorkflowType] : null;
      const _phaseKey = (_bmadPhaseTag && _bmadPhaseTag[1]) || _phaseFromWorkflow;
      const _resolvedEffort = (_phaseKey && _liveBmadCfg.efforts[_phaseKey])
        || task._bmadWorkflow?.effort
        || undefined;
      // Resolve model: runtime phase config > task model > session model > workflow default > sonnet
      const _resolvedModel = (_phaseKey && _liveBmadCfg.models[_phaseKey])
        || task.model
        || session?.model
        || task._bmadWorkflow?.model
        || 'sonnet';
      const _sendOpts = { prompt: currentTaskPrompt, sessionId: currentTaskCid, model: _resolvedModel, maxTurns: effectiveTaskMaxTurns, abortController: taskAbort };
      if (_resolvedEffort) _sendOpts.effort = _resolvedEffort;

      // Sync session.model + task.model to the resolved model so the kanban UI shows
      // the actual model being used (not a stale value from when the session/task was
      // originally created under different settings).
      try {
        if (sessionId && session && session.model !== _resolvedModel) {
          db.prepare(`UPDATE sessions SET model=? WHERE id=?`).run(_resolvedModel, sessionId);
        }
        if (task.model !== _resolvedModel) {
          db.prepare(`UPDATE tasks SET model=? WHERE id=?`).run(_resolvedModel, task.id);
        }
      } catch (e) { /* non-fatal */ }
      if (taskSystemPrompt) _sendOpts.systemPrompt = taskSystemPrompt;
      // MCP servers: disabled for --print mode (Claude CLI ignores --mcp-config in --print mode).
      // QA browser testing uses Playwright via Bash scripts instead.
      // Uncomment below if future Claude CLI versions support MCP in --print mode.
      // const _mcpConfig = loadMergedConfig();
      // if (_mcpConfig.mcpServers && Object.keys(_mcpConfig.mcpServers).length > 0) {
      //   _sendOpts.mcpServers = _mcpConfig.mcpServers;
      // }
      const stream = cli.send(_sendOpts);
      // Save subprocess PID so startup recovery can kill orphans on restart
      if (stream.process?.pid) {
        db.prepare(`UPDATE tasks SET worker_pid=? WHERE id=?`).run(stream.process.pid, task.id);
      }
      await new Promise(resolve => {
        stream
          .onText(t => {
            fullText += t;
            taskBuffers.set(task.id, (taskBuffers.get(task.id) || '') + t);
            broadcastToSession(sessionId, { type: 'text', text: t, tabId: sessionId });
          })
          .onTool((name, inp) => {
            try { stmts.addMsg.run(sessionId, 'assistant', 'tool', (inp || '').substring(0, 500), name, null, null, null); } catch {}
            // Capture Bash/Read/Write tool inputs so Playwright enforcement can see
            // scripts written via heredoc (cat > file <<SCRIPT ...). These don't
            // show up in fullText which only contains natural-language text.
            if (name === 'Bash' || name === 'Write' || name === 'Edit') {
              toolCommandBodies += '\n' + String(inp || '').slice(0, 20000);
            }
            if (name !== 'ask_user' && name !== 'notify_user' && name !== 'set_ui_state') {
              broadcastToSession(sessionId, { type: 'tool', tool: name, input: (inp || '').substring(0, 600), tabId: sessionId });
            }
          })
          .onSessionId(sid => { newCid = sid; currentTaskCid = sid; try { stmts.updateClaudeId.run(sid, sessionId); } catch {} })
          .onResult(r => { lastTaskResult = r; })
          .onError(err => {
            hasError = true;
            console.error(`[taskWorker] task ${task.id} error:`, err);
            try { stmts.addMsg.run(sessionId, 'assistant', 'text', `❌ ${err.substring(0, 500)}`, null, null, null, null); } catch {}
            broadcastToSession(sessionId, { type: 'error', error: err.substring(0, 500), tabId: sessionId });
          })
          .onDone(sid => {
            if (sid) { newCid = sid; currentTaskCid = sid; }
            resolve();
          });
      });

      // ✅ Success — agent finished naturally
      if (lastTaskResult?.subtype === 'success') break;
      // 💰 Budget limit — can't continue
      if (lastTaskResult?.subtype === 'error_max_budget_usd') break;
      // 🛑 User stopped or aborted
      if (taskAbort?.signal?.aborted || stoppingTasks.has(task.id)) break;
      // 🔄 Auto-continue budget exhausted
      if (taskContinueCount >= MAX_AUTO_CONTINUES) {
        console.log(`[taskWorker] task ${task.id}: auto-continue budget exhausted (${MAX_AUTO_CONTINUES})`);
        break;
      }

      // 🔄 Auto-continue — agent stopped but didn't finish
      taskContinueCount++;
      console.log(`[taskWorker] task ${task.id}: auto-continuing (${taskContinueCount}/${MAX_AUTO_CONTINUES}), reason: ${lastTaskResult?.subtype || 'unknown'}`);
      const notice = `\n⏳ Auto-continuing (${taskContinueCount}/${MAX_AUTO_CONTINUES})...\n`;
      fullText += notice;
      taskBuffers.set(task.id, (taskBuffers.get(task.id) || '') + notice);
      broadcastToSession(sessionId, { type: 'text', text: notice, tabId: sessionId });
      currentTaskPrompt = 'Continue where you left off. Complete the remaining work. When finished, run the MANDATORY POST-TASK VERIFICATION from your original instructions.';
    }

    // After loop: persist text and determine task status
    try {
      if (newCid) { try { stmts.updateClaudeId.run(newCid, sessionId); } catch (e) { log.error('taskWorker updateClaudeId failed', { cid: String(newCid).substring(0,50), sessionId, err: e.message, stack: e.stack }); } }
      if (fullText) { try { stmts.addMsg.run(sessionId, 'assistant', 'text', fullText, null, null, null, null); } catch (e) { log.error('taskWorker addMsg(assistant) failed', { sessionId, textLen: fullText.length, err: e.message, stack: e.stack }); } }
      const wasStopped = stoppingTasks.has(task.id);
      stoppingTasks.delete(task.id);
      if (!wasStopped) {
        const isSuccess = lastTaskResult?.subtype === 'success' && !hasError;
        const isRateLimited = hasError && (fullText.includes('rate_limit') || fullText.includes('overloaded') || fullText.includes('Too many'));
        const MAX_CHAIN_RETRIES = 2;

        // 🛡️ PRE-CHECK: Detect completed work regardless of process exit status
        // Claude may hit max_turns or timeout AFTER completing all work.
        // Check output for completion markers before deciding success/failure.
        const _tail3k = (fullText || '').slice(-3000);
        const _hasCompletionEvidence = 
          _tail3k.includes('✅ Done') || _tail3k.includes('✅ done') ||
          _tail3k.includes('VERIFICATION') || _tail3k.includes('verification') ||
          _tail3k.includes('All acceptance criteria') || _tail3k.includes('all acceptance criteria') ||
          _tail3k.includes('Task complete') || _tail3k.includes('task complete') ||
          _tail3k.includes('Implementation complete') || _tail3k.includes('implementation complete') ||
          _tail3k.includes('Successfully implemented') || _tail3k.includes('successfully completed') ||
          _tail3k.includes('All requirements verified') || _tail3k.includes('all requirements verified') ||
          _tail3k.includes('Build passed') || _tail3k.includes('build passed') ||
          /Done\s*[—–-]/.test(_tail3k) ||
          (/verified|confirmed|passing/i.test(_tail3k) && /commit|committed/i.test(_tail3k));

        // Override isSuccess if output proves completion
        const effectiveSuccess = isSuccess || _hasCompletionEvidence;
        if (!isSuccess && _hasCompletionEvidence) {
          log.warn(`[taskWorker] task ${task.id}: process exit was not success (subtype: ${lastTaskResult?.subtype}) but output contains completion markers — treating as success`);
        }

        if (effectiveSuccess) {
          // 🛡️ SAFEGUARD: Detect timeout masquerading as success
          // If the agent exhausted all auto-continues, check if it actually completed
          const tail2k = (fullText || '').slice(-2000);
          const hasCompletionMarker = 
            tail2k.includes('✅ Done') || tail2k.includes('✅ done') ||
            tail2k.includes('--- \n✅') || tail2k.includes('---\n✅') ||
            tail2k.includes('VERIFICATION') || tail2k.includes('verification') ||
            tail2k.includes('All acceptance criteria') || tail2k.includes('all acceptance criteria') ||
            tail2k.includes('Task complete') || tail2k.includes('task complete') ||
            tail2k.includes('Implementation complete') || tail2k.includes('implementation complete') ||
            tail2k.includes('Successfully') || tail2k.includes('successfully completed') ||
            /Done\s*[—–-]/.test(tail2k);
          const hitContinueLimit = taskContinueCount >= MAX_AUTO_CONTINUES;
          
          if (hitContinueLimit && !hasCompletionMarker) {
            // Agent timed out without completing — auto-retry up to 2 times
            const retryCount = task.task_retry_count || 0;
            const MAX_TIMEOUT_RETRIES = 2;
            
            if (retryCount < MAX_TIMEOUT_RETRIES) {
              // Re-queue with continuation context
              log.warn(`[taskWorker] task ${task.id}: timed out without completion — re-queuing (retry ${retryCount + 1}/${MAX_TIMEOUT_RETRIES})`);
              
              // Save what was done so far as context for the retry
              const progressSummary = (fullText || '').slice(-3000).trim();
              const continuationNote = `\n\n---\nPREVIOUS ATTEMPT CONTEXT (retry ${retryCount + 1}):\nThe previous attempt ran out of turns before completing. Here is what was accomplished:\n\n${progressSummary}\n\n---\nCONTINUE FROM WHERE THE PREVIOUS ATTEMPT LEFT OFF. Do NOT restart from scratch. Complete the remaining work and save the output file.`;
              
              // Update task: reset to bmad_workflow, increment retry count, append continuation context
              const updatedDesc = (task.description || '') + continuationNote;
              db.prepare(`UPDATE tasks SET status='bmad_workflow', session_id=NULL, failure_reason='timeout_retry_${retryCount + 1}', task_retry_count=?, description=?, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
                .run(retryCount + 1, updatedDesc, task.id);
              
              wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
              const projName = getProjectName(task.workdir);
              openclawNotify.taskFailed(task, projName, `Timed out — auto-retrying (${retryCount + 1}/${MAX_TIMEOUT_RETRIES})`);
              
              // Trigger queue processing after a short delay
              setTimeout(processQueue, 5000);
            } else {
              // Exhausted retries — now truly cancel
              log.error(`[taskWorker] task ${task.id}: timed out after ${MAX_TIMEOUT_RETRIES} retries — cancelling`);
              db.prepare(`UPDATE tasks SET status='cancelled', failure_reason='timeout_exhausted', worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
                .run(task.id);
              try { updateStoryOnCompletion(task, 'failed', fullText); } catch (e) { /* ignore */ }
              try { updateSprintStatus(task.workdir || WORKDIR); } catch (e) { /* ignore */ }
              wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
              const projName = getProjectName(task.workdir);
              openclawNotify.taskFailed(task, projName, `Timed out after ${MAX_TIMEOUT_RETRIES} retries — cancelled. Manual intervention needed.`);
            }
          } else {
          // Check if this is an interactive/planning task that needs user input
          // Check if Claude is asking a question at the END of its response (last 300 chars)
          const tail = (fullText || '').slice(-300);
          const hasQuestionMark = tail.includes('?') || tail.includes('❓') || tail.includes('⁉');
          const hasQuestionPattern = (
            tail.includes('Would you') || tail.includes('Do you') || tail.includes('Should I') ||
            tail.includes('What ') || tail.includes('Which ') || tail.includes('How ') ||
            tail.includes('please ') || tail.includes('let me know') || tail.includes('your thoughts') ||
            tail.includes('prefer') || tail.includes('ready to') || tail.includes('like to') ||
            tail.includes('want to') || tail.includes('option') || tail.includes('choose') ||
            tail.includes('Waiting for input') || tail.includes('waiting for input') ||
            tail.includes('select one') || tail.includes('your choice') ||
            /\*\*\[.\]/.test(tail)
          );
          const isAskingQuestion = hasQuestionMark && hasQuestionPattern;
          
          if (isAskingQuestion) {
            // Claude is waiting for user input — park the task
            // Extract last meaningful section for context (last 1500 chars, trimmed to last section break)
            const contextRaw = (fullText || '').slice(-1500);
            const sectionBreak = contextRaw.search(/\n#{1,3} |\n\*\*[A-Z]|\n---/);
            const contextSnippet = (sectionBreak > 0 ? contextRaw.slice(sectionBreak) : contextRaw).trim().substring(0, 1800);
            
            db.prepare(`UPDATE tasks SET status='awaiting_input', worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
              .run(task.id);
            log.info(`[taskWorker] task ${task.id}: awaiting user input`);
            wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
            // Notify via Discord
            const projName = getProjectName(task.workdir);
            openclawNotify.taskAwaitingInput(task, projName, contextSnippet);
          } else {
          // 🎭 Server-enforced Playwright check: ANY task that modified frontend files
          // MUST have used real Playwright browser testing. No curl/HTTP fallback accepted.
          const _isQaTask = (task.title || '').startsWith('QA:') || ((task.notes || '').includes('[bmad-workflow:playwright-qa]'));
          const _isBackendQa = (task.notes || '').includes('[bmad-workflow:backend-qa]');

          // Detect frontend file changes in this task's output (for ALL workflows, not just QA)
          const _fullOutLC = (fullText || '').toLowerCase();
          const _touchedFrontend = /\.(vue|tsx?|jsx?|svelte)(\b|['"`,:\s])/i.test(fullText || '') ||
                                  /\+\+\+\s+b\/[^\n]+\.(vue|tsx?|jsx?|css|scss|svelte|html)/i.test(fullText || '');
          // Is this an implementation workflow that could produce frontend changes?
          const _wfTypeNow = task._bmadWorkflowType || ((task.notes || '').match(/\[bmad-workflow:([\w-]+)\]/)?.[1]) || '';
          const _isImplWorkflow = ['dev-story', 'quick-dev', 'quick-dev-new-preview', 'quick-flow-solo-dev', 'quick-spec', 'code-review'].includes(_wfTypeNow);

          // Strict Playwright-execution regex: require TWO distinct evidence markers
          // across BOTH fullText AND tool call bodies (Bash/Write commands). Agents
          // typically write Playwright scripts via `cat > file.mjs <<SCRIPT` heredocs
          // which live in tool call inputs, not in natural-language output.
          const _scanText = (fullText || '') + '\n' + (toolCommandBodies || '');
          const _playwrightExec = _scanText ? (
            /chromium\.launch\s*\(/.test(_scanText) +
            /browser\.newPage\s*\(/.test(_scanText) +
            /page\.goto\s*\(/.test(_scanText) +
            /page\.screenshot\s*\(/.test(_scanText) +
            /from\s+['"]playwright['"]/.test(_scanText) +
            /require\s*\(\s*['"]playwright['"]\s*\)/.test(_scanText)
          ) : 0;
          const _usedPlaywright = _playwrightExec >= 2;

          // Evasion markers: these indicate the agent tried to sidestep Playwright.
          // Only check fullText (natural-language output) — tool command bodies may
          // legitimately contain the word 'curl' for real API testing alongside
          // Playwright browser testing.
          const _hasEvasion = /mcp.*not.*available|playwright.*mcp.*not|fallback.*curl|as\s+(?:a\s+)?fallback.*curl|using\s+curl.*instead|curl.*instead.*of.*playwright|http\s+200.*instead/i.test(fullText || '');

          // Enforce for: (a) QA tasks (existing behavior) OR (b) impl tasks with frontend file changes.
          // Both enforcement flags are runtime-configurable via the Settings dialog.
          const _bmadCfgLive = getBmadConfig();
          const _enforceQA = _bmadCfgLive.playwright.enforceForQA !== false;
          const _enforceImpl = _bmadCfgLive.playwright.enforceForImplementation !== false;
          const _mustVerifyBrowser = (_isQaTask && !_isBackendQa && _enforceQA) || (_isImplWorkflow && _touchedFrontend && _enforceImpl);
          if (_mustVerifyBrowser && fullText && (!_usedPlaywright || _hasEvasion)) {
            const _reason = _hasEvasion
              ? 'QA_PLAYWRIGHT_EVASION: Task attempted to bypass Playwright (curl fallback / MCP-not-available excuse). Real browser testing is mandatory.'
              : 'QA_NO_PLAYWRIGHT: Real Playwright execution not detected (need chromium.launch + page.goto + page.screenshot). curl / HTTP checks are not acceptable.';
            log.warn(`[taskWorker] task ${task.id} ("${task.title}") FAILED Playwright enforcement: evasion=${_hasEvasion} execMarkers=${_playwrightExec} fullTextLen=${(fullText||'').length} toolBodiesLen=${toolCommandBodies.length}`);
            db.prepare(`UPDATE tasks SET status='bmad_workflow', failure_reason=?, task_retry_count=COALESCE(task_retry_count,0)+1, session_id=NULL, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
              .run(_reason, task.id);
            wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
            openclawNotify.taskFailed && openclawNotify.taskFailed(task, _reason, getProjectName(task.workdir));
            return; // Don't proceed to done_review
          }
          // ✅ Success — AI-completed tasks go to done_review for user approval (auto-moves to done after 24h)
          db.prepare(`UPDATE tasks SET status='done_review', failure_reason=NULL, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
            .run(task.id);
          db.prepare(`UPDATE sessions SET retry_count=0 WHERE id=?`).run(sessionId);
          log.info(`[taskWorker] task ${task.id}: done_review (pending user review)`);
          // 📝 Update story file and sprint status
          try { updateStoryOnCompletion(task, 'done', fullText); } catch (e) { log.warn(`[bmad-story] ${e.message}`); }
          try { updateSprintStatus(task.workdir || WORKDIR); } catch (e) { log.warn(`[bmad-sprint] ${e.message}`); }
          // 🔗 Auto-chain: BMAD planning pipeline (domain-research → planning → solutioning → sprint-planning)
          try { autoBmadPipelineChain(task); } catch (e) { log.warn(`[auto-pipeline] ${e.message}`); }
          // 🔗 Auto-chain: create-story → dev-story (server-enforced, not agent-dependent)
          try { autoChainCreateStoryToDev(task); } catch (e) { log.warn(`[auto-chain] ${e.message}`); }
          // 🧪 Auto-create QA task for dev workflows (server-enforced, not agent-dependent)
          try { autoCreateQATask(task, fullText); } catch (e) { log.warn(`[auto-qa] ${e.message}`); }
          // 🔧 Auto-create fix tasks from QA reports (server-side, no auth needed)
          try { autoCreateFixFromQA(task, fullText); } catch (e) { log.warn(`[auto-fix] ${e.message}`); }
          // 🔄 Auto-epic progression: when last task in a chain completes, activate next epic
          try { autoActivateNextEpic(task); } catch (e) { log.warn(`[auto-epic] ${e.message}`); }
          // 🔄 Auto-schedule next occurrence for recurring tasks
          scheduleNextRun(task);
          // Notify Telegram about completed task
          if (telegramBot && telegramBot.isRunning()) {
            telegramBot.notifyTaskComplete({
              sessionId,
              title: task.title || 'Task',
              status: 'done_review',
              duration: Date.now() - _taskStartedAt,
            }).catch(() => {});
          }
          // Task 18: Forward completion event to OpenClaw
          openclawBridge.emitEvent({
            type: 'task_complete',
            taskId: task.id,
            title: task.title,
            result: fullText ? fullText.substring(0, 2000) : null,
            duration: Date.now() - _taskStartedAt,
            workdir: task.workdir || null,
          });
          // Extract summary from end of output for notification
          const _completionTail = (fullText || '').slice(-2000);
          // Look for VERIFICATION block, or last markdown section, or last 500 chars
          let _summary = '';
          const verMatch = _completionTail.match(/VERIFICATION:[\s\S]*/);
          if (verMatch) {
            _summary = verMatch[0].substring(0, 1500);
          } else {
            // Find last section heading
            const sections = _completionTail.split(/\n#{1,3} /);
            if (sections.length > 1) {
              _summary = '## ' + sections[sections.length - 1].trim().substring(0, 1500);
            } else {
              _summary = _completionTail.slice(-800).trim();
            }
          }
          openclawNotify.taskCompleted(task, Date.now() - _taskStartedAt, getProjectName(task.workdir), _summary);
          
          // Auto-commit for implementation tasks (scope-aware: stages only story File List files)
          const AUTO_COMMIT_WORKFLOWS = new Set(['quick-dev', 'dev-story', 'quick-spec']);
          const _wfType = task._bmadWorkflowType || ((task.notes || '').match(/\[bmad-workflow:([\w-]+)\]/)?.[1]);
          const _hasBmadPhase = (task.notes || '').match(/\[bmad-phase:(implementation|qa)\]/);
          if ((_wfType && AUTO_COMMIT_WORKFLOWS.has(_wfType)) || _hasBmadPhase) {
            const cwd = task.workdir || WORKDIR;
            try {
              const { execSync: _exec } = require('child_process');
              const _dirtyOutput = _exec('git status --porcelain', { cwd, timeout: 5000 }).toString().trim();
              if (_dirtyOutput) {
                let _commitDone = false;

                // Primary: stage only files declared in the story File List
                if (storyPath) {
                  try {
                    const _storyContent = fs.readFileSync(storyPath, 'utf8');
                    const _fileList = extractFileListFromStory(_storyContent, cwd);
                    if (_fileList && _fileList.length > 0) {
                      // Always include sprint-status.yaml and the story file itself
                      const _sprintStatus = path.join(cwd, '_bmad-output', 'sprint-status.yaml');
                      const _allFiles = [...new Set([..._fileList, storyPath, _sprintStatus])];
                      for (const absFile of _allFiles) {
                        try {
                          const relFile = path.relative(cwd, absFile);
                          if (relFile.startsWith('..')) continue; // skip files outside repo (e.g. bench paths)
                          _exec(`git add -- ${JSON.stringify(relFile)}`, { cwd, timeout: 5000 });
                        } catch (_fe) { /* file may not exist or untracked, skip */ }
                      }
                      const _staged = _exec('git diff --cached --name-only', { cwd, timeout: 5000 }).toString().trim();
                      if (_staged) {
                        const commitMsg = `feat(${_wfType || 'impl'}): ${task.title.substring(0, 72)}\n\nAutomated commit by Claude Studio`;
                        _exec(`git commit --no-verify -m ${JSON.stringify(commitMsg)}`, { cwd, timeout: 15000 });
                        log.info(`[taskWorker] auto-committed ${_staged.split('\n').length} task-scoped files for task ${task.id} (File List)`);
                      } else {
                        log.info(`[taskWorker] auto-commit: File List files not dirty for task ${task.id}, skipping`);
                      }
                      // Do NOT set _commitDone=true here. The agent's File List may have
                      // missed files it edited (e.g. i18n locale files). Let the pre-task
                      // baseline fallback run AFTER the File List commit to catch leftovers.
                    }
                  } catch (_parseErr) {
                    log.warn(`[taskWorker] auto-commit File List parse error for task ${task.id}: ${_parseErr.message}`);
                  }
                }

                // Sweep: pick up anything the File List missed (i18n files, config, etc.)
                // Scoped by _preTaskDirtyFiles so unrelated pre-existing dirt is NOT staged.
                if (!_commitDone && task._preTaskDirtyFiles) {
                  // Re-read dirty output (the File List commit above may have cleared some)
                  const _dirtyNow = _exec('git status --porcelain', { cwd, timeout: 5000 }).toString().trim();
                  const _newDirtyFiles = _dirtyNow.split('\n')
                    .filter(l => l.trim())
                    .map(l => l.slice(3).trim())
                    .filter(f => !task._preTaskDirtyFiles.has(f));
                  if (_newDirtyFiles.length > 0) {
                    for (const f of _newDirtyFiles) {
                      try { _exec(`git add -- ${JSON.stringify(f)}`, { cwd, timeout: 5000 }); } catch (_fe) {}
                    }
                    const _staged2 = _exec('git diff --cached --name-only', { cwd, timeout: 5000 }).toString().trim();
                    if (_staged2) {
                      const commitMsg = `feat(${_wfType || 'impl'}): ${task.title.substring(0, 72)} (missed files)\n\nAutomated sweep commit — files not in story File List but modified during task.`;
                      _exec(`git commit --no-verify -m ${JSON.stringify(commitMsg)}`, { cwd, timeout: 15000 });
                      log.info(`[taskWorker] auto-committed ${_staged2.split('\n').length} missed files for task ${task.id} (sweep after File List)`);
                    }
                  }
                  _commitDone = true;
                }

                // Last resort: commit all dirty files (no story file, no pre-task baseline)
                if (!_commitDone) {
                  _exec('git add -A', { cwd, timeout: 10000 });
                  const commitMsg = `feat(${_wfType || 'impl'}): ${task.title.substring(0, 72)}\n\nAutomated commit by Claude Studio`;
                  _exec(`git commit --no-verify -m ${JSON.stringify(commitMsg)}`, { cwd, timeout: 15000 });
                  log.info(`[taskWorker] auto-committed all dirty files for task ${task.id} in ${cwd} (last resort)`);
                }
              }
            } catch (e) {
              log.warn(`[taskWorker] auto-commit failed for task ${task.id}: ${e.message}`);
            }
          }
          
          } // end else (non-interactive success)
          } // end else (not timed out)
        } else if (task.chain_id && (task.task_retry_count || 0) < MAX_CHAIN_RETRIES) {
          // 🔄 Auto-retry for chain tasks — don't give up on first failure
          const reason = isRateLimited ? 'rate_limited' : 'agent_incomplete';
          _retryBackoffMs = isRateLimited ? Math.min(60000 * ((task.task_retry_count || 0) + 1), 300000) : 3000;
          db.prepare(`UPDATE tasks SET status='bmad_workflow', failure_reason=?, task_retry_count=COALESCE(task_retry_count,0)+1, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
            .run(reason, task.id);
          log.warn(`[taskWorker] task ${task.id}: chain retry ${(task.task_retry_count||0)+1}/${MAX_CHAIN_RETRIES}, reason: ${reason}, backoff: ${_retryBackoffMs}ms`);
          if (task.source_session_id) {
            const _ctx = getNotificationContext(task.source_session_id);
            broadcastToSession(task.source_session_id, {
              type: 'notification', level: 'warn',
              title: `Retrying: "${task.title}"`,
              detail: `Attempt ${(task.task_retry_count||0)+2}/${MAX_CHAIN_RETRIES+1}${isRateLimited ? '. Rate limited, backing off.' : ''}`,
              chainTaskId: task.id, chainStatus: 'retry',
              sessionTitle: _ctx.sessionTitle, projectName: _ctx.projectName,
            });
          }
        } else {
          // ❌ Failed — retries exhausted or not a chain task
          const reason = isRateLimited ? 'rate_limited' : 'agent_incomplete';
          db.prepare(`UPDATE tasks SET status='cancelled', failure_reason=?, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
            .run(reason, task.id);
          log.error(`[taskWorker] task ${task.id}: cancelled (${reason}, subtype: ${lastTaskResult?.subtype || 'unknown'})`);
          try { updateStoryOnCompletion(task, 'failed', fullText); } catch (e) { /* ignore */ }
          try { updateSprintStatus(task.workdir || WORKDIR); } catch (e) { /* ignore */ }
          // Notify source chat about the failed task
          if (task.source_session_id) {
            const _ctx = getNotificationContext(task.source_session_id);
            broadcastToSession(task.source_session_id, {
              type: 'notification', level: 'error',
              title: `Task failed: "${task.title}"`,
              detail: task.chain_id ? `Retries exhausted (${reason}). Dependent tasks will be cancelled.` : reason,
              chainTaskId: task.id, chainStatus: 'cancelled',
              sessionTitle: _ctx.sessionTitle, projectName: _ctx.projectName,
            });
          }
          // Notify Telegram about failed task
          if (telegramBot && telegramBot.isRunning()) {
            telegramBot.notifyTaskComplete({
              sessionId,
              title: task.title || 'Task',
              status: 'error',
              duration: Date.now() - _taskStartedAt,
              error: reason,
            }).catch(() => {});
          }
          // Task 18: Forward failure event to OpenClaw
          openclawBridge.emitEvent({
            type: 'task_failed',
            taskId: task.id,
            title: task.title,
            error: reason,
            duration: Date.now() - _taskStartedAt,
            workdir: task.workdir || null,
          });
          openclawNotify.taskFailed(task, reason, getProjectName(task.workdir));
          // Cascade cancel of dependents happens in next processQueue() run
        }
      } else {
        // User manually stopped — mark as user_cancelled, cascade will follow.
        // EXCEPTION: if the task is being restarted, DON'T overwrite the status
        // (the /restart endpoint has already set it to bmad_workflow).
        if (restartingTasks.has(task.id)) {
          restartingTasks.delete(task.id);
          log.info(`[taskWorker] task ${task.id}: worker exited for restart — status untouched`);
        } else {
          db.prepare(`UPDATE tasks SET status='cancelled', failure_reason='user_cancelled', worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
            .run(task.id);
          log.info(`[taskWorker] task ${task.id}: stopped by user`);
        }
      }
    } catch (e) {
      console.error(`[taskWorker] task ${task.id} onDone DB error:`, e);
    }
    broadcastToSession(sessionId, { type: 'done', tabId: sessionId, taskId: task.id, duration: Date.now() - _taskStartedAt });
  } catch (err) {
    log.error(`[taskWorker] task ${task.id} exception`, { message: err.message, name: err.name, stack: err.stack });
    try {
      // Exception: auto-retry for chain tasks, cancel for non-chain
      const failureMsg = `${err.name}: ${err.message}`;
      if (task.chain_id && (task.task_retry_count || 0) < 2) {
        db.prepare(`UPDATE tasks SET status='bmad_workflow', failure_reason=?, task_retry_count=COALESCE(task_retry_count,0)+1, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`).run(failureMsg, task.id);
        _retryBackoffMs = 5000;
        log.warn(`[taskWorker] task ${task.id}: exception → auto-retry`);
      } else {
        db.prepare(`UPDATE tasks SET status='cancelled', failure_reason=?, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`).run(failureMsg, task.id);
      }
    } catch {}
    // Send done so the client doesn't wait forever for an event that will never arrive.
    if (sessionId) broadcastToSession(sessionId, { type: 'done', tabId: sessionId, taskId: task.id, duration: Date.now() - _taskStartedAt });
  } finally {
    taskBuffers.delete(task.id);
    taskRunning.delete(task.id);
    runningTaskAborts.delete(task.id);
    setTimeout(processQueue, _retryBackoffMs || 500);
  }
}

// ─── Recurring task scheduler ────────────────────────────────────────────────
function calcNextRun(scheduled_at, recurrence) {
  const d = new Date(scheduled_at * 1000);
  if (recurrence === 'hourly')  d.setHours(d.getHours() + 1);
  if (recurrence === 'daily')   d.setDate(d.getDate() + 1);
  if (recurrence === 'weekly')  d.setDate(d.getDate() + 7);
  if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
  return Math.floor(d.getTime() / 1000);
}

function scheduleNextRun(task) {
  if (!task.recurrence || !task.scheduled_at) return;
  const now = Math.floor(Date.now() / 1000);
  // Find next future occurrence — handles server downtime gaps gracefully.
  // Cap iterations to prevent runaway loops for very old tasks.
  let next = calcNextRun(task.scheduled_at, task.recurrence);
  let guard = 0;
  while (next <= now && guard < 10000) { next = calcNextRun(next, task.recurrence); guard++; }
  if (guard >= 10000) { log.warn(`[schedule] Too many iterations for "${task.title}", skipping`); return; }
  // Respect end date
  if (task.recurrence_end_at && next > task.recurrence_end_at) {
    log.info(`[schedule] Recurrence series ended for "${task.title}"`);
    return;
  }
  const newId = genId();
  const _tn = stmts.nextTaskNumber.get(task.workdir || '').next_num;
  stmts.createTask.run(
    newId, task.title, task.description || '', task.notes || '', task.status || 'bmad_workflow', task.sort_order || 0,
    task.session_id || null, task.workdir || null, task.model || 'sonnet',
    task.mode || 'auto', task.agent_mode || 'single', task.max_turns || 30,
    null, null, null, null,
    next, task.recurrence, task.recurrence_end_at || null, _tn, task.dep_group || null
  );
  log.info(`[schedule] Next run queued: "${task.title}" → ${new Date(next * 1000).toISOString()}`);
}

function processQueue() {
  const todo = stmts.getTodoTasks.all();
  if (!todo.length) return;

  // ── BMAD Sprint Auto-Dispatch: expand BMAD sprint stories into agent chains ──
  for (const task of todo) {
    if (task.chain_id) continue; // already part of a chain
    const bmadMatch = (task.notes || '').match(/\[bmad:([^\]]+)\]/);
    if (!bmadMatch) continue; // not a BMAD sprint task
    
    // Check if story file exists in the project
    const storyId = bmadMatch[1];
    const workdir = task.workdir || WORKDIR;
    
    // This is a BMAD sprint story — expand into a dispatch chain
    log.info(`[BMAD] Auto-dispatching sprint story: ${storyId}`);
    
    const chainId = genId();
    const chainSessionId = genId();
    stmts.createSession.run(
      chainSessionId, task.title.substring(0, 200),
      '[]', '[]', 'auto', 'single', task.model || 'sonnet', 'cli', workdir
    );
    
    // Create the BMAD workflow chain: analyze → elicitate → design → validate → implement → review → verify
    const subtasks = [
      // 1. Analyst (opus) — brainstorm phase + Party Mode
      {
        title: `[BMAD Analyst] Research & Requirements — ${storyId}`,
        description:
          `PARTY MODE ACTIVE: Before executing your analysis, facilitate a multi-agent discussion.\n` +
          `Simulate perspectives from these BMAD agents:\n` +
          `- Mary (Analyst 📊): Market research, competitive analysis\n` +
          `- John (PM 📋): Requirements, stakeholder alignment\n` +
          `- Sally (UX 🎨): User experience, interaction patterns\n` +
          `- Bob (SM 🏃): Sprint feasibility, story breakdown\n\n` +
          `Discussion format:\n` +
          `1. Each agent states their perspective on the story requirements (2-3 sentences each)\n` +
          `2. Identify areas of agreement and disagreement\n` +
          `3. Synthesize into unified requirements\n\n` +
          `Then proceed with your analysis tasks.\n\n` +
          `<!-- bmad-skills: ["analyst","product-manager"] -->\n` +
          `You are the BMAD Analyst. Analyze the story requirements for: ${storyId}\n\n` +
          `Epic context from sprint: ${task.title}\n\n${task.description || ''}\n\n` +
          `Tasks:\n` +
          `1. Read the project's _bmad-output/implementation-artifacts/ directory to find story files\n` +
          `2. If no story file exists for ${storyId}, create one based on the epic file's acceptance criteria\n` +
          `3. Analyze the existing codebase to understand current architecture and patterns\n` +
          `4. Document technical requirements, dependencies, and risks\n` +
          `5. Write your analysis as a comment at the top of the story file\n` +
          `\nOutput: A clear story file with requirements, acceptance criteria, and technical notes.`,
        sort: 0,
        bmadPhase: 'bmad_brainstorm',
        model: 'opus',
      },
      // 2. Elicitation: Pre-mortem + Stakeholder Round Table (opus) — brainstorm phase
      {
        title: `[BMAD Elicitation] Requirements Analysis — ${storyId}`,
        description:
          `<!-- bmad-skills: ["advanced-elicitation","analyst"] -->\n` +
          `You are running Advanced Elicitation on the Analyst's output for story: ${storyId}\n\n` +
          `Apply these elicitation methods in sequence:\n` +
          `1. **Pre-mortem Analysis**: Assume this feature already failed in production. Work backward to find what went wrong. Document gaps in the requirements.\n` +
          `2. **Stakeholder Round Table**: Evaluate requirements from perspectives of: end user, developer, product owner, operations team. Find blind spots.\n\n` +
          `Read the story file that was just created/updated by the Analyst.\n` +
          `Apply each method, document findings, and update the story file with enhanced requirements.\n` +
          `Output: Enhanced story file with elicitation-improved requirements.`,
        sort: 1,
        depends: [0],
        bmadPhase: 'bmad_brainstorm',
        model: 'opus',
      },
      // 3. Architect (opus) — architecture phase + Party Mode
      {
        title: `[BMAD Architect] Technical Design — ${storyId}`,
        description:
          `PARTY MODE ACTIVE: Before designing, facilitate a multi-agent architecture discussion.\n` +
          `Simulate perspectives from:\n` +
          `- Winston (Architect 🏗️): System design, scalability, patterns\n` +
          `- Amelia (Developer 💻): Implementation feasibility, code patterns\n` +
          `- Quinn (QA 🧪): Testability, edge cases, failure modes\n` +
          `- Bob (SM 🏃): Story impact, sprint planning implications\n\n` +
          `Discussion format:\n` +
          `1. Each agent evaluates the proposed approach (2-3 sentences each)\n` +
          `2. Debate trade-offs and alternatives\n` +
          `3. Converge on the recommended technical approach\n\n` +
          `Then proceed with your architecture tasks.\n\n` +
          `<!-- bmad-skills: ["architect"] -->\n` +
          `You are the BMAD Architect. Design the technical approach for: ${storyId}\n\n` +
          `Tasks:\n` +
          `1. Read the story file created by the Analyst\n` +
          `2. Review existing architecture patterns in the codebase\n` +
          `3. Design the implementation approach: which files to modify/create, data models, API changes\n` +
          `4. Identify potential issues and edge cases\n` +
          `5. Create a brief implementation plan as a checklist\n` +
          `\nOutput: A technical design comment in the story file with implementation plan.`,
        sort: 2,
        depends: [1],
        bmadPhase: 'bmad_architecture',
        model: 'opus',
      },
      // 4. Elicitation: ADR + First Principles (opus) — architecture phase
      {
        title: `[BMAD Elicitation] Architecture Validation — ${storyId}`,
        description:
          `<!-- bmad-skills: ["advanced-elicitation","architect"] -->\n` +
          `You are running Advanced Elicitation on the Architecture for story: ${storyId}\n\n` +
          `Apply these methods:\n` +
          `1. **Architecture Decision Records**: Document each technical decision with explicit trade-offs, alternatives considered, and rationale.\n` +
          `2. **First Principles Thinking**: Strip away assumptions about the architecture. What must be true? Rebuild the approach from ground truth.\n\n` +
          `Read the architecture notes in the story file.\n` +
          `Apply methods, document ADRs, and update the story file.\n` +
          `Output: Architecture section with ADRs and first-principles validation.`,
        sort: 3,
        depends: [2],
        bmadPhase: 'bmad_architecture',
        model: 'opus',
      },
      // 5. Developer (sonnet) — implementation phase
      {
        title: `[BMAD Developer] Implementation — ${storyId}`,
        description:
          `<!-- bmad-skills: ["developer"] -->\n` +
          `You are the BMAD Developer. Implement the story: ${storyId}\n\n` +
          `Tasks:\n` +
          `1. Read the story file with requirements and technical design\n` +
          `2. Implement all acceptance criteria following existing code patterns\n` +
          `3. Write clean, well-documented code\n` +
          `4. Handle error cases and edge cases identified by the Architect\n` +
          `5. Run any existing tests to ensure nothing is broken\n` +
          `\nOutput: Working implementation that satisfies all acceptance criteria.`,
        sort: 4,
        depends: [3],
        bmadPhase: 'bmad_implementation',
        model: 'sonnet',
      },
      // 6. Code Reviewer + Red Team elicitation (sonnet) — implementation phase
      {
        title: `[BMAD Code Review] Review — ${storyId}`,
        description:
          `<!-- bmad-skills: ["code-review","analyst"] -->\n` +
          `You are the BMAD Code Reviewer. Review the implementation of: ${storyId}\n\n` +
          `Apply Red Team vs Blue Team elicitation:\n` +
          `- **Red Team (attacker)**: Find vulnerabilities, edge cases, logic flaws, security issues\n` +
          `- **Blue Team (defender)**: Validate robustness, propose hardening, verify fixes\n\n` +
          `Tasks:\n` +
          `1. Review all changes made by the Developer\n` +
          `2. Check against the acceptance criteria in the story file\n` +
          `3. Verify code quality: naming, patterns, error handling, security\n` +
          `4. Check for regressions or missed edge cases\n` +
          `5. Fix any issues found (HIGH severity: fix immediately, MEDIUM: fix, LOW: note)\n` +
          `\nOutput: Code review summary with issues found and fixes applied.`,
        sort: 5,
        depends: [4],
        bmadPhase: 'bmad_implementation',
        model: 'sonnet',
      },
      // 7. QA (sonnet) — qa phase
      {
        title: `[BMAD QA] Verification — ${storyId}`,
        description:
          `<!-- bmad-skills: ["qa-engineer"] -->\n` +
          `You are the BMAD QA Engineer. Verify the implementation of: ${storyId}\n\n` +
          `Tasks:\n` +
          `1. Read the story acceptance criteria\n` +
          `2. Write tests for each acceptance criterion\n` +
          `3. Run the test suite and verify all pass\n` +
          `4. Check for edge cases and error scenarios\n` +
          `5. Update the story status to 'done' if all checks pass\n` +
          `\nOutput: Test results and verification report.`,
        sort: 6,
        depends: [5],
        bmadPhase: 'bmad_qa',
        model: 'sonnet',
      },
    ];
    
    // Create real task IDs and map dependencies
    const taskIds = subtasks.map(() => genId());
    
    db.transaction(() => {
      for (let i = 0; i < subtasks.length; i++) {
        const st = subtasks[i];
        const realDeps = (st.depends || []).map(d => taskIds[d]);
          const _tn2 = stmts.nextTaskNumber.get(workdir || '').next_num;
          stmts.createTask.run(
          taskIds[i], st.title.substring(0, 200), st.description.substring(0, 2000),
          `[bmad:${storyId}] [bmad-phase:${st.bmadPhase}] Chain subtask ${i+1}/${subtasks.length}`,
          'todo', st.sort,
          chainSessionId, workdir,
          st.model || task.model || 'sonnet', 'auto', 'single', 50, // max_turns 50 for thorough work
          null, realDeps.length ? JSON.stringify(realDeps) : null,
          chainId, null, null, null, null, _tn2, null
        );
      }
      // Remove the original task — it's been replaced by the chain subtasks
      db.prepare(`DELETE FROM tasks WHERE id=?`).run(task.id);
    })();
    
    log.info(`[BMAD] Created dispatch chain for ${storyId}: ${subtasks.length} subtasks, chain=${chainId}`);
    
    // Notify connected clients
    wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
  }
  
  // Re-fetch todo after potential expansions
  const todoRefreshed = stmts.getTodoTasks.all();
  if (!todoRefreshed.length) return;
  const inProg = stmts.getInProgressTasks.all();
  // Sessions currently occupied (in_progress or just started by taskRunning)
  const occupiedSids = new Set(inProg.filter(t => t.session_id).map(t => t.session_id));
  // Workdir-level lock: prevents parallel chain tasks from writing to the same directory concurrently
  const occupiedWorkdirs = new Set(inProg.filter(t => t.workdir).map(t => t.workdir));
  // Per-workdir running count (for MAX_PER_WORKDIR limit)
  const workdirCounts = new Map();
  inProg.forEach(t => { if (t.workdir) workdirCounts.set(t.workdir, (workdirCounts.get(t.workdir) || 0) + 1); });
  // Per-project concurrency override: each project can set its own maxWorkers in projects.json
  // (1-20). Falls back to global MAX_PER_WORKDIR when unset or invalid.
  const _pqProjects = loadProjects();
  const workdirLimitFor = (workdir) => {
    if (!workdir) return MAX_PER_WORKDIR;
    const proj = _pqProjects.find(p => p.workdir === workdir);
    const n = proj?.maxWorkers;
    if (typeof n === 'number' && n >= 1 && n <= 20) return n;
    return MAX_PER_WORKDIR;
  };
  // Count independent running tasks (null session_id)
  let indepRunning = inProg.filter(t => !t.session_id).length;
  const startedSids = new Set();
  const startedWorkdirs = new Set();
  for (const task of todoRefreshed) {
    if (taskRunning.has(task.id)) continue;
    // Dependency gate: check depends_on before starting chain tasks
    if (task.depends_on) {
      try {
        const deps = JSON.parse(task.depends_on);
        if (deps.length) {
                    const failedDep = deps.find(depId => {
            if (typeof depId === 'string' && depId.startsWith('group:')) return false; // handled below
            const dep = stmts.getTask.get(depId);
            return dep && dep.status === 'cancelled';
          });
          if (failedDep) {
            // Cascade cancel: dependency failed, this task can't run
            db.prepare(`UPDATE tasks SET status='cancelled', failure_reason='dep_failed', notes=?, updated_at=datetime('now') WHERE id=?`)
              .run(`Blocked: dependency ${failedDep} failed`, task.id);
            log.warn('Task cascade-cancelled', { taskId: task.id, failedDep });
            if (task.source_session_id) {
              const _ctx = getNotificationContext(task.source_session_id);
              broadcastToSession(task.source_session_id, {
                type: 'notification', level: 'warn',
                title: `Task cancelled: "${task.title}"`,
                detail: 'Dependency failed',
                chainTaskId: task.id, chainStatus: 'cancelled',
                sessionTitle: _ctx.sessionTitle, projectName: _ctx.projectName,
              });
            }
            continue;
          }
          const allDone = deps.every(depId => {
            // Support group dependencies: "group:S1.1" means all tasks with dep_group="S1.1" must be done
            if (typeof depId === 'string' && depId.startsWith('group:')) {
              const groupName = depId.slice(6);
              // Exclude self from group check to prevent deadlock (task in its own dep_group)
              const groupTasks = db.prepare(`SELECT id, status FROM tasks WHERE dep_group=? AND id!=?`).all(groupName, task.id);
              if (groupTasks.length === 0) return true; // no tasks in group yet — treat as satisfied
              return groupTasks.every(gt => ['done', 'done_review', 'archived'].includes(gt.status));
            }
            const dep = stmts.getTask.get(depId);
            return dep && ['done', 'done_review', 'archived'].includes(dep.status);
          });
          if (!allDone) continue; // deps not ready yet

          // Check for cancelled group deps — cascade cancel
          const hasFailedGroup = deps.some(depId => {
            if (typeof depId === 'string' && depId.startsWith('group:')) {
              const groupName = depId.slice(6);
              // Exclude self from group check
              const groupTasks = db.prepare(`SELECT id, status FROM tasks WHERE dep_group=? AND id!=?`).all(groupName, task.id);
              return groupTasks.some(gt => gt.status === 'cancelled');
            }
            return false;
          });
          if (hasFailedGroup) {
            db.prepare(`UPDATE tasks SET status='cancelled', failure_reason='dep_group_failed', updated_at=datetime('now') WHERE id=?`)
              .run(task.id);
            log.warn('Task cascade-cancelled (group dep failed)', { taskId: task.id });
            continue;
          }
        }
      } catch (e) { log.error('depends_on parse error', { taskId: task.id, error: e.message }); }
    }
    // Chain sequencing: tasks in the same chain must run in sort_order.
    // Block this task if any earlier task in the same chain is not yet done/cancelled.
    if (task.chain_id) {
      const chainTasks = stmts.getTasksByChain.all(task.chain_id);
      const earlierPending = chainTasks.some(t =>
        (t.sort_order || 0) < (task.sort_order || 0) &&
        !['done', 'done_review', 'archived', 'cancelled'].includes(t.status)
      );
      if (earlierPending) continue;
      // Also check if same-chain task was just started in this queue cycle
      if (task.workdir && [...startedWorkdirs].some(key => key === `${task.chain_id}:${task.workdir}`)) continue;
    }
    if (task.session_id) {
      // Shared session: one at a time per session, still respects workdir limit
      if (!occupiedSids.has(task.session_id) && !startedSids.has(task.session_id)) {
        if (task.workdir) {
          const wdCount = (workdirCounts.get(task.workdir) || 0);
          if (wdCount >= workdirLimitFor(task.workdir)) continue;
          workdirCounts.set(task.workdir, wdCount + 1);
        }
        if (indepRunning >= MAX_TASK_WORKERS) break;
        indepRunning++;
        occupiedSids.add(task.session_id);
        startedSids.add(task.session_id);
        if (task.chain_id && task.workdir) startedWorkdirs.add(`${task.chain_id}:${task.workdir}`);
        log.info(`[processQueue] Starting task ${task.id} (${indepRunning}/${MAX_TASK_WORKERS} global, workdir=${task.workdir ? workdirCounts.get(task.workdir) + '/' + workdirLimitFor(task.workdir) : 'none'}, session=${task.session_id.slice(0,8)})`);
        startTask(task).catch(e => console.error('[taskWorker]', e));
      }
    } else {
      // Independent: up to MAX_TASK_WORKERS concurrent globally, up to MAX_PER_WORKDIR per project
      if (indepRunning >= MAX_TASK_WORKERS) break; // no more global slots
      if (task.workdir) {
        const wdCount = (workdirCounts.get(task.workdir) || 0);
        if (wdCount >= workdirLimitFor(task.workdir)) continue; // skip this task, try next from different workdir
        workdirCounts.set(task.workdir, wdCount + 1);
      }
      indepRunning++;
      log.info(`[processQueue] Starting task ${task.id} (${indepRunning}/${MAX_TASK_WORKERS} global, workdir=${task.workdir ? workdirCounts.get(task.workdir) + '/' + workdirLimitFor(task.workdir) : 'none'})`);
      startTask(task).catch(e => console.error('[taskWorker]', e));
    }
  }
}
// Run every 15s (fast enough to pick up unblocked tasks promptly,
// light enough to be negligible — just two SELECT queries on SQLite)
// Delay first processQueue by 5s to let orphan recovery finish first
setTimeout(() => { processQueue(); setInterval(processQueue, 15000); }, 5000);

// ── Orphaned task recovery on startup ──
// Tasks stuck in active BMAD phases after a server restart have no Claude process.
// Reset them to 'bmad_workflow' so processQueue picks them up again.
// Also kill any orphaned worker PIDs that no longer exist.
(function recoverOrphanedTasks() {
  const orphaned = db.prepare(`
    SELECT id, title, status, session_id, worker_pid, notes FROM tasks 
    WHERE status IN ('in_progress','bmad_brainstorm','bmad_prd','bmad_architecture','bmad_implementation','bmad_qa')
    AND status != 'awaiting_input'
  `).all();
  if (orphaned.length) {
    log.info(`[Recovery] Found ${orphaned.length} orphaned active tasks — resetting to bmad_workflow`);
    const reset = db.prepare(`UPDATE tasks SET status='bmad_workflow', session_id=NULL, worker_pid=NULL WHERE id=?`);
    for (const t of orphaned) {
      // Check if the worker PID is still alive
      let stillRunning = false;
      if (t.worker_pid) {
        try { process.kill(t.worker_pid, 0); stillRunning = true; } catch { stillRunning = false; }
      }
      if (stillRunning) {
        log.info(`[Recovery] Skipping: ${t.title.substring(0, 60)} (pid ${t.worker_pid} still alive, status=${t.status})`);
        continue; // Don't reset tasks that are still actually running
      }
      reset.run(t.id);
      log.info(`[Recovery] Reset: ${t.title.substring(0, 60)} (was ${t.status})`);
    }
    // Trigger queue processing after a short delay
    setTimeout(processQueue, 3000);
  }
})();

// ── Auto Mode: automatically move backlog → todo for auto-enabled projects ──
const AUTO_MODE_CONCURRENCY = 5; // max concurrent chains per project

function autoModeProcess() {
  const projects = loadProjects();
  const autoProjects = projects.filter(p => p.autoMode);
  if (!autoProjects.length) return;

  for (const proj of autoProjects) {
    const workdir = proj.workdir;
    
    // Count stories actively being processed:
    // A "story" = a chain that has been expanded from a backlog task
    // Count distinct chains that have at least one task NOT in 'todo' and NOT in 'done'/'cancelled'
    // (i.e., actively executing in a BMAD phase or in_progress)
    const runningChains = db.prepare(`
      SELECT COUNT(DISTINCT chain_id) as cnt FROM tasks 
      WHERE workdir=? AND chain_id IS NOT NULL 
        AND status IN ('in_progress','bmad_workflow','bmad_brainstorm','bmad_prd','bmad_architecture','bmad_implementation','bmad_qa')
    `).get(workdir);

    // Also count chains that are fully in 'todo' (just expanded, waiting to start)
    const pendingChains = db.prepare(`
      SELECT COUNT(DISTINCT chain_id) as cnt FROM tasks
      WHERE workdir=? AND chain_id IS NOT NULL AND status='todo'
        AND chain_id NOT IN (
          SELECT DISTINCT chain_id FROM tasks
          WHERE workdir=? AND chain_id IS NOT NULL
            AND status IN ('in_progress','bmad_workflow','bmad_brainstorm','bmad_prd','bmad_architecture','bmad_implementation','bmad_qa','done','done_review','archived','cancelled')
        )
    `).get(workdir, workdir);

    // Non-chain BMAD tasks in active state (exclude scheduled/non-BMAD tasks from auto mode count)
    const nonChainActive = db.prepare(`
      SELECT COUNT(*) as cnt FROM tasks
      WHERE workdir=? AND chain_id IS NULL
        AND status IN ('todo','in_progress','bmad_workflow','bmad_brainstorm','bmad_prd','bmad_architecture','bmad_implementation','bmad_qa')
        AND notes LIKE '%[bmad:%'
    `).get(workdir);
    
    const currentStories = (runningChains?.cnt || 0) + (pendingChains?.cnt || 0) + (nonChainActive?.cnt || 0);
    
    if (currentStories >= AUTO_MODE_CONCURRENCY) continue;
    
    const slotsAvailable = AUTO_MODE_CONCURRENCY - currentStories;
    
    // Get backlog tasks for this project, respecting sort order
    const backlogTasks = db.prepare(`
      SELECT * FROM tasks 
      WHERE workdir=? AND status='backlog' AND chain_id IS NULL
      ORDER BY sort_order ASC, created_at ASC
      LIMIT ?
    `).all(workdir, slotsAvailable);
    
    if (!backlogTasks.length) {
      // Check if ALL tasks are done — auto mode complete
      const remaining = db.prepare(`
        SELECT COUNT(*) as cnt FROM tasks
        WHERE workdir=? AND status NOT IN ('done','done_review','archived','cancelled')
      `).get(workdir);

      if (remaining.cnt === 0) {
        // All done! Disable auto mode
        proj.autoMode = false;
        delete proj.autoModeStartedAt;
        saveProjects(projects);
        const doneCount = db.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE workdir=? AND status IN ('done','done_review','archived')`).get(workdir);
        openclawNotify.notify(`🎉 **Auto Mode Complete**: ${proj.name}\n✅ All ${doneCount.cnt} tasks finished!`);
        log.info(`[AutoMode] ALL DONE for project "${proj.name}" — disabling auto mode`);
      }
      continue;
    }
    
    // Move backlog tasks to todo (which triggers BMAD chain expansion in processQueue)
    for (const task of backlogTasks) {
      db.prepare(`UPDATE tasks SET status='bmad_workflow', updated_at=datetime('now') WHERE id=?`).run(task.id);
      log.info(`[AutoMode] Moved to todo: "${task.title}" (${task.id})`);
    }
    
    if (backlogTasks.length) {
      log.info(`[AutoMode] ${proj.name}: moved ${backlogTasks.length} tasks from backlog → todo (${currentActive + backlogTasks.length}/${AUTO_MODE_CONCURRENCY} active)`);
      // Notify connected clients
      wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
    }
  }
  
  // Trigger processQueue to pick up the newly moved tasks
  setImmediate(processQueue);
}

// Run auto mode check every 15 seconds (same cadence as processQueue)
setInterval(autoModeProcess, 15000);

// ── Auto-archive: done_review → done (after 24h) and done → archived (after 48h) ──
// Also cleans up task screenshots on archive and purges old screenshots (>48h)
// Matches both task-{id}- and task-{taskNumber}- prefixes
function cleanupTaskScreenshots(workdir, taskId, taskNumber) {
  try {
    const screenshotDirs = [
      path.join(workdir, 'test-screenshots'),
      path.join(workdir, 'docs', 'screenshots'),
    ];
    const prefixes = [`task-${taskId}-`];
    if (taskNumber) prefixes.push(`task-${taskNumber}-`);
    let deleted = 0;
    for (const screenshotDir of screenshotDirs) {
      if (!fs.existsSync(screenshotDir)) continue;
      const files = fs.readdirSync(screenshotDir);
      for (const f of files) {
        if (prefixes.some(p => f.startsWith(p))) {
          fs.unlinkSync(path.join(screenshotDir, f));
          deleted++;
        }
      }
    }
    if (deleted > 0) log.info(`[screenshot-cleanup] Deleted ${deleted} screenshots for task ${taskId}${taskNumber ? ` (#${taskNumber})` : ''}`);
  } catch (e) {
    log.warn('[screenshot-cleanup] error', { error: e.message });
  }
}

function purgeOldScreenshots() {
  try {
    // Find all project workdirs that have test-screenshots
    const workdirs = db.prepare(`SELECT DISTINCT workdir FROM tasks WHERE workdir IS NOT NULL`).all();
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    let totalDeleted = 0;
    for (const { workdir } of workdirs) {
      const dirs = [
        path.join(workdir, 'test-screenshots'),
        path.join(workdir, 'docs', 'screenshots'),
      ];
      for (const screenshotDir of dirs) {
        if (!fs.existsSync(screenshotDir)) continue;
        const files = fs.readdirSync(screenshotDir);
        for (const f of files) {
          const fp = path.join(screenshotDir, f);
          try {
            const stat = fs.statSync(fp);
            if (stat.isFile() && stat.mtimeMs < cutoff) {
              fs.unlinkSync(fp);
              totalDeleted++;
            }
          } catch (e) { /* skip */ }
        }
      }
    }
    if (totalDeleted > 0) log.info(`[screenshot-cleanup] Purged ${totalDeleted} screenshots older than 48h`);
  } catch (e) {
    log.warn('[screenshot-cleanup] purge error', { error: e.message });
  }
}

/**
 * Auto-activate next epic: when all tasks in a chain (epic) are done/done_review/archived,
 * find the next epic chain for the same workdir and activate its first task.
 * 
 * Epic chains follow a naming convention: epic-N-slug
 * This enables sequential epic execution without manual intervention.
 */
/**
 * Auto-create a QA task after dev/implementation tasks complete.
 * Server-enforced — does not rely on the agent to create QA tasks.
 * 
 * QA tasks:
 * - Run on Opus model (independent reviewer)
 * - Use adversarial-review workflow
 * - Produce a report only (no code changes)
 * - Reference the dev task's story file and output
 * - If issues found, chain a fix task after
 */
const DEV_WORKFLOWS_NEEDING_QA = new Set(['quick-dev', 'dev-story', 'quick-spec', 'quick-dev-new-preview', 'quick-flow-solo-dev']);

/**
 * Auto-chain: When a create-story task completes, automatically transition it to dev-story
 * so the implementation actually happens. Previously this relied on the AI agent making a
 * curl call to self-update, which was unreliable.
 *
 * Instead of updating the same task (which would lose the create-story session), we create
 * a NEW dev-story task that references the story file, inheriting chain_id and workdir.
 */
/**
 * Auto-chain BMAD planning pipeline:
 *   domain-research → planning (PRD) → solutioning (arch+epics) → sprint-planning
 * Each step creates the next task automatically when it completes.
 * The task description is forwarded so context carries through.
 */
function autoBmadPipelineChain(task) {
  const wfMatch = (task.notes || '').match(/\[bmad-workflow:([\w-]+)\]/);
  if (!wfMatch) return;
  const currentWf = wfMatch[1];

  // Define the pipeline sequence
  const PIPELINE = {
    'domain-research': { next: 'planning', model: 'opus', title: (t) => t.replace(/^Domain Research:?\s*/i, 'PRD: ').replace(/^PRD: PRD:/i, 'PRD:') },
    'planning':        { next: 'solutioning', model: 'opus', title: (t) => t.replace(/^PRD:?\s*/i, 'Architecture & Epics: ') },
    'solutioning':     { next: 'sprint-planning', model: 'opus',
    effort: 'xhigh', title: (t) => t.replace(/^Architecture & Epics:?\s*/i, 'Sprint Planning: ') },
  };

  const step = PIPELINE[currentWf];
  if (!step) return;

  const nextWf = step.next;
  const nextTitle = step.title(task.title).substring(0, 200);

  // Check for existing task with same workflow for this workdir (avoid duplicates)
  const existing = db.prepare(
    `SELECT id FROM tasks WHERE workdir=? AND notes LIKE ? AND status NOT IN ('cancelled','archived') LIMIT 1`
  ).get(task.workdir, `%[bmad-workflow:${nextWf}]%`);
  if (existing) {
    log.info(`[auto-pipeline] ${nextWf} task already exists for workdir ${task.workdir}, skipping`);
    return;
  }

  const id = genId();
  const taskNum = stmts.nextTaskNumber.get(sqlVal(task.workdir) || '').next_num;
  const nextDesc = (task.description || '').substring(0, 2000) +
    `\n\n---\nAuto-chained from ${currentWf} task #${task.task_number || task.id}.`;

  stmts.createTask.run(
    id,
    nextTitle,
    nextDesc,
    `[bmad-workflow:${nextWf}]`,
    'bmad_workflow',        // status
    sqlVal(task.sort_order) || 0,
    null,                   // session_id
    sqlVal(task.workdir) || null,
    step.model,             // model
    'auto',                 // mode
    'single',               // agent_mode
    100,                    // max_turns
    null,                   // attachments
    null,                   // depends_on
    sqlVal(task.chain_id) || null,
    null,                   // source_session_id
    null,                   // scheduled_at
    null,                   // recurrence
    null,                   // recurrence_end_at
    taskNum,
    task.dep_group || null
  );

  log.info(`[auto-pipeline] ${currentWf} → ${nextWf}: created task ${id} ("${nextTitle}")`);
  wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
}

function autoChainCreateStoryToDev(task) {
  const wfMatch = (task.notes || '').match(/\[bmad-workflow:([\w-]+)\]/);
  if (!wfMatch || wfMatch[1] !== 'create-story') return;

  // Check if a dev-story task already exists for this title (avoid duplicates)
  const existing = db.prepare(
    `SELECT id FROM tasks WHERE title=? AND workdir=? AND notes LIKE '%[bmad-workflow:dev-story]%' LIMIT 1`
  ).get(task.title, task.workdir);
  if (existing) {
    log.info(`[auto-chain] dev-story already exists for "${task.title}", skipping`);
    return;
  }

  const id = genId();
  const taskNum = stmts.nextTaskNumber.get(sqlVal(task.workdir) || '').next_num;
  const devNotes = `[bmad-workflow:dev-story]`;
  const devDesc = (task.description || '') + `\n\nStory file created by task #${task.task_number || task.id}. Read the story from _bmad-output/implementation-artifacts/ and implement all acceptance criteria.`;

  stmts.createTask.run(
    id,
    String(task.title).substring(0, 200),
    String(devDesc).substring(0, 2000),
    String(devNotes).substring(0, 2000),
    'bmad_workflow',        // status — queued for BMAD worker
    sqlVal(task.sort_order) || 0,
    null,                   // session_id
    sqlVal(task.workdir) || null,
    'sonnet',               // model — dev-story uses sonnet
    'auto',                 // mode
    'single',               // agent_mode
    100,                    // max_turns — dev needs more turns
    null,                   // attachments
    null,                   // depends_on
    sqlVal(task.chain_id) || null,
    null,                   // source_session_id
    null,                   // scheduled_at
    null,                   // recurrence
    null,                   // recurrence_end_at
    taskNum,
    task.dep_group || null     // inherit dep_group
  );

  log.info(`[auto-chain] create-story → dev-story: created task ${id} ("${task.title}") for implementation`);
  wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
}

function autoCreateQATask(task, fullText) {
  const wfMatch = (task.notes || '').match(/\[bmad-workflow:([\w-]+)\]/);
  const wfType = wfMatch ? wfMatch[1] : '';
  
  if (!DEV_WORKFLOWS_NEEDING_QA.has(wfType)) return;
  
  // Don't create QA for a QA task (prevent infinite loop)
  if (task.title.startsWith('QA:') || task.title.startsWith('🧪')) return;
  
  // Depth limit: Fix tasks get ONE QA pass max. Check task lineage via description.
  // Fix tasks (depth=1) get QA. QA on fix tasks (depth=2) does NOT spawn more fixes.
  // Robust detection: any 'Fix:' or 'Fix ' segment anywhere in the title indicates a fix task
  // (handles cases where title was enhanced with workflow prefix like 'Quick Dev: Fix: ...')
  const isFixTask = /\bFix:\s|\bFix\s/.test(task.title);
  const qaDepth = isFixTask ? 2 : 1;
  
  // Depth 2 = this is already a fix-of-a-fix scenario. Stop here.
  if (qaDepth > 1) return;
  
  const workdir = task.workdir || WORKDIR;
  const qaId = genId();
  const taskNum = stmts.nextTaskNumber.get(workdir).next_num;
  
  // Extract what was changed from the output
  const tail = (fullText || '').slice(-3000);
  const filesChanged = tail.match(/files?\s*(?:changed|modified|created|updated)[:\s]*([^\n]+)/gi) || [];
  const fileList = filesChanged.join('\n') || '(check git diff for changes)';
  
  // Find the story file for context
  const slug = slugify(task.title);
  const storyFile = `_bmad-output/implementation-artifacts/story-${task.task_number || 0}-${slug}.md`;
  
  // Detect backend-only vs frontend tasks based on files changed in output
  const _isBackendOnly = (() => {
    const output = fullText || '';
    // Check for frontend file extensions in the changed files
    const hasFrontendFiles = /\.(vue|tsx?|jsx?|css|scss|svelte|html)\b/i.test(
      (output.match(/files?\s*(?:changed|modified|created|updated)[:\s]*([^\n]+)/gi) || []).join(' ')
    );
    // Also check git diff output for frontend files
    const hasFrontendDiff = /\+\+\+.*\.(vue|tsx?|jsx?|css|scss|svelte|html)/i.test(output);
    // If only .py files mentioned, it's backend-only
    const hasOnlyPython = /\.(py)\b/i.test(output) && !hasFrontendFiles && !hasFrontendDiff;
    return hasOnlyPython;
  })();

  const qaTitle = `QA: ${task.title.substring(0, 80)}`;
  const qaWorkflow = _isBackendOnly ? '[bmad-workflow:backend-qa]' : '[bmad-workflow:playwright-qa]';
  
  const qaDesc = _isBackendOnly ? `## Backend QA Report — DO NOT MODIFY CODE

### PRE-CHECK: Verify code is committed
Before testing, run \`git status\` and \`git log --oneline -3\` in the project directory.
If the dev task's changes are NOT committed (untracked/modified files from the feature), FAIL the task immediately with:
- Finding: "Code not committed — changes exist only as uncommitted files"
- Severity: P0

**Review task #${task.task_number}: ${task.title}**

### This is a BACKEND-ONLY task — no Playwright browser testing required
Focus on:
1. **Unit test coverage** — run \`bench run-tests\` for the affected modules
2. **Acceptance criteria verification** — use \`bench execute\` or \`bench console\` to verify each AC
3. **Regression testing** — ensure existing tests still pass
4. **Code review** — verify the implementation matches the story requirements

Start by reading docs/testing-info.md for backend test configuration.

### What to verify
Read the story file for acceptance criteria: \`${storyFile}\`

### Files changed
${fileList}

### Test steps
1. Read docs/testing-info.md for backend test configuration
2. Run \`bench run-tests\` for affected modules — ALL must pass
3. Use \`bench execute\` or \`bench console\` to verify each acceptance criterion with real data
4. Check for regressions in related test suites
5. Verify the implementation handles edge cases

### Deliverable
Produce \`docs/qa-report-task-${task.task_number}.md\` with:
- Each AC: PASS/FAIL with evidence (test output, bench execute results)
- Unit test results (total pass/fail counts)
- Regression test results
- Severity ratings (P0-P3) for any failures

### Creating fix tasks (HANDLED AUTOMATICALLY BY SERVER)
If you find P0 or P1 failures, clearly document them in your QA report with:
1. **Severity level** (P0/P1) clearly labeled in headings
2. **Exact file paths + line numbers** for every issue
3. **Before/after code snippets** showing exactly what to change
4. **Verification command** for each fix

The server will automatically create a fix task from your QA report when P0/P1 issues are detected.

**CRITICAL: Clearly label P0/P1 issues in your report. Do NOT mark ALL PASS if there are P0/P1 issues.**`
  : `## QA Report Task — DO NOT MODIFY CODE

### PRE-CHECK: Verify code is committed
Before testing, run \`git status\` and \`git log --oneline -3\` in the project directory.
If the dev task's changes are NOT committed (untracked/modified files from the feature), FAIL the task immediately with:
- Finding: "Code not committed — changes exist only as uncommitted files"
- Severity: P0
- This means the dev task did not properly finish its work.

**Review task #${task.task_number}: ${task.title}**
**QA Depth: ${qaDepth}/1** (max depth reached = no further QA cycles)

### MANDATORY: Use Playwright via Bash scripts for ALL browser testing
You MUST write and execute Playwright scripts using the Bash tool. MCP tools are NOT available.

Example pattern:
\`\`\`
cat > /tmp/qa-test.mjs << 'SCRIPT'
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
// ... test code ...
await browser.close();
SCRIPT
node /tmp/qa-test.mjs
\`\`\`

**If you skip Playwright testing, the task will be FAILED by the server automatically.**

Start by reading docs/testing-info.md for the correct test URL and credentials.

### What to verify
Read the story file for acceptance criteria: \`${storyFile}\`

### Files changed
${fileList}

### Screenshot Rules — FOCUSED SCREENSHOTS ONLY
**Do NOT screenshot login, OTP, or navigation steps.** These waste time and add no value.

Only take screenshots that directly verify acceptance criteria:
- ✅ The feature UI after it loads (the component/page being tested)
- ✅ Test results or data displayed by the feature
- ✅ Error states being verified
- ✅ Before/after comparisons for visual changes
- ❌ Login page, OTP screen, sidebar navigation, loading spinners
- ❌ Generic homepage or dashboard unless that IS the feature

Save screenshots to \`test-screenshots/\` with descriptive names prefixed by task number: \`task-${task.task_number}-feature-name.png\`

Aim for 2-5 focused screenshots per QA task, not 10+ routine ones.

### Test steps
1. Read docs/testing-info.md for the correct test URL and credentials
2. Write a Playwright script that logs in (no screenshot needed for login)
3. Navigate to the relevant pages for this feature
4. Test each acceptance criterion from the story file
5. Take FOCUSED screenshots only for AC verification (see rules above)
6. Check for console errors
7. Check for regressions in related functionality

### Deliverable
Produce \`docs/qa-report-task-${task.task_number}.md\` with:
- Each AC: PASS/FAIL with evidence
- Screenshots referenced (use task-prefixed naming)
- Console errors captured
- Severity ratings (P0-P3) for any failures

### Creating fix tasks (HANDLED AUTOMATICALLY BY SERVER)
If you find P0 or P1 failures, clearly document them in your QA report with:
1. **Severity level** (P0/P1) clearly labeled in headings
2. **Exact file paths + line numbers** for every issue
3. **Before/after code snippets** showing exactly what to change
4. **Verification command** for each fix

The server will automatically create a fix task from your QA report when P0/P1 issues are detected.
You do NOT need to create fix tasks via curl anymore — just write a thorough QA report.

**CRITICAL: Clearly label P0/P1 issues in your report. Do NOT mark ALL PASS if there are P0/P1 issues.**`;

  stmts.createTask.run(
    qaId, qaTitle, qaDesc, qaWorkflow, 'bmad_workflow', 
    (task.sort_order || 0) + 1,
    null, workdir, 'opus',
    'auto', 'single', 80,
    null, null, task.chain_id || null, null,
    null, null, null, taskNum, task.dep_group || null
  );
  
  log.info(`[auto-qa] Created QA task #${taskNum} "${qaTitle}" for dev task #${task.task_number}`);
  wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
}

/**
 * Auto-create fix tasks from QA task output (server-side).
 * When a QA task completes and its output contains P0/P1 findings,
 * parse the output and create a fix task. This replaces the unreliable
 * curl-from-agent approach that fails due to auth cookie expiry.
 */
function autoCreateFixFromQA(task, fullText) {
  // Only process QA tasks
  if (!task.title.startsWith('QA:') && !task.title.startsWith('🧪')) return;
  
  // Don't create fixes for QA-on-fix tasks (depth limit)
  // Robust detection: any 'Fix:' or 'Fix ' segment anywhere in the rest of the title
  // (handles titles like 'QA: Quick Dev: Fix: ...' where workflow prefix was added)
  const parentTitle = task.title.replace(/^QA:\s*/, '').replace(/^🧪\s*/, '');
  if (/\bFix:\s|\bFix\s/.test(parentTitle)) return;
  
  const output = fullText || '';
  
  // Detect P0/P1 issues in the output
  const hasP0 = /\bP0\b/i.test(output);
  const hasP1 = /\bP1\b/i.test(output);
  const hasFail = /\bFAIL\b/i.test(output) && !/\bALL PASS\b/i.test(output);
  const hasBlocker = /\bblocker\b/i.test(output);
  const hasFixNeeded = /fix\s*(task\s*)?(?:needed|required|created|specified)/i.test(output);
  const noFixNeeded = /no\s*fix\s*(?:task\s*)?needed/i.test(output);
  const allPass = /ALL\s*(?:PASS|REQUIREMENTS?\s*VERIFIED)/i.test(output);
  
  // If all pass or explicitly no fix needed, skip
  if (allPass && !hasP0 && !hasP1) return;
  if (noFixNeeded && !hasP0) return;
  if (!hasP0 && !hasP1 && !hasFail && !hasBlocker && !hasFixNeeded) return;
  
  const workdir = task.workdir || WORKDIR;
  
  // Try to read the QA report file for detailed fix info
  let qaReportContent = '';
  try {
    const qaReportPath = require('path').join(workdir, `docs/qa-report-task-${task.task_number}.md`);
    if (require('fs').existsSync(qaReportPath)) {
      qaReportContent = require('fs').readFileSync(qaReportPath, 'utf8').substring(0, 8000);
    }
  } catch {}
  
  // Also try parent task number format
  if (!qaReportContent) {
    const parentNum = parentTitle.match(/#(\d+)/)?.[1];
    if (parentNum) {
      try {
        const altPath = require('path').join(workdir, `docs/qa-report-task-${parentNum}.md`);
        if (require('fs').existsSync(altPath)) {
          qaReportContent = require('fs').readFileSync(altPath, 'utf8').substring(0, 8000);
        }
      } catch {}
    }
  }
  
  // Extract the fix description from QA output
  // Look for sections about what needs fixing
  const fixSections = output.match(/(?:### (?:Fix|Issues?|P0|P1|Blockers?|What Failed).*?)(?=###|\n## |$)/gis) || [];
  const fixContext = fixSections.join('\n\n').substring(0, 4000) || 
    output.substring(Math.max(0, output.length - 3000));
  
  const fixId = genId();
  const fixTaskNum = stmts.nextTaskNumber.get(workdir).next_num;
  
  const fixTitle = `Fix: ${parentTitle.substring(0, 70)} — issues from QA`;
  const fixDesc = `## Auto-generated Fix Task (from QA task #${task.task_number})

### Source
QA Report: \`docs/qa-report-task-${task.task_number}.md\`
Read the QA report FIRST for full context on what failed and needs fixing.

### QA Findings Summary
${qaReportContent ? qaReportContent.substring(0, 4000) : fixContext}

### Instructions
1. Read the QA report at \`docs/qa-report-task-${task.task_number}.md\`
2. Fix ALL P0 and P1 issues identified
3. Verify each fix with the verification commands from the report
4. Ensure the build still passes
5. Do NOT start a Vite dev server

### Done Checklist
- [ ] All P0 issues fixed
- [ ] All P1 issues fixed
- [ ] App builds without errors
- [ ] No console errors on affected pages
- [ ] git diff shows only expected files`;

  stmts.createTask.run(
    fixId, fixTitle, fixDesc, '[bmad-workflow:quick-dev]', 'bmad_workflow',
    (task.sort_order || 0) + 1,
    null, workdir, 'sonnet',
    'auto', 'single', 60,
    null, null, null, null,  // Fix tasks: no chain_id (prevents deadlock with chain sort order)
    null, null, null, fixTaskNum, task.dep_group || null
  );
  
  log.info(`[auto-fix] Created fix task #${fixTaskNum} "${fixTitle}" from QA task #${task.task_number}`);
  wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
}

function autoActivateNextEpic(task) {
  if (!task.chain_id || !task.workdir) return;
  
  // Check if all tasks in this chain are complete
  const chainTasks = db.prepare(`SELECT id, status, chain_id FROM tasks WHERE chain_id=? AND workdir=?`).all(task.chain_id, task.workdir);
  const allDone = chainTasks.every(t => ['done', 'done_review', 'archived', 'cancelled'].includes(t.status));
  if (!allDone) return;
  
  log.info(`[auto-epic] Chain "${task.chain_id}" is fully complete (${chainTasks.length} tasks)`);
  
  // Find all epic chains for this workdir
  const allChains = db.prepare(`
    SELECT DISTINCT chain_id FROM tasks 
    WHERE workdir=? AND chain_id LIKE 'epic-%' 
    ORDER BY chain_id ASC
  `).all(task.workdir);
  
  const currentIdx = allChains.findIndex(c => c.chain_id === task.chain_id);
  if (currentIdx < 0 || currentIdx >= allChains.length - 1) return; // no next epic
  
  const nextChainId = allChains[currentIdx + 1].chain_id;
  
  // Check if next epic tasks are in done_review (created by sprint-planning but not yet activated)
  const nextTasks = db.prepare(`
    SELECT id, status, task_number, title FROM tasks 
    WHERE chain_id=? AND workdir=? AND status='done_review'
    ORDER BY sort_order ASC, task_number ASC
  `).all(nextChainId, task.workdir);
  
  if (!nextTasks.length) {
    log.info(`[auto-epic] Next chain "${nextChainId}" has no done_review tasks to activate`);
    return;
  }
  
  // Activate all tasks in the next epic (set to bmad_workflow)
  const activate = db.prepare(`UPDATE tasks SET status='bmad_workflow', updated_at=datetime('now') WHERE id=?`);
  for (const t of nextTasks) {
    activate.run(t.id);
    log.info(`[auto-epic] Activated #${t.task_number} "${t.title.substring(0, 50)}" in chain "${nextChainId}"`);
  }
  
  log.info(`[auto-epic] Activated ${nextTasks.length} tasks in next epic: ${nextChainId}`);
  wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
  
  // Notify
  const projName = getProjectName(task.workdir);
  openclawNotify.sendNotification(`🚀 [${projName}] Epic "${task.chain_id}" complete! Auto-started next epic "${nextChainId}" (${nextTasks.length} stories)`, projName, task.workdir);
  
  // Trigger queue processing
  setTimeout(processQueue, 3000);
}

function autoArchiveProcess() {
  try {
    // Move done_review tasks older than 24h to done (user didn't review in time)
    // Also clean up their screenshots at this transition
    const tasksToApprove = db.prepare(`
      SELECT id, workdir, task_number FROM tasks
      WHERE status='done_review'
        AND updated_at < datetime('now', '-24 hours')
    `).all();
    if (tasksToApprove.length > 0) {
      const approveStmt = db.prepare(`UPDATE tasks SET status='done', updated_at=datetime('now') WHERE id=?`);
      for (const t of tasksToApprove) {
        approveStmt.run(t.id);
        cleanupTaskScreenshots(t.workdir, t.id, t.task_number);
      }
      log.info(`[autoArchive] Auto-approved ${tasksToApprove.length} done_review task(s) → done + cleaned screenshots`);
      wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
    }
    // Move done tasks older than 48h to archived + clean up their screenshots
    const tasksToArchive = db.prepare(`
      SELECT id, workdir, task_number FROM tasks
      WHERE status='done'
        AND updated_at < datetime('now', '-48 hours')
    `).all();
    if (tasksToArchive.length > 0) {
      const archiveStmt = db.prepare(`UPDATE tasks SET status='archived', updated_at=datetime('now') WHERE id=?`);
      for (const t of tasksToArchive) {
        archiveStmt.run(t.id);
        cleanupTaskScreenshots(t.workdir, t.id, t.task_number);
      }
      log.info(`[autoArchive] Archived ${tasksToArchive.length} done task(s) → archived + cleaned screenshots`);
      wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
    }
    // Purge any screenshots older than 48h (catches orphans not linked to tasks)
    purgeOldScreenshots();
  } catch (e) {
    log.warn('[autoArchive] error', { error: e.message });
  }
}
// Run every 5 minutes
setInterval(autoArchiveProcess, 5 * 60 * 1000);

// ── Periodic Progress Summary via OpenClaw (every 2 hours) ──
setInterval(() => {
  try {
    const allTasks = db.prepare(`SELECT * FROM tasks`).all();
    // Group by workdir (project)
    const byProject = {};
    for (const t of allTasks) {
      const proj = t.workdir || 'default';
      if (!byProject[proj]) byProject[proj] = [];
      byProject[proj].push(t);
    }
    for (const [projPath, tasks] of Object.entries(byProject)) {
      const projName = require('path').basename(projPath);
      const backlog = tasks.filter(t => t.status === 'backlog').length;
      const todo = tasks.filter(t => t.status === 'todo').length;
      const active = tasks.filter(t => t.status !== 'backlog' && t.status !== 'todo' && t.status !== 'done' && t.status !== 'done_review' && t.status !== 'archived' && t.status !== 'cancelled').length;
      const done = tasks.filter(t => ['done','done_review','archived'].includes(t.status)).length;
      const total = tasks.filter(t => t.status !== 'cancelled').length;
      // Recently completed (last 2 hours)
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
      const recentlyCompleted = tasks
        .filter(t => ['done','done_review'].includes(t.status) && t.updated_at > twoHoursAgo)
        .map(t => t.title);
      if (active > 0 || recentlyCompleted.length > 0) {
        openclawNotify.progressSummary(projName, { backlog, todo, active, done, total, recentlyCompleted });
      }
    }
  } catch (e) { log.error('[progress-summary]', { error: e.message }); }
}, 2 * 60 * 60 * 1000); // every 2 hours

// Kick off on startup — smart recovery for in_progress tasks
setTimeout(() => {
  const stuck = db.prepare(`SELECT * FROM tasks WHERE status='in_progress'`).all();
  for (const task of stuck) {
    // Step 1: Kill orphaned subprocess to prevent double-execution.
    // When Node restarts, spawned 'claude' processes become OS orphans and keep running.
    // We kill them before deciding what to do with the task.
    if (task.worker_pid) {
      killByPid(task.worker_pid);
      console.log(`[startup] sent kill to orphan PID ${task.worker_pid} for task "${task.title}"`);
    }
    // Step 2: Determine if the task actually completed.
    // Assistant text is only written to DB on onDone — so its presence means success.
    let newStatus = 'todo'; // default: retry (task was interrupted)
    if (task.chain_id) {
      // Chain task: ALWAYS retry. Shared session has messages from other tasks in the
      // chain, so the "has assistant message" heuristic gives false positives.
      // --resume will recover full context from the shared Claude session.
      newStatus = 'todo';
    } else if (task.session_id) {
      const assistantMsg = db.prepare(
        `SELECT id FROM messages WHERE session_id=? AND role='assistant' AND type='text' LIMIT 1`
      ).get(task.session_id);
      if (assistantMsg) newStatus = 'done_review'; // completed before/during restart — needs user review
    }
    db.prepare(`UPDATE tasks SET status=?, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(newStatus, task.id);
    console.log(`[startup] recovered task "${task.title}" (${task.id}): in_progress → ${newStatus}`);
  }
  processQueue();
}, 3000);

class WsProxy {
  constructor(ws) { this._ws = ws; this._buffer = []; }
  send(data) {
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(data);
    } else if (this._buffer.length < 1000) {
      this._buffer.push(data);
    }
  }
  attach(newWs) {
    this._ws = newWs;
    const buf = this._buffer.splice(0);
    for (const msg of buf) { try { newWs.send(msg); } catch {} }
  }
  detach() { this._ws = null; }
}

// ─── Telegram Proxy (duck-typed WsProxy for Telegram bot streaming) ──────────
class TelegramProxy {
  constructor(bot, chatId, sessionId, userId) {
    this._bot = bot;
    this._chatId = chatId;
    this._sessionId = sessionId;
    this._userId = userId;
    this._buffer = '';
    this._progressMsgId = null;
    this._updateTimer = null;
    this._lastEditAt = 0;
    this._toolsUsed = [];
    this._finished = false;
    // Typing indicator — sends "typing..." action every 4s
    this._typingInterval = setInterval(() => {
      this._bot._callApi('sendChatAction', { chat_id: this._chatId, action: 'typing' }).catch(() => {});
    }, 4000);
    // Safety net: auto-stop typing after 30 min to prevent interval leak if
    // neither _finalize nor _sendError are called (e.g. subprocess crash)
    this._typingSafetyTimer = setTimeout(() => this._stopTyping(), 30 * 60 * 1000);
    // Send initial typing action immediately
    this._bot._callApi('sendChatAction', { chat_id: this._chatId, action: 'typing' }).catch(() => {});
  }

  _stopTyping() {
    if (this._typingInterval) {
      clearInterval(this._typingInterval);
      this._typingInterval = null;
    }
    if (this._typingSafetyTimer) {
      clearTimeout(this._typingSafetyTimer);
      this._typingSafetyTimer = null;
    }
  }

  send(raw) {
    try {
      const data = JSON.parse(raw);
      // Also broadcast to web UI watchers
      broadcastToSession(this._sessionId, data);

      if (data.type === 'text') {
        this._buffer += (data.text || '');
        this._scheduleUpdate();
      } else if (data.type === 'tool_use' || data.type === 'tool') {
        this._toolsUsed.push(data.tool || data.tool_name || 'tool');
      } else if (data.type === 'done') {
        this._finalize(data);
      } else if (data.type === 'error') {
        this._lastError = data.error || 'Unknown error';
        if (!this._buffer.trim()) {
          this._sendError(data);
        }
      } else if (data.type === 'ask_user') {
        this._handleAskUser(data);
      } else if (data.type === 'ask_user_timeout') {
        this._handleAskUserDismiss(this._bot._t('ask_timeout'));
      } else if (data.type === 'notification') {
        this._handleNotification(data);
      }
    } catch (e) {
      console.error('[TelegramProxy] parse error:', e.message);
    }
  }

  // ─── ask_user: Forward Claude's question to Telegram user ────────────────
  async _handleAskUser(data) {
    // Pause progress updates while waiting for user input
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }
    this._stopTyping();

    const questions = (Array.isArray(data.questions) && data.questions.length) ? data.questions : [{ question: data.question || '?' }];
    const q = questions[0];
    const questionText = q.question || data.question || '?';

    // Store pending state on the bot's user context
    if (this._userId) {
      const ctx = this._bot._getContext(this._userId);
      ctx.pendingAskRequestId = data.requestId;
      ctx.pendingAskQuestions = questions;
    }

    // Build message text (i18n-aware)
    const t = (k, v) => this._bot._t(k, v);
    let text = `❓ <b>${t('ask_title')}</b>\n\n${this._bot._escHtml(questionText)}`;

    // Build inline keyboard
    const skipLabel = t('ask_skip_btn');
    let replyMarkup;
    if (q.options && q.options.length > 0) {
      // Options mode: show buttons (truncate label to 64 chars for Telegram display)
      const rows = q.options.map((opt, i) => ([{
        text: (typeof opt === 'string' ? opt : (opt.label || opt.value || `Option ${i + 1}`)).substring(0, 64),
        callback_data: `ask:${i}`
      }]));
      rows.push([{ text: skipLabel, callback_data: 'ask:skip' }]);
      replyMarkup = JSON.stringify({ inline_keyboard: rows });
      text += `\n\n<i>${t('ask_choose_hint')}</i>`;
    } else {
      // Free text mode: prompt user to type
      replyMarkup = JSON.stringify({
        inline_keyboard: [[{ text: skipLabel, callback_data: 'ask:skip' }]]
      });
      text += `\n\n<i>${t('ask_text_hint')}</i>`;
    }

    // Delete progress message if exists (show clean question)
    if (this._progressMsgId) {
      try {
        await this._bot._callApi('deleteMessage', { chat_id: this._chatId, message_id: this._progressMsgId });
      } catch {}
      this._progressMsgId = null;
    }

    try {
      await this._bot._sendMessage(this._chatId, text, { parse_mode: 'HTML', reply_markup: replyMarkup });
    } catch {
      // Fallback without HTML
      await this._bot._sendMessage(this._chatId, text.replace(/<[^>]+>/g, ''), { reply_markup: replyMarkup }).catch(() => {});
    }
  }

  // Dismiss ask_user UI (timeout or answered elsewhere)
  async _handleAskUserDismiss(reason) {
    if (this._userId) {
      const ctx = this._bot._getContext(this._userId);
      ctx.pendingAskRequestId = null;
      ctx.pendingAskQuestions = null;
    }
    await this._bot._sendMessage(this._chatId, reason).catch(() => {});
    // Resume typing indicator (guard against double-start)
    if (!this._finished && !this._typingInterval) {
      this._typingInterval = setInterval(() => {
        this._bot._callApi('sendChatAction', { chat_id: this._chatId, action: 'typing' }).catch(() => {});
      }, 4000);
    }
  }

  // ─── Notifications: Forward to Telegram ──────────────────────────────────
  async _handleNotification(data) {
    const icons = { info: 'ℹ️', warn: '⚠️', error: '❌', success: '✅' };
    const icon = icons[data.level] || 'ℹ️';
    const detail = data.detail ? `\n${this._bot._escHtml(data.detail)}` : '';
    const progress = data.progress ? ` (${data.progress.current}/${data.progress.total})` : '';
    const text = `${icon} ${this._bot._escHtml(data.title)}${progress}${detail}`;
    await this._bot._sendMessage(this._chatId, text, { parse_mode: 'HTML' }).catch(() => {});
  }

  _scheduleUpdate() {
    if (this._finished) return;
    if (this._updateTimer) return;
    const elapsed = Date.now() - this._lastEditAt;
    const delay = Math.max(3000 - elapsed, 500);
    this._updateTimer = setTimeout(() => this._sendProgress(), delay);
  }

  async _sendProgress() {
    this._updateTimer = null;
    if (this._finished) return;

    this._lastEditAt = Date.now();

    let preview = this._buffer;
    if (preview.length > 3500) {
      preview = '...\n' + preview.slice(-3500);
    }
    preview = this._bot._escHtml(preview);

    const toolLine = this._toolsUsed.length
      ? `\n🔧 ${this._bot._escHtml(this._toolsUsed.slice(-3).join(', '))}`
      : '';
    const text = `⏳ <b>Processing...</b>${toolLine}\n\n${preview}`;

    // Inline stop button on progress messages so the user always has controls at the bottom
    const progressMarkup = JSON.stringify({ inline_keyboard: [[
      { text: '🛑 Stop', callback_data: 'cm:stop' },
      { text: '🏠 Menu', callback_data: 'm:menu' },
    ]] });

    try {
      if (this._progressMsgId) {
        await this._bot._callApi('editMessageText', {
          chat_id: this._chatId,
          message_id: this._progressMsgId,
          text: text.slice(0, 4096),
          parse_mode: 'HTML',
          reply_markup: progressMarkup,
        }).catch(() => {
          return this._bot._callApi('editMessageText', {
            chat_id: this._chatId,
            message_id: this._progressMsgId,
            text: text.replace(/<[^>]+>/g, '').slice(0, 4096),
            reply_markup: progressMarkup,
          });
        });
      } else {
        const result = await this._bot._sendMessage(this._chatId, text.slice(0, 4096), { parse_mode: 'HTML', reply_markup: progressMarkup });
        if (result && result.message_id) {
          this._progressMsgId = result.message_id;
        }
      }
    } catch (e) {
      if (e.message && e.message.includes('429')) {
        this._updateTimer = setTimeout(() => this._sendProgress(), 6000);
      }
    }
  }

  async _finalize(data) {
    if (this._finished) return; // already finalized or errored
    this._finished = true;
    this._stopTyping();
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }

    // Delete progress message if exists
    if (this._progressMsgId) {
      try {
        await this._bot._callApi('deleteMessage', {
          chat_id: this._chatId,
          message_id: this._progressMsgId
        });
      } catch (e) { /* ignore */ }
      this._progressMsgId = null;
    }

    // Send final response — collapse large messages with preview + "Show full" button
    const rawLen = this._buffer.trim().length;
    const isLarge = rawLen > TG_COLLAPSE_THRESHOLD;

    if (rawLen > 0) {
      if (!isLarge) {
        // Short response — send in full
        const html = this._bot._mdToHtml(this._buffer);
        const chunks = this._bot._chunkForTelegram(html, MAX_MESSAGE_LENGTH - 100);
        for (const chunk of chunks) {
          await this._bot._sendMessage(this._chatId, chunk, { parse_mode: 'HTML' }).catch(() => {
            return this._bot._sendMessage(this._chatId, chunk.replace(/<[^>]+>/g, ''));
          });
        }
      } else {
        // Large response — send preview only, full available via button
        const previewRaw = this._buffer.substring(0, TG_PREVIEW_LENGTH);
        // Truncate at last newline to avoid broken lines/fences
        const lastNl = previewRaw.lastIndexOf('\n');
        const cleanPreview = lastNl > TG_PREVIEW_LENGTH / 2 ? previewRaw.substring(0, lastNl) : previewRaw;
        const previewHtml = this._bot._mdToHtml(cleanPreview);
        const totalChars = rawLen > 1000 ? `${Math.round(rawLen / 1000)}k` : rawLen;
        const moreIndicator = `\n\n<i>···  ${totalChars} chars — tap 📄 to expand  ···</i>`;
        await this._bot._sendMessage(this._chatId, previewHtml + moreIndicator, { parse_mode: 'HTML' }).catch(() => {
          return this._bot._sendMessage(this._chatId, (cleanPreview + `\n\n···  ${totalChars} chars — tap 📄 to expand  ···`).replace(/<[^>]+>/g, ''));
        });
      }
    }

    // Send completion notification with buttons
    const duration = data.duration ? ` (${Math.round(data.duration / 1000)}s)` : '';
    const toolsSummary = this._toolsUsed.length ? `\n🔧 Tools: ${this._bot._escHtml([...new Set(this._toolsUsed)].join(', '))}` : '';
    const doneButtons = [
      { text: '💬 Continue', callback_data: 'cm:compose' },
      ...(isLarge ? [{ text: '📄 Full', callback_data: 'cm:full' }] : []),
      { text: '🏠 Menu', callback_data: 'm:menu' }
    ];
    await this._bot._sendMessage(this._chatId,
      `✅ <b>Done</b>${duration}${toolsSummary}`,
      {
        parse_mode: 'HTML',
        reply_markup: JSON.stringify({ inline_keyboard: [doneButtons] })
      }
    );
  }

  async _sendError(data) {
    if (this._finished) return; // already finalized or errored
    this._finished = true;
    this._stopTyping();
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }

    if (this._progressMsgId) {
      try {
        await this._bot._callApi('deleteMessage', {
          chat_id: this._chatId,
          message_id: this._progressMsgId
        });
      } catch (e) { /* ignore */ }
    }

    await this._bot._sendMessage(this._chatId,
      `❌ <b>Error:</b> ${this._bot._escHtml(data.error || 'Unknown error')}`,
      {
        parse_mode: 'HTML',
        reply_markup: JSON.stringify({
          inline_keyboard: [[
            { text: '🔄 Retry', callback_data: 'cm:compose' },
            { text: '🏠 Menu', callback_data: 'm:menu' }
          ]]
        })
      }
    );
  }

  get readyState() { return 1; } // WebSocket.OPEN
}

// Telegram max message length constant (used by TelegramProxy for splitting)
const MAX_MESSAGE_LENGTH = 4000;
// Threshold for collapsing large responses (raw markdown chars)
const TG_COLLAPSE_THRESHOLD = 800;
// Preview length for collapsed responses
const TG_PREVIEW_LENGTH = 600;

// Build Claude content blocks from text + file attachments.
// Returns plain string when no attachments, or ContentBlock[] when attachments present.
function buildUserContent(text, attachments = []) {
  if (!attachments || attachments.length === 0) return text;
  const blocks = [];
  for (const att of attachments) {
    if (att.type && att.type.startsWith('image/')) {
      // Vision block — base64 image
      blocks.push({ type: 'image', source: { type: 'base64', media_type: att.type, data: att.base64 } });
    } else if (att.type === 'ssh') {
      // SSH host reference — inject full connection info as text context
      let sshText = `[SSH Host: ${att.label || att.host}]\nHost: ${att.host}:${att.port || 22}`;
      if (att.sshKeyPath) sshText += `\nSSH Key: ${att.sshKeyPath}`;
      else if (att.password) sshText += `\nPassword: ${att.password}`;
      blocks.push({ type: 'text', text: sshText });
    } else {
      // Text / PDF — decode base64 and embed as readable text block
      let content = '(unable to decode)';
      try { content = Buffer.from(att.base64, 'base64').toString('utf-8'); } catch {}
      blocks.push({ type: 'text', text: `[File: ${att.name}]\n${content}` });
    }
  }
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

// ============================================
// CONFIG
// ============================================

/** Default slash commands — seeded into config.json on first run / fresh install. */
const DEFAULT_SLASH_COMMANDS = [
  { id: 'sc1', name: '/check',    text: 'Check this step by step: syntax, logic, edge cases, and potential bugs. Be thorough.' },
  { id: 'sc2', name: '/review',   text: 'Do a thorough code review: readability, performance, security, and adherence to best practices. Point out issues with severity levels (critical / warning / suggestion).' },
  { id: 'sc3', name: '/fix',      text: 'Find and fix the bug. Explain what caused it and exactly what you changed.' },
  { id: 'sc4', name: '/explain',  text: 'Explain this code clearly: what it does, how it works, and why it\'s structured this way. Use examples if helpful.' },
  { id: 'sc5', name: '/refactor', text: 'Refactor this code for clarity and maintainability. Keep the exact same behavior. Show what changed and why.' },
  { id: 'sc6', name: '/test',     text: 'Write comprehensive tests: happy path, edge cases, and error scenarios. Explain what each test covers.' },
  { id: 'sc7', name: '/docs',     text: 'Write clear documentation: purpose, parameters, return values, usage examples, and any gotchas.' },
  { id: 'sc8', name: '/optimize', text: 'Analyze performance and optimize. Identify bottlenecks, propose improvements, quantify the expected gains.' },
  { id: 'sc9', name: '/compact',  text: 'Summarize our conversation so far into a concise recap: key decisions made, what was built or changed, current state, and what still needs to be done. Be brief and structured.' },
  { id: 'sc10', name: '/init',    text: 'Analyze this project and create a CLAUDE.md file in the project root. Include: project overview, tech stack, architecture, key conventions, common commands (build, test, lint), and any gotchas a developer should know. Be thorough but concise.' },
  // Task 13: BMAD contextual guidance command
  { id: 'sc11', name: '/bmad-help', text: `Analyze the current project state and provide contextual BMAD guidance. Do the following:

1. **Project Phase Detection**: Check for BMAD artifacts in the workspace:
   - Look for product-brief.md, prd.md, architecture docs → determines current phase
   - Look for sprint-status.yaml → implementation phase indicator
   - Look for test files, coverage reports → QA phase indicator
   - Check recent git commits for phase clues

2. **Phase Assessment**: Based on what you find, identify which BMAD phase the project is in:
   - 🧠 Brainstorm (no PRD yet)
   - 📋 PRD (has brief, needs PRD)
   - 🏗️ Architecture (has PRD, needs architecture doc)
   - 💻 Implementation (has architecture, coding in progress)
   - 🧪 QA (implementation done, needs testing)
   - ✅ Done (all phases complete)

3. **Next Steps**: Suggest the 2-3 most important next actions, including which BMAD agent to use (analyst, architect, developer, qa-engineer, etc.)

4. **Quick Commands**: Provide copy-pasteable prompts for the suggested next steps.

Be concise and actionable. Focus on what's most useful right now.` },
];

/** Load LOCAL config only — used by write operations (add/delete MCP, upload/delete skill).
 *  Seeds default slash commands into config.json on fresh install and after updates:
 *  only adds defaults whose name is not yet present — never overwrites user commands. */
function loadConfig() {
  let c;
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { c = {}; }
  if (!c.mcpServers)    c.mcpServers    = {};
  if (!c.skills)        c.skills        = {};
  if (!c.slashCommands) c.slashCommands = [];
  // Merge-in any default commands the user doesn't have yet (match by name).
  // This handles fresh installs AND version upgrades that add new defaults.
  const existingNames = new Set(c.slashCommands.map(cmd => cmd.name));
  const toAdd = DEFAULT_SLASH_COMMANDS.filter(def => !existingNames.has(def.name));
  if (toAdd.length > 0) {
    c.slashCommands.push(...toAdd);
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); } catch {}
  }
  return c;
}
function saveConfig(c) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
  _mergedConfigCache = null; // invalidate on every write
  _skillContentCache.clear(); // skill files may have changed
  _systemPromptCache.clear(); // prompts depend on skill content
}

// In-memory cache for the merged (global + local) config.
// Hot path: processChat calls loadMergedConfig() on every request — caching
// eliminates 2× readFileSync per chat turn.
// Invalidated by saveConfig() and by GET /api/config (which forces a fresh
// read so the config UI always reflects the current state on disk).
let _mergedConfigCache = null;

/** Merge global (~/.claude/config.json) + local config.json for read/display/execution.
 *  Local entries override global entries with the same key. */
function loadMergedConfig() {
  if (_mergedConfigCache !== null) return _mergedConfigCache;
  let g = {}, l = {};
  try { g = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')); } catch {}
  try { l = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  _mergedConfigCache = {
    mcpServers:    { ...(g.mcpServers||{}), ...(l.mcpServers||{}) },
    skills:        { ...(g.skills||{}),     ...(l.skills||{})     },
    slashCommands: [...(l.slashCommands||[])],
    lang:          l.lang || g.lang || 'en',
  };
  return _mergedConfigCache;
}

/** Resolve skill file path.
 *  - Absolute path → used as-is.
 *  - Relative path → try ~/.claude/skills/<basename> first, then project root. */
function resolveSkillFile(file) {
  if (path.isAbsolute(file)) return file;
  const globalPath = path.join(GLOBAL_SKILLS_DIR, path.basename(file));
  if (fs.existsSync(globalPath)) return globalPath;
  // Try APP_DIR first (user-uploaded skills), then __dirname (bundled skills)
  const appPath = path.join(APP_DIR, file);
  if (fs.existsSync(appPath)) return appPath;
  return path.join(__dirname, file);
}

// ─── Skill content cache (avoids fs.readFileSync on every chat turn) ─────────
// Key: resolved file path → { content, mtimeMs }
// Invalidated when file mtime changes. saveConfig() clears entire cache.
const _skillContentCache = new Map();
function getSkillContent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cached = _skillContentCache.get(filePath);
    if (cached && cached.mtimeMs >= stat.mtimeMs) return cached.content;
    const content = fs.readFileSync(filePath, 'utf-8');
    _skillContentCache.set(filePath, { content, mtimeMs: stat.mtimeMs });
    return content;
  } catch { return ''; }
}

// ─── System prompt builder with caching ──────────────────────────────────────
// Caches assembled system prompt by sorted skill IDs → avoids repeated string
// concatenation + disk reads on every chat turn with the same skill set.
const _systemPromptCache = new Map();
const MAX_PROMPT_CACHE_SIZE = 32;

// Base instructions (always included) — kept concise to save tokens
const BASE_SYSTEM_INSTRUCTIONS = `When you are answering a specific question or task that is one of several questions or tasks in the user's message, begin your response with a short quote (1–2 lines) of that specific question or task formatted as a markdown blockquote:
> <original question or task text>
Then provide your answer below it. Do not add the blockquote if the message contains only a single question or task.`;

// Language names for UI language instruction
const LANG_NAMES = { en: 'English', uk: 'Ukrainian', ru: 'Russian' };

// Internal MCP tool instructions — compact versions (~140 tokens vs original ~240)
const ASK_USER_INSTRUCTION = `\n\nYou have access to an "ask_user" tool (via MCP server "_ccs_ask_user"). When you need user input BEFORE proceeding — such as choosing between approaches, confirming an action, or clarifying requirements — you MUST call ask_user instead of writing questions as text. The ask_user tool pauses execution and waits for the user's response. Do NOT ask questions in your text output and then continue working — always use the ask_user tool for questions.`;

const NOTIFY_USER_INSTRUCTION = `\n\nYou have access to a "notify_user" tool (via MCP server "_ccs_notify"). Use it to send non-blocking progress updates to the user. Call notify_user for milestones ("Completed database migration"), warnings ("Rate limit approaching"), errors ("Test suite has 3 failures"), or progress tracking (with current/total steps). Unlike ask_user, notify_user does NOT pause execution — you continue working immediately. Do NOT overuse it: send notifications only for meaningful status changes, not for every minor step.`;

const SET_UI_STATE_INSTRUCTION = `\n\nYou have access to a "set_ui_state" tool (via MCP server "_ccs_set_ui_state"). You MUST call this tool when you transition between phases so the UI toolbar reflects your current state. Specifically:
- When you finish PLANNING and start EXECUTING: call set_ui_state({ mode: "auto" }) IMMEDIATELY
- When you switch models: call set_ui_state({ model: "opus" }) or set_ui_state({ model: "haiku" })
This is REQUIRED behavior, not optional. The tool is fire-and-forget — execution continues immediately.`;

const BROWSER_TESTING_INSTRUCTION = `

BROWSER TESTING POLICY (STRICT):

**PLAYWRIGHT IS INSTALLED AND AVAILABLE.** Do NOT claim otherwise.
- hmis-lite has \`@playwright/test\` in package.json (verified).
- Browsers are pre-installed at \`~/.cache/ms-playwright/\`.
- From ANY project workdir, \`node -e "require('playwright')"\` works.
- The \`playwright\` npm package is resolvable via Bash + node.
- MCP servers are NOT used in --print mode \u2014 this is expected, NOT a reason to skip testing.

**RULES:**

1. **Frontend dev/implementation tasks (quick-dev, dev-story, quick-spec, code-review):** If you modified any .vue/.tsx/.jsx/.ts/.js/.css/.scss/.html file, you MUST run a Playwright script via Bash. NO EXCEPTIONS.

2. **QA tasks:** Playwright browser testing is mandatory for every acceptance criterion. Write a structured QA report. Do NOT modify source code.

3. **Backend-only tasks (.py only):** Playwright not required. Use \`bench --site execute\`.

**FORBIDDEN FALLBACKS (the server will FAIL your task):**
- curl / wget HTTP checks (even if they return 200)
- "Playwright MCP not available" \u2014 MCP is never available in --print mode; use Bash + npm package
- "Dev server is working" \u2014 not a substitute for real browser verification
- "Files compile cleanly" \u2014 compilation \u2260 functional verification
- "require('playwright') fails in my eval" \u2014 run it from the project workdir, not from a random path

**EXACT RECIPE \u2014 copy-paste this, adapting the URL/interactions:**

    cat > /tmp/verify-task.mjs << 'SCRIPT'
    import { chromium } from 'playwright';
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('<URL from docs/testing-info.md>');
    await page.screenshot({ path: 'test-screenshots/task-<N>-01-initial.png', fullPage: true });
    // Login if needed, navigate, interact, take more screenshots...
    await browser.close();
    console.log('playwright-ok');
    SCRIPT
    node /tmp/verify-task.mjs

**TROUBLESHOOTING:**
- If \`Cannot find module 'playwright'\`: you are running from the wrong cwd. \`cd\` to the project workdir first, OR use \`NODE_PATH=$(npm root -g) node /tmp/verify-task.mjs\`.
- If \`Executable doesn't exist\`: run \`npx playwright install chromium\` first. Browsers at ~/.cache/ms-playwright/ should already cover this.
- If page.goto hangs: the dev server URL is wrong. Re-read docs/testing-info.md.

**SERVER ENFORCEMENT:** Your output is scanned for >=2 of these execution markers: \`chromium.launch(\`, \`browser.newPage(\`, \`page.goto(\`, \`page.screenshot(\`, \`from 'playwright'\`, \`require('playwright')\`. Missing 2+ markers = automatic task failure and requeue. Mentioning evasion phrases ("MCP not available", "fallback curl", "HTTP 200 instead") triggers immediate failure.

**First step in every UI-touching task:** Read docs/testing-info.md to get the correct test URL and credentials.

QA-SPECIFIC RULES:
1. Write and run Playwright scripts via Bash for EVERY test step
2. Login, navigate, interact, screenshot, check console errors
3. Read docs/testing-info.md for credentials
4. Produce a STRUCTURED QA REPORT as a markdown file in docs/
5. DO NOT modify source code
6. Document findings: severity (P0-P3), description, repro steps, expected vs actual, screenshot ref
7. For P0/P1 issues: create ONE consolidated fix task (see task description for curl template)
   - ONE task only
   - Exact file paths + line numbers
   - Before/after code snippets
   - Verification commands
   - Done checklist with independently verifiable items
   - P2/P3 issues go in the report only

SCREENSHOT NAMING: Save all screenshots to \`test-screenshots/\` with pattern \`task-{TASK_NUMBER}-{NN}-{description}.png\` where TASK_NUMBER is the numeric task number from the task title (#N), NN is zero-padded (01, 02), and description is kebab-case. Example: task-467-01-initial.png, task-467-02-after-scroll.png.`;

const AUTONOMOUS_INSTRUCTION = `\n\nCRITICAL — AUTONOMOUS MODE: You are running as an autonomous agent. DO NOT ask questions, present options, or wait for user input. Make decisions using your best professional judgment and IMPLEMENT them immediately.
- If there are multiple valid approaches, pick the best one and execute it. Document your reasoning in a brief comment.
- If you find additional issues during implementation, FIX THEM if they're related to the task scope. Log what you found and fixed.
- If you encounter an error, debug and resolve it yourself. Try alternative approaches. Only give up after 3 attempts.
- If an adversarial review or QA step finds issues, FIX the real issues automatically — do not present them as options.
- Never output menus like [W] Walk through / [F] Fix / [S] Skip. Just fix.
- End with a clear summary of what was done, what was fixed, and any caveats.
- NEVER git add or commit screenshots, test images, or any files from test-screenshots/. They are gitignored.

QA NOTE: QA tasks are auto-created server-side when a dev task (quick-dev, dev-story, quick-spec) completes. You do NOT need to create the QA task yourself — the server will spawn it with an adversarial-review workflow on Opus. Just complete your implementation cleanly and exit. If you see references in this task description to "create a QA task", they are outdated — ignore them.

FLOW: Dev Task → (server auto-creates) QA Task → (server auto-creates if P0/P1 findings) Fix Task → (server auto-creates) QA Task again

IF you are a QA task (title starts with "QA:"): Playwright browser testing is MANDATORY. Write a report, do NOT modify source code. If you find P0/P1 issues, the server will auto-create a fix task from your report — you do NOT need to POST /api/tasks.`;

// Status line + tool call instructions (~100 tokens vs original ~170)
const STATUS_LINE_INSTRUCTION = `\n\nIMPORTANT: Always end your response with a single clear status line separated by "---". Use one of these patterns:
- "✅ Done — [brief summary of what was completed]." when the task is fully finished.
- "⏳ In progress — [what's happening now and what comes next]." when you're still working and will continue.
- "❓ Waiting for input — [what you need from the user]." when you need the user to answer or decide something.
- "⚠️ Blocked — [what went wrong and what's needed to proceed]." when something prevents you from continuing.
This status line must always be the very last thing in your response. Never skip it.`;

const TOOL_CALL_INSTRUCTION = `\n\nCRITICAL: After finishing tool calls (Read, Bash, Edit, Write, Grep, etc.), you MUST write a final text response with the status line. NEVER end your turn on a tool call without a text summary. The user cannot see tool results — they only see your text. If you called tools, summarize what you found or did in 1-3 sentences, then add the "---" status line.`;

// Mandatory verification suffix — appended to every Kanban task prompt.
// Stays in context on --resume turns because it is part of the first user message.
const TASK_VERIFICATION_SUFFIX = `

---
## MANDATORY POST-TASK VERIFICATION

After completing all work above, run this verification loop BEFORE finishing:

### Step 1 — Requirements Audit
Re-read the task and list every requirement explicitly (numbered).

### Step 2 — Proof of Completion
For each requirement: run a command or inspect output that PROVES it is satisfied.
Do NOT skip — execute actual commands and show the output.

### Step 3 — Browser Testing (MANDATORY for ANY frontend/UI change)
If this task modifies **any** .vue, .tsx, .jsx, .ts, .js, .css, .scss, or .html file in a frontend project, you MUST run Playwright browser tests via the Bash tool. There is NO fallback. curl is NOT an acceptable substitute.

1. Read docs/testing-info.md for credentials and test URL
2. Write a Playwright script via the Bash tool (example):

    cat > /tmp/verify-task.mjs << 'SCRIPT'
    import { chromium } from 'playwright';
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('<URL from docs/testing-info.md>');
    // login, navigate, interact, screenshot
    await page.screenshot({ path: 'test-screenshots/task-<N>-01-feature.png' });
    await browser.close();
    SCRIPT
    node /tmp/verify-task.mjs

3. Your output MUST show Playwright execution: chromium.launch + page.goto + page.screenshot with actual files written to test-screenshots/
4. The server will FAIL this task if no Playwright evidence is detected in output. curl verification, HTTP 200 checks against dev server, or "MCP not available" excuses are NOT acceptable and the task will be retried.

**Playwright is always available** via the playwright npm package (already installed globally). MCP servers are NOT used in --print mode — always use Bash + the playwright package directly.

### Step 4 — Fix & Re-verify
If any check fails: fix it immediately, then re-run the exact check to confirm it passes.

### Step 5 — Self-Audit
Ask: "If a senior engineer reviews this right now, would they approve without any changes?"
If the answer is no — fix the issues first.

### Verification Report (required, always at the end)
\`\`\`
VERIFICATION:
✅ [requirement 1]: [command / output as proof]
✅ [requirement 2]: [command / output as proof]
🌐 [browser test]: [screenshot or description of what was verified in browser]
❌ [requirement N]: ISSUE FOUND → FIXED: [what was done] → ✅ confirmed
FINAL: ✅ All requirements verified [/ ⚠️ N issues found and fixed]
\`\`\``;

/**
 * Build system prompt for a chat turn.
 * Caches by sorted skill IDs + UI language to avoid rebuilding identical prompts.
 * @param {string[]} skillIds - active skill IDs
 * @param {object} config - merged config with skills definitions and UI language
 * @returns {string} assembled system prompt
 */
function buildSystemPrompt(skillIds, config) {
  const uiLang = config.lang || 'en';
  const cacheKey = [...skillIds].sort().join('|') + `|lang:${uiLang}`;
  const cached = _systemPromptCache.get(cacheKey);
  if (cached) return cached;

  let prompt = BASE_SYSTEM_INSTRUCTIONS;

  // Language instruction: reasoning in English, user-facing in UI language
  const langName = LANG_NAMES[uiLang] || 'English';
  prompt += `\n\nLANGUAGE: All internal reasoning, thinking, and inter-agent communication MUST be in English (token-efficient). All user-facing text (responses, explanations, questions) MUST be in ${langName}.`;

  for (const sid of skillIds) {
    const s = config.skills[sid];
    if (!s) continue;
    const content = getSkillContent(resolveSkillFile(s.file));
    if (content) prompt += `\n\n--- SKILL: ${s.label} ---\n${content}`;
  }

  prompt += ASK_USER_INSTRUCTION;
  prompt += NOTIFY_USER_INSTRUCTION;
  prompt += SET_UI_STATE_INSTRUCTION;
  prompt += BROWSER_TESTING_INSTRUCTION;
  prompt += AUTONOMOUS_INSTRUCTION;
  prompt += STATUS_LINE_INSTRUCTION;
  prompt += TOOL_CALL_INSTRUCTION;

  // Evict oldest if cache full
  if (_systemPromptCache.size >= MAX_PROMPT_CACHE_SIZE) {
    const oldest = _systemPromptCache.keys().next().value;
    _systemPromptCache.delete(oldest);
  }
  _systemPromptCache.set(cacheKey, prompt);
  return prompt;
}

// ============================================
// LLM-BASED TASK CLASSIFIER (haiku)
// ============================================
// Single haiku call returns both specialist skills AND a short chat title.
// Replaces client-side keyword matching + ugly message truncation.
// Haiku via CLI → ~10-15s (CLI overhead), but runs before main agent.
const CLASSIFY_TIMEOUT_MS = 30000;

async function classifyTask(userMessage, currentSkills, config, workdir) {
  const catalog = Object.entries(config.skills || {})
    .filter(([id]) => id !== 'auto-mode')
    .map(([id, s]) => `- ${id}: ${(s.label || id).replace(/^\S+\s/, '')} — ${s.description || ''}`)
    .join('\n');

  const currentCtx = currentSkills.length
    ? `\nCurrently active: ${currentSkills.filter(id => id !== 'auto-mode').join(', ')}`
    : '';

  const prompt = `Specialists:\n${catalog}${currentCtx}\n\nUser task: "${userMessage.substring(0, 600)}"`;

  const cli = new ClaudeCLI({ cwd: workdir });

  return new Promise((resolve) => {
    let fullText = '';
    let settled = false;
    const fallback = { skills: [], title: '' };
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(fallback); }
    }, CLASSIFY_TIMEOUT_MS);

    cli.send({
      prompt,
      model: 'haiku',
      maxTurns: 1,
      allowedTools: ['_none'],
      mcpServers: {},
      systemPrompt: 'You are a task classifier. Analyze the user task and:\n1. Select 1-4 most relevant specialist IDs from the list\n2. Generate a short chat title (3-7 words, in the SAME language as user\'s message)\n\nReturn ONLY a JSON object: {"skills":["id1","id2"],"title":"Short title here"}\nNo explanation, no markdown.',
    })
    .onText(t => { fullText += t; })
    .onDone(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const match = fullText.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          const skills = (parsed.skills || []).filter(id => typeof id === 'string' && config.skills[id] && id !== 'auto-mode');
          const title = typeof parsed.title === 'string' ? parsed.title.trim().substring(0, 80) : '';
          resolve({
            skills: skills.length > 0 && config.skills['auto-mode'] ? ['auto-mode', ...skills] : skills,
            title,
          });
          return;
        }
        resolve(fallback);
      } catch {
        resolve(fallback);
      }
    })
    .onError(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

// ============================================
// PROJECTS
// ============================================
function loadProjects() { try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8')); } catch { return []; } }
function getProjectName(workdir) { if(!workdir) return ''; const p = loadProjects().find(p => p.workdir === workdir); return p?.name || path.basename(workdir); }
function saveProjects(p) { const d=path.dirname(PROJECTS_FILE); if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); fs.writeFileSync(PROJECTS_FILE, JSON.stringify(p, null, 2)); }

/**
 * Get notification context (session title + project name) for enriching notification payloads.
 * @param {string} sessionId - session ID to look up
 * @returns {{ sessionTitle: string|null, projectName: string|null }}
 */
function getNotificationContext(sessionId) {
  if (!sessionId) return { sessionTitle: null, projectName: null };
  try {
    const sess = stmts.getSession.get(sessionId);
    if (!sess) return { sessionTitle: null, projectName: null };
    const sessionTitle = (sess.title && !DEFAULT_SESSION_TITLES.has(sess.title)) ? sess.title : null;
    let projectName = null;
    if (sess.workdir) {
      const proj = loadProjects().find(p => p.workdir === sess.workdir);
      projectName = proj?.name || null;
    }
    return { sessionTitle, projectName };
  } catch {
    return { sessionTitle: null, projectName: null };
  }
}

function loadRemoteHosts() { try { return JSON.parse(fs.readFileSync(REMOTE_HOSTS_FILE, 'utf-8')); } catch { return []; } }
function saveRemoteHosts(h) { const d=path.dirname(REMOTE_HOSTS_FILE); if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); fs.writeFileSync(REMOTE_HOSTS_FILE, JSON.stringify(h, null, 2)); }

// ─── SSH password encryption (AES-256-GCM, persistent key) ───────────────────
// Key is generated once and stored in data/hosts.key (600 perms).
// Stored format: "enc:<base64(16-byte-IV + 16-byte-authTag + ciphertext)>"
// Prefix "enc:" enables backward compatibility with existing plaintext entries.
function _loadOrCreateHostsKey() {
  try { const k = fs.readFileSync(HOSTS_KEY_FILE); if (k.length === 32) return k; } catch {}
  const k = crypto.randomBytes(32);
  const d = path.dirname(HOSTS_KEY_FILE);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(HOSTS_KEY_FILE, k, { mode: 0o600 });
  return k;
}
const HOSTS_ENCRYPT_KEY = _loadOrCreateHostsKey();

function encryptPassword(plain) {
  if (!plain) return '';
  const iv  = crypto.randomBytes(16);
  const c   = crypto.createCipheriv('aes-256-gcm', HOSTS_ENCRYPT_KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decryptPassword(stored) {
  if (!stored) return '';
  if (!stored.startsWith('enc:')) return stored; // backward compat: plaintext
  try {
    const buf = Buffer.from(stored.slice(4), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', HOSTS_ENCRYPT_KEY, buf.subarray(0, 16));
    d.setAuthTag(buf.subarray(16, 32));
    return d.update(buf.subarray(32)).toString('utf8') + d.final('utf8');
  } catch { return ''; }
}

// testSshConnection is now exported from claude-ssh.js (uses ssh2 library, supports password auth)

// ============================================
// EXECUTION ENGINES
// ============================================

// Maximum number of auto-continue attempts when agent hits --max-turns limit.
// Each continue resumes the session, giving the agent another maxTurns window.
const MAX_AUTO_CONTINUES = 5;

// --- CLI Single Agent ---
async function runCliSingle(p) {
  const { prompt, userContent, systemPrompt, mcpServers, model, maxTurns, ws, sessionId, abortController, claudeSessionId, mode, workdir, tabId } = p;
  const mp = mode==='planning' ? 'MODE: PLANNING ONLY. Analyze, plan, DO NOT modify files.\n\n' : mode==='task' ? 'MODE: EXECUTION.\n\n' : '';
  const sp = (mp + (systemPrompt||'')).trim() || undefined;
  // MCP tools must use the mcp__<serverName>__<toolName> format in allowedTools
  const mcpTools = ['mcp___ccs_set_ui_state__set_ui_state', 'mcp___ccs_ask_user__ask_user', 'mcp___ccs_notify__notify_user'];
  const tools = mode==='planning'
    ? ['View','GlobTool','GrepTool','ListDir','ReadNotebook', ...mcpTools]
    : ['Bash','View','GlobTool','GrepTool','ReadNotebook','NotebookEditCell','ListDir','SearchReplace','Write', ...mcpTools];
  const effectiveMaxTurns = maxTurns || 30;
  let fullText = '', newCid = claudeSessionId, chunkCount = 0;
  let currentPrompt = prompt;
  let continueCount = 0;
  // First invocation carries attachments; subsequent auto-continues do not
  let currentContentBlocks = Array.isArray(userContent) ? userContent : null;

  const cli = new ClaudeCLI({ cwd: workdir || WORKDIR });

  // Run a single CLI invocation and return { resultData, sid, errorText }
  const runOnce = (runPrompt, contentBlocks, resumeId) => new Promise((resolve) => {
    let resultData = null;
    let errorText = '';
    let _done = false;
    const _finish = (sid) => { if (!_done) { _done = true; resolve({ resultData, sid, errorText }); } };

    cli.send({ prompt: runPrompt, contentBlocks, sessionId: resumeId, model, maxTurns: effectiveMaxTurns, systemPrompt: sp, mcpServers, allowedTools: tools, abortController })
      .onText(t => {
        fullText += t;
        { const _cb = (chatBuffers.get(sessionId) || '') + t; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        ws.send(JSON.stringify({ type:'text', text:t, ...(tabId ? { tabId } : {}) }));
        if (++chunkCount % 5 === 0) {
          try { stmts.setPartialText.run(fullText, sessionId); } catch {}
        }
      })
      .onThinking(t => { ws.send(JSON.stringify({ type:'thinking', text:t, ...(tabId ? { tabId } : {}) })); })
      .onTool((name, inp) => {
        if (name === 'ask_user' || name === 'notify_user' || name === 'set_ui_state') {
          try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
          return;
        }
        if (name === 'AskUserQuestion') {
          try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
          return;
        }
        ws.send(JSON.stringify({ type:'tool', tool:name, input:(inp||'').substring(0,600), ...(tabId ? { tabId } : {}) }));
        try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
      })
      .onSessionId(sid => { newCid = sid; try { stmts.updateClaudeId.run(sid, sessionId); } catch {} })
      .onRateLimit(info => { ws.send(JSON.stringify({ type:'rate_limit', info, ...(tabId ? { tabId } : {}) })); })
      .onResult(r => { resultData = r; })
      .onError(err => {
        // Capture error text for the main loop to inspect (e.g. thinking block signature errors)
        errorText += err;
        // Don't resolve here — let onDone be the sole resolver (matches taskWorker pattern).
        // This ensures resultData is fully populated before the loop checks it.
        try { ws.send(JSON.stringify({ type:'error', error:err.substring(0,500), ...(tabId ? { tabId } : {}) })); } catch {}
      })
      .onDone(sid => {
        if (sid) newCid = sid;
        _finish(newCid);
      });
  });

  // Main loop: run agent, auto-continue until it finishes successfully or budget exhausted
  let lastResult = null;
  while (true) {
    const { resultData, errorText } = await runOnce(currentPrompt, currentContentBlocks, newCid);
    lastResult = resultData;

    // ✅ Success — agent finished naturally
    if (resultData?.subtype === 'success') break;

    // 🔑 Invalid thinking block signature — session is corrupted, start fresh
    // This happens when system prompt changed between turns or session state is inconsistent.
    // Clear the Claude session ID so the next attempt starts a new session.
    if (errorText && /Invalid signature in thinking block/i.test(errorText)) {
      log.warn('thinking-block-signature-error', { sessionId, oldCid: newCid });
      const notice = '\n\n⚠️ **Session reset** — thinking block signature expired, starting fresh session...\n\n';
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
      // Clear session ID — next iteration will start a fresh Claude session
      newCid = null;
      try { stmts.updateClaudeId.run(null, sessionId); } catch {}
      // Use original prompt for the fresh session, not the continuation prompt
      currentPrompt = prompt;
      currentContentBlocks = Array.isArray(userContent) ? userContent : null;
      continueCount++;
      if (continueCount >= MAX_AUTO_CONTINUES) break;
      continue;
    }

    // 💰 Budget exceeded — hard limit, cannot continue
    if (resultData?.subtype === 'error_max_budget_usd') {
      const notice = '\n\n⚠️ **Budget limit reached** — agent stopped.\n\n';
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
      break;
    }

    // 🛑 User aborted
    if (abortController?.signal?.aborted) break;

    // 🔄 Auto-continue budget exhausted
    if (continueCount >= MAX_AUTO_CONTINUES) {
      const notice = `\n\n⚠️ **Agent did not complete** after ${MAX_AUTO_CONTINUES} auto-continues. Continue manually if needed.\n\n`;
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
      break;
    }

    // 🔄 Auto-continue: agent stopped but didn't finish
    continueCount++;

    if (resultData?.subtype === 'error_max_turns') {
      // Max-turns hit — notify user explicitly
      log.info('auto-continue (max_turns)', { sessionId, attempt: continueCount, maxAttempts: MAX_AUTO_CONTINUES, turnsUsed: resultData.num_turns });
      const notice = `\n\n---\n⏳ **Auto-continuing** (${continueCount}/${MAX_AUTO_CONTINUES}) — hit ${effectiveMaxTurns}-turn limit, resuming...\n\n`;
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
    } else {
      // Any other non-success stop (error_during_execution, process crash, etc.) — auto-continue silently
      log.info('auto-continue (non-success)', { sessionId, attempt: continueCount, subtype: resultData?.subtype || 'unknown' });
    }

    // Resume session with continuation prompt — no attachments on subsequent runs
    currentPrompt = 'Continue where you left off. Complete the remaining work.';
    currentContentBlocks = null;
  }

  // Persist final text and clean up
  try { if (fullText) stmts.addMsg.run(sessionId, 'assistant', 'text', fullText, null, null, null, null); } catch {}
  try { stmts.setPartialText.run(null, sessionId); } catch {}
  return { cid: newCid, completed: lastResult?.subtype === 'success' };
}

// --- SSH Remote Agent ---
async function runSshSingle(p) {
  const { prompt, systemPrompt, model, maxTurns, ws, sessionId, abortController, claudeSessionId, mode, remoteHost, remoteWorkdir, sshKeyPath, password, port, tabId } = p;
  const mp = mode==='planning' ? 'MODE: PLANNING ONLY. Analyze, plan, DO NOT modify files.\n\n' : mode==='task' ? 'MODE: EXECUTION.\n\n' : '';
  const sp = (mp + (systemPrompt||'')).trim() || undefined;
  // MCP tools must use the mcp__<serverName>__<toolName> format in allowedTools
  const mcpTools = ['mcp___ccs_set_ui_state__set_ui_state', 'mcp___ccs_ask_user__ask_user', 'mcp___ccs_notify__notify_user'];
  const tools = mode==='planning'
    ? ['View','GlobTool','GrepTool','ListDir','ReadNotebook', ...mcpTools]
    : ['Bash','View','GlobTool','GrepTool','ListDir','SearchReplace','Write', ...mcpTools];
  const effectiveMaxTurns = maxTurns || 30;
  let fullText = '', newCid = claudeSessionId, chunkCount = 0;
  let currentPrompt = prompt;
  let continueCount = 0;

  const ssh = new ClaudeSSH({ host: remoteHost, workdir: remoteWorkdir, sshKeyPath, password, port });

  const runOnce = (runPrompt, resumeId) => new Promise((resolve) => {
    let resultData = null;
    let _done = false;
    const _finish = (sid) => { if (!_done) { _done = true; resolve({ resultData, sid }); } };

    ssh.send({ prompt: runPrompt, sessionId: resumeId, model, maxTurns: effectiveMaxTurns, systemPrompt: sp, allowedTools: tools, abortController })
      .onText(t => {
        fullText += t;
        { const _cb = (chatBuffers.get(sessionId) || '') + t; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        ws.send(JSON.stringify({ type:'text', text:t, ...(tabId ? { tabId } : {}) }));
        if (++chunkCount % 5 === 0) {
          try { stmts.setPartialText.run(fullText, sessionId); } catch {}
        }
      })
      .onThinking(t => { ws.send(JSON.stringify({ type:'thinking', text:t, ...(tabId ? { tabId } : {}) })); })
      .onTool((name, inp) => {
        if (name === 'ask_user' || name === 'notify_user' || name === 'set_ui_state') {
          try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
          return;
        }
        ws.send(JSON.stringify({ type:'tool', tool:name, input:(inp||'').substring(0,600), ...(tabId ? { tabId } : {}) }));
        try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
      })
      .onSessionId(sid => { newCid = sid; try { stmts.updateClaudeId.run(sid, sessionId); } catch {} })
      .onRateLimit(info => { ws.send(JSON.stringify({ type:'rate_limit', info, ...(tabId ? { tabId } : {}) })); })
      .onResult(r => { resultData = r; })
      .onError(err => {
        try { ws.send(JSON.stringify({ type:'error', error:err.substring(0,500), ...(tabId ? { tabId } : {}) })); } catch {}
      })
      .onDone(sid => {
        if (sid) newCid = sid;
        _finish(newCid);
      });
  });

  let lastResult = null;
  while (true) {
    const { resultData } = await runOnce(currentPrompt, newCid);
    lastResult = resultData;
    if (resultData?.subtype === 'success') break;
    if (resultData?.subtype === 'error_max_budget_usd') {
      const notice = '\n\n⚠️ **Budget limit reached** — agent stopped.\n\n';
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
      break;
    }
    if (abortController?.signal?.aborted) break;
    if (continueCount >= MAX_AUTO_CONTINUES) {
      const notice = `\n\n⚠️ **Agent did not complete** after ${MAX_AUTO_CONTINUES} auto-continues.\n\n`;
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
      break;
    }
    continueCount++;
    if (resultData?.subtype === 'error_max_turns') {
      const notice = `\n\n---\n⏳ **Auto-continuing** (${continueCount}/${MAX_AUTO_CONTINUES}) — resuming on remote...\n\n`;
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
    }
    currentPrompt = 'Continue where you left off. Complete the remaining work.';
  }

  try { if (fullText) stmts.addMsg.run(sessionId, 'assistant', 'text', fullText, null, null, null, null); } catch {}
  try { stmts.setPartialText.run(null, sessionId); } catch {}
  return { cid: newCid, completed: lastResult?.subtype === 'success' };
}

// ── Task 12: Party Mode — BMAD multi-persona discussion + execution ──────────
// Party mode: before execution, each relevant BMAD agent briefly discusses the
// task from their perspective, then a synthesis creates the execution plan.
async function runPartyMode(p) {
  const { prompt, systemPrompt, mcpServers, model, maxTurns, ws, sessionId, abortController, claudeSessionId, workdir, tabId } = p;
  const effectiveWorkdir = workdir || WORKDIR;
  const cli = new ClaudeCLI({ cwd: effectiveWorkdir });

  // ── Step 1: Identify relevant BMAD agents ───────────────────────────────
  const PARTY_AGENTS = [
    { id: 'analyst',         emoji: '📊', name: 'Mary (Analyst)'         },
    { id: 'architect',       emoji: '🏗️',  name: 'Winston (Architect)'    },
    { id: 'developer',       emoji: '💻', name: 'Amelia (Developer)'     },
    { id: 'qa-engineer',     emoji: '🧪', name: 'Quinn (QA)'             },
    { id: 'product-manager', emoji: '📋', name: 'John (PM)'              },
  ];
  ws.send(JSON.stringify({ type:'agent_status', agent:'party-host', status:'🎉 Party Mode — BMAD agents discussing...', ...(tabId ? { tabId } : {}) }));
  ws.send(JSON.stringify({ type:'party_start', agents: PARTY_AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji })), ...(tabId ? { tabId } : {}) }));

  const headerText = `\n## 🎉 Party Mode — BMAD Agent Discussion\n\n`;
  const _addBuf = (t) => { const _cb = (chatBuffers.get(sessionId) || '') + t; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); };
  _addBuf(headerText);
  ws.send(JSON.stringify({ type:'text', text: headerText, ...(tabId ? { tabId } : {}) }));

  let currentSessionId = claudeSessionId || null;
  const config = loadMergedConfig();

  // ── Step 2: Each BMAD agent briefly discusses the task ─────────────────
  const agentPerspectives = [];
  for (const agent of PARTY_AGENTS) {
    ws.send(JSON.stringify({ type:'agent_status', agent: agent.id, status:`${agent.emoji} ${agent.name} reviewing...`, ...(tabId ? { tabId } : {}) }));
    const agentSkillPrompt = config.skills[agent.id] ? buildSystemPrompt([agent.id], config) : `You are ${agent.name}. Be concise.${AUTONOMOUS_INSTRUCTION}`;
    const agentPrompt = `As ${agent.name}, review this task in 2-3 sentences from your specialist perspective. Focus on your key concern, approach, or recommendation.\n\nTASK: ${prompt}`;
    let agentText = '';
    await new Promise(res => {
      let _s = false; const _r = () => { if (!_s) { _s = true; res(); } };
      cli.send({ prompt: agentPrompt, sessionId: currentSessionId, model, maxTurns: 1, systemPrompt: agentSkillPrompt, allowedTools: [], abortController })
        .onText(t => { agentText += t; })
        .onSessionId(sid => { currentSessionId = sid; })
        .onError(() => _r()).onDone(() => _r());
    });
    const perspText = `\n**${agent.emoji} ${agent.name}:** ${agentText.trim()}\n`;
    agentPerspectives.push({ agent: agent.id, name: agent.name, text: agentText.trim() });
    _addBuf(perspText);
    ws.send(JSON.stringify({ type:'text', text: perspText, agent: agent.id, ...(tabId ? { tabId } : {}) }));
    ws.send(JSON.stringify({ type:'party_agent_spoke', agent: agent.id, name: agent.name, emoji: agent.emoji, text: agentText.trim(), ...(tabId ? { tabId } : {}) }));
    if (abortController?.signal?.aborted) break;
  }

  ws.send(JSON.stringify({ type:'agent_status', agent:'party-host', status:'📋 Synthesizing discussion into execution plan...', ...(tabId ? { tabId } : {}) }));

  // ── Step 3: Synthesize discussion into execution plan ──────────────────
  const synthPrompt = `Based on the BMAD team discussion above, create a concrete execution plan. Break into 2-5 subtasks with specific roles. Respond ONLY in JSON:\n{"plan":"...","agents":[{"id":"agent-1","role":"developer","task":"...","depends_on":[]}]}\n\nAgent perspectives:\n${agentPerspectives.map(a => `${a.name}: ${a.text}`).join('\n')}\n\nTASK: ${prompt}`;
  let planText = '';
  await new Promise(res => {
    let _s = false; const _r = () => { if (!_s) { _s = true; res(); } };
    cli.send({ prompt: synthPrompt, sessionId: currentSessionId, model, maxTurns: 1, allowedTools: [], abortController })
      .onText(t => { planText += t; })
      .onSessionId(sid => { currentSessionId = sid; })
      .onError(() => _r()).onDone(() => _r());
  });

  let plan = null;
  try { const m = planText.match(/\{[\s\S]*\}/); if (m) plan = JSON.parse(m[0]); } catch {}

  if (!plan?.agents?.length) {
    ws.send(JSON.stringify({ type:'agent_status', agent:'party-host', status:'⚠️ Falling back to single mode', ...(tabId ? { tabId } : {}) }));
    return runCliSingle(p);
  }

  const planSummaryText = `\n---\n📋 **Execution Plan:** ${plan.plan}\n🤖 ${plan.agents.map(a => `${a.id}(${a.role})`).join(', ')}\n---\n`;
  _addBuf(planSummaryText);
  ws.send(JSON.stringify({ type:'text', text: planSummaryText, ...(tabId ? { tabId } : {}) }));
  ws.send(JSON.stringify({ type:'agent_plan', plan: plan.plan, agents: plan.agents.map(a => ({ id: a.id, role: a.role, task: a.task })), ...(tabId ? { tabId } : {}) }));

  // ── Step 4: Execute the plan (reuse multi-agent execution loop) ─────────
  const completed = new Set(), results = {};
  const remaining = [...plan.agents];
  while (remaining.length) {
    const runnable = remaining.filter(a => (a.depends_on||[]).every(d => completed.has(d)));
    if (!runnable.length) break;
    await Promise.all(runnable.map(async agent => {
      remaining.splice(remaining.indexOf(agent), 1);
      ws.send(JSON.stringify({ type:'agent_status', agent: agent.id, status:`🔄 ${agent.role}`, ...(tabId ? { tabId } : {}) }));
      const depCtx = (agent.depends_on||[]).map(d => results[d] ? `\n[${d}]:${results[d].substring(0,2000)}` : '').join('');
      const agentPrompt = agent.task + (depCtx ? '\nContext:'+depCtx : '');
      const _bmadSkillId = BMAD_ROLE_TO_SKILL[agent.role?.toLowerCase()];
      let agentSp = _bmadSkillId && config.skills[_bmadSkillId] ? buildSystemPrompt([_bmadSkillId], config) : `You are ${agent.role}. Complete your assigned task thoroughly.${AUTONOMOUS_INSTRUCTION}`;
      let agentText = '';
      await new Promise(res => {
        let _s = false; const _r = () => { if (!_s) { _s = true; res(); } };
        cli.send({ prompt: agentPrompt, sessionId: currentSessionId, model, maxTurns: Math.min(maxTurns||30, 50), systemPrompt: agentSp, mcpServers, allowedTools: ['Bash','View','GlobTool','GrepTool','ListDir','SearchReplace','Write'], abortController })
          .onText(t => { agentText += t; _addBuf(t); try { ws.send(JSON.stringify({ type:'text', text:t, agent:agent.id, ...(tabId ? { tabId } : {}) })); } catch {} })
          .onTool((n,i) => { try { ws.send(JSON.stringify({ type:'tool', tool:n, input:(i||'').substring(0,600), agent:agent.id, ...(tabId ? { tabId } : {}) })); } catch {} })
          .onSessionId(sid => { currentSessionId = sid; })
          .onError(err => { try { ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`❌ ${err.substring(0,200)}`, ...(tabId ? { tabId } : {}) })); } catch {} _r(); })
          .onDone(() => _r());
      });
      results[agent.id] = agentText;
      completed.add(agent.id);
      ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`✅ ${agent.role}`, ...(tabId ? { tabId } : {}) }));
    }));
  }

  ws.send(JSON.stringify({ type:'agent_status', agent:'party-host', status:'✅ Party Mode complete', ...(tabId ? { tabId } : {}) }));
  return currentSessionId;
}

// ── Task 11: BMAD role → skill ID mapping ────────────────────────────────────
const BMAD_ROLE_TO_SKILL = {
  'architect':       'architect',
  'developer':       'developer',
  'qa-engineer':     'qa-engineer',
  'tech-writer':     'tech-writer',
  'ux-designer':     'ux-designer',
  'analyst':         'analyst',
  'product-manager': 'product-manager',
  'scrum-master':    'scrum-master',
  'bmad-master':     'bmad-master',
  'quick-flow':      'quick-flow',
  // Common synonyms
  'tester':          'qa-engineer',
  'qa':              'qa-engineer',
  'documentation':   'tech-writer',
  'writer':          'tech-writer',
  'design':          'ux-designer',
  'ux':              'ux-designer',
  'backend':         'backend',
  'frontend':        'frontend',
  'devops':          'devops',
  'security':        'security',
};

// --- Multi-Agent (CLI only) ---
async function runMultiAgent(p) {
  const { prompt, systemPrompt, mcpServers, model, maxTurns, ws, sessionId, abortController, claudeSessionId, workdir, tabId } = p;
  ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'🧠 Planning...', statusKey:'agent.planning', ...(tabId ? { tabId } : {}) }));

  const effectiveWorkdir = workdir || WORKDIR;
  const cli = new ClaudeCLI({ cwd: effectiveWorkdir });
  let planText = '';
  // Orchestrator gets existing session context via --resume if available
  // Task 11: Use BMAD role names in orchestrator prompt for persona mapping
  const planPrompt = `You are a BMAD lead architect. Break this into 2-5 subtasks, assigning each to the most appropriate BMAD specialist. Use these exact role names when applicable: architect, developer, qa-engineer, tech-writer, ux-designer, analyst, product-manager. Respond ONLY in JSON:\n{"plan":"...","agents":[{"id":"agent-1","role":"developer","task":"...","depends_on":[]}]}\n\nTASK: ${prompt}`;
  let currentSessionId = claudeSessionId || null;

  await new Promise(res => {
    let _settled = false;
    const _res = () => { if (!_settled) { _settled = true; res(); } };
    cli.send({ prompt:planPrompt, sessionId: currentSessionId, model, maxTurns:1, allowedTools:[], abortController })
      .onText(t => { planText+=t; })
      .onSessionId(sid => { currentSessionId = sid; })
      .onError(() => _res())
      .onDone(() => _res());
  });

  let plan = null;
  try { const m = planText.match(/\{[\s\S]*\}/); if (m) plan = JSON.parse(m[0]); } catch {}

  if (!plan?.agents?.length) {
    ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'⚠️ Falling back to single mode', statusKey:'agent.fallback_single', ...(tabId ? { tabId } : {}) }));
    // runCliSingle returns { cid, completed } — extract .cid to match
    // runMultiAgent's contract of returning a plain session ID string.
    const fallback = await runCliSingle(p);
    return fallback?.cid || null;
  }

  const planSummaryText = `📋 **${plan.plan}**\n🤖 ${plan.agents.map(a=>`${a.id}(${a.role})`).join(', ')}\n---\n`;
  { const _cb = (chatBuffers.get(sessionId) || '') + planSummaryText; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
  ws.send(JSON.stringify({ type:'text', text: planSummaryText, ...(tabId ? { tabId } : {}) }));
  ws.send(JSON.stringify({ type:'agent_plan', plan: plan.plan, agents: plan.agents.map(a => ({ id: a.id, role: a.role, task: a.task })), ...(tabId ? { tabId } : {}) }));
  try {
    const _apJson = JSON.stringify({ plan: plan.plan, agents: plan.agents.map(a => ({ id: a.id, role: a.role, task: a.task })), dispatched: false });
    stmts.addMsg.run(sessionId,'assistant','agent_plan',_apJson,null,'orchestrator',null,null);
  } catch {}

  const completed = new Set(), results = {};
  const remaining = [...plan.agents];

  // Run agents with session context
  while (remaining.length) {
    const runnable = remaining.filter(a => (a.depends_on||[]).every(d => completed.has(d)));
    if (!runnable.length) { ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'Circular deps', statusKey:'agent.circular_deps', ...(tabId ? { tabId } : {}) })); break; }

    await Promise.all(runnable.map(async agent => {
      remaining.splice(remaining.indexOf(agent), 1);
      ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`🔄 ${agent.role}`, ...(tabId ? { tabId } : {}) }));
      const depCtx = (agent.depends_on||[]).map(d => results[d] ? `\n[${d}]:${results[d].substring(0,2000)}` : '').join('');
      const agentPrompt = agent.task + (depCtx ? '\nContext:'+depCtx : '');
      // Task 11: Map agent role to BMAD skill and build skill-based system prompt
      const _bmadSkillId = BMAD_ROLE_TO_SKILL[agent.role?.toLowerCase()] || null;
      let agentSp;
      if (_bmadSkillId) {
        try {
          const _skillConfig = loadMergedConfig();
          if (_skillConfig.skills[_bmadSkillId]) {
            agentSp = buildSystemPrompt([_bmadSkillId], _skillConfig);
          }
        } catch {}
      }
      if (!agentSp) agentSp = `You are ${agent.role}. Complete your assigned task thoroughly. Be concise in output.${AUTONOMOUS_INSTRUCTION}`;
      const agentTools = ['Bash','View','GlobTool','GrepTool','ListDir','SearchReplace','Write'];
      let agentText = '';

      await new Promise(res => {
        let _settled = false;
        const _res = () => { if (!_settled) { _settled = true; res(); } };
        // Agent resumes session to maintain context
        cli.send({ prompt:agentPrompt, sessionId: currentSessionId, model, maxTurns:Math.min(maxTurns||30, 50), systemPrompt:agentSp, mcpServers, allowedTools:agentTools, abortController })
          .onText(t => { agentText+=t; { const _cb = (chatBuffers.get(sessionId) || '') + t; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); } try { ws.send(JSON.stringify({ type:'text', text:t, agent:agent.id, ...(tabId ? { tabId } : {}) })); } catch {} })
          .onTool((n,i) => { if (n !== 'ask_user' && n !== 'notify_user' && n !== 'set_ui_state') { try { ws.send(JSON.stringify({ type:'tool', tool:n, input:(i||'').substring(0,600), agent:agent.id, ...(tabId ? { tabId } : {}) })); } catch {} } try { stmts.addMsg.run(sessionId,'assistant','tool',(i||'').substring(0,500),n,agent.id,null,null); } catch {} })
          .onSessionId(sid => { currentSessionId = sid; })
          .onError(err => { try { ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`❌ ${err.substring(0,200)}`, ...(tabId ? { tabId } : {}) })); } catch {} _res(); })
          .onDone(() => _res());
      });

      results[agent.id] = agentText;
      try { if (agentText) stmts.addMsg.run(sessionId,'assistant','text',agentText,null,agent.id,null,null); } catch {}
      completed.add(agent.id);
      ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`✅ ${agent.role}`, ...(tabId ? { tabId } : {}) }));
    }));
  }

  // Summarizer agent: synthesizes results and provides final session_id for resume
  ws.send(JSON.stringify({ type:'agent_status', agent:'summarizer', status:'📝 Synthesizing results...', ...(tabId ? { tabId } : {}) }));
  const summaryPrompt = `You are a coordinator. Synthesize the results from all agents and provide a concise summary.

AGENT RESULTS:
${Object.entries(results).map(([id, text]) => `【${id}】\n${(text||'No output').substring(0,3000)}`).join('\n\n')}

Provide a clear summary of what was accomplished. Be concise.`;

  let summaryText = '';
  await new Promise(res => {
    let _settled = false;
    const _res = () => { if (!_settled) { _settled = true; res(); } };
    cli.send({ prompt:summaryPrompt, sessionId: currentSessionId, model, maxTurns:1, allowedTools:[], abortController })
      .onText(t => { summaryText+=t; { const _cb = (chatBuffers.get(sessionId) || '') + t; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); } try { ws.send(JSON.stringify({ type:'text', text:t, agent:'summarizer', ...(tabId ? { tabId } : {}) })); } catch {} })
      .onSessionId(sid => { currentSessionId = sid; try { stmts.updateClaudeId.run(sid, sessionId); } catch {} })
      .onError(() => _res())
      .onDone(() => _res());
  });

  if (summaryText) {
    try { stmts.addMsg.run(sessionId,'assistant','text',summaryText,null,'summarizer',null,null); } catch {}
  }
  ws.send(JSON.stringify({ type:'agent_status', agent:'summarizer', status:'✅ Summary complete', ...(tabId ? { tabId } : {}) }));
  ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'All agents done', statusKey:'agent.done', ...(tabId ? { tabId } : {}) }));

  // Return session_id for future resume
  return currentSessionId;
}

// ============================================
// EXPRESS
// ============================================
// CSP disabled: SPA uses inline scripts/styles; all other helmet headers applied
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit:'5mb' }));
app.use(cookieParser());

// ─── HTTP Request Logging ─────────────────────────────────────────────────────
// Logs method, path, status, and duration for every request.
// Skips the health endpoint to avoid noisy polling logs.
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    log[lvl]('http', { method: req.method, path: req.path, status: res.statusCode, ms });
  });
  next();
});

// ─── Internal MCP: ask_user endpoint ─────────────────────────────────────────
// Registered BEFORE authMiddleware — MCP subprocess authenticates with ASK_USER_SECRET,
// not with a user session token. The Bearer secret is a 32-char hex generated per process.
app.post('/api/internal/ask-user', express.json(), (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${ASK_USER_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { requestId, sessionId, question, questions, options, inputType } = req.body;
  if (!requestId || !sessionId || !question) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Normalize: if new-style `questions` array is present, use it; otherwise wrap legacy fields
  const normalizedQuestions = Array.isArray(questions) && questions.length
    ? questions
    : [{ question, options: options || null, multiSelect: inputType === 'multi_choice' }];

  // Set up a timer that auto-resolves if the user doesn't answer
  const timer = setTimeout(() => {
    const entry = pendingAskUser.get(requestId);
    if (entry) {
      pendingAskUser.delete(requestId);
      entry.resolve({ answer: '[No response — proceed with your best judgment.]' });
      // Notify client that the question timed out so it can disable the card
      const task = activeTasks.get(sessionId);
      if (task?.proxy) {
        try { task.proxy.send(JSON.stringify({ type: 'ask_user_timeout', requestId, tabId: sessionId })); } catch {}
      }
    }
  }, ASK_USER_TIMEOUT_MS);

  // Store the pending question — resolve will be called by WS handler
  const promise = new Promise((resolve) => {
    pendingAskUser.set(requestId, {
      resolve,
      sessionId,
      timer,
      question,
      questions: normalizedQuestions,
    });
  });

  // Route question to the client via the active task's proxy (survives WS reconnects)
  const activeTask = activeTasks.get(sessionId);
  if (activeTask?.proxy) {
    const payload = JSON.stringify({
      type: 'ask_user',
      requestId,
      question,
      questions: normalizedQuestions,
      tabId: sessionId,
    });
    try { activeTask.proxy.send(payload); } catch {}
  }

  // Wait for the user's answer (or timeout)
  promise.then((result) => {
    res.json(result);
  }).catch((err) => {
    res.status(500).json({ error: err.message || 'Internal error' });
  });
});

// ─── Notify User endpoint (non-blocking, fire-and-forget) ────────────────────
app.post('/api/internal/notify', express.json(), (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${NOTIFY_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { sessionId, level, title, detail, progress } = req.body;
  if (!sessionId || !title) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const ctx = getNotificationContext(sessionId);
  const payload = JSON.stringify({
    type: 'notification',
    level: level || 'info',
    title: String(title).substring(0, 120),
    detail: detail ? String(detail).substring(0, 500) : '',
    progress: progress || null,
    tabId: sessionId,
    timestamp: Date.now(),
    sessionTitle: ctx.sessionTitle,
    projectName: ctx.projectName,
  });

  // Route via active task proxy (survives WS reconnects)
  const activeTask = activeTasks.get(sessionId);
  if (activeTask?.proxy) {
    try { activeTask.proxy.send(payload); } catch {}
  }

  // Also broadcast to session watchers (Kanban task viewers)
  broadcastToSession(sessionId, JSON.parse(payload));

  res.json({ ok: true });
});

// ─── Set UI State endpoint (non-blocking, fire-and-forget) ───────────────────
app.post('/api/internal/set-ui-state', express.json(), (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${SET_UI_STATE_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { sessionId, mode, model, agent } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }
  if (!mode && !model && !agent) {
    return res.status(400).json({ error: 'At least one of mode, model, or agent must be provided' });
  }

  // Broadcast to session watchers — UI will receive via WebSocket
  const payload = { type: 'ui_state_change' };
  if (mode) payload.mode = mode;
  if (model) payload.model = model;
  if (agent) payload.agent = agent;
  payload.tabId = sessionId;

  // Route via active task proxy (survives WS reconnects)
  const activeTask = activeTasks.get(sessionId);
  if (activeTask?.proxy) {
    try { activeTask.proxy.send(JSON.stringify(payload)); } catch {}
  }

  // Also broadcast to session watchers
  broadcastToSession(sessionId, payload);

  res.json({ ok: true });
});

// ─── Public shared document page — NO AUTH ───────────────────────────────────
// Must be registered BEFORE auth middleware so it's accessible without login.
app.get('/shared/:token', (req, res) => {
  const { token } = req.params;
  if (!/^[a-f0-9]{32}$/i.test(token)) {
    return res.status(404).send(sharedDoc404());
  }
  const now = new Date().toISOString();
  const share = db.prepare(`SELECT * FROM shared_docs WHERE id=? AND (expires_at IS NULL OR expires_at > ?)`).get(token, now);
  if (!share) return res.status(404).send(sharedDoc404());
  const filePath = path.resolve(share.project_id || '', share.file_path);
  if (!fs.existsSync(filePath)) return res.status(404).send(sharedDoc404());
  try {
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    const stat = fs.statSync(filePath);
    const modified = stat.mtime;
    const projectName = path.basename(share.project_id || '');
    let content = '';
    let isText = true;
    if (['.png','.jpg','.jpeg','.gif','.svg','.webp','.bmp'].includes(ext)) {
      isText = false;
      const buf = fs.readFileSync(filePath);
      const mime = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.svg':'image/svg+xml', '.webp':'image/webp', '.bmp':'image/bmp' }[ext] || 'image/octet-stream';
      content = `<img src="data:${mime};base64,${buf.toString('base64')}" alt="${escHtml(name)}" style="max-width:100%;border-radius:8px">`;
    } else if (['.pdf','.doc','.docx','.xls','.xlsx'].includes(ext)) {
      isText = false;
      content = `<div style="text-align:center;padding:40px"><div style="font-size:48px;margin-bottom:16px">📄</div><div style="font-size:18px;font-weight:600;margin-bottom:8px">${escHtml(name)}</div><p style="color:#94a3b8">Binary file — download not available on shared view.</p></div>`;
    } else {
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (ext === '.md') {
        content = `<div class="md-rendered">${sharedRenderMarkdown(raw)}</div>`;
      } else if (ext === '.yaml' || ext === '.yml') {
        content = `<pre class="code-block language-yaml">${escHtml(raw)}</pre>`;
      } else if (ext === '.json') {
        let pretty = raw;
        try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
        content = `<pre class="code-block language-json">${escHtml(pretty)}</pre>`;
      } else {
        content = `<pre class="code-block">${escHtml(raw)}</pre>`;
      }
    }
    const modStr = modified.toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    const expiryStr = share.expires_at ? `Expires ${new Date(share.expires_at).toLocaleDateString('en-US')}` : '';
    const sharedAtStr = new Date(share.created_at).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    res.send(sharedDocPage({ name, projectName, modStr, expiryStr, content, token, sharedAtStr }));
  } catch (e) {
    res.status(500).send(sharedDoc404('Error loading document'));
  }
});

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function sharedRenderMarkdown(md) {
  let html = escHtml(md);
  // Fenced code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const cls = lang ? ` class="language-${lang}"` : '';
    return `<pre class="code-block"><code${cls}>${code}</code></pre>`;
  });
  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold/italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // HR
  html = html.replace(/^---$/gm, '<hr>');
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>)(\n(?=<li>)|$)/g, '$1$2');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Tables
  html = html.replace(/^(\|.+\|)\n(\|[-: |]+\|)\n((?:\|.+\|\n?)*)/gm, (_, header, sep, body) => {
    const ths = header.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
    const rows = body.trim().split('\n').map(row => {
      const tds = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
  });
  // Paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';
  html = html.replace(/([^>])\n([^<])/g, '$1<br>$2');
  html = html.replace(/<p>\s*<\/p>/g, '');
  return html;
}

function sharedDocPage({ name, projectName, modStr, expiryStr, content, token, sharedAtStr }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(name)} — Claude Code Studio</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f1117;--s1:#1a1d27;--s2:#21263a;--s3:#2a2f45;
  --fg:#e2e8f0;--fg2:#94a3b8;--border:#2d3748;
  --accent:#6366f1;--green:#22c55e;--red:#ef4444;
  --font:'Inter',system-ui,-apple-system,sans-serif;
  --mono:'JetBrains Mono','Fira Code','Consolas',monospace;
}
body{background:var(--bg);color:var(--fg);font-family:var(--font);font-size:15px;line-height:1.6;min-height:100vh;display:flex;flex-direction:column}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--s1);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;position:sticky;top:0;z-index:10}
.header-left{display:flex;align-items:center;gap:12px}
.brand{display:flex;align-items:center;gap:8px;color:var(--fg2);font-size:13px}
.brand-dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}
.doc-title{font-size:18px;font-weight:700;color:var(--fg)}
.doc-meta{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.meta-chip{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--fg2);background:var(--s2);padding:4px 10px;border-radius:20px;border:1px solid var(--border)}
main{flex:1;max-width:860px;width:100%;margin:0 auto;padding:32px 24px}
footer{background:var(--s1);border-top:1px solid var(--border);padding:16px 24px;text-align:center;font-size:12px;color:var(--fg2)}
footer a{color:var(--fg2)}footer a:hover{color:var(--accent)}
/* Markdown rendered */
.md-rendered h1,.md-rendered h2,.md-rendered h3,.md-rendered h4{color:var(--fg);font-weight:700;margin:1.5em 0 .6em}
.md-rendered h1{font-size:1.9em;border-bottom:1px solid var(--border);padding-bottom:.4em}
.md-rendered h2{font-size:1.45em;border-bottom:1px solid var(--border);padding-bottom:.3em}
.md-rendered h3{font-size:1.2em}
.md-rendered p{margin:.8em 0;color:var(--fg)}
.md-rendered ul,.md-rendered ol{margin:.8em 0 .8em 1.6em}
.md-rendered li{margin:.3em 0}
.md-rendered blockquote{border-left:3px solid var(--accent);margin:1em 0;padding:.5em 1em;background:var(--s2);border-radius:0 6px 6px 0;color:var(--fg2)}
.md-rendered hr{border:none;border-top:1px solid var(--border);margin:1.5em 0}
.md-rendered strong{color:var(--fg);font-weight:600}
.md-rendered em{font-style:italic}
.md-rendered a{color:var(--accent)}
.md-rendered table{width:100%;border-collapse:collapse;margin:1em 0;font-size:14px}
.md-rendered th{background:var(--s3);color:var(--fg);text-align:left;padding:8px 12px;border:1px solid var(--border);font-weight:600}
.md-rendered td{padding:7px 12px;border:1px solid var(--border);color:var(--fg)}
.md-rendered tr:nth-child(even) td{background:var(--s2)}
/* Code */
.code-block{background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:16px;overflow-x:auto;font-family:var(--mono);font-size:13px;line-height:1.6;color:#e2e8f0;white-space:pre}
.md-rendered pre.code-block{margin:1em 0}
.inline-code{background:var(--s2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-family:var(--mono);font-size:0.9em;color:#fbbf24}
@media(max-width:600px){
  header{padding:12px 16px}
  .doc-title{font-size:15px}
  main{padding:20px 16px}
  .doc-meta{gap:8px}
}
</style>
</head>
<body>
<header>
  <div class="header-left">
    <div class="brand"><div class="brand-dot"></div>Claude Code Studio</div>
    <div class="doc-title">📄 ${escHtml(name)}</div>
  </div>
  <div class="doc-meta">
    ${projectName ? `<span class="meta-chip">📁 ${escHtml(projectName)}</span>` : ''}
    <span class="meta-chip">🗓 ${escHtml(modStr)}</span>
    ${expiryStr ? `<span class="meta-chip">⏳ ${escHtml(expiryStr)}</span>` : ''}
    <span class="meta-chip" style="color:#94a3b8">🔒 Read-only</span>
  </div>
</header>
<main>
${content}
</main>
<footer>
  Shared via <a href="/" target="_blank">Claude Code Studio</a> &nbsp;·&nbsp; Read-only view${sharedAtStr ? ` &nbsp;·&nbsp; Shared ${escHtml(sharedAtStr)}` : ''}
</footer>
</body>
</html>`;
}

function sharedDoc404(msg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Document Not Found — Claude Code Studio</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1117;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
.box{max-width:420px;padding:40px 32px}
.icon{font-size:64px;margin-bottom:20px}
h1{font-size:24px;font-weight:700;margin-bottom:8px}
p{color:#94a3b8;font-size:15px;margin-bottom:24px}
a{color:#6366f1;text-decoration:none;font-size:14px}a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="box">
  <div class="icon">🔗</div>
  <h1>${msg || 'Document Not Found'}</h1>
  <p>This share link is invalid, has expired, or the document was revoked.</p>
  <a href="/">← Back to Claude Code Studio</a>
</div>
</body>
</html>`;
}

app.use(auth.authMiddleware);

// Prevent browser caching for all API responses.
// Without this Express sends ETag but no Cache-Control, so browsers may
// serve stale cached JSON (e.g. task list after a DELETE still contains
// the deleted item until the heuristic cache expires).
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Kanban as default landing — must be before static middleware (which serves index.html for /)
app.get('/', (req,res,next) => { if(!auth.isSetupDone()) return res.redirect('/setup'); res.sendFile(path.join(__dirname,'public','kanban.html')); });
app.get('/chat', (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.use(express.static(path.join(__dirname, 'public')));

// ─── Language ─────────────────────────────────────────────────────────────────
// ---- BMAD runtime config (Settings dialog) ----
app.get('/api/config/bmad', (req, res) => {
  try {
    res.json({ ok: true, config: getBmadConfig(), defaults: BMAD_CONFIG_DEFAULTS });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/config/bmad', (req, res) => {
  try {
    const body = req.body || {};
    // Basic validation
    const VALID_MODELS = [
      'opus','sonnet','haiku',
      'opus-4.7','opus-4.6','opus-4.5','opus-4.1',
      'sonnet-4.6','sonnet-4.5','sonnet-4.0','sonnet-3.7',
      'haiku-4.5','haiku-3.5',
    ];
    const VALID_EFFORTS = ['low','medium','high','xhigh','max'];
    const VALID_PHASES = Object.keys(BMAD_CONFIG_DEFAULTS.models);
    if (body.models) {
      for (const [phase, model] of Object.entries(body.models)) {
        if (!VALID_PHASES.includes(phase)) return res.status(400).json({ ok: false, error: `invalid phase: ${phase}` });
        if (!VALID_MODELS.includes(model)) return res.status(400).json({ ok: false, error: `invalid model: ${model}` });
      }
    }
    if (body.efforts) {
      for (const [phase, effort] of Object.entries(body.efforts)) {
        if (!VALID_PHASES.includes(phase)) return res.status(400).json({ ok: false, error: `invalid phase: ${phase}` });
        if (!VALID_EFFORTS.includes(effort)) return res.status(400).json({ ok: false, error: `invalid effort: ${effort}` });
      }
    }
    if (body.playwright) {
      for (const key of Object.keys(body.playwright)) {
        if (!['enforceForImplementation','enforceForQA'].includes(key)) return res.status(400).json({ ok: false, error: `invalid playwright key: ${key}` });
      }
    }
    const saved = setBmadConfig(body);
    log.info('BMAD config updated', saved);
    res.json({ ok: true, config: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/lang', (req, res) => {
  const c = loadConfig();
  res.json({ lang: c.lang || 'en' });
});

app.put('/api/lang', express.json(), (req, res) => {
  const lang = req.body.lang;
  if (!['uk', 'en', 'ru'].includes(lang)) return res.status(400).json({ error: 'Invalid lang' });
  const c = loadConfig();
  c.lang = lang;
  saveConfig(c);
  // Update bot language if running
  if (telegramBot) telegramBot.lang = lang;
  res.json({ ok: true });
});

// ─── Health check ─────────────────────────────────────────────────────────────
// Deep health check: verifies DB connectivity, reports uptime / memory / WS connections.
// Returns HTTP 503 if any critical subsystem is degraded.
app.get('/api/version', (_, res) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  res.json({ version: pkg.version, name: pkg.name });
});

app.get('/api/health', (_, res) => {
  let dbOk = false;
  try { db.prepare('SELECT 1').get(); dbOk = true; } catch { /* db unavailable */ }

  const mem   = process.memoryUsage();
  const status = dbOk ? 'healthy' : 'degraded';
  const payload = {
    ok:           dbOk,
    status,
    uptime:       Math.floor(process.uptime()),       // seconds
    timestamp:    new Date().toISOString(),
    version:      (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')).version; } catch { return 'unknown'; } })(),
    db:           dbOk ? 'ok' : 'error',
    connections:  wss.clients.size,
    memory: {
      rss_mb:  Math.round(mem.rss        / 1024 / 1024),
      heap_mb: Math.round(mem.heapUsed   / 1024 / 1024),
    },
  };
  res.status(dbOk ? 200 : 503).json(payload);
});

// Test endpoint to simulate Ask tool (for UI testing)
// Stats
app.get('/api/stats', (req, res) => {
  const sessionId = req.query.session_id || null;

  // Unique agent_ids active in the last 5 minutes (assistant messages only)
  const activeAgents = stmts.activeAgents.all().map(r => r.agent_id);

  // User message counts — used only for pct calculation, not exposed raw
  const daily  = stmts.dailyMessages.get().count;
  const weekly = stmts.weeklyMessages.get().count;

  // Pre-compute usage percentages server-side
  const dailyPct  = Math.min(100, Math.round(daily  / CLAUDE_MAX_LIMITS.daily  * 100));
  const weeklyPct = Math.min(100, Math.round(weekly / CLAUDE_MAX_LIMITS.weekly * 100));

  // Next reset timestamps (UTC-based ISO strings)
  const now = new Date();
  const dailyResetAt  = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
  ));
  const daysToMon = now.getUTCDay() === 0 ? 1 : 8 - now.getUTCDay();
  const weeklyResetAt = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMon
  ));

  // Context size estimate: sum of all content lengths in session ÷ 4 chars/token
  let contextTokens = 0;
  if (sessionId) {
    const { total } = stmts.contextTokens.get(sessionId) || { total: 0 };
    contextTokens = Math.round(total / 4);
  }

  res.json({
    active_agents:    activeAgents,
    daily_pct:        dailyPct,
    weekly_pct:       weeklyPct,
    daily_reset_at:   dailyResetAt.toISOString(),
    weekly_reset_at:  weeklyResetAt.toISOString(),
    context_tokens:   contextTokens,
    limits:           CLAUDE_MAX_LIMITS,
  });
});
app.get('/api/auth/status', (req,res) => {
  const setupDone = auth.isSetupDone();
  const token = req.cookies?.token || req.headers['x-auth-token'];
  const loggedIn = setupDone && auth.validateToken(token);
  const ad = auth.loadAuth();
  const tokenInfo = loggedIn ? auth.getTokenInfo(token) : null;
  const result = { setupDone, loggedIn };
  if (loggedIn && tokenInfo) {
    result.role = tokenInfo.role;
    result.username = tokenInfo.username;
    if (tokenInfo.role === 'admin') {
      result.displayName = ad?.displayName || 'Admin';
    } else {
      const user = auth.getUserById(tokenInfo.userId);
      result.displayName = user?.displayName || tokenInfo.username;
      result.projects = user?.projects || [];
    }
  }
  res.json(result);
});

app.post('/api/auth/setup', authLimiter, async (req,res) => {
  try {
    const { password, displayName } = req.body;
    const token = await auth.setupUser(password, displayName);
    res.cookie('token', token, { httpOnly:true, sameSite:'lax', secure:SECURE_COOKIES, maxAge:30*24*60*60*1000 });
    res.json({ ok:true, displayName:displayName||'Admin' });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

app.post('/api/auth/login', authLimiter, async (req,res) => {
  try {
    const { password, username } = req.body;
    const token = await auth.login(password, username || undefined);
    res.cookie('token', token, { httpOnly:true, sameSite:'lax', secure:SECURE_COOKIES, maxAge:30*24*60*60*1000 });
    const tokenInfo = auth.getTokenInfo(token);
    const displayName = tokenInfo?.role === 'admin' ? auth.loadAuth()?.displayName : (auth.getUserById(tokenInfo?.userId)?.displayName || tokenInfo?.username);
    res.json({ ok:true, displayName, role: tokenInfo?.role, username: tokenInfo?.username });
  } catch(e) { res.status(401).json({ error:e.message }); }
});

app.post('/api/auth/logout', (req,res) => { if(req.cookies?.token) auth.revokeToken(req.cookies.token); res.clearCookie('token'); res.json({ ok:true }); });

app.post('/api/auth/change-password', async (req,res) => {
  try {
    const token = await auth.changePassword(req.body.oldPassword, req.body.newPassword);
    res.cookie('token', token, { httpOnly:true, sameSite:'lax', secure:SECURE_COOKIES, maxAge:30*24*60*60*1000 });
    res.json({ ok:true });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

app.get('/setup', (_,res) => { if(auth.isSetupDone()) return res.redirect('/'); res.sendFile(path.join(__dirname,'public','auth.html')); });
app.get('/login', (_,res) => { if(!auth.isSetupDone()) return res.redirect('/setup'); res.sendFile(path.join(__dirname,'public','auth.html')); });
app.get('/kanban', (_,res) => res.sendFile(path.join(__dirname,'public','kanban.html')));
app.get('/schedule', (_,res) => res.sendFile(path.join(__dirname,'public','schedule.html')));
app.get('/users', (_,res) => res.sendFile(path.join(__dirname,'public','users.html')));

// ─── Admin-only middleware ────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ─── User Management (admin only) ────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(auth.listUsers());
});

app.post('/api/users', requireAdmin, express.json(), async (req, res) => {
  try {
    const user = await auth.createUser(req.body);
    res.json({ ok: true, user });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/users/:id', requireAdmin, express.json(), async (req, res) => {
  try {
    const user = await auth.updateUser(req.params.id, req.body);
    res.json({ ok: true, user });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  try {
    auth.deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Tasks (Kanban) ───────────────────────────────────────────────────────
app.get('/api/tasks', (req, res) => {
  const workdir = req.query.workdir || null;
  const statusFilter = req.query.status || null; // Task 16: ?status=todo filter
  let rows = stmts.getTasks.all({ w: workdir || null });
  // Optional status filter for external API clients
  if (statusFilter) rows = rows.filter(t => t.status === statusFilter);
  // Non-admin users: filter tasks to only show those in assigned projects
  if (req.userRole !== 'admin') {
    const user = auth.getUserById(req.userId);
    const assignedProjects = user?.projects || [];
    const projectWorkdirs = new Set();
    const allProjects = loadProjects();
    for (const p of allProjects) {
      if (assignedProjects.includes(p.id)) projectWorkdirs.add(p.workdir);
    }
    rows = rows.filter(t => t.workdir && projectWorkdirs.has(t.workdir));
  }
  // Add last_activity and started_at for running tasks
  const lastActivityStmt = db.prepare(`SELECT created_at FROM messages WHERE session_id=? ORDER BY created_at DESC LIMIT 1`);
  const firstActivityStmt = db.prepare(`SELECT created_at FROM messages WHERE session_id=? ORDER BY created_at ASC LIMIT 1`);
  const result = rows.map(t => {
    const out = {
      ...t,
      is_active: t.session_id ? activeTasks.has(t.session_id) : false,
    };
    if (t.session_id && ['in_progress','bmad_brainstorm','bmad_prd','bmad_architecture','bmad_implementation','bmad_qa','done','done_review','awaiting_input'].includes(t.status)) {
      const last = lastActivityStmt.get(t.session_id);
      const first = firstActivityStmt.get(t.session_id);
      out.last_activity = last?.created_at || t.updated_at;
      out.started_at = first?.created_at || t.updated_at;
    }
    return out;
  });
  res.json(result);
});
app.get('/api/tasks/etag', (req, res) => { res.json(stmts.getTasksEtag.get()); });

// Screenshots for a specific task
app.get('/api/tasks/:id/screenshots', (req, res) => {
  const task = stmts.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const screenshotDir = path.join(task.workdir, 'test-screenshots');
  if (!fs.existsSync(screenshotDir)) return res.json([]);
  const prefix = `task-${task.id}-`;
  try {
    const files = fs.readdirSync(screenshotDir)
      .filter(f => f.startsWith(prefix) && /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
      .sort()
      .map(f => {
        const stat = fs.statSync(path.join(screenshotDir, f));
        return { name: f, size: stat.size, created: stat.mtimeMs, url: `/api/tasks/${task.id}/screenshot/${encodeURIComponent(f)}` };
      });
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// Serve a specific screenshot file for a task
app.get('/api/tasks/:id/screenshot/:file', (req, res) => {
  const task = stmts.getTask.get(req.params.id);
  if (!task) return res.status(404).send('Not found');
  const fp = path.join(task.workdir, 'test-screenshots', decodeURIComponent(req.params.file));
  // Security: ensure file is within the screenshots dir
  if (!fp.startsWith(path.join(task.workdir, 'test-screenshots'))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.sendFile(fp);
});
// Returns session IDs that currently have in_progress tasks — used by client to show spinners on all tabs
app.get('/api/tasks/running-sessions', (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT session_id FROM tasks WHERE status='in_progress' AND session_id IS NOT NULL`).all();
  res.json(rows.map(r => r.session_id));
});
app.post('/api/tasks', (req, res) => {
  let { title=i18nTask(), description='', notes='', status='backlog', sort_order=0, session_id=null, workdir=null,
          model='sonnet', mode='auto', agent_mode='single', max_turns=30, attachments=null,
          depends_on=null, chain_id=null, source_session_id=null,
          scheduled_at=null, recurrence=null, recurrence_end_at=null,
          after=null, dep_group=null } = req.body;
  
  // Auto-chaining: if 'after' is a task ID, inherit or create chain_id and set sort_order
  if (after) {
    const depTask = stmts.getTask.get(after);
    if (depTask) {
      chain_id = depTask.chain_id || `chain-${after}`;
      sort_order = (depTask.sort_order || 0) + 1;
      workdir = workdir || depTask.workdir;
      // If the dependency task didn't have a chain_id, assign one retroactively
      if (!depTask.chain_id) {
        db.prepare(`UPDATE tasks SET chain_id=? WHERE id=?`).run(chain_id, after);
      }
    }
  }
  
  // ── Require valid project: resolve project_id from workdir ──────────────────
  const allProjects = loadProjects();
  if (!workdir) {
    // If no workdir, try to find a single project and use its workdir
    if (allProjects.length === 1) {
      workdir = allProjects[0].workdir;
    } else {
      return res.status(400).json({ error: 'workdir is required — every task must belong to a project' });
    }
  }
  const matchedProject = allProjects.find(p => p.workdir === workdir);
  if (!matchedProject) {
    return res.status(400).json({ error: `No project found for workdir "${workdir}". Register the project first.` });
  }

  // ── Normalize status to valid kanban columns ──────────────────────────────
  const VALID_KANBAN = new Set(['backlog','todo','bmad_workflow','bmad_brainstorm','bmad_prd','bmad_architecture','bmad_implementation','bmad_qa','awaiting_input','in_progress','done_review','done','archived','cancelled']);
  if (status === 'open') status = 'backlog';
  if (!VALID_KANBAN.has(status)) status = 'backlog';

  const id = genId();
  const taskNum = stmts.nextTaskNumber.get(sqlVal(workdir) || '').next_num;
  
  // Auto-correct status: if task has a BMAD workflow tag, it should be in bmad_workflow queue
  if (notes && /\[bmad-workflow:[\w-]+\]/.test(notes) && (!status || status === 'backlog' || status === 'todo')) {
    status = 'bmad_workflow';
  }
  
  stmts.createTask.run(id, String(title).substring(0,200), String(description).substring(0,2000), String(notes||'').substring(0,2000), sqlVal(status), sqlVal(sort_order), sqlVal(session_id)||null, sqlVal(workdir)||null, sqlVal(model), sqlVal(mode), sqlVal(agent_mode), sqlVal(max_turns), sqlVal(attachments)||null, sqlVal(depends_on)||null, sqlVal(chain_id)||null, sqlVal(source_session_id)||null, sqlVal(scheduled_at)||null, sqlVal(recurrence)||null, sqlVal(recurrence_end_at)||null, taskNum, sqlVal(dep_group)||null);
  const task = stmts.getTask.get(id);
  if (['todo', 'bmad_workflow'].includes(status)) setImmediate(processQueue);
  res.json(task);
});

// ─── Discord BMAD Bridge API (local only) ──────────────────────────────────
const bmadBridge = require('./discord-bmad-bridge');

// POST /api/bmad/command — execute a BMAD command from Discord
// Body: { command: "bmad quick-spec \"HMIS Lite\" Fix pharmacy" }
app.post('/api/bmad/command', (req, res) => {
  // Local only — reject external requests
  const ip = req.ip || req.connection?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
    return res.status(403).json({ error: 'Local only' });
  }
  
  const parsed = bmadBridge.parseCommand(req.body.command);
  if (!parsed) return res.json({ error: 'Not a bmad command' });
  
  if (parsed.action === 'list') {
    return res.json({ ok: true, text: bmadBridge.formatWorkflowList() });
  }
  
  if (parsed.action === 'status') {
    const cookie = `token=${req.cookies?.token || ''}`;
    bmadBridge.getTaskStatus(cookie).then(text => res.json({ ok: true, text })).catch(e => res.json({ error: e.message }));
    return;
  }
  
  if (parsed.action === 'start') {
    const cookie = req.headers.cookie || '';
    bmadBridge.findProject(parsed.project, 'http://127.0.0.1:3000', cookie).then(async proj => {
      if (!proj) return res.json({ error: `Project "${parsed.project}" not found. Use \`bmad list\` to see options.` });
      
      const title = parsed.description 
        ? `${parsed.description.substring(0, 80)}`
        : `${parsed.workflow} — ${proj.name}`;
      
      try {
        const opts = {};
        if (parsed.chainAfterLast) {
          const lastTask = await bmadBridge.findLastTask(cookie, proj.workdir);
          if (lastTask) opts.after = lastTask.id;
        }
        const task = await bmadBridge.createTask(parsed.workflow, proj.workdir, title, parsed.description, cookie, opts);
        if (task.error) return res.json({ error: task.error });
        const chainNote = task.chain_id ? `\n🔗 Chained after: \`${opts.after?.slice(0,8) || '—'}\`` : '';
        res.json({ 
          ok: true, 
          text: `🚀 **Task Created:** ${title}\n🔮 Workflow: \`${parsed.workflow}\`\n📁 Project: ${proj.name}\n🆔 \`${task.id}\`${chainNote}`,
          taskId: task.id 
        });
      } catch (e) {
        res.json({ error: e.message });
      }
    });
    return;
  }
  
  if (parsed.action === 'reply') {
    const cookie = req.headers.cookie || '';
    (async () => {
      try {
        let taskId = parsed.taskId;
        let taskTitle = '';
        if (!taskId) {
          // Auto-find the most recent awaiting_input task
          const task = await bmadBridge.findAwaitingTask(cookie);
          if (!task) return res.json({ error: 'No tasks currently awaiting input.' });
          taskId = task.id;
          taskTitle = task.title;
        }
        await bmadBridge.replyToTask(taskId, parsed.message, cookie);
        const label = taskTitle ? `**${taskTitle}** (\`${taskId.slice(0,8)}\`)` : `\`${taskId}\``;
        res.json({ ok: true, text: `✅ Reply sent to ${label}` });
      } catch (e) {
        res.json({ error: e.message });
      }
    })();
    return;
  }
  
  // help
  res.json({ ok: true, text: bmadBridge.formatWorkflowList() });
});

// POST /api/tasks/:id/reply — send a reply to an awaiting_input task and resume it
app.post('/api/tasks/:id/reply', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.session_id) return res.status(400).json({ error: 'No session linked' });
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
  
  // Save user message to the session
  try {
    stmts.addMsg.run(task.session_id, 'user', 'text', message.trim(), null, null, null, null);
  } catch (e) { log.error('reply addMsg failed', e.message); }
  
  // Set task back to todo so the worker picks it up and resumes with the user's reply
  db.prepare(`UPDATE tasks SET status='bmad_workflow', updated_at=datetime('now') WHERE id=?`)
    .run(task.id);
  
  wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
  
  // Trigger queue processing
  setTimeout(processQueue, 500);
  
  res.json({ ok: true, status: 'todo' });
});

app.put('/api/tasks/:id', (req, res) => {
  const task = stmts.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const { title=task.title, description=task.description, notes=task.notes,
          status=task.status, sort_order=task.sort_order,
          session_id=task.session_id, workdir=task.workdir,
          model=task.model||'sonnet', mode=task.mode||'auto', agent_mode=task.agent_mode||'single',
          max_turns=task.max_turns||30, attachments=task.attachments,
          depends_on=task.depends_on, chain_id=task.chain_id, source_session_id=task.source_session_id,
          scheduled_at=task.scheduled_at, recurrence=task.recurrence, recurrence_end_at=task.recurrence_end_at,
          dep_group=task.dep_group } = req.body;
  // Stop running process when task is moved away from in_progress
  if (task.status === 'in_progress' && status !== 'in_progress') {
    const ctrl = runningTaskAborts.get(req.params.id);
    if (ctrl) {
      stoppingTasks.add(req.params.id);
      ctrl.abort();
      console.log(`[taskWorker] aborting task "${task.title}" (${req.params.id}) — moved to ${status}`);
    } else if (task.worker_pid) {
      stoppingTasks.add(req.params.id);
      killByPid(task.worker_pid);
    }
  }
  stmts.updateTask.run(
    String(title).substring(0,200), String(description).substring(0,2000),
    String(notes||'').substring(0,2000),
    sqlVal(status), sqlVal(sort_order), sqlVal(session_id) || null, sqlVal(workdir) || null,
    sqlVal(model), sqlVal(mode), sqlVal(agent_mode), sqlVal(max_turns), sqlVal(attachments) || null,
    sqlVal(depends_on) || null, sqlVal(chain_id) || null, sqlVal(source_session_id) || null,
    sqlVal(scheduled_at) || null, sqlVal(recurrence) || null, sqlVal(recurrence_end_at) || null,
    sqlVal(dep_group) || null,
    req.params.id
  );
  const updated = stmts.getTask.get(req.params.id);
  // Trigger queue whenever status is todo (covers "Run now" on scheduled tasks too)
  if (status === 'todo') setImmediate(processQueue);

  // ── Screenshot cleanup on status transitions (PUT — used by Kanban drag) ──
  if (status !== task.status && ['done', 'archived'].includes(status)) {
    const wd = workdir || WORKDIR;
    try {
      cleanupTaskScreenshots(wd, req.params.id, task.task_number);
    } catch (e) {
      log.warn('[screenshot-cleanup] PUT transition cleanup error', { error: e.message });
    }
  }

  res.json(updated);
});
app.delete('/api/tasks/:id', (req, res) => {
  const tid = req.params.id;
  // Abort running subprocess if this task is in progress
  const taskAbort = runningTaskAborts.get(tid);
  if (taskAbort) {
    stoppingTasks.add(tid);
    try { taskAbort.abort(); } catch {}
  }
  // Kill worker process directly if PID is known
  const task = stmts.getTask.get(tid);
  if (task?.worker_pid) killByPid(task.worker_pid);
  stmts.deleteTask.run(tid);
  res.json({ ok: true });
});

// ─── Task 16: Extended REST API for external card creation ───────────────────
// POST /api/tasks/bulk-move — move all tasks from one status to another
app.post('/api/tasks/bulk-move', express.json(), (req, res) => {
  const { from_status, to_status, workdir } = req.body;
  if (!from_status || !to_status) return res.status(400).json({ error: 'from_status and to_status required' });
  if (from_status === to_status) return res.status(400).json({ error: 'from_status and to_status must differ' });
  const wd = workdir || null;
  let result;
  if (wd) {
    result = db.prepare(`UPDATE tasks SET status=?, updated_at=datetime('now') WHERE status=? AND workdir=?`).run(to_status, from_status, wd);
  } else {
    result = db.prepare(`UPDATE tasks SET status=?, updated_at=datetime('now') WHERE status=?`).run(to_status, from_status);
  }
  log.info(`[bulk-move] Moved ${result.changes} tasks from ${from_status} → ${to_status}${wd ? ` (workdir=${wd})` : ''}`);
  // Clean up screenshots when bulk-moving to done/archived
  if (['done', 'archived'].includes(to_status) && wd) {
    try {
      const screenshotDirs = [path.join(wd, 'test-screenshots'), path.join(wd, 'docs', 'screenshots')];
      let deleted = 0;
      for (const dir of screenshotDirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
        for (const f of files) { fs.unlinkSync(path.join(dir, f)); deleted++; }
      }
      if (deleted > 0) log.info(`[bulk-move] Cleaned up ${deleted} screenshots in ${wd}`);
    } catch (e) { log.warn('[bulk-move] screenshot cleanup error', { error: e.message }); }
  }
  // Trigger queue if moving to todo
  if (to_status === 'todo') setImmediate(processQueue);
  wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
  res.json({ moved: result.changes });
});

// PATCH /api/tasks/:id — partial update (only provide fields you want to change)
app.patch('/api/tasks/:id', express.json(), (req, res) => {
  const task = stmts.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const allowed = ['title', 'description', 'notes', 'status', 'sort_order', 'model', 'mode', 'agent_mode', 'max_turns', 'scheduled_at', 'recurrence', 'recurrence_end_at', 'dep_group', 'depends_on', 'chain_id'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  // Handle 'column' as alias for 'status' (friendlier API)
  if (req.body.column !== undefined) updates.status = req.body.column;
  // Normalize 'open' → 'backlog' on status updates too
  if (updates.status === 'open') updates.status = 'backlog';
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields provided' });
  const merged = { ...task, ...updates };
  // Stop task if being moved away from in_progress
  if (task.status === 'in_progress' && merged.status && merged.status !== 'in_progress') {
    const ctrl = runningTaskAborts.get(req.params.id);
    if (ctrl) { stoppingTasks.add(req.params.id); ctrl.abort(); }
    else if (task.worker_pid) { stoppingTasks.add(req.params.id); killByPid(task.worker_pid); }
  }
  stmts.updateTask.run(
    String(merged.title).substring(0,200), String(merged.description||'').substring(0,2000),
    String(merged.notes||'').substring(0,2000),
    sqlVal(merged.status), sqlVal(merged.sort_order), sqlVal(merged.session_id)||null, sqlVal(merged.workdir)||null,
    sqlVal(merged.model), sqlVal(merged.mode), sqlVal(merged.agent_mode), sqlVal(merged.max_turns), sqlVal(merged.attachments)||null,
    sqlVal(merged.depends_on)||null, sqlVal(merged.chain_id)||null, sqlVal(merged.source_session_id)||null,
    sqlVal(merged.scheduled_at)||null, sqlVal(merged.recurrence)||null, sqlVal(merged.recurrence_end_at)||null,
    sqlVal(merged.dep_group)||null,
    req.params.id
  );
  if (merged.status === 'todo') setImmediate(processQueue);
  // ── BMAD reverse sync: update sprint-status.yaml when Kanban status changes ──
  if (updates.status && merged.notes) {
    const bmadMatch = (merged.notes || '').match(/\[bmad:([^\]]+)\]/);
    if (bmadMatch) {
      const REVERSE_MAP = { 'backlog':'backlog','todo':'ready-for-dev','in_progress':'in-progress','done':'done','done_review':'done','archived':'done','cancelled':'backlog' };
      const bmadStatus = REVERSE_MAP[merged.status];
      if (bmadStatus) {
        const wd = merged.workdir || WORKDIR;
        const spFile = findSprintStatusFile(wd);
        if (spFile) {
          try {
            let content = fs.readFileSync(spFile, 'utf-8');
            const re = new RegExp(`(\\s+${bmadMatch[1].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}:\\s*)\\S+`, 'm');
            if (re.test(content)) {
              content = content.replace(re, `$1${bmadStatus}`);
              fs.writeFileSync(spFile, content, 'utf-8');
              log.info('BMAD reverse sync', { story: bmadMatch[1], status: bmadStatus });
            }
          } catch (e) { log.warn('BMAD reverse sync failed', { error: e.message }); }
        }
      }
    }
  }
  // ── Screenshot cleanup on status transitions ──
  // Clean up task screenshots when moving to done or archived (manual transitions)
  if (updates.status && ['done', 'archived'].includes(updates.status) && !['done', 'archived'].includes(task.status)) {
    const wd = merged.workdir || WORKDIR;
    try {
      cleanupTaskScreenshots(wd, req.params.id, task.task_number);
    } catch (e) {
      log.warn('[screenshot-cleanup] manual transition cleanup error', { error: e.message });
    }
  }

  res.json(stmts.getTask.get(req.params.id));
});

// GET /api/tasks/:id — get a single task by ID
app.get('/api/tasks/:id', (req, res) => {
  const task = stmts.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  res.json({ ...task, is_active: task.session_id ? activeTasks.has(task.session_id) : false });
});

// GET /api/tasks/:id/result — get task result (assistant messages from linked session)
app.get('/api/tasks/:id/result', (req, res) => {
  const task = stmts.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!task.session_id) return res.json({ task, messages: [], summary: null });
  const messages = db.prepare(`SELECT role, type, content, tool_name, created_at FROM messages WHERE session_id=? ORDER BY id ASC`).all(task.session_id);
  const assistantText = messages.filter(m => m.role === 'assistant' && m.type === 'text').map(m => m.content).join('\n\n');
  res.json({
    task,
    messages,
    summary: assistantText ? assistantText.substring(0, 2000) : null,
    status: task.status,
    failure_reason: task.failure_reason || null,
  });
});

// POST /api/tasks/:id/run — trigger a task to start immediately (set status to 'todo')
// POST /api/tasks/:id/restart — kill worker if running, reset to queue with fresh state.
// Use this after changing BMAD settings (model/effort) to re-run a task with new params.
// Preserves: title, description, attachments, retry_count (bumped).
// Clears: session_id, worker_pid, failure_reason.
app.post('/api/tasks/:id/restart', (req, res) => {
  const task = stmts.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  // Kill any running worker for this task
  let killed = false;
  restartingTasks.add(req.params.id); // signal worker exit handler: DO NOT set status=cancelled
  const ctrl = runningTaskAborts.get(req.params.id);
  if (ctrl) {
    stoppingTasks.add(req.params.id);
    ctrl.abort();
    killed = true;
  }
  if (task.worker_pid) {
    try { killByPid(task.worker_pid); killed = true; } catch {}
  }

  // Reset task state — put back into queue for re-dispatch
  db.prepare(`UPDATE tasks SET 
      status='bmad_workflow', 
      session_id=NULL, 
      worker_pid=NULL, 
      failure_reason=NULL, 
      task_retry_count=COALESCE(task_retry_count,0)+1, 
      updated_at=datetime('now') 
    WHERE id=?`).run(req.params.id);

  // Allow stoppingTasks to clear naturally (worker loop checks it), but remove
  // from runningTaskAborts immediately so queue can re-dispatch
  runningTaskAborts.delete(req.params.id);

  wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
  setImmediate(processQueue);

  const updated = stmts.getTask.get(req.params.id);
  log.info(`[restart] task ${req.params.id} ("${task.title}") reset to bmad_workflow (killed=${killed})`);
  res.json({ ok: true, killed, task: updated });
});

// POST /api/tasks/:id/cancel — kill worker if running, mark cancelled.
// Artifacts (story file, screenshots, commits) are preserved.
app.post('/api/tasks/:id/cancel', (req, res) => {
  const task = stmts.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (task.status === 'cancelled') return res.json({ ok: true, task, already: true });

  let killed = false;
  const ctrl = runningTaskAborts.get(req.params.id);
  if (ctrl) {
    stoppingTasks.add(req.params.id);
    ctrl.abort();
    killed = true;
  }
  if (task.worker_pid) {
    try { killByPid(task.worker_pid); killed = true; } catch {}
  }

  db.prepare(`UPDATE tasks SET 
      status='cancelled', 
      worker_pid=NULL, 
      failure_reason='cancelled_by_user', 
      updated_at=datetime('now') 
    WHERE id=?`).run(req.params.id);

  runningTaskAborts.delete(req.params.id);

  wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });

  const updated = stmts.getTask.get(req.params.id);
  log.info(`[cancel] task ${req.params.id} ("${task.title}") cancelled (killed=${killed})`);
  res.json({ ok: true, killed, task: updated });
});

app.post('/api/tasks/:id/run', (req, res) => {
  const task = stmts.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (task.status === 'in_progress') return res.status(409).json({ error: 'Task already running' });
  db.prepare(`UPDATE tasks SET status='bmad_workflow', failure_reason=NULL, updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  setImmediate(processQueue);
  res.json({ ok: true, task: stmts.getTask.get(req.params.id) });
});

// ─── Task Dispatch (Chat → Kanban chain) ─────────────────────────────────
app.post('/api/tasks/dispatch', (req, res) => {
  const {
    plan_description,
    tasks: planTasks,
    workdir,
    model = 'sonnet',
    source_session_id,
    claude_session_id,
  } = req.body;

  if (!planTasks?.length) return res.status(400).json({ error: 'No tasks provided' });
  if (planTasks.length > 10) return res.status(400).json({ error: 'Max 10 tasks per dispatch' });

  // Circular dependency detection (DFS)
  // Validate dependency references exist + detect cycles
  const validIds = new Set(planTasks.map(t => t.id));
  for (const t of planTasks) {
    for (const dep of (t.depends_on || [])) {
      if (!validIds.has(dep)) return res.status(400).json({ error: `Unknown dependency: ${dep}` });
    }
  }
  const adj = {};
  for (const t of planTasks) adj[t.id] = t.depends_on || [];
  const _visited = new Set(), _stack = new Set();
  function _hasCycle(node) {
    if (_stack.has(node)) return true;
    if (_visited.has(node)) return false;
    _visited.add(node); _stack.add(node);
    for (const dep of (adj[node] || [])) { if (_hasCycle(dep)) return true; }
    _stack.delete(node);
    return false;
  }
  if (planTasks.some(t => _hasCycle(t.id))) {
    return res.status(400).json({ error: 'Circular dependency detected in plan' });
  }

  const chainId = genId();

  // Inherit MCP + skills from source session
  const source = source_session_id ? stmts.getSession.get(source_session_id) : null;
  const chainSessionId = genId();
  stmts.createSession.run(
    chainSessionId,
    (plan_description || 'Task chain').substring(0, 200),
    source?.active_mcp || '[]',
    source?.active_skills || '[]',
    'auto', 'single', sqlVal(model) || 'sonnet', 'cli',
    sqlVal(workdir) || null
  );

  // Chain gets its OWN Claude session — first task starts fresh,
  // subsequent tasks --resume from the chain's session (NOT the source chat's).

  // First pass: assign real IDs to all tasks (handles forward references in depends_on)
  const idMap = {};
  for (const t of planTasks) idMap[t.id] = genId();
  const createdTasks = [];

  db.transaction(() => {
    for (let i = 0; i < planTasks.length; i++) {
      const t = planTasks[i];
      const taskId = idMap[t.id];
      const realDeps = (t.depends_on || []).map(d => idMap[d]).filter(Boolean);

      const _tn3 = stmts.nextTaskNumber.get(sqlVal(workdir) || '').next_num;
      stmts.createTask.run(
        taskId,
        (t.title || t.role || 'Subtask').substring(0, 200),
        (t.description || t.task || '').substring(0, 2000),
        '',            // notes
        'todo',
        i,             // sort_order preserves plan ordering
        chainSessionId,
        sqlVal(workdir) || null,
        sqlVal(model) || 'sonnet',
        'auto', 'single', 30,
        null,          // attachments
        realDeps.length ? JSON.stringify(realDeps) : null,
        chainId,
        source_session_id || null,
        null, null, null, _tn3, null  // scheduled_at, recurrence, recurrence_end_at, task_number, dep_group
      );
      createdTasks.push(stmts.getTask.get(taskId));
    }
  })();

  setImmediate(processQueue);
  log.info('Tasks dispatched', { chainId, count: createdTasks.length, workdir });
  res.json({ chain_id: chainId, session_id: chainSessionId, tasks: createdTasks });
});

// ─── Tasks 17-19: OpenClaw Bridge Endpoints ──────────────────────────────────
// GET /api/openclaw/status — check if OpenClaw bridge is configured
app.get('/api/openclaw/status', async (req, res) => {
  const configured = openclawBridge.isConfigured();
  if (!configured) return res.json({ configured: false, message: 'Set OPENCLAW_API_URL and OPENCLAW_API_KEY in .env to enable' });
  const health = await openclawBridge.healthCheck();
  res.json({ configured, ...health });
});
// GET /api/openclaw/cron-templates — Task 19: return cron integration templates
app.get('/api/openclaw/cron-templates', (req, res) => {
  res.json(openclawBridge.CRON_TEMPLATES);
});

// ─── Task 8: BMAD Phase Templates ────────────────────────────────────────────
// Returns the content of a BMAD template by name.
// Templates stored at /home/ubuntu/.openclaw/workspace/bmad-openclaw/templates/
const BMAD_TEMPLATES_DIR = path.join(os.homedir(), '.openclaw', 'workspace', 'bmad-openclaw', 'templates');
const BMAD_TEMPLATE_NAMES = {
  'brainstorming-session': 'brainstorming-session.md',
  'prd': 'prd.md',
  'tech-spec': 'tech-spec.md',
  'readiness-report': 'readiness-report.md',
  'story': 'story.md',
  'epics': 'epics.md',
  'architecture-decision': 'architecture-decision.md',
  'ux-design': 'ux-design.md',
};
app.get('/api/bmad/templates/:name', (req, res) => {
  const name = req.params.name;
  const filename = BMAD_TEMPLATE_NAMES[name];
  if (!filename) return res.status(404).json({ error: 'Template not found' });
  try {
    const filePath = path.join(BMAD_TEMPLATES_DIR, filename);
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ name, filename, content });
  } catch (err) {
    res.status(404).json({ error: `Template file not readable: ${err.message}` });
  }
});
app.get('/api/bmad/templates', (req, res) => {
  const templates = Object.entries(BMAD_TEMPLATE_NAMES).map(([name, filename]) => {
    const filePath = path.join(BMAD_TEMPLATES_DIR, filename);
    const exists = fs.existsSync(filePath);
    return { name, filename, available: exists };
  });
  res.json(templates);
});

// ─── BMAD Sprint Status Integration ───────────────────────────────────────────
// Finds and parses sprint-status.yaml from a project's _bmad-output directory.
// Maps BMAD statuses → Kanban statuses and syncs tasks bidirectionally.

const BMAD_STATUS_MAP = {
  'backlog':       'backlog',
  'ready-for-dev': 'todo',
  'in-progress':   'in_progress',
  'review':        'in_progress',
  'needs-revision':'in_progress',
  'done':          'done',
  'optional':      'backlog',
};

function findSprintStatusFile(workdir) {
  if (!workdir) return null;
  // Common locations for sprint-status.yaml relative to the project workdir
  const candidates = [
    path.join(workdir, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
    path.join(workdir, '_bmad-output', 'sprint-status.yaml'),
    path.join(workdir, 'sprint-status.yaml'),
    path.join(workdir, '_bmad', 'sprint-status.yaml'),
  ];
  // Also check the openclaw workspace for a project with the same base name
  const baseName = path.basename(workdir);
  const homeDir = os.homedir();
  const ocWorkspace = path.join(homeDir, '.openclaw', 'workspace');
  // Try exact match and common variations (e.g., golf_casino → golf_casino_app)
  const variations = [baseName, baseName + '_app', baseName.replace(/-/g, '_'), baseName.replace(/_/g, '-')];
  for (const v of variations) {
    candidates.push(path.join(ocWorkspace, v, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'));
    candidates.push(path.join(ocWorkspace, v, '_bmad-output', 'sprint-status.yaml'));
    candidates.push(path.join(ocWorkspace, v, 'sprint-status.yaml'));
  }
  // No shallow scan — only return files that belong to this project
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function parseSprintStatus(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const doc = yaml.load(raw);
    if (!doc || !doc.development_status) return null;

    const meta = {
      project: doc.project || '',
      project_key: doc.project_key || '',
      generated: doc.generated || '',
      story_location: doc.story_location || '',
    };

    // Parse development_status into structured epics and stories
    const epics = [];
    let currentEpic = null;

    // Read the raw file for comments (epic titles)
    const lines = raw.split('\n');
    const epicComments = {};
    for (const line of lines) {
      const cm = line.match(/^\s*#\s*Epic\s+(\d+):\s*(.+)/i);
      if (cm) epicComments[`epic-${cm[1]}`] = cm[2].trim();
    }

    for (const [key, status] of Object.entries(doc.development_status)) {
      const statusStr = String(status).split('#')[0].trim(); // strip inline comments
      if (key.match(/^epic-\d+$/)) {
        currentEpic = {
          id: key,
          title: epicComments[key] || key,
          status: statusStr,
          kanbanStatus: BMAD_STATUS_MAP[statusStr] || 'backlog',
          stories: [],
        };
        epics.push(currentEpic);
      } else if (key.match(/^epic-\d+-retrospective$/)) {
        if (currentEpic) currentEpic.retrospective = statusStr;
      } else if (currentEpic && !key.startsWith('epic-')) {
        // It's a story
        const storyComment = raw.split('\n').find(l => l.includes(key + ':'));
        const inlineComment = storyComment ? (storyComment.split('#').slice(1).join('#').trim() || '') : '';
        currentEpic.stories.push({
          id: key,
          title: key.replace(/^\d+-\d+-/, '').replace(/-/g, ' '),
          status: statusStr,
          kanbanStatus: BMAD_STATUS_MAP[statusStr] || 'backlog',
          notes: inlineComment,
        });
      }
    }

    return { meta, epics, filePath };
  } catch (e) {
    log.error('Failed to parse sprint-status.yaml', { error: e.message, filePath });
    return null;
  }
}

// POST /api/bmad/upload — upload documents into BMAD folders
const bmadUpload = multer({ dest: path.join(os.tmpdir(), 'bmad-upload'), limits: { fileSize: 50 * 1024 * 1024 } });
app.post('/api/bmad/upload', bmadUpload.array('files', 20), (req, res) => {
  const { workdir, folder } = req.body;
  if (!workdir || !folder) return res.status(400).json({ error: 'workdir and folder required' });
  // Validate folder is within allowed BMAD paths
  const allowedFolders = ['docs', '_bmad-output/planning-artifacts', '_bmad-output/implementation-artifacts', '_bmad'];
  if (!allowedFolders.includes(folder)) return res.status(400).json({ error: 'Invalid target folder' });
  const targetDir = path.join(workdir, folder);
  try {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    let count = 0;
    for (const file of (req.files || [])) {
      const dest = path.join(targetDir, file.originalname);
      fs.renameSync(file.path, dest);
      count++;
    }
    res.json({ ok: true, count, folder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bmad/docs?workdir=... — list BMAD output documents
app.get('/api/bmad/docs', (req, res) => {
  const workdir = req.query.workdir || WORKDIR;
  const docs = [];
  const baseName = path.basename(workdir);
  const homeDir = os.homedir();
  const ocWorkspace = path.join(homeDir, '.openclaw', 'workspace');
  const ALLOWED_EXTS = new Set(['.md', '.yaml', '.yml', '.txt', '.json', '.csv', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp']);

  function scanDir(dir, category) {
    try {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const fp = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fp, category);
        } else if (entry.isFile() && ALLOWED_EXTS.has(path.extname(entry.name).toLowerCase())) {
          const stat = fs.statSync(fp);
          docs.push({
            name: entry.name,
            category,
            path: fp,
            relativePath: path.relative(workdir, fp),
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        }
      }
    } catch {}
  }

  scanDir(path.join(workdir, '_bmad-output'), 'BMAD Output');
  scanDir(path.join(workdir, 'docs'), 'Project Docs');
  scanDir(path.join(workdir, 'tests'), 'Tests');
  scanDir(path.join(workdir, 'test-screenshots'), 'Screenshots');
  scanDir(path.join(workdir, 'test-results'), 'Test Results');

  const variations = [baseName, baseName + '_app', baseName.replace(/-/g, '_'), baseName.replace(/_/g, '-')];
  for (const v of variations) {
    const ocDir = path.join(ocWorkspace, v, '_bmad-output');
    if (fs.existsSync(ocDir)) {
      scanDir(ocDir, 'BMAD Output');
      break;
    }
  }

  const hasBmad = fs.existsSync(path.join(workdir, '_bmad')) || fs.existsSync(path.join(workdir, '_bmad-output')) || fs.existsSync(path.join(workdir, 'docs')) || fs.existsSync(path.join(workdir, 'tests')) || fs.existsSync(path.join(workdir, 'test-screenshots'));
  res.json({ docs, workdir, hasBmad });
});


// GET /api/bmad/doc?path=... — read a single BMAD document
app.get('/api/bmad/doc', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const normalized = path.resolve(filePath);
  if (!normalized.includes('_bmad-output') && !normalized.includes('/docs/') && !normalized.includes('_bmad/') && !normalized.includes('.openclaw/workspace') && !normalized.includes('/tests/') && !normalized.includes('/test-screenshots/') && !normalized.includes('/test-results/')) {
    return res.status(403).json({ error: 'Access denied — only BMAD output files allowed' });
  }
  try {
    const ext = path.extname(normalized).toLowerCase();
    const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']);
    if (IMAGE_EXTS.has(ext)) {
      // Return image as base64 data URL
      const buf = fs.readFileSync(normalized);
      const mime = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.svg':'image/svg+xml', '.webp':'image/webp', '.bmp':'image/bmp', '.ico':'image/x-icon' }[ext] || 'application/octet-stream';
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      res.json({ content: dataUrl, name: path.basename(normalized), ext, size: buf.length, isImage: true });
    } else if (['.pdf', '.doc', '.docx', '.xls', '.xlsx'].includes(ext)) {
      // Binary docs — return metadata only, use download endpoint
      const stat = fs.statSync(normalized);
      res.json({ content: null, name: path.basename(normalized), ext, size: stat.size, isBinary: true });
    } else {
      const content = fs.readFileSync(normalized, 'utf-8');
      res.json({ content, name: path.basename(normalized), ext, size: content.length });
    }
  } catch (e) {
    res.status(404).json({ error: 'File not found' });
  }
});

// POST /api/bmad/doc — create or update a document
app.post('/api/bmad/doc', (req, res) => {
  const { filePath, content } = req.body;
  if (!filePath || content === undefined) return res.status(400).json({ error: 'filePath and content required' });
  const normalized = path.resolve(filePath);
  // Security: only allow writing to docs/, _bmad-output/, or _bmad/ within a project
  if (!normalized.includes('/docs/') && !normalized.includes('_bmad-output') && !normalized.includes('_bmad/') && !normalized.includes('/tests/') && !normalized.includes('/test-screenshots/') && !normalized.includes('/test-results/') && !normalized.includes('.openclaw/workspace')) {
    return res.status(403).json({ error: 'Access denied — can only write to docs/ or _bmad-output/' });
  }
  try {
    const dir = path.dirname(normalized);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(normalized, content, 'utf-8');
    res.json({ ok: true, path: normalized, size: content.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/bmad/doc — delete a document
app.delete('/api/bmad/doc', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const normalized = path.resolve(filePath);
  if (!normalized.includes('/docs/') && !normalized.includes('_bmad-output') && !normalized.includes('/tests/') && !normalized.includes('/test-screenshots/') && !normalized.includes('/test-results/') && !normalized.includes('.openclaw/workspace')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    if (fs.existsSync(normalized)) fs.unlinkSync(normalized);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bmad/doc/download?path=... — download a document file
app.get('/api/bmad/doc/download', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const normalized = path.resolve(filePath);
  if (!fs.existsSync(normalized)) return res.status(404).json({ error: 'File not found' });
  const filename = path.basename(normalized);
  res.download(normalized, filename);
});

// ─── Document Sharing ────────────────────────────────────────────────────────

// POST /api/docs/share — create a share link for a document
app.post('/api/docs/share', express.json(), (req, res) => {
  const { projectId, filePath, expiresIn } = req.body;
  if (!projectId || !filePath) return res.status(400).json({ error: 'projectId and filePath required' });
  // Resolve file path relative to project workdir
  const fullPath = path.resolve(projectId, filePath);
  // Security: must be within the project workdir
  if (!fullPath.startsWith(path.resolve(projectId))) {
    return res.status(403).json({ error: 'Access denied — path traversal detected' });
  }
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
  // Check if a share already exists for this file+project (reuse/update it)
  const existing = db.prepare('SELECT * FROM shared_docs WHERE project_id=? AND file_path=?').get(projectId, filePath);
  let expiresAt = null;
  if (expiresIn) expiresAt = new Date(Date.now() + expiresIn * 3600 * 1000).toISOString();
  if (existing) {
    db.prepare('UPDATE shared_docs SET expires_at=? WHERE id=?').run(expiresAt, existing.id);
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return res.json({ url: `${proto}://${host}/shared/${existing.id}`, token: existing.id, expires_at: expiresAt });
  }
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO shared_docs (id, project_id, file_path, expires_at, created_by) VALUES (?,?,?,?,?)').run(token, projectId, filePath, expiresAt, 'user');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  res.json({ url: `${proto}://${host}/shared/${token}`, token, expires_at: expiresAt });
});

// DELETE /api/docs/share/:token — revoke a share link
app.delete('/api/docs/share/:token', (req, res) => {
  const { token } = req.params;
  const result = db.prepare('DELETE FROM shared_docs WHERE id=?').run(token);
  if (result.changes === 0) return res.status(404).json({ error: 'Share not found' });
  res.json({ ok: true });
});

// GET /api/docs/shares?projectId=X — list active shares for a project
app.get('/api/docs/shares', (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });
  const now = new Date().toISOString();
  const shares = db.prepare(`SELECT * FROM shared_docs WHERE project_id=? AND (expires_at IS NULL OR expires_at > ?)`).all(projectId, now);
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  res.json(shares.map(s => ({ ...s, url: `${proto}://${host}/shared/${s.id}` })));
});

// GET /api/bmad/sprint-status?workdir=... — parse and return sprint status
app.get('/api/bmad/sprint-status', (req, res) => {
  const workdir = req.query.workdir || WORKDIR;
  const filePath = findSprintStatusFile(workdir);
  if (!filePath) return res.json({ found: false, workdir });
  const parsed = parseSprintStatus(filePath);
  if (!parsed) return res.status(500).json({ error: 'Failed to parse sprint-status.yaml' });
  res.json({ found: true, ...parsed });
});

// POST /api/bmad/sprint-sync — sync sprint stories → Kanban cards
app.post('/api/bmad/sprint-sync', express.json(), (req, res) => {
  const workdir = req.body.workdir || WORKDIR;
  const filter = req.body.filter || 'all'; // 'all' | 'active' | 'backlog'
  const filePath = findSprintStatusFile(workdir);
  if (!filePath) return res.status(404).json({ error: 'No sprint-status.yaml found', workdir });
  const parsed = parseSprintStatus(filePath);
  if (!parsed) return res.status(500).json({ error: 'Failed to parse sprint-status.yaml' });

  // Get existing tasks tagged with bmad_sprint source
  const existingTasks = db.prepare(`SELECT * FROM tasks WHERE workdir=?`).all(workdir);
  const existingByBmadId = {};
  for (const t of existingTasks) {
    // Check notes for [bmad:story-id] tag
    const m = (t.notes || '').match(/\[bmad:([^\]]+)\]/);
    if (m) existingByBmadId[m[1]] = t;
  }

  const created = [], updated = [], skipped = [];

  for (const epic of parsed.epics) {
    for (const story of epic.stories) {
      // Apply filter
      if (filter === 'active' && (story.status === 'backlog' || story.status === 'done')) continue;
      if (filter === 'backlog' && story.status !== 'backlog') continue;

      const bmadTag = `[bmad:${story.id}]`;
      const existing = existingByBmadId[story.id];

      if (existing) {
        // Update status if BMAD status changed
        if (existing.status !== story.kanbanStatus) {
          stmts.patchTaskStatus.run(story.kanbanStatus, existing.sort_order, existing.id);
          updated.push({ id: story.id, from: existing.status, to: story.kanbanStatus });
        } else {
          skipped.push(story.id);
        }
      } else {
        // Create new Kanban card
        const id = crypto.randomUUID();
        const title = `[${epic.id}] ${story.title}`;
        const description = story.notes
          ? `BMAD Story: ${story.id}\nEpic: ${epic.title}\n\n${story.notes}\n\nImplement this story following the acceptance criteria in the story file.`
          : `BMAD Story: ${story.id}\nEpic: ${epic.title}\n\nImplement this story following the acceptance criteria in the story file.`;
        const notes = `${bmadTag} Sprint: ${parsed.meta.project}`;
        const sortOrder = epic.stories.indexOf(story);

        const _tn4 = stmts.nextTaskNumber.get(workdir || '').next_num;
        stmts.createTask.run(
          id, title, description, notes,
          story.kanbanStatus, sortOrder, null, workdir,
          null, null, null, null, null, null, null, null, null, null, null, _tn4, null
        );
        created.push({ id: story.id, kanbanId: id, status: story.kanbanStatus });
      }
    }
  }

  // Broadcast refresh
  // Notify connected clients
  wss.clients.forEach(ws => { try { ws.send(JSON.stringify({ type: 'tasks-changed' })); } catch {} });
  res.json({ synced: true, created: created.length, updated: updated.length, skipped: skipped.length, details: { created, updated, skipped } });
});

// POST /api/bmad/sprint-status/update — update a story status back to sprint-status.yaml
app.post('/api/bmad/sprint-status/update', express.json(), (req, res) => {
  const { workdir, storyId, newStatus } = req.body;
  const dir = workdir || WORKDIR;
  const filePath = findSprintStatusFile(dir);
  if (!filePath) return res.status(404).json({ error: 'No sprint-status.yaml found' });
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    // Find the line with the story ID and update its status
    const regex = new RegExp(`(\\s+${storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*)\\S+`, 'm');
    if (!regex.test(content)) return res.status(404).json({ error: `Story ${storyId} not found in sprint-status.yaml` });
    content = content.replace(regex, `$1${newStatus}`);
    fs.writeFileSync(filePath, content, 'utf-8');
    res.json({ updated: true, storyId, newStatus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sessions
app.get('/api/sessions', (req,res) => {
  const { workdir } = req.query;
  res.json(workdir ? stmts.getSessionsByWorkdir.all(workdir) : stmts.getSessions.all());
});
app.post('/api/sessions', (req, res) => {
  const { title = i18nSession(), workdir = null, model = 'sonnet', mode = 'auto', agentMode = 'single', engine = null } = req.body || {};
  const id = genId();
  stmts.createSession.run(id, String(title).substring(0, 200), '[]', '[]', sqlVal(mode), sqlVal(agentMode), sqlVal(model), sqlVal(engine), sqlVal(workdir) || null);
  res.json(stmts.getSession.get(id));
});
app.get('/api/sessions/interrupted', (req, res) => { res.json(stmts.getInterrupted.all()); });
app.post('/api/sessions/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'no ids' });
  const update = db.prepare(`UPDATE sessions SET sort_order=? WHERE id=?`);
  const tx = db.transaction(() => { ids.forEach((id, i) => update.run(i, String(id))); });
  tx();
  res.json({ ok: true });
});
app.get('/api/sessions/:id', (req,res) => {
  const s = stmts.getSession.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  // Lite: strip tool content — frontend only needs tool_name + agent_id for badge counts
  s.messages = stmts.getMsgsLite.all(req.params.id);
  // Include running-task flag so client can show spinner immediately on load
  s.hasRunningTask = !!stmts.hasRunningTask.get(req.params.id);
  // True when a direct-chat streaming session is alive in memory (not a Kanban task)
  s.isChatRunning = activeTasks.has(req.params.id);
  // Include chain tasks dispatched FROM this session (for chain progress widget restoration)
  const chainTasks = stmts.getChainTasks.all(req.params.id);
  if (chainTasks.length) {
    // Group by chain_id (a session could have dispatched multiple chains)
    const chains = {};
    for (const t of chainTasks) {
      if (!t.chain_id) continue;
      if (!chains[t.chain_id]) chains[t.chain_id] = [];
      chains[t.chain_id].push({ id: t.id, title: t.title, status: t.status, depends_on: t.depends_on });
    }
    s.chains = chains;
  }
  res.json(s);
});
app.put('/api/sessions/:id', (req, res) => {
  const { title, active_mcp, active_skills } = req.body;
  if (title) stmts.updateTitle.run(title, req.params.id);
  if (active_mcp !== undefined || active_skills !== undefined) {
    db.prepare(`UPDATE sessions SET active_mcp=COALESCE(?,active_mcp),active_skills=COALESCE(?,active_skills),updated_at=datetime('now') WHERE id=?`)
      .run(
        active_mcp !== undefined ? JSON.stringify(active_mcp) : null,
        active_skills !== undefined ? JSON.stringify(active_skills) : null,
        req.params.id
      );
  }
  res.json({ok:true});
});
app.get('/api/sessions/:id/tasks-count', (req,res) => { res.json(stmts.countTasksBySession.get(req.params.id)); });
app.delete('/api/sessions/:id', (req,res) => {
  const sid = req.params.id;
  // Abort any running Claude subprocess for this session before deleting
  const active = activeTasks.get(sid);
  if (active) {
    try { active.abortController.abort(); } catch {}
    if (active.cleanupTimer) clearTimeout(active.cleanupTimer);
    activeTasks.delete(sid);
  }
  chatBuffers.delete(sid);
  stmts.deleteTasksBySession.run(sid);
  stmts.deleteSession.run(sid);
  sessionQueues.delete(sid);
  res.json({ok:true});
});
app.post('/api/sessions/bulk-delete', (req,res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'no ids' });
  // Abort running subprocesses before deleting
  for (const id of ids) {
    const active = activeTasks.get(id);
    if (active) {
      try { active.abortController.abort(); } catch {}
      if (active.cleanupTimer) clearTimeout(active.cleanupTimer);
      activeTasks.delete(id);
    }
    chatBuffers.delete(id);
  }
  const del = db.transaction(() => { for (const id of ids) { stmts.deleteTasksBySession.run(id); stmts.deleteSession.run(id); sessionQueues.delete(id); } });
  del();
  res.json({ ok: true, deleted: ids.length });
});
app.post('/api/sessions/:id/open-terminal', (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  const _cleanSid = sanitizeSessionId(session?.claude_session_id);
  if (!_cleanSid) return res.status(400).json({ error: 'No Claude session ID' });
  const safeSid = _cleanSid.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeSid) return res.status(400).json({ error: 'Invalid session ID' });
  const workdir = session.workdir || WORKDIR;
  const platform = process.platform;
  let fullCmd, ok = false;
  try {
    if (platform === 'win32') {
      fullCmd = `cd /d "${workdir}" && set CLAUDECODE= && claude --resume ${safeSid}`;
      // Empty title "" required: without it cmd.exe treats first quoted arg as window title
      execSync(`start "" cmd /k "${fullCmd.replace(/"/g, '\\"')}"`, { shell: true });
      ok = true;
    } else if (platform === 'darwin') {
      const safeWorkdir = workdir.replace(/'/g, "'\\''");
      fullCmd = `cd '${safeWorkdir}' && unset CLAUDECODE; claude --resume ${safeSid}`;
      execSync(`osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "${fullCmd.replace(/"/g, '\\"')}"'`);
      ok = true;
    } else {
      // Linux: try common terminal emulators using spawn+detach (non-blocking)
      // execSync would kill xterm after the timeout; spawnProc+unref lets it live.
      const safeWorkdir = workdir.replace(/'/g, "'\\''");
      fullCmd = `cd '${safeWorkdir}' && unset CLAUDECODE; claude --resume ${safeSid}`;
      const termCandidates = [
        ['gnome-terminal', ['--', 'bash', '-c', `${fullCmd}; exec bash`]],
        ['xterm',          ['-e', 'bash', '-c', `${fullCmd}; exec bash`]],
        ['konsole',        ['-e', 'bash', '-c', fullCmd]],
      ];
      for (const [cmd, args] of termCandidates) {
        try {
          const p = spawnProc(cmd, args, { detached: true, stdio: 'ignore' });
          p.unref();
          ok = true; break;
        } catch {}
      }
    }
  } catch {}
  res.json({ ok, command: fullCmd });
});

// Paginated messages — GET /api/sessions/:id/messages?limit=50&offset=0
app.get('/api/sessions/:id/messages', (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const MAX_LIMIT = 200;
  const DEFAULT_LIMIT = 50;

  const rawLimit  = parseInt(req.query.limit,  10);
  const rawOffset = parseInt(req.query.offset, 10);

  const limit  = Number.isFinite(rawLimit)  && rawLimit  > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  const { total } = stmts.countMsgs.get(req.params.id);
  const messages  = stmts.getMsgsPaginated.all(req.params.id, limit, offset);

  res.json({
    messages,
    total,
    limit,
    offset,
    hasMore: offset + messages.length < total,
  });
});

// Config
app.get('/api/config', (_,res) => {
  _mergedConfigCache = null; // always fresh for the config UI — disk may have changed externally
  const c = loadMergedConfig();
  // Auto-discover skills from global dir that are not already in config
  if (fs.existsSync(GLOBAL_SKILLS_DIR)) {
    for (const f of fs.readdirSync(GLOBAL_SKILLS_DIR).filter(f => f.endsWith('.md'))) {
      const id = path.parse(f).name;
      if (!c.skills[id]) c.skills[id] = { label:`🌐 ${id}`, description:'Global skill (~/.claude/skills/)', file:path.join(GLOBAL_SKILLS_DIR, f), global:true };
    }
  }
  // Auto-discover skills from local dir (APP_DIR/skills/) that are not already in config
  if (fs.existsSync(SKILLS_DIR)) {
    for (const f of fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'))) {
      const id = path.parse(f).name;
      if (!c.skills[id]) {
        const meta = BUNDLED_SKILL_META[id] || {};
        c.skills[id] = { label: meta.label || `📄 ${id}`, description:'Local skill', file:`skills/${f}`, ...(meta.category ? { category:meta.category } : {}) };
      }
    }
  }
  // Auto-discover bundled skills (__dirname/skills/) when running via npx (APP_DIR != __dirname)
  const BUNDLED_SKILLS_DIR = path.join(__dirname, 'skills');
  if (BUNDLED_SKILLS_DIR !== SKILLS_DIR && fs.existsSync(BUNDLED_SKILLS_DIR)) {
    for (const f of fs.readdirSync(BUNDLED_SKILLS_DIR).filter(f => f.endsWith('.md'))) {
      const id = path.parse(f).name;
      if (!c.skills[id]) {
        const meta = BUNDLED_SKILL_META[id] || {};
        c.skills[id] = { label: meta.label || `📄 ${id}`, description:'Bundled skill', file:path.join(BUNDLED_SKILLS_DIR, f), ...(meta.category ? { category:meta.category } : {}) };
      }
    }
  }
  for (const[k,s] of Object.entries(c.skills||{})) { try{s.content=fs.readFileSync(resolveSkillFile(s.file),'utf-8')}catch{s.content=''} }
  res.json(c);
});
app.post('/api/mcp/add', (req,res) => {
  const{id,label,description,type,command,args,env,url,headers}=req.body;
  const c=loadConfig();
  const entry={label:label||id,description:description||'',enabled:true,custom:true};
  if(type==='sse'||type==='http'){
    entry.type=type; entry.url=url||''; entry.headers=headers||{}; entry.env=env||{};
  } else {
    entry.command=command; entry.args=args||[]; entry.env=env||{};
  }
  c.mcpServers[id]=entry; saveConfig(c); res.json({ok:true});
});
app.put('/api/mcp/:id', (req,res) => {
  const c=loadConfig(); const id=req.params.id;
  const{env,headers,url,args,label,description,type,command}=req.body;
  if(!c.mcpServers[id]){
    const merged=loadMergedConfig();
    if(!merged.mcpServers[id]) return res.status(404).json({error:'Not found'});
    c.mcpServers[id]={...merged.mcpServers[id]};
  }
  if(label!==undefined) c.mcpServers[id].label=label;
  if(description!==undefined) c.mcpServers[id].description=description;
  if(type!==undefined) c.mcpServers[id].type=type;
  if(command!==undefined) c.mcpServers[id].command=command;
  if(env !== undefined) c.mcpServers[id].env=env;
  if(headers!==undefined) c.mcpServers[id].headers=headers;
  if(url!==undefined) c.mcpServers[id].url=url;
  if(args!==undefined) c.mcpServers[id].args=args;
  saveConfig(c); res.json({ok:true});
});
app.delete('/api/mcp/:id', (req,res) => { const c=loadConfig(); if(c.mcpServers[req.params.id]?.custom){delete c.mcpServers[req.params.id]; saveConfig(c)} res.json({ok:true}); });

app.post('/api/mcp/import', (req, res) => {
  const { servers, replace } = req.body;
  if (!servers || typeof servers !== 'object') return res.status(400).json({ error: 'Invalid servers object' });
  const c = loadConfig();
  if (!c.mcpServers) c.mcpServers = {};
  if (replace) {
    for (const id of Object.keys(c.mcpServers)) {
      if (c.mcpServers[id]?.custom) delete c.mcpServers[id];
    }
  }
  const ID_VALID = /^[a-zA-Z0-9_-]{1,64}$/;
  let imported = 0;
  for (const [id, m] of Object.entries(servers)) {
    if (!id || !ID_VALID.test(id) || typeof m !== 'object') continue;
    const entry = { label: m.label || id, description: m.description || '', enabled: true, custom: true };
    if (m.type === 'sse' || m.type === 'http' || m.url) {
      entry.type = m.type || 'http'; entry.url = m.url || ''; entry.headers = m.headers || {}; entry.env = m.env || {};
    } else {
      entry.command = m.command || ''; entry.args = m.args || []; entry.env = m.env || {};
    }
    c.mcpServers[id] = entry;
    imported++;
  }
  saveConfig(c);
  res.json({ ok: true, imported });
});

app.get('/api/mcp/export', (req, res) => {
  const c = loadMergedConfig();
  const mcpServers = {};
  for (const [id, m] of Object.entries(c.mcpServers || {})) {
    const entry = {};
    if (m.label && m.label !== id) entry.label = m.label;
    if (m.description) entry.description = m.description;
    if (m.type === 'sse' || m.type === 'http' || m.url) {
      entry.type = m.type || 'http'; entry.url = m.url || '';
      if (m.headers && Object.keys(m.headers).length) entry.headers = m.headers;
      if (m.env && Object.keys(m.env).length) entry.env = m.env;
    } else {
      entry.command = m.command || ''; entry.args = m.args || [];
      if (m.env && Object.keys(m.env).length) entry.env = m.env;
    }
    mcpServers[id] = entry;
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="mcp-config.json"');
  res.json({ mcpServers });
});

const upload = multer({ dest: path.join(os.tmpdir(), 'skills-upload') });
app.post('/api/skills/upload', upload.single('file'), (req,res) => {
  if(!req.file) return res.status(400).json({error:'No file'});
  const name=req.body.name||path.parse(req.file.originalname).name;
  const id=name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const destFile=`skills/${id}.md`; fs.mkdirSync(SKILLS_DIR,{recursive:true}); fs.copyFileSync(req.file.path, path.join(APP_DIR,destFile)); fs.unlinkSync(req.file.path);
  const c=loadConfig(); c.skills[id]={label:req.body.label||`📄 ${name}`,description:req.body.description||'Custom',file:destFile,custom:true}; saveConfig(c); res.json({ok:true,id});
});
app.delete('/api/skills/:id', (req,res) => { const c=loadConfig(); const s=c.skills[req.params.id]; if(s?.custom){try{fs.unlinkSync(path.join(APP_DIR,s.file))}catch{} delete c.skills[req.params.id]; saveConfig(c)} res.json({ok:true}); });

// ============================================
// SLASH COMMANDS CRUD
// ============================================
app.post('/api/commands', (req, res) => {
  const { name, text } = req.body;
  if (!name || !text) return res.status(400).json({ error: 'name and text required' });
  const c = loadConfig();
  if (!c.slashCommands) c.slashCommands = [];
  const id = Date.now().toString();
  const safeName = name.startsWith('/') ? name : '/' + name;
  c.slashCommands.push({ id, name: safeName, text });
  saveConfig(c);
  res.json({ ok: true, id });
});

app.put('/api/commands/:id', (req, res) => {
  const { name, text } = req.body;
  if (!name || !text) return res.status(400).json({ error: 'name and text required' });
  const c = loadConfig();
  if (!c.slashCommands) c.slashCommands = [];
  const cmd = c.slashCommands.find(cmd => cmd.id === req.params.id);
  if (!cmd) return res.status(404).json({ error: 'Not found' });
  cmd.name = name.startsWith('/') ? name : '/' + name;
  cmd.text = text;
  saveConfig(c);
  res.json({ ok: true });
});

app.delete('/api/commands/:id', (req, res) => {
  const c = loadConfig();
  if (!c.slashCommands) c.slashCommands = [];
  c.slashCommands = c.slashCommands.filter(cmd => cmd.id !== req.params.id);
  saveConfig(c);
  res.json({ ok: true });
});

// ============================================
// FILE UPLOAD  (images / text / PDF)
// ============================================
const ALLOWED_MIME_RE  = /^(image\/|text\/|application\/pdf$)/;
const UPLOAD_MAX_AGE   = 60 * 60 * 1000;          // 1 h — files older than this are deleted
const UPLOAD_MAX_SIZE  = 20 * 1024 * 1024;         // 20 MB per file

const fileUploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, file,  cb) => {
    const id  = genId();
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, id + ext);
  },
});

const fileUpload = multer({
  storage:    fileUploadStorage,
  limits:     { fileSize: UPLOAD_MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_RE.test(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error(`Unsupported MIME type: ${file.mimetype}`), { status: 415 }));
  },
});

/** Delete uploads older than UPLOAD_MAX_AGE */
function cleanOldUploads() {
  try {
    const cutoff = Date.now() - UPLOAD_MAX_AGE;
    for (const name of fs.readdirSync(UPLOADS_DIR)) {
      const fp = path.join(UPLOADS_DIR, name);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
    }
  } catch {}
}
cleanOldUploads();                             // run once on startup
setInterval(cleanOldUploads, 30 * 60 * 1000); // then every 30 min

// Database maintenance: sessions cleanup + WAL checkpoint
runDatabaseMaintenance();                                            // run once on startup
setInterval(runDatabaseMaintenance, CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000); // every N hours

app.post('/api/upload', fileUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  try {
    const data   = fs.readFileSync(req.file.path);
    const base64 = data.toString('base64');
    const id     = path.parse(req.file.filename).name;
    res.json({
      id,
      name:   req.file.originalname,
      type:   req.file.mimetype,
      size:   req.file.size,
      base64,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Multer MIME-filter errors → 415
app.use((err, _req, res, next) => {
  if (err?.status === 415) return res.status(415).json({ error: err.message });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large (max ${UPLOAD_MAX_SIZE / 1024 / 1024} MB)` });
  next(err);
});

// Config files editor
app.get('/api/config-files', (_,res) => {
  const files={};
  try{files['config.json']=fs.readFileSync(CONFIG_PATH,'utf-8')}catch{files['config.json']='{}'}
  try{files['CLAUDE.md']=fs.readFileSync(path.join(WORKDIR,'CLAUDE.md'),'utf-8')}catch{files['CLAUDE.md']=''}
  try{files['.claude/settings.json']=fs.readFileSync(path.join(os.homedir(),'.claude','settings.json'),'utf-8')}catch{files['.claude/settings.json']='{}'}
  try{files['.env']=fs.readFileSync(path.join(APP_DIR,'.env'),'utf-8')}catch{files['.env']=''}
  res.json(files);
});
app.put('/api/config-files', (req,res) => {
  const{filename,content}=req.body;
  const allowed={'config.json':CONFIG_PATH,'CLAUDE.md':path.join(WORKDIR,'CLAUDE.md'),'.claude/settings.json':path.join(os.homedir(),'.claude','settings.json'),'.env':path.join(APP_DIR,'.env')};
  const target=allowed[filename]; if(!target) return res.status(400).json({error:'Unknown'});
  try{const dir=path.dirname(target); if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(target,content,'utf-8'); res.json({ok:true})}
  catch(e){res.status(500).json({error:e.message})}
});

// CLAUDE.md editor — global (~/.claude/CLAUDE.md) + local (WORKDIR/CLAUDE.md)
const GLOBAL_CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');
const LOCAL_CLAUDE_MD  = path.join(WORKDIR, 'CLAUDE.md');

app.get('/api/claude-md', (req,res) => {
  const localDir = req.query.dir ? path.resolve(req.query.dir) : null;
  const localMd  = localDir ? path.join(localDir, 'CLAUDE.md') : LOCAL_CLAUDE_MD;
  const result = { global: '', local: '', globalPath: GLOBAL_CLAUDE_MD, localPath: localMd };
  try { result.global = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf-8'); } catch {}
  try { result.local  = fs.readFileSync(localMd, 'utf-8'); } catch {}
  res.json(result);
});

app.post('/api/claude-md', (req,res) => {
  const { type, content, dir } = req.body;
  if (!['global','local'].includes(type))
    return res.status(400).json({ error: 'type must be "global" or "local"' });
  const localMd = dir ? path.join(path.resolve(dir), 'CLAUDE.md') : LOCAL_CLAUDE_MD;
  const target  = type === 'global' ? GLOBAL_CLAUDE_MD : localMd;
  try {
    const d = path.dirname(target);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(target, content ?? '', 'utf-8');
    res.json({ ok: true, path: target });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Files browser
// Resolve the effective workspace for /api/files and /api/files/download.
// Priority: ?workdir= query param (must match a registered project) → global WORKDIR.
// Returns null if workdir is unknown, or { workdir, isRemote } object.
function resolveFilesWorkdir(reqWorkdir) {
  if (reqWorkdir) {
    const projects = loadProjects();
    const match = projects.find(p => path.resolve(p.workdir) === path.resolve(reqWorkdir));
    if (match) return { workdir: path.resolve(match.workdir), isRemote: !!match.isRemote };
    return null; // not a registered project — deny
  }
  return { workdir: path.resolve(WORKDIR), isRemote: false };
}

app.get('/api/files', (req,res) => {
  const dir=req.query.path||'';
  const resolved = resolveFilesWorkdir(req.query.workdir);
  if (!resolved) return res.status(403).json({error:'Workdir not in registered projects'});
  if (resolved.isRemote) return res.json({type:'remote'}); // remote FS can't be browsed locally
  const workdirReal = resolved.workdir;
  const fp=path.resolve(workdirReal,dir);
  if(fp!==workdirReal && !fp.startsWith(workdirReal+path.sep)) return res.status(403).json({error:'Denied'});
  try{
    const stat=fs.statSync(fp);
    if(stat.isDirectory()){
      const items=fs.readdirSync(fp,{withFileTypes:true}).filter(d=>!d.name.startsWith('.'))
        .map(d=>({name:d.name,type:d.isDirectory()?'dir':'file',path:path.join(dir,d.name),size:d.isFile()?fs.statSync(path.join(fp,d.name)).size:null}));
      res.json({type:'dir',items,workdir:workdirReal});
    } else {
      const ext=path.extname(fp).toLowerCase();
      const te=['.js','.ts','.py','.html','.css','.json','.md','.txt','.yaml','.yml','.sh','.env','.toml','.sql','.jsx','.tsx','.pine','.cfg','.log','.mjs','.go','.rs','.rb','.php'];
      const content=(te.includes(ext)||stat.size<512*1024)?fs.readFileSync(fp,'utf-8'):'[Binary]';
      res.json({type:'file',name:path.basename(fp),content,ext,workdir:workdirReal});
    }
  }catch{res.status(404).json({error:'Not found'})}
});

app.get('/api/files/download', (req,res) => {
  const fp_rel = req.query.path || '';
  const resolved = resolveFilesWorkdir(req.query.workdir);
  if (!resolved) return res.status(403).json({error:'Workdir not in registered projects'});
  if (resolved.isRemote) return res.status(400).json({error:'File download not available for remote projects'});
  const workdirReal = resolved.workdir;
  const fp = path.resolve(workdirReal, fp_rel);
  if (fp !== workdirReal && !fp.startsWith(workdirReal + path.sep)) return res.status(403).json({error:'Denied'});
  try {
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) return res.status(400).json({error:'Cannot download a directory'});
    const _dlFilename = path.basename(fp).replace(/[^\w.\-]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${_dlFilename}"`);
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(fp).pipe(res);
  } catch { res.status(404).json({error:'Not found'}); }
});

app.get('/api/files/raw', (req, res) => {
  const fp_rel = req.query.path || '';
  const resolved = resolveFilesWorkdir(req.query.workdir);
  if (!resolved) return res.status(403).json({error:'Workdir not in registered projects'});
  if (resolved.isRemote) return res.status(400).json({error:'Raw file access not available for remote projects'});
  const workdirReal = resolved.workdir;
  const fp = path.resolve(workdirReal, fp_rel);
  if (fp !== workdirReal && !fp.startsWith(workdirReal + path.sep)) return res.status(403).json({error:'Denied'});
  try {
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) return res.status(400).json({error:'Cannot serve directory'});
    const ext = path.extname(fp).toLowerCase();
    const mimeMap = {
      '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
      '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml',
      '.pdf':'application/pdf',
      '.mp4':'video/mp4', '.webm':'video/webm', '.ogg':'video/ogg',
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(fp).pipe(res);
  } catch { res.status(404).json({error:'Not found'}); }
});

// ─── Project file search (for @ mention) ────────────────────────────────────
const TEXT_EXTS = new Set(['.js','.ts','.jsx','.tsx','.mjs','.cjs','.py','.rb','.go','.rs','.php','.java','.kt','.swift','.cs','.cpp','.c','.h','.html','.css','.scss','.less','.json','.yaml','.yml','.toml','.ini','.cfg','.env','.md','.txt','.sh','.bash','.zsh','.sql','.graphql','.xml','.vue','.svelte','.lock','.log','.pine','.r','.jl']);
const SKIP_DIRS  = new Set(['node_modules','.git','.next','.nuxt','__pycache__','dist','build','.cache','vendor','venv','.venv','.svn','.hg']);
const MAX_FILE_SIZE = 512 * 1024; // 512 KB

function searchProjectFiles(rootDir, query, maxResults = 80) {
  const results = [];
  const qLow = (query || '').toLowerCase();
  function walk(dir, depth) {
    if (depth > 6 || results.length >= maxResults) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= maxResults) break;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!TEXT_EXTS.has(ext)) continue;
        const relPath = path.relative(rootDir, path.join(dir, e.name));
        if (!qLow || relPath.toLowerCase().includes(qLow) || e.name.toLowerCase().includes(qLow)) {
          results.push({ name: e.name, relPath, absPath: path.join(dir, e.name) });
        }
      }
    }
  }
  walk(rootDir, 0);
  // Sort: exact name matches first, then by path length
  if (qLow) results.sort((a, b) => {
    const aName = a.name.toLowerCase().startsWith(qLow) ? 0 : 1;
    const bName = b.name.toLowerCase().startsWith(qLow) ? 0 : 1;
    return aName - bName || a.relPath.length - b.relPath.length;
  });
  return results;
}

app.get('/api/project-files', (req, res) => {
  const { dir, q } = req.query;
  if (!dir) return res.status(400).json({ error: 'dir required' });
  const absDir = path.resolve(dir);
  // Security: dir must be one of the registered project workdirs
  const projects = loadProjects();
  const allowed = projects.some(p => {
    const pd = path.resolve(p.workdir);
    return absDir === pd || absDir.startsWith(pd + path.sep);
  });
  if (!allowed) return res.status(403).json({ error: 'Dir not in any registered project' });
  if (!fs.existsSync(absDir)) return res.status(404).json({ error: 'Not found' });
  const files = searchProjectFiles(absDir, q || '');
  res.json({ files });
});

app.get('/api/project-files/read', (req, res) => {
  const { path: filePath, dir } = req.query;
  if (!filePath || !dir) return res.status(400).json({ error: 'path and dir required' });
  const absFile = path.resolve(filePath);
  const absDir  = path.resolve(dir);
  // Security: file must be inside the project dir
  if (!absFile.startsWith(absDir + path.sep) && absFile !== absDir) {
    return res.status(403).json({ error: 'Path outside project dir' });
  }
  const projects = loadProjects();
  const allowed = projects.some(p => {
    const pd = path.resolve(p.workdir);
    return absDir === pd || absDir.startsWith(pd + path.sep);
  });
  if (!allowed) return res.status(403).json({ error: 'Dir not in any registered project' });
  try {
    const stat = fs.statSync(absFile);
    if (stat.size > MAX_FILE_SIZE) return res.status(413).json({ error: 'File too large (max 512 KB)' });
    const content = fs.readFileSync(absFile, 'utf-8');
    res.json({ content, name: path.basename(absFile), path: absFile });
  } catch (e) { res.status(404).json({ error: 'Not found' }); }
});

// Projects CRUD
app.get('/api/projects', (req,res) => {
  let projects = loadProjects();
  // Non-admin users only see assigned projects
  if (req.userRole !== 'admin') {
    const user = auth.getUserById(req.userId);
    const assignedIds = new Set(user?.projects || []);
    projects = projects.filter(p => assignedIds.has(p.id));
  }
  res.json(projects);
});

app.post('/api/projects', requireAdmin, (req,res) => {
  const { name, workdir, gitInit, isRemote=false, remoteHostId='', remoteWorkdir='', sshKeyPath='', port=22 } = req.body;
  if (!name || !workdir) return res.status(400).json({ error:'name and workdir required' });
  try {
    const actions = [];
    if (isRemote) {
      // Remote project: workdir is the path on the remote server — don't create locally
      const hosts = loadRemoteHosts();
      const rh = hosts.find(h => h.id === remoteHostId);
      if (!rh) return res.status(400).json({ error:'Remote host not found. Add a host first.' });
      const projects = loadProjects();
      const existing = projects.find(p => p.workdir === workdir && p.remoteHostId === remoteHostId);
      if (existing) { existing.name = name; saveProjects(projects); return res.json({ ok:true, id:existing.id, actions, updated:true }); }
      const id = 'proj-' + genId();
      projects.push({ id, name, workdir, isRemote:true, remoteHostId, remoteHost: rh.host, sshKeyPath: rh.sshKeyPath||'', password: rh.password||'', port: rh.port||Number(port)||22, createdAt:new Date().toISOString() });
      saveProjects(projects);
      return res.json({ ok:true, id, actions });
    }
    // Local project (existing behavior)
    if (!fs.existsSync(workdir)) fs.mkdirSync(workdir, { recursive:true });
    if (gitInit && !fs.existsSync(path.join(workdir,'.git'))) {
      try { execSync('git init', { cwd:workdir, stdio:'pipe' }); actions.push('git init'); }
      catch(e) { return res.json({ ok:true, id:null, actions, gitError:(e.stderr?.toString()||e.message).trim() }); }
    }
    const projects = loadProjects();
    const existing = projects.find(p => p.workdir === workdir);
    if (existing) {
      existing.name = name; saveProjects(projects);
      // Auto-install BMAD even for re-added projects if missing
      if (!fs.existsSync(path.join(workdir, '_bmad'))) {
        const { execFile: ef2 } = require('child_process');
        ef2('npx', ['bmad-method', 'install', '--directory', workdir, '--tools', 'claude-code', '--user-name', 'Mwogi', '--modules', 'bmm', '--output-folder', '_bmad-output', '--yes'], { timeout: 120000, cwd: workdir }, (err) => {
          if (err) log.warn('BMAD auto-install failed (existing project)', { workdir, error: err.message });
          else log.info('BMAD auto-installed (existing project)', { workdir });
        });
        actions.push('bmad install (background)');
      }
      return res.json({ ok:true, id:existing.id, actions, updated:true });
    }
    const id = 'proj-' + genId();
    projects.push({ id, name, workdir, createdAt:new Date().toISOString() });
    saveProjects(projects);
    // Auto-install BMAD in new local projects (background, non-blocking)
    if (!fs.existsSync(path.join(workdir, '_bmad'))) {
      const { execFile: ef } = require('child_process');
      ef('npx', ['bmad-method', 'install', '--directory', workdir, '--tools', 'claude-code', '--user-name', 'Mwogi', '--modules', 'bmm', '--output-folder', '_bmad-output', '--yes'], { timeout: 120000, cwd: workdir }, (err) => {
        if (err) log.warn('BMAD auto-install failed', { workdir, error: err.message });
        else log.info('BMAD auto-installed', { workdir });
      });
      actions.push('bmad install (background)');
    }
    res.json({ ok:true, id, actions });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/projects/reorder', requireAdmin, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'no ids' });
  const all = loadProjects();
  const byId = Object.fromEntries(all.map(p => [p.id, p]));
  const ordered = ids.map(id => byId[id]).filter(Boolean);
  const inSet = new Set(ids);
  all.filter(p => !inSet.has(p.id)).forEach(p => ordered.push(p));
  saveProjects(ordered);
  res.json({ ok: true });
});
app.patch('/api/projects/:id', requireAdmin, (req,res) => {
  const { name, autoMode, maxWorkers } = req.body;
  const projects = loadProjects();
  const p = projects.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error:'not found' });
  if (name !== undefined) p.name = String(name).trim();
  if (maxWorkers !== undefined) {
    const n = parseInt(maxWorkers, 10);
    if (isNaN(n) || n < 1 || n > 20) return res.status(400).json({ error: 'maxWorkers must be 1-20' });
    p.maxWorkers = n;
  }
  if (autoMode !== undefined) {
    p.autoMode = !!autoMode;
    if (p.autoMode) {
      p.autoModeStartedAt = new Date().toISOString();
      log.info(`[AutoMode] ENABLED for project "${p.name}" (${p.workdir})`);
      openclawNotify.notify(`⚡ **Auto Mode Enabled**: ${p.name}\nTasks will be processed automatically, 5 at a time.`);
    } else {
      delete p.autoModeStartedAt;
      log.info(`[AutoMode] DISABLED for project "${p.name}"`);
      openclawNotify.notify(`⏸️ **Auto Mode Disabled**: ${p.name}`);
    }
  }
  saveProjects(projects);
  if (autoMode) setImmediate(autoModeProcess); // kick off immediately
  res.json({ ok:true, autoMode: !!p.autoMode });
});

app.delete('/api/projects/:id', requireAdmin, (req,res) => {
  saveProjects(loadProjects().filter(p => p.id !== req.params.id));
  res.json({ ok:true });
});

// ─── Remote SSH Hosts CRUD ────────────────────────────────────────────────────
app.get('/api/remote-hosts', (_,res) => res.json(
  loadRemoteHosts().map(h => ({ ...h, password: h.password ? '***' : '' }))
));

app.post('/api/remote-hosts', (req,res) => {
  const { label, host, port=22, sshKeyPath='', password='' } = req.body;
  if (!label || !host) return res.status(400).json({ error:'label and host required' });
  const hosts = loadRemoteHosts();
  const id = 'rh-' + genId();
  const entry = { id, label, host, port: Number(port)||22, sshKeyPath: sshKeyPath||'', password: encryptPassword(password||''), createdAt: new Date().toISOString() };
  hosts.push(entry);
  saveRemoteHosts(hosts);
  // Don't expose password in response
  res.json({ ok:true, id, host: { ...entry, password: entry.password ? '***' : '' } });
});

app.put('/api/remote-hosts/:id', (req,res) => {
  const { label, host, port=22, sshKeyPath='', password } = req.body;
  const hosts = loadRemoteHosts();
  const idx = hosts.findIndex(h => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error:'Not found' });
  // If password not sent (undefined), keep existing encrypted value; if sent, encrypt the new value
  const newPassword = password === undefined ? (hosts[idx].password || '') : encryptPassword(password || '');
  hosts[idx] = { ...hosts[idx], label, host, port: Number(port)||22, sshKeyPath: sshKeyPath||'', password: newPassword };
  saveRemoteHosts(hosts);
  res.json({ ok:true, host: { ...hosts[idx], password: hosts[idx].password ? '***' : '' } });
});

app.delete('/api/remote-hosts/:id', (req,res) => {
  saveRemoteHosts(loadRemoteHosts().filter(h => h.id !== req.params.id));
  res.json({ ok:true });
});

// Test SSH connection — for new (unsaved) host (must be before /:id/test)
app.post('/api/remote-hosts/test-new', async (req,res) => {
  const { host, port=22, sshKeyPath='', password='' } = req.body;
  if (!host) return res.status(400).json({ error:'host required' });
  try {
    const result = await testSshConnection({ host, port: Number(port)||22, sshKeyPath, password });
    res.json({ ok:true, message:'Connection successful', latencyMs: result.latencyMs });
  } catch(e) { res.status(400).json({ error: e.message||'Connection failed' }); }
});

// Test SSH connection — for saved host
app.post('/api/remote-hosts/:id/test', async (req,res) => {
  const hosts = loadRemoteHosts();
  const rh = hosts.find(h => h.id === req.params.id);
  if (!rh) return res.status(404).json({ error:'Host not found' });
  try {
    const result = await testSshConnection({ host: rh.host, port: rh.port||22, sshKeyPath: rh.sshKeyPath||'', password: decryptPassword(rh.password)||'' });
    res.json({ ok:true, message:'Connection successful', latencyMs: result.latencyMs });
  } catch(e) { res.status(400).json({ error: e.message||'Connection failed' }); }
});

// Directory browser — list directories at given path (no restriction to WORKDIR)
app.get('/api/browse-dirs', (req, res) => {
  // Windows: show drive list when explicitly requested OR when no path given (initial open)
  if (process.platform === 'win32' && (!req.query.path || req.query.path === '__drives__')) {
    const drives = [];
    for (let i = 65; i <= 90; i++) { // A–Z
      const drive = String.fromCharCode(i) + ':\\';
      try { fs.accessSync(drive); drives.push({ name: String.fromCharCode(i) + ':', path: drive, hidden: false }); } catch {}
    }
    return res.json({ path: '__drives__', parent: null, items: drives });
  }
  const dir = path.resolve(req.query.path || os.homedir());
  try {
    if (!fs.statSync(dir).isDirectory()) return res.status(400).json({ error: 'Not a directory' });
    const raw = fs.readdirSync(dir, { withFileTypes: true });
    const items = raw
      .filter(d => d.isDirectory())
      .sort((a, b) => {
        const ah = a.name.startsWith('.'), bh = b.name.startsWith('.');
        if (ah !== bh) return ah ? 1 : -1; // hidden dirs last
        return a.name.localeCompare(b.name);
      })
      .map(d => ({ name: d.name, path: path.join(dir, d.name), hidden: d.name.startsWith('.') }));
    // On Windows, drive roots have dirname === self; use '__drives__' as virtual parent
    let parent = path.dirname(dir) !== dir ? path.dirname(dir) : null;
    if (process.platform === 'win32' && parent === null) parent = '__drives__';
    res.json({ path: dir, parent, items });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Create a new directory (for new project creation)
app.post('/api/create-dir', (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'path required' });
  try {
    if (fs.existsSync(dirPath)) return res.status(400).json({ error: 'Folder already exists' });
    fs.mkdirSync(dirPath, { recursive: true });
    res.json({ ok: true, path: dirPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Initialize project directory (create dir + optional git init)
app.post('/api/project/init', (req, res) => {
  const { workdir, gitInit } = req.body;
  if (!workdir) return res.status(400).json({ error: 'workdir required' });
  try {
    if (!fs.existsSync(workdir)) fs.mkdirSync(workdir, { recursive: true });
    const actions = [];
    if (gitInit && !fs.existsSync(path.join(workdir, '.git'))) {
      try {
        execSync('git init', { cwd: workdir, stdio: 'pipe' });
        actions.push('git init');
      } catch(e) { return res.json({ ok: true, actions, gitError: (e.stderr?.toString()||e.message).trim() }); }
    }
    res.json({ ok: true, actions });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// TUNNEL MANAGER
// ============================================
let tunnelManager = null;

function initTunnelManager() {
  tunnelManager = new TunnelManager({ log, port: PORT });

  tunnelManager.on('url', (url) => {
    // Notify all WebSocket clients
    wss.clients.forEach(ws => {
      try { ws.send(JSON.stringify({ type: 'tunnel_url', url })); } catch {}
    });
    // Notify all paired Telegram devices
    if (telegramBot?.isRunning()) {
      telegramBot.notifyTunnelUrl(url).catch(e => log.error('[tunnel] notifyTunnelUrl failed:', e.message));
    }
  });

  tunnelManager.on('close', (reason) => {
    wss.clients.forEach(ws => {
      try { ws.send(JSON.stringify({ type: 'tunnel_closed', reason })); } catch {}
    });
    if (telegramBot?.isRunning()) {
      telegramBot.notifyTunnelClosed().catch(e => log.error('[tunnel] notifyTunnelClosed failed:', e.message));
    }
  });
}

// ============================================
// TELEGRAM BOT
// ============================================
let telegramBot = null;

// Helper: clean up Telegram ask_user state when answered from elsewhere (web UI)
function _clearTelegramAskState(sessionId) {
  if (!telegramBot) return;
  const task = activeTasks.get(sessionId);
  if (task?.proxy?._userId) {
    const ctx = telegramBot._getContext(task.proxy._userId);
    ctx.pendingAskRequestId = null;
    ctx.pendingAskQuestions = null;
  }
}

// ─── Process a chat message from Telegram ────────────────────────────────────
// Reuses the same core logic as processChat but without WebSocket dependency.
async function processTelegramChat({ sessionId, text, userId, chatId, attachments }) {
  if (!telegramBot) return;

  // Check if session is busy
  if (activeTasks.has(sessionId)) {
    await telegramBot._sendMessage(chatId, '⏳ This session is busy. Wait for completion or use /stop.');
    return;
  }

  // Load session from DB
  const session = stmts.getSession.get(sessionId);
  if (!session) {
    await telegramBot._sendMessage(chatId, '❌ Session not found.');
    return;
  }

  const proxy = new TelegramProxy(telegramBot, chatId, sessionId, userId);
  const abortController = new AbortController();

  activeTasks.set(sessionId, {
    proxy,
    abortController,
    source: 'telegram',
    userId,
    chatId,
    startedAt: Date.now()
  });
  chatBuffers.set(sessionId, '');

  try {
    // Build user content (with attachments if any)
    const userContent = buildUserContent(text, attachments || []);

    // Store user message in DB (marked as telegram source)
    stmts.addTelegramMsg.run(sessionId, 'user', 'text', typeof userContent === 'string' ? userContent : text, null, null, null, null);

    // Broadcast user message to web UI watchers (so web chat updates in real-time)
    broadcastToSession(sessionId, {
      type: 'task_started',
      prompt: typeof userContent === 'string' ? userContent : text,
      source: 'telegram',
    });

    // Load session config
    const model = session.model || 'sonnet';
    const mode = session.mode || 'auto';
    const workdir = session.workdir || WORKDIR;

    // Parse active MCP and skills
    let mcpIds = [];
    let skillIds = [];
    try { mcpIds = JSON.parse(session.active_mcp || '[]'); } catch(e) {}
    try { skillIds = JSON.parse(session.active_skills || '[]'); } catch(e) {}

    // Build system prompt from skills (same logic as processChat)
    const config = loadMergedConfig();
    const systemPrompt = buildSystemPrompt(skillIds, config);

    // Build MCP servers map
    const mcpServers = {};
    for (const mid of mcpIds) {
      const m = config.mcpServers[mid];
      if (!m) continue;
      if (m.type === 'http' || m.type === 'sse' || m.url) {
        mcpServers[mid] = { type: m.type || 'http', url: m.url, ...(m.headers ? { headers: m.headers } : {}), ...(m.env ? { env: expandTildeInObj(m.env) } : {}) };
      } else {
        mcpServers[mid] = { command: m.command, args: m.args || [], env: expandTildeInObj(m.env || {}) };
      }
    }

    // Internal MCPs (always injected)
    mcpServers['_ccs_ask_user'] = {
      command: 'node',
      args: [path.join(__dirname, 'mcp-ask-user.js')],
      env: {
        ASK_USER_SERVER_URL: `http://127.0.0.1:${PORT}`,
        ASK_USER_SESSION_ID: sessionId,
        ASK_USER_SECRET: ASK_USER_SECRET,
      },
    };
    mcpServers['_ccs_notify'] = {
      command: 'node',
      args: [path.join(__dirname, 'mcp-notify.js')],
      env: {
        NOTIFY_SERVER_URL: `http://127.0.0.1:${PORT}`,
        NOTIFY_SESSION_ID: sessionId,
        NOTIFY_SECRET: NOTIFY_SECRET,
      },
    };
    mcpServers['_ccs_set_ui_state'] = {
      command: 'node',
      args: [path.join(__dirname, 'mcp-set-ui-state.js')],
      env: {
        SET_UI_STATE_SERVER_URL: `http://127.0.0.1:${PORT}`,
        SET_UI_STATE_SESSION_ID: sessionId,
        SET_UI_STATE_SECRET: SET_UI_STATE_SECRET,
      },
    };

    // Save last user msg for reconnect recovery
    stmts.setLastUserMsg.run(text, sessionId);

    // Send "thinking" indicator and pass message ID to proxy for reuse
    const thinkingMsg = await telegramBot._sendMessage(chatId, '🤔 <b>Thinking...</b>', {
      parse_mode: 'HTML',
      reply_markup: JSON.stringify({ inline_keyboard: [[
        { text: '🛑 Stop', callback_data: 'cm:stop' },
        { text: '🏠 Menu', callback_data: 'm:menu' },
      ]] }),
    });
    if (thinkingMsg?.message_id) {
      proxy._progressMsgId = thinkingMsg.message_id;
    }

    const params = {
      prompt: text,
      userContent,
      systemPrompt,
      mcpServers,
      model,
      maxTurns: 30,
      ws: proxy,
      sessionId,
      abortController,
      claudeSessionId: sanitizeSessionId(session.claude_session_id) || undefined,
      mode,
      workdir,
    };

    // Check if the active project is a remote SSH project
    const _activeProj = loadProjects().find(p => p.workdir === workdir && p.isRemote);
    if (_activeProj) {
      await runSshSingle({
        ...params,
        remoteHost:    _activeProj.remoteHost,
        remoteWorkdir: _activeProj.workdir,
        sshKeyPath:    _activeProj.sshKeyPath || '',
        password:      decryptPassword(_activeProj.password) || '',
        port:          _activeProj.port || 22,
      });
    } else {
      await runCliSingle(params);
    }

    const _taskStart = activeTasks.get(sessionId)?.startedAt;
    proxy.send(JSON.stringify({ type: 'done', duration: _taskStart ? Date.now() - _taskStart : 0 }));
  } catch (err) {
    log.error('[processTelegramChat] Error', { message: err.message, name: err.name, stack: err.stack });
    proxy.send(JSON.stringify({ type: 'error', error: err.message }));
  } finally {
    activeTasks.delete(sessionId);
    chatBuffers.delete(sessionId);
    // Clean up pending ask_user questions for this session
    for (const [rid, entry] of pendingAskUser) {
      if (entry.sessionId === sessionId) {
        clearTimeout(entry.timer);
        pendingAskUser.delete(rid);
        entry.resolve({ answer: '[Session ended]' });
      }
    }
    // Clean up pending ask_user state on Telegram bot context
    if (userId && telegramBot) {
      const ctx = telegramBot._getContext(userId);
      ctx.pendingAskRequestId = null;
      ctx.pendingAskQuestions = null;
    }
    try { stmts.clearLastUserMsg.run(sessionId); } catch {}
  }
}

function _attachTelegramListeners(bot) {
  bot.on('device_paired', (device) => {
    wss.clients.forEach(ws => {
      try { ws.send(JSON.stringify({ type: 'telegram_device_paired', device })); } catch {}
    });
  });
  bot.on('device_removed', (data) => {
    wss.clients.forEach(ws => {
      try { ws.send(JSON.stringify({ type: 'telegram_device_removed', ...data })); } catch {}
    });
  });

  // ask_user responses from Telegram
  bot.on('ask_user_response', ({ requestId, answer }) => {
    const entry = pendingAskUser.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      pendingAskUser.delete(requestId);
      entry.resolve({ answer: answer || '[Empty response]' });
    }
  });

  // Phase 2: Process messages sent from Telegram to Claude
  bot.on('send_message', async ({ sessionId, text, userId, chatId, attachments, callback }) => {
    try {
      if (callback) callback({ ok: true });
      await processTelegramChat({ sessionId, text, userId, chatId, attachments });
    } catch (err) {
      console.error('[Telegram] send_message error:', err.message);
      // Note: callback already called before processTelegramChat — errors are
      // reported via TelegramProxy._sendError, not via callback
    }
  });

  // Active chats query from Telegram status screen
  bot.on('get_active_chats', (callback) => {
    const chats = [];
    for (const [sessionId, task] of activeTasks) {
      const session = stmts.getSession.get(sessionId);
      chats.push({
        sessionId,
        title: session?.title || 'Untitled',
        source: task.source || 'web',
        startedAt: task.startedAt,
      });
    }
    callback(chats);
  });

  // Tunnel: status query from Telegram
  bot.on('tunnel_get_status', (callback) => {
    const status = tunnelManager?.getStatus() || { running: false };
    callback(status);
  });

  // Tunnel control from Telegram
  bot.on('tunnel_start', async ({ chatId }) => {
    try {
      if (!tunnelManager) initTunnelManager();
      if (tunnelManager.isRunning()) {
        const s = tunnelManager.getStatus();
        await bot._sendMessage(chatId, `🟢 Already running:\n${bot._escHtml(s.publicUrl)}`);
        return;
      }
      const c = loadConfig();
      const provider = c.tunnel?.provider || 'cloudflared';
      const config = { ngrokAuthtoken: c.tunnel?.ngrokAuthtoken };
      await bot._sendMessage(chatId, `⏳ Starting ${bot._escHtml(provider)}...`);
      const { publicUrl } = await tunnelManager.start(provider, config);
      await bot._sendMessage(chatId, `🟢 Remote Access active!\n\n🔗 ${bot._escHtml(publicUrl)}`);
    } catch (err) {
      await bot._sendMessage(chatId, `❌ Error: ${bot._escHtml(err.message)}`);
    }
  });

  bot.on('tunnel_stop', async ({ chatId }) => {
    try {
      if (!tunnelManager?.isRunning()) {
        await bot._sendMessage(chatId, bot._t('tn_not_running'));
        return;
      }
      tunnelManager.stop();
      await bot._sendMessage(chatId, bot._t('tn_notify_stopped'));
    } catch (err) {
      try { await bot._sendMessage(chatId, `❌ ${bot._escHtml(err.message)}`); } catch {}
    }
  });

  bot.on('tunnel_status', async ({ chatId }) => {
    try {
      const s = tunnelManager?.getStatus();
      if (s?.running) {
        await bot._sendMessage(chatId, `🟢 Remote Access active\n\n🔗 ${bot._escHtml(s.publicUrl)}\n⏱ Since: ${bot._escHtml(String(s.startedAt))}`);
      } else {
        await bot._sendMessage(chatId, bot._t('tn_not_running'));
      }
    } catch (err) {
      try { await bot._sendMessage(chatId, `❌ ${bot._escHtml(err.message)}`); } catch {}
    }
  });

  // Phase 2: Stop running task from Telegram
  bot.on('stop_task', async ({ sessionId, chatId }) => {
    const task = activeTasks.get(sessionId);
    if (task && task.abortController) {
      task.abortController.abort();
      await bot._sendMessage(chatId, '🛑 Task stopped.');
    } else {
      await bot._sendMessage(chatId, 'No active task in this session.');
    }
  });
}

function initTelegramBot() {
  const c = loadConfig();
  const tg = c.telegram;
  if (!tg || !tg.enabled || !tg.botToken) return;

  telegramBot = new TelegramBot(db, { log, lang: c.lang || 'uk' });
  telegramBot.acceptNewConnections = tg.acceptNewConnections !== false;
  _attachTelegramListeners(telegramBot);

  telegramBot.start(tg.botToken).catch(err => {
    log.error('[telegram] Failed to start bot', { error: err.message });
    telegramBot = null;
  });
}

// ─── Telegram API Endpoints ─────────────────────────────────────────────────

app.get('/api/telegram/status', (_, res) => {
  const c = loadConfig();
  const tg = c.telegram || {};
  res.json({
    enabled: !!tg.enabled,
    running: telegramBot?.isRunning() || false,
    botInfo: telegramBot?.getBotInfo() || null,
    acceptNewConnections: telegramBot?.acceptNewConnections ?? tg.acceptNewConnections ?? true,
    hasToken: !!tg.botToken,
    devices: telegramBot?.getDevices() || [],
  });
});

app.post('/api/telegram/start', (req, res) => {
  const { botToken } = req.body;
  if (!botToken) return res.status(400).json({ error: 'botToken required' });

  // Save to config
  const c = loadConfig();
  if (!c.telegram) c.telegram = {};
  c.telegram.botToken = botToken;
  c.telegram.enabled = true;
  if (c.telegram.acceptNewConnections === undefined) c.telegram.acceptNewConnections = true;
  saveConfig(c);

  // Stop existing bot if running
  if (telegramBot) {
    telegramBot.stop();
    telegramBot = null;
  }

  // Start new bot
  telegramBot = new TelegramBot(db, { log, lang: c.lang || 'uk' });
  telegramBot.acceptNewConnections = c.telegram.acceptNewConnections !== false;
  _attachTelegramListeners(telegramBot);

  telegramBot.start(botToken)
    .then(botInfo => {
      res.json({ ok: true, botInfo });
    })
    .catch(err => {
      telegramBot = null;
      // Don't disable in config — let user fix the token
      res.status(400).json({ error: err.message });
    });
});

app.post('/api/telegram/stop', (_, res) => {
  if (telegramBot) {
    telegramBot.stop();
    telegramBot = null;
  }
  const c = loadConfig();
  if (c.telegram) c.telegram.enabled = false;
  saveConfig(c);
  res.json({ ok: true });
});

app.post('/api/telegram/pairing-code', (_, res) => {
  if (!telegramBot || !telegramBot.isRunning()) {
    return res.status(400).json({ error: 'Bot is not running' });
  }
  const result = telegramBot.generatePairingCode();
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.delete('/api/telegram/devices/:id', (req, res) => {
  if (!telegramBot) return res.status(400).json({ error: 'Bot is not running' });
  const id = parseInt(req.params.id, 10);
  const removed = telegramBot.removeDevice(id);
  res.json({ ok: removed });
});

app.put('/api/telegram/accept-connections', (req, res) => {
  const { accept } = req.body;
  if (typeof accept !== 'boolean') return res.status(400).json({ error: 'accept (boolean) required' });

  // Save to config
  const c = loadConfig();
  if (!c.telegram) c.telegram = {};
  c.telegram.acceptNewConnections = accept;
  saveConfig(c);

  // Apply to running bot
  if (telegramBot) {
    telegramBot.acceptNewConnections = accept;
  }

  res.json({ ok: true, acceptNewConnections: accept });
});

// ============================================
// TUNNEL API
// ============================================

app.get('/api/tunnel/status', (_, res) => {
  const s = tunnelManager?.getStatus() || { running: false };
  const c = loadConfig();
  res.json({
    running: s.running,
    provider: s.provider || c.tunnel?.provider || 'cloudflared',
    publicUrl: s.publicUrl || null,
    startedAt: s.startedAt || null,
    pid: s.pid || null,
    error: s.error || null,
    savedProvider: c.tunnel?.provider || 'cloudflared',
    hasNgrokToken: !!c.tunnel?.ngrokAuthtoken,
  });
});

let _tunnelStartLock = false;
app.post('/api/tunnel/start', async (req, res) => {
  if (tunnelManager?.isRunning()) {
    return res.json({ ok: true, publicUrl: tunnelManager.getStatus().publicUrl, already: true });
  }
  if (_tunnelStartLock) {
    return res.status(409).json({ error: 'Tunnel start already in progress' });
  }

  const { provider, ngrokAuthtoken } = req.body;
  const prov = provider || 'cloudflared';
  if (!['cloudflared', 'ngrok'].includes(prov)) {
    return res.status(400).json({ error: `Unknown provider: ${prov}` });
  }

  // Save preferences to config
  const c = loadConfig();
  if (!c.tunnel) c.tunnel = {};
  c.tunnel.provider = prov;
  if (ngrokAuthtoken) c.tunnel.ngrokAuthtoken = ngrokAuthtoken;
  saveConfig(c);

  // Initialize manager if not done
  if (!tunnelManager) initTunnelManager();

  _tunnelStartLock = true;
  try {
    const { publicUrl } = await tunnelManager.start(prov, {
      ngrokAuthtoken: ngrokAuthtoken || c.tunnel.ngrokAuthtoken,
    });
    res.json({ ok: true, publicUrl });
  } catch (err) {
    const resp = { error: err.message };
    if (err.installUrl) {
      resp.installUrl = err.installUrl;
      resp.installCmd = err.installCmd;
    }
    res.status(400).json(resp);
  } finally {
    _tunnelStartLock = false;
  }
});

app.post('/api/tunnel/notify-telegram', async (_, res) => {
  if (!tunnelManager?.isRunning()) {
    return res.status(400).json({ error: 'Remote access is not running' });
  }
  if (!telegramBot?.isRunning()) {
    return res.status(400).json({ error: 'Telegram bot is not running' });
  }
  const url = tunnelManager.getStatus().publicUrl;
  try {
    await telegramBot.notifyTunnelUrl(url);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to notify Telegram devices' });
  }
});

app.post('/api/tunnel/stop', (_, res) => {
  if (tunnelManager?.isRunning()) {
    tunnelManager.stop();
  }
  res.json({ ok: true });
});

// ============================================
// WEBSOCKET
// ============================================
server.on('upgrade', (req, socket, head) => {
  const cookies = {};
  (req.headers.cookie||'').split(';').forEach(c => { const[k,v]=c.trim().split('='); if(k&&v) cookies[k]=v; });
  const bearerToken = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  const token = cookies.token || req.headers['x-auth-token'] || bearerToken;
  if (!auth.validateWsToken(token)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  log.info('ws connected', { clients: wss.clients.size });
  // Per-tab concurrency tracking
  ws._tabBusy  = {};  // tabId → bool
  ws._tabQueue = {};  // tabId → msg[]
  ws._tabAbort = {};  // tabId → AbortController
  // Legacy single-connection state (kept for backward compat with start_session)
  let legacySessionId = null, legacyClaudeId = undefined;
  // Legacy queue (for messages without tabId)
  ws._queue = []; ws._busy = false; ws._queueIdCounter = 0;

  function queuePayload(tabId) {
    const queue = tabId ? (ws._tabQueue[tabId] || []) : ws._queue;
    return JSON.stringify({
      type: 'queue_update',
      tabId,
      pending: queue.length,
      items: queue.map(m => ({ id: m._queueId, queueId: m.queueId || null, text: m.text || '', attachments: m.attachments || [] })),
    });
  }

  async function processChat(msg) {
    const tabId = msg.tabId || null;
    const proxy = new WsProxy(ws); // buffers output when browser disconnects

    // Mark this tab as busy
    if (tabId) ws._tabBusy[tabId] = true;
    else ws._busy = true;

    // Track OUR abort controller so finally can detect if a stop+new processChat
    // happened while we were running (stale finally must not reset _tabBusy).
    let myAbortController = null;

    // Pre-declared so catch/finally always have scope for busy-state cleanup.
    // effectiveTabId starts as tabId: if an error is thrown before the real
    // effectiveTabId (= localSessionId) is computed, finally still resets the
    // correct _tabBusy key and avoids leaving the tab permanently stuck.
    let localSessionId = null, localClaudeId = undefined, effectiveTabId = tabId;
    const _chatStartedAt = Date.now();

    try {
      ws.send(queuePayload(tabId));

      // Resolve session: use sessionId from message, or legacy, or create new
      localSessionId = msg.sessionId || (tabId ? null : legacySessionId);

      // Single DB lookup — reused for workdir check, existence check, claude_session_id, and auto-title
      let existSess = localSessionId ? stmts.getSession.get(localSessionId) : null;

      // Validate workdir: if the session belongs to a different project, don't reuse it.
      if (existSess && msg.workdir && existSess.workdir && existSess.workdir !== msg.workdir) {
        log.warn('workdir mismatch — refusing to reuse session from different project', { sessionId: localSessionId, sessionWorkdir: existSess.workdir, msgWorkdir: msg.workdir });
        localSessionId = null;
        existSess = null;
      }

      let isNewSession = false;
      if (!localSessionId || !existSess) {
        localSessionId = genId();
        stmts.createSession.run(localSessionId,i18nSession(),'[]','[]',sqlVal(msg.mode)||'auto',sqlVal(msg.agentMode)||'single',sqlVal(msg.model)||'sonnet',sqlVal(msg.engine)||null,sqlVal(msg.workdir)||null);
        isNewSession = true;
      } else {
        localClaudeId = sanitizeSessionId(existSess.claude_session_id) || undefined;
      }

      // For legacy (no tabId) mode, keep WS-level state in sync
      if (!tabId) { legacySessionId = localSessionId; }

      // Tell client which real session this tab is using (converts temp tab id → real session id)
      ws.send(JSON.stringify({ type:'session_started', sessionId:localSessionId, tabId }));

      // After session_started, use localSessionId as the effective tabId for all subsequent events.
      // The client renames the tab from tempId → localSessionId upon receiving session_started,
      // so further events must carry localSessionId (not the original temp tabId) to be routed correctly.
      effectiveTabId = tabId ? localSessionId : null;
      // Migrate _tabBusy/_tabAbort keys from tempId to real session id
      if (tabId && tabId !== localSessionId) {
        ws._tabBusy[localSessionId] = true; delete ws._tabBusy[tabId];
        if (ws._tabQueue[tabId]) {
          const q = ws._tabQueue[tabId];
          // Fix: update tabId + sessionId in queued messages so they continue in the same session,
          // not create new ones. Without this, msgs queued before session_started (on a new tab)
          // had tabId:'new-abc'/sessionId:null and each created a fresh phantom session on dequeue.
          for (const m of q) { m.tabId = localSessionId; m.sessionId = localSessionId; }
          ws._tabQueue[localSessionId] = q; delete ws._tabQueue[tabId]; sessionQueues.set(localSessionId, q); sessionQueues.delete(tabId);
        }
      }

      const { text:userMessage, attachments=[], skills:sIds=[], mcpServers:mIds=[], mode='auto', agentMode='single', model='sonnet', maxTurns=30, workdir=null, reply_to=null, retry=false, autoSkill=false } = msg;

      let replyQuote = '';
      if (reply_to && reply_to.content) {
        const snippet = String(reply_to.content).slice(0, 200);
        replyQuote = `[Replying to: ${reply_to.role || 'user'}: ${snippet}]\n\n`;
      }
      const replyToId = sqlVal(reply_to?.id ?? null);
      const engineMessage = replyQuote + userMessage;
      // Enrich SSH attachments with stored auth credentials (key path or decrypted password)
      const enrichedAttachments = attachments.map(att => {
        if (att.type !== 'ssh' || !att.hostId) return att;
        const hosts = loadRemoteHosts();
        const rh = hosts.find(h => h.id === att.hostId);
        if (!rh) return att;
        return { ...att, sshKeyPath: rh.sshKeyPath || '', password: decryptPassword(rh.password) || '' };
      });
      const userContent = buildUserContent(engineMessage, enrichedAttachments);

      if (!retry) {
        const attJson = attachments.length ? JSON.stringify(attachments.map(a => ({ type: a.type, name: a.name, base64: a.base64 }))) : null;
        try { stmts.addMsg.run(localSessionId,'user','text',userMessage,null,null,replyToId,attJson); }
        catch (e) { log.error('addMsg(user) failed', { sessionId: localSessionId, replyToId, attJsonLen: attJson?.length, err: e.message, stack: e.stack }); throw e; }
      } else {
        try { stmts.incrementRetry.run(localSessionId); }
        catch (e) { log.error('incrementRetry failed', { sessionId: localSessionId, err: e.message, stack: e.stack }); }
      }

      // Load config early — needed for skill classification
      const config = loadMergedConfig();

      // Create AbortController EARLY — before classification — so that pressing
      // Stop during the 10-15s classification phase actually aborts this processChat.
      // Previously it was created AFTER classification, causing a race: Stop reset
      // _tabBusy but couldn't abort, allowing a second processChat to start in parallel.
      const abortController = new AbortController();
      myAbortController = abortController;
      if (effectiveTabId) ws._tabAbort[effectiveTabId] = abortController;
      else ws._abort = abortController;

      // ─── LLM-based task classification ──────────────────────────────
      // When autoSkill=true, classify the user message with haiku (~10-15s via CLI).
      // Returns both specialist skills AND a short chat title in one call.
      // Skip on resumed sessions (localClaudeId set) — skills already baked into session
      // context, no need to pay for a Haiku call on every subsequent message.
      let effectiveSkills = sIds;
      let classifiedTitle = '';
      const shouldClassify = autoSkill && !localClaudeId;
      log.info('[classify] start', { autoSkill, shouldClassify, sIds, msgLen: userMessage.length });
      if (shouldClassify) {
        try {
          proxy.send(JSON.stringify({ type:'agent_status', status:'⚡ Classifying task...', statusKey:'status.classifying', tabId: effectiveTabId }));
          const classification = await classifyTask(userMessage, sIds, config, workdir || WORKDIR);
          classifiedTitle = classification.title;
          // Merge classified skills into existing (not replace)
          const merged = new Set(sIds);
          for (const s of classification.skills) merged.add(s);
          effectiveSkills = [...merged];
          log.info('[classify] done', { newSkills: classification.skills, merged: effectiveSkills, title: classifiedTitle });
          if (effectiveSkills.length > 0) {
            proxy.send(JSON.stringify({ type:'skills_auto', skills: effectiveSkills, tabId: effectiveTabId }));
          }
        } catch (err) {
          log.error('[classify] Failed', { err: err.message });
          if (!effectiveSkills.length) effectiveSkills = config.skills['auto-mode'] ? ['auto-mode'] : [];
        }
      }

      // Bail out early if user pressed Stop during classification
      if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      try { stmts.updateConfig.run(JSON.stringify(mIds),JSON.stringify(effectiveSkills),sqlVal(mode),sqlVal(agentMode),sqlVal(model),sqlVal(workdir)||null,localSessionId); }
      catch (e) { log.error('updateConfig failed', { sessionId: localSessionId, mode, agentMode, model, mIdsLen: mIds.length, skillsLen: effectiveSkills.length, err: e.message, stack: e.stack }); throw e; }

      // Auto-title: use LLM-generated title if available, otherwise truncate message
      if (isNewSession || DEFAULT_SESSION_TITLES.has(existSess?.title)) {
        const title = classifiedTitle || (userMessage.substring(0,60)+(userMessage.length>60?'...':''));
        try { stmts.updateTitle.run(title, localSessionId); } catch (e) { log.error('updateTitle failed', { err: e.message }); }
        ws.send(JSON.stringify({ type:'session_title', sessionId:localSessionId, title, tabId: effectiveTabId }));
      }

      // Build system prompt — cached by skill combination, skill files cached in memory.
      // BMAD Master is always included as the default orchestrator
      if (config.skills['bmad-master'] && !effectiveSkills.includes('bmad-master')) {
        effectiveSkills = ['bmad-master', ...effectiveSkills];
      }
      // Skipped on resumed sessions (localClaudeId set): claude-cli.js blocks --system-prompt
      // when --resume is used (cryptographic signatures on thinking blocks), so building
      // it would be pure waste. System prompt was already set on the first turn of this session.
      const systemPrompt = localClaudeId ? undefined : buildSystemPrompt(effectiveSkills, config);

      const mcpServers = {};
      for (const mid of mIds) {
        const m = config.mcpServers[mid];
        if (!m) continue;
        if (m.type === 'http' || m.type === 'sse' || m.url) {
          mcpServers[mid] = { type: m.type || 'http', url: m.url, ...(m.headers ? { headers: m.headers } : {}), ...(m.env ? { env: expandTildeInObj(m.env) } : {}) };
        } else {
          mcpServers[mid] = { command: m.command, args: m.args || [], env: expandTildeInObj(m.env || {}) };
        }
      }

      // --- Internal MCPs (always injected, invisible to user) ---
      mcpServers['_ccs_ask_user'] = {
        command: 'node',
        args: [path.join(__dirname, 'mcp-ask-user.js')],
        env: {
          ASK_USER_SERVER_URL: `http://127.0.0.1:${PORT}`,
          ASK_USER_SESSION_ID: localSessionId,
          ASK_USER_SECRET: ASK_USER_SECRET,
        },
      };

      mcpServers['_ccs_notify'] = {
        command: 'node',
        args: [path.join(__dirname, 'mcp-notify.js')],
        env: {
          NOTIFY_SERVER_URL: `http://127.0.0.1:${PORT}`,
          NOTIFY_SESSION_ID: localSessionId,
          NOTIFY_SECRET: NOTIFY_SECRET,
        },
      };
      mcpServers['_ccs_set_ui_state'] = {
        command: 'node',
        args: [path.join(__dirname, 'mcp-set-ui-state.js')],
        env: {
          SET_UI_STATE_SERVER_URL: `http://127.0.0.1:${PORT}`,
          SET_UI_STATE_SESSION_ID: localSessionId,
          SET_UI_STATE_SECRET: SET_UI_STATE_SECRET,
        },
      };

      proxy.send(JSON.stringify({ type:'status', status:'thinking', mode, agentMode, model, tabId: effectiveTabId }));

      // Register task in activeTasks so it survives client disconnect/reload
      try { stmts.setLastUserMsg.run(userMessage, localSessionId); } catch (e) { log.error('setLastUserMsg failed', { err: e.message }); }
      chatBuffers.set(localSessionId, ''); // reset buffer for this session
      activeTasks.set(localSessionId, { proxy, abortController, cleanupTimer: null });

      const params = {
        prompt: engineMessage,
        userContent,
        systemPrompt,
        mcpServers,
        model,
        maxTurns,
        ws: proxy,
        sessionId: localSessionId,
        abortController,
        claudeSessionId: localClaudeId,
        mode,
        workdir: workdir || WORKDIR,
        tabId: effectiveTabId,
      };

      let newCid;
      // Check if the active project is a remote SSH project
      const _activeProj = loadProjects().find(p => p.workdir === (workdir || WORKDIR) && p.isRemote);
      if (_activeProj) {
        // Route to SSH engine — runs claude on remote server
        const sshResult = await runSshSingle({
          ...params,
          remoteHost:   _activeProj.remoteHost,
          remoteWorkdir: _activeProj.workdir,
          sshKeyPath:   _activeProj.sshKeyPath || '',
          password:     decryptPassword(_activeProj.password) || '',
          port:         _activeProj.port || 22,
        });
        newCid = sshResult.cid;
        // Track remote host on session for UI indicators
        try { db.prepare(`UPDATE sessions SET remote_host=? WHERE id=?`).run(_activeProj.remoteHost, localSessionId); } catch {}
      } else if (agentMode==='multi') {
        newCid = await runMultiAgent(params);
      } else if (agentMode==='party') {
        newCid = await runPartyMode(params);
      } else {
        const result = await runCliSingle(params);
        newCid = result.cid;
      }
      if (newCid) { try { stmts.updateClaudeId.run(newCid, localSessionId); } catch (e) { log.error('updateClaudeId failed', { cid: String(newCid).substring(0,50), sessionId: localSessionId, err: e.message, stack: e.stack }); } }

      proxy.send(JSON.stringify({ type:'done', tabId: effectiveTabId, duration: Date.now() - _chatStartedAt }));
      proxy.send(JSON.stringify({ type:'files_changed' }));
      // Notify Telegram (if task was NOT started from Telegram — those get notified via TelegramProxy)
      if (telegramBot && telegramBot.isRunning()) {
        const _tgTask = activeTasks.get(localSessionId);
        if (!_tgTask || _tgTask.source !== 'telegram') {
          const _tgSess = stmts.getSession.get(localSessionId);
          telegramBot.notifyTaskComplete({
            sessionId: localSessionId,
            title: _tgSess?.title || 'Chat',
            status: 'done',
            duration: Date.now() - _chatStartedAt
          });
        }
      }
    } catch(err) {
      if(err.name==='AbortError') proxy.send(JSON.stringify({ type:'agent_status', status:'Stopped', statusKey:'status.stopped', tabId: effectiveTabId }));
      else { log.error('chat error', { message: err.message, name: err.name, stack: err.stack }); proxy.send(JSON.stringify({ type:'error', error:err.message, tabId: effectiveTabId })); }
      proxy.send(JSON.stringify({ type:'done', tabId: effectiveTabId, duration: Date.now() - _chatStartedAt }));
      // Notify Telegram about error (if task was NOT started from Telegram)
      if (telegramBot && telegramBot.isRunning() && err.name !== 'AbortError') {
        const _tgTask = activeTasks.get(localSessionId);
        if (!_tgTask || _tgTask.source !== 'telegram') {
          telegramBot.notifyTaskComplete({
            sessionId: localSessionId,
            title: stmts.getSession.get(localSessionId)?.title || 'Chat',
            status: 'error',
            error: err.message
          });
        }
      }
    } finally {
      activeTasks.delete(localSessionId);
      chatBuffers.delete(localSessionId); // cleanup in-memory buffer
      // Clean up any pending ask_user questions for this session
      for (const [rid, entry] of pendingAskUser) {
        if (entry.sessionId === localSessionId) {
          clearTimeout(entry.timer);
          pendingAskUser.delete(rid);
          entry.resolve({ answer: '[Session ended]' });
        }
      }
      try { stmts.clearLastUserMsg.run(localSessionId); } catch {}
      // Detect stale finally: if a stop happened, ws._tabAbort was deleted or replaced
      // by a new processChat. In that case, another processChat now owns this tab — our
      // cleanup would stomp on its _tabBusy flag. Skip cleanup and let the new owner handle it.
      const isStale = myAbortController !== null && (effectiveTabId
        ? ws._tabAbort?.[effectiveTabId] !== myAbortController
        : ws._abort !== myAbortController);
      if (!isStale && effectiveTabId) {
        ws._tabBusy[effectiveTabId] = false;
        delete ws._tabAbort[effectiveTabId];
        const tabQ = ws._tabQueue[effectiveTabId] || [];
        if (tabQ.length > 0) {
          const next = tabQ.shift();
          if (tabQ.length === 0) { delete ws._tabQueue[effectiveTabId]; sessionQueues.delete(effectiveTabId); }
          try { ws.send(queuePayload(effectiveTabId)); } catch {}
          processChat(next).catch(err => log.error('processChat tab-queue error', { message: err.message }));
        } else {
          delete ws._tabQueue[effectiveTabId];
          sessionQueues.delete(effectiveTabId);
          try { ws.send(JSON.stringify({ type: 'queue_update', tabId: effectiveTabId, pending: 0, items: [] })); } catch {}
          // Fix: WS-reconnect scenario — old WS had empty queue but a newer WS (page refresh / network blip)
          // may have restored queue items from sessionQueues into its own _tabQueue (shared-ref).
          // Since the shared-ref persists after sessionQueues.delete, check sessionWatchers for a live
          // WS with pending items and fire _dequeue_next on it so the queue isn't stuck.
          setImmediate(() => {
            const watchers = sessionWatchers.get(effectiveTabId);
            if (!watchers) return;
            for (const liveWs of watchers) {
              if (liveWs !== ws && liveWs.readyState === 1 &&
                  liveWs._tabQueue?.[effectiveTabId]?.length > 0 &&
                  !liveWs._tabBusy?.[effectiveTabId]) {
                liveWs.emit('message', JSON.stringify({ type: '_dequeue_next', tabId: effectiveTabId }));
                break;
              }
            }
          });
        }
      } else if (!isStale) {
        ws._busy = false;
        ws._abort = null;
        if (ws._queue.length > 0) {
          const next = ws._queue.shift();
          try { ws.send(queuePayload(null)); } catch {}
          try { await processChat(next); } catch (err) { log.error('processChat legacy-queue error', { message: err.message }); }
        } else {
          try { ws.send(JSON.stringify({ type: 'queue_update', pending: 0, items: [] })); } catch {}
        }
      } else if (isStale && effectiveTabId) {
        // Page refresh scenario: task finished on old (closed) WS but queue items
        // persist in sessionQueues. Trigger dequeue on the live WS that now owns this session.
        const pendingQueue = sessionQueues.get(effectiveTabId);
        if (pendingQueue?.length > 0) {
          setImmediate(() => {
            const watchers = sessionWatchers.get(effectiveTabId);
            if (!watchers) return;
            for (const liveWs of watchers) {
              if (liveWs.readyState === 1) {
                liveWs.emit('message', JSON.stringify({ type: '_dequeue_next', tabId: effectiveTabId }));
                break;
              }
            }
          });
        }
      }
    }
  }

  ws.on('message', async (raw) => {
    let msg; try{msg=JSON.parse(raw)}catch{return}

    if (msg.type==='start_session') {
      legacySessionId = msg.sessionId || genId();
      const existing = stmts.getSession.get(legacySessionId);
      if (existing) {
        legacyClaudeId = sanitizeSessionId(existing.claude_session_id) || undefined;
        // Don't send session_started for existing sessions — the client's session_started
        // handler resets streaming.el which destroys the just-restored _bgTxt bubble on tab switch.
        // session_started is only needed for NEW sessions (to map temp tab ID → real session ID).
      } else {
        stmts.createSession.run(legacySessionId,i18nSession(),'[]','[]',sqlVal(msg.mode)||'auto',sqlVal(msg.agentMode)||'single',sqlVal(msg.model)||'sonnet',sqlVal(msg.engine)||null,null);
        ws.send(JSON.stringify({ type:'session_started', sessionId:legacySessionId }));
      }
      return;
    }

    // Internal: dequeue next item after page refresh (triggered by stale finally block via setImmediate)
    // Internal: dequeue next queued message after page refresh or task completion on stale WS.
    // Triggered via setImmediate + emit('message') because processChat is scoped to each WS connection.
    if (msg.type === '_dequeue_next') {
      const tabId = msg.tabId;
      if (!tabId) return;
      // Guard: session may have been deleted while dequeue was pending
      if (!stmts.getSession.get(tabId)) { sessionQueues.delete(tabId); return; }
      if (ws._tabQueue[tabId]?.length > 0 && !ws._tabBusy[tabId]) {
        const next = ws._tabQueue[tabId].shift();
        if (ws._tabQueue[tabId].length === 0) { delete ws._tabQueue[tabId]; sessionQueues.delete(tabId); }
        ws.send(queuePayload(tabId));
        processChat(next).catch(err => log.error('processChat dequeue error', { message: err.message }));
      }
      return;
    }

    if (msg.type==='chat') {
      const tabId = msg.tabId || null;
      if (tabId) {
        // Per-tab concurrency: queue if this specific tab is busy
        if (ws._tabBusy[tabId]) {
          if (!ws._tabQueue[tabId]) {
            ws._tabQueue[tabId] = sessionQueues.get(tabId) || [];
            sessionQueues.set(tabId, ws._tabQueue[tabId]);
          }
          // Prevent unbounded queue growth
          if (ws._tabQueue[tabId].length >= 20) {
            ws.send(JSON.stringify({ type: 'error', error: 'Queue full (max 20). Wait for current task to finish.', tabId }));
            return;
          }
          msg._queueId = ++ws._queueIdCounter;
          ws._tabQueue[tabId].push(msg);
          ws.send(queuePayload(tabId));
          return;
        }
      } else {
        // Legacy single-tab mode
        if (ws._busy) {
          msg._queueId = ++ws._queueIdCounter;
          ws._queue.push(msg);
          ws.send(queuePayload(null));
          return;
        }
      }
      processChat(msg).catch(err => log.error('processChat error', { message: err.message })); // don't await — allows parallel tabs
      return;
    }

    if (msg.type==='stop') {
      const tabId = msg.tabId;
      if (tabId && ws._tabAbort && ws._tabAbort[tabId]) {
        // Stop specific tab — immediately mark as not busy so the next chat
        // message is processed directly instead of being queued (race condition fix).
        // The stale finally guard in processChat prevents the old finally from
        // resetting _tabBusy after a new processChat has already started.
        ws._tabBusy[tabId] = false;
        if (ws._tabQueue) ws._tabQueue[tabId] = [];
        sessionQueues.delete(tabId);
        ws._tabAbort[tabId].abort();
        delete ws._tabAbort[tabId];
      } else if (!tabId) {
        // Legacy (no-tab) stop — only abort the legacy controller, leave tab-mode untouched
        ws._queue = [];
        if (ws._abort) ws._abort.abort();
      }
      // Clear last_user_msg so reconnect doesn't auto-retry a user-stopped task
      if (tabId) { try { stmts.clearLastUserMsg.run(tabId); } catch {} }
      // tabId present but no active controller → tab is idle, nothing to abort
      // Also stop any Kanban task running under this session
      if (tabId) {
        const runningTask = db.prepare(`SELECT id, worker_pid FROM tasks WHERE session_id=? AND status='in_progress' LIMIT 1`).get(tabId);
        if (runningTask) {
          stoppingTasks.add(runningTask.id);
          db.prepare(`UPDATE tasks SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(runningTask.id);
          const ctrl = runningTaskAborts.get(runningTask.id);
          if (ctrl) { ctrl.abort(); }
          else if (runningTask.worker_pid) { killByPid(runningTask.worker_pid); }
          log.info('ws stop aborted kanban task', { taskId: runningTask.id, sessionId: tabId });
        }
      }
      // Resolve any pending ask_user questions for this session with "[Cancelled]"
      if (tabId) {
        for (const [rid, entry] of pendingAskUser) {
          if (entry.sessionId === tabId) {
            clearTimeout(entry.timer);
            pendingAskUser.delete(rid);
            entry.resolve({ answer: '[Cancelled]' });
          }
        }
      }
    }

    // ─── Queue management: remove / edit ────────────────────────────────────
    if (msg.type === 'queue_remove') {
      const { queueId, tabId: rmTabId } = msg;
      if (queueId) {
        // Remove from per-tab queue
        for (const [tid, queue] of Object.entries(ws._tabQueue || {})) {
          const idx = queue.findIndex(m => m.queueId === queueId);
          if (idx !== -1) {
            queue.splice(idx, 1);
            if (queue.length === 0) sessionQueues.delete(tid);
            ws.send(JSON.stringify({ type: 'queue_removed', queueId, tabId: tid }));
            ws.send(queuePayload(tid));
            break;
          }
        }
        // Also check legacy queue
        const li = ws._queue.findIndex(m => m.queueId === queueId);
        if (li !== -1) {
          ws._queue.splice(li, 1);
          ws.send(JSON.stringify({ type: 'queue_removed', queueId }));
          ws.send(queuePayload(null));
        }
      }
      return;
    }

    if (msg.type === 'queue_edit') {
      const { queueId, text } = msg;
      if (queueId && text != null) {
        // Update in per-tab queues
        for (const queue of Object.values(ws._tabQueue || {})) {
          const item = queue.find(m => m.queueId === queueId);
          if (item) { item.text = text; break; }
        }
        // Also check legacy queue
        const legacyItem = ws._queue.find(m => m.queueId === queueId);
        if (legacyItem) legacyItem.text = text;
        ws.send(JSON.stringify({ type: 'queue_edited', queueId }));
      }
      return;
    }

    // ─── Ask User responses ──────────────────────────────────────────────────
    if (msg.type === 'ask_user_response') {
      const entry = pendingAskUser.get(msg.requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pendingAskUser.delete(msg.requestId);
        entry.resolve({ answer: msg.answer || '[Empty response]' });
        // Clean up Telegram pending ask state (prevents stale intercept swallowing next message)
        _clearTelegramAskState(entry.sessionId);
      }
      return;
    }

    if (msg.type === 'ask_user_cancel') {
      const entry = pendingAskUser.get(msg.requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pendingAskUser.delete(msg.requestId);
        entry.resolve({ answer: '[Skipped by user]' });
        _clearTelegramAskState(entry.sessionId);
      }
      return;
    }

    if (msg.type==='new_session') {
      ws._queue = [];
      if (ws._abort) ws._abort.abort();
      legacySessionId=null; legacyClaudeId=undefined;
      ws.send(JSON.stringify({ type:'session_reset' }));
    }

    if (msg.type==='new_session_silent') {
      // Reset server state for a specific tab without sending session_reset back
      // (used when client auto-creates a tab and sends first message)
      // Nothing to do here since processChat now uses per-message sessionId
      // Just clear legacy state if no tabId involved
    }

    if (msg.type === 'subscribe_session') {
      const { sessionId, noCatchUp } = msg;
      if (sessionId) {
        // Allow multi-session watching: do NOT remove from other sessions.
        // Cleanup happens on WS disconnect (ws.on('close') handler).
        if (!sessionWatchers.has(sessionId)) sessionWatchers.set(sessionId, new Set());
        sessionWatchers.get(sessionId).add(ws);
        // Catch up new subscriber with any already-running task (unless suppressed)
        if (!noCatchUp) {
          const runningTask = db.prepare(
            `SELECT * FROM tasks WHERE session_id=? AND status IN ('in_progress','bmad_workflow','bmad_brainstorm','bmad_prd','bmad_architecture','bmad_implementation','bmad_qa') LIMIT 1`
          ).get(sessionId);
          if (runningTask && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'task_started', taskId: runningTask.id, title: runningTask.title, tabId: sessionId }));
            const buf = taskBuffers.get(runningTask.id);
            if (buf) ws.send(JSON.stringify({ type: 'text', text: buf, tabId: sessionId }));
          } else if (!activeTasks.has(sessionId)) {
            // Check for interrupted chat session (server crash recovery).
            // Only when no live task exists in memory — prevents false interrupts on WS hiccup.
            const sess = stmts.getSession.get(sessionId);
            if (sess?.last_user_msg && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'task_interrupted', sessionId, tabId: sessionId, prompt: sess.last_user_msg, retryCount: sess.retry_count || 0 }));
            }
          } else {
            const activeTask = activeTasks.get(sessionId);
            // Guard: abort() may have been called (timer fired or user stopped) but the
            // subprocess hasn't exited yet so the entry is still in activeTasks.
            // Reattaching the proxy to a dying stream would leave the client waiting
            // forever for output that will never arrive.
            if (activeTask.abortController.signal.aborted) {
              // Stream is being killed — treat as interrupted so client can retry.
              const sess = stmts.getSession.get(sessionId);
              if (sess?.last_user_msg && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'task_interrupted', sessionId, tabId: sessionId, prompt: sess.last_user_msg, retryCount: sess.retry_count || 0 }));
              }
            } else {
              // Chat task is running normally — cancel cleanup timer and reattach proxy.
              if (activeTask.cleanupTimer) { clearTimeout(activeTask.cleanupTimer); activeTask.cleanupTimer = null; }
              // Replay ALL accumulated text from the start so the client never has a gap.
              // chatBuffers holds everything from onText since the session started.
              const chatBuf = chatBuffers.get(sessionId);
              if (chatBuf && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'text', text: chatBuf, tabId: sessionId, catchUp: true }));
              }
              // Keep non-text events from proxy buffer (tool activity, done, error, status).
              // Text is already replayed via chatBuf above — discard text/thinking to avoid duplication.
              activeTask.proxy._buffer = activeTask.proxy._buffer.filter(raw => {
                try { const d = JSON.parse(raw); return d.type !== 'text' && d.type !== 'thinking'; } catch { return false; }
              });
              activeTask.proxy.attach(ws);
              ws._tabAbort[sessionId] = activeTask.abortController;
              if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'task_resumed', sessionId, tabId: sessionId }));
              // Re-send any pending ask_user questions for this session
              for (const [rid, entry] of pendingAskUser) {
                if (entry.sessionId === sessionId && ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'ask_user', requestId: rid, question: entry.question, questions: entry.questions, tabId: sessionId }));
                }
              }
            }
          }
        }
        // Restore queue from persistent storage (survives page refresh / WS reconnect)
        if (!ws._tabQueue[sessionId]?.length && sessionQueues.has(sessionId) && sessionQueues.get(sessionId).length > 0) {
          ws._tabQueue[sessionId] = sessionQueues.get(sessionId); // shared ref
        }
        // Re-send queue state so client can restore queued message badges after tab switch
        if (ws._tabQueue?.[sessionId]?.length > 0 && ws.readyState === 1) {
          ws.send(queuePayload(sessionId));
          // If the session is idle (task already finished while WS was disconnected),
          // immediately start processing the first queued item.
          if (!ws._tabBusy[sessionId] && !activeTasks.has(sessionId)) {
            setImmediate(() => {
              if (ws.readyState === 1) {
                ws.emit('message', JSON.stringify({ type: '_dequeue_next', tabId: sessionId }));
              }
            });
          }
        }
      }
      return;
    }

    // ─── Task Dispatch: decompose + dispatch to Kanban ─────────────────────
    if (msg.type === 'dispatch_plan') {
      (async () => {
        try {
          const { text, plan, agents, sessionId, workdir, model, tabId } = msg;
          let finalPlan, finalAgents;

          // Save user's dispatch text to DB (so it survives page refresh)
          if (text && sessionId) {
            try { stmts.addMsg.run(sessionId, 'user', 'text', text, null, null, null, null); } catch {}
          }

          if (plan && agents?.length) {
            // Mode 1: Plan already provided (from agent_plan card "📋 Kanban" button)
            finalPlan = plan;
            finalAgents = agents;
          } else if (text) {
            // Mode 2: Decompose first (from "Plan" agent mode)
            ws.send(JSON.stringify({ type: 'agent_status', agent: 'orchestrator', status: 'Planning...', statusKey: 'agent.planning', ...(tabId ? { tabId } : {}) }));

            const effectiveWorkdir = workdir || WORKDIR;
            const cli = new ClaudeCLI({ cwd: effectiveWorkdir });
            const planPrompt = `You are a lead architect. Break this into 2-5 subtasks. Respond ONLY in JSON:\n{"plan":"...","agents":[{"id":"agent-1","role":"...","task":"...","depends_on":[]}]}\n\nTASK: ${text}`;

            const session = sessionId ? stmts.getSession.get(sessionId) : null;
            let planText = '';

            await new Promise(resolve => {
              let done = false;
              cli.send({ prompt: planPrompt, sessionId: sanitizeSessionId(session?.claude_session_id), model: model || 'sonnet', maxTurns: 1, allowedTools: [] })
                .onText(t => { planText += t; })
                .onError(() => { if (!done) { done = true; resolve(); } })
                .onDone(() => { if (!done) { done = true; resolve(); } });
            });

            try {
              const m = planText.match(/\{[\s\S]*\}/);
              const parsed = m ? JSON.parse(m[0]) : null;
              finalPlan = parsed?.plan;
              finalAgents = parsed?.agents;
            } catch {}

            if (!finalAgents?.length) {
              ws.send(JSON.stringify({ type: 'error', error: 'Failed to decompose task into subtasks', ...(tabId ? { tabId } : {}) }));
              return;
            }

            // Show plan in chat & save as agent_plan message (restorable on refresh)
            ws.send(JSON.stringify({ type: 'agent_plan', plan: finalPlan, agents: finalAgents.map(a => ({ id: a.id, role: a.role, task: a.task })), dispatched: true, ...(tabId ? { tabId } : {}) }));
            try {
              if (sessionId) {
                const agentPlanJson = JSON.stringify({ plan: finalPlan, agents: finalAgents.map(a => ({ id: a.id, role: a.role, task: a.task })), dispatched: true });
                stmts.addMsg.run(sessionId, 'assistant', 'agent_plan', agentPlanJson, null, 'orchestrator', null, null);
              }
            } catch {}
          } else {
            ws.send(JSON.stringify({ type: 'error', error: 'No plan or text provided for dispatch', ...(tabId ? { tabId } : {}) }));
            return;
          }

          // Save agent_plan to DB for Mode 1 (plan from 📋 Kanban button — wasn't saved above)
          if (plan && agents?.length && sessionId) {
            try {
              const agentPlanJson = JSON.stringify({ plan: finalPlan, agents: finalAgents.map(a => ({ id: a.id, role: a.role, task: a.task })), dispatched: true });
              stmts.addMsg.run(sessionId, 'assistant', 'agent_plan', agentPlanJson, null, 'orchestrator', null, null);
            } catch {}
          }

          // Circular dependency check
          const adj = {};
          for (const a of finalAgents) adj[a.id] = a.depends_on || [];
          const _v = new Set(), _s = new Set();
          function _cyc(n) { if (_s.has(n)) return true; if (_v.has(n)) return false; _v.add(n); _s.add(n); for (const d of (adj[n]||[])) { if (_cyc(d)) return true; } _s.delete(n); return false; }
          if (finalAgents.some(a => _cyc(a.id))) {
            ws.send(JSON.stringify({ type: 'error', error: 'Circular dependency detected in plan', ...(tabId ? { tabId } : {}) }));
            return;
          }

          // Create chain session + tasks
          const chainId = genId();
          const source = sessionId ? stmts.getSession.get(sessionId) : null;
          const chainSessionId = genId();
          stmts.createSession.run(
            chainSessionId,
            (finalPlan || 'Task chain').substring(0, 200),
            source?.active_mcp || '[]',
            source?.active_skills || '[]',
            'auto', 'single', sqlVal(model) || 'sonnet', 'cli',
            sqlVal(workdir) || null
          );
          // Chain gets its OWN Claude session — first task starts fresh,
          // subsequent tasks --resume from the chain's session (NOT the source chat's).
          // Sharing claude_session_id with source chat causes context mixing chaos.

          // First pass: assign real IDs (handles forward references in depends_on)
          const idMap = {};
          for (const a of finalAgents) idMap[a.id] = genId();
          const created = [];

          db.transaction(() => {
            for (let i = 0; i < finalAgents.length; i++) {
              const a = finalAgents[i];
              const taskId = idMap[a.id];
              const realDeps = (a.depends_on || []).map(d => idMap[d]).filter(Boolean);
              const _tn5 = stmts.nextTaskNumber.get(sqlVal(workdir) || '').next_num;
              stmts.createTask.run(
                taskId,
                (a.role || 'Subtask').substring(0, 200),
                (a.task || '').substring(0, 2000),
                '', 'todo', i, chainSessionId, sqlVal(workdir) || null,
                sqlVal(model) || 'sonnet', 'auto', 'single', 30, null,
                realDeps.length ? JSON.stringify(realDeps) : null,
                chainId, sessionId || null,
                null, null, null, _tn5, null  // scheduled_at, recurrence, recurrence_end_at, task_number, dep_group
              );
              created.push(stmts.getTask.get(taskId));
            }
          })();

          setImmediate(processQueue);

          // Notify client
          const _kanbanCtx = tabId ? getNotificationContext(tabId) : { sessionTitle: null, projectName: null };
          ws.send(JSON.stringify({
            type: 'notification', level: 'success',
            title: 'Dispatched to Kanban',
            detail: `${created.length} tasks created`,
            ...(tabId ? { tabId } : {}),
            sessionTitle: _kanbanCtx.sessionTitle, projectName: _kanbanCtx.projectName,
          }));

          // Send chain info so frontend can render progress widget
          ws.send(JSON.stringify({
            type: 'chain_dispatched',
            chain_id: chainId,
            session_id: chainSessionId,
            tasks: created.map(t => ({ id: t.id, title: t.title, status: t.status, depends_on: t.depends_on })),
            ...(tabId ? { tabId } : {}),
          }));

          // Auto-watch the chain session to stream results back to source chat
          if (!sessionWatchers.has(chainSessionId)) sessionWatchers.set(chainSessionId, new Set());
          sessionWatchers.get(chainSessionId).add(ws);

          log.info('Plan dispatched via WS', { chainId, count: created.length });
        } catch (e) {
          log.error('dispatch_plan error', { error: e.message });
          ws.send(JSON.stringify({ type: 'error', error: `Dispatch failed: ${e.message}`, ...(msg.tabId ? { tabId: msg.tabId } : {}) }));
        }
      })();
      return;
    }

    if (msg.type === 'resume_task') {
      const { sessionId, tabId } = msg;
      const task = activeTasks.get(sessionId);
      if (task) {
        // Guard: abort() may have been called (user stopped, or idle timer fired) but the
        // subprocess hasn't exited yet so the entry is still in activeTasks.
        if (task.abortController.signal.aborted) {
          const session = stmts.getSession.get(sessionId);
          if (session?.last_user_msg) {
            ws.send(JSON.stringify({ type: 'task_interrupted', sessionId, tabId, prompt: session.last_user_msg, retryCount: session.retry_count || 0 }));
          } else {
            ws.send(JSON.stringify({ type: 'task_lost', sessionId, tabId }));
          }
        } else {
          // Task is still running — cancel cleanup timer and re-attach to new WS
          if (task.cleanupTimer) { clearTimeout(task.cleanupTimer); task.cleanupTimer = null; }
          // Replay all accumulated text before re-attaching so the client has no gap
          const chatBuf = chatBuffers.get(sessionId);
          if (chatBuf && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'text', text: chatBuf, tabId: tabId || sessionId, catchUp: true }));
          }
          // Keep non-text events (tool, done, error, status) — discard text/thinking
          // to avoid duplication with chatBuf replay above
          task.proxy._buffer = task.proxy._buffer.filter(raw => {
            try { const d = JSON.parse(raw); return d.type !== 'text' && d.type !== 'thinking'; } catch { return false; }
          });
          task.proxy.attach(ws);
          if (tabId) ws._tabAbort[tabId] = task.abortController;
          ws.send(JSON.stringify({ type: 'task_resumed', sessionId, tabId }));
        }
      } else {
        // Task not in memory — check if it was interrupted (server crash)
        const session = stmts.getSession.get(sessionId);
        if (session?.last_user_msg) {
          ws.send(JSON.stringify({ type: 'task_interrupted', sessionId, tabId, prompt: session.last_user_msg, retryCount: session.retry_count || 0 }));
        } else {
          ws.send(JSON.stringify({ type: 'task_lost', sessionId, tabId }));
        }
      }
      return;
    }
  });

  ws.on('close', () => {
    log.info('ws disconnected', { clients: wss.clients.size - 1 });
    ws._queue = [];
    // Clean up session watchers
    for (const [sid, set] of sessionWatchers) { set.delete(ws); if (!set.size) sessionWatchers.delete(sid); }
    // Detach from active task proxies — tasks keep running in background
    for (const [sid, task] of activeTasks) {
      if (task.proxy._ws === ws) {
        task.proxy.detach();
        if (!task.cleanupTimer) {
          task.cleanupTimer = setTimeout(() => {
            log.info('task idle timeout, aborting', { sessionId: sid });
            try { task.abortController.abort(); } catch {}
            activeTasks.delete(sid);
          }, TASK_IDLE_TIMEOUT_MS);
        }
      }
    }
    // Abort legacy (no-tab) session tasks only
    if (ws._abort) { ws._abort.abort(); ws._abort = null; }
    // WS-1: clean up per-tab state — abort CLI runs that are NOT tracked in activeTasks.
    // Sessions in activeTasks have a 30-min idle timeout and can be reattached on reconnect.
    for (const [tid, ac] of Object.entries(ws._tabAbort || {})) {
      if (!activeTasks.has(tid)) { try { ac.abort(); } catch {} }
    }
    // Clean up orphaned sessionQueues entries: if no other watcher and no active task,
    // the queue will never be processed — remove to prevent memory leak.
    for (const tid of Object.keys(ws._tabQueue || {})) {
      const watchers = sessionWatchers.get(tid);
      const hasOtherWatcher = watchers && [...watchers].some(w => w !== ws && w.readyState === 1);
      if (!hasOtherWatcher && !activeTasks.has(tid)) {
        sessionQueues.delete(tid);
      }
    }
    ws._tabAbort = {};
    ws._tabBusy  = {};
    ws._tabQueue = {};
  });
});

// Seed default slash commands on startup so they are available immediately
// (not deferred until the first config-write operation).
loadConfig();

// Initialize tunnel manager
initTunnelManager();

// Start Telegram bot if configured
initTelegramBot();

const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  log.info('server started', {
    port:      PORT,
    url:       `http://localhost:${PORT}`,
    workdir:   WORKDIR,
    setup:     auth.isSetupDone() ? 'done' : 'required',
    nodeEnv:   process.env.NODE_ENV || 'development',
    logLevel:  process.env.LOG_LEVEL || 'info',
    telegram:  telegramBot?.isRunning() ? 'running' : 'off',
    tunnel:    tunnelManager?.isRunning() ? tunnelManager.getStatus().publicUrl : 'off',
  });
});

// Safety net: log unhandled rejections instead of crashing the process.
// All known async paths have explicit .catch() — this catches any that slipped through.
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { message: reason?.message || String(reason), stack: reason?.stack });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n⚠️  ${signal} received — shutting down gracefully…`);

  // 0. Stop tunnel first (close external access immediately)
  if (tunnelManager?.isRunning()) { tunnelManager.stop(); }

  // 0b. Stop Telegram bot
  if (telegramBot) { telegramBot.stop(); telegramBot = null; }

  // 1. Abort all running Claude subprocesses
  wss.clients.forEach(ws => {
    ws._queue = [];
    if (ws._abort) { try { ws._abort.abort(); } catch {} }
    if (ws._tabAbort) { Object.values(ws._tabAbort).forEach(ac => { try { ac.abort(); } catch {} }); }
    // Close WebSocket with "server going down" code so clients reconnect
    try { ws.close(1001, 'Server shutting down'); } catch {}
  });

  // 2. Force-exit after 10 s if server.close() hangs (long-lived WS connections)
  const forceExit = setTimeout(() => {
    console.error('⚠️  Force exit after 10 s timeout');
    try { db.pragma('optimize'); db.close(); } catch {}
    process.exit(1);
  }, 10000);
  forceExit.unref(); // don't keep the event loop alive just for this timer

  // 3. Stop accepting new HTTP connections; wait for in-flight requests
  server.close(() => {
    clearTimeout(forceExit);
    try { db.pragma('optimize'); } catch {} // update query planner stats
    db.close();
    console.log('✅ Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
