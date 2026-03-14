/**
 * discord-bmad-bridge.js — Bridge between Discord (via OpenClaw) and Claude Studio BMAD tasks
 * 
 * Provides functions to:
 * 1. Show workflow picker (select menu + buttons)
 * 2. Create tasks from Discord
 * 3. Track active interactive tasks per user
 * 4. Forward replies to awaiting_input tasks
 */
'use strict';

const { execFile } = require('child_process');

const DISCORD_CHANNEL = process.env.OPENCLAW_NOTIFY_CHANNEL || '1479520243385765888';
const STUDIO_URL = process.env.STUDIO_URL || 'http://localhost:3000';

// Active task tracking: maps Discord thread IDs to task info
const activeThreadTasks = new Map();

/**
 * Send a message to Discord via OpenClaw CLI
 */
function sendDiscord(message, target = DISCORD_CHANNEL) {
  return new Promise((resolve, reject) => {
    execFile('openclaw', [
      'message', 'send',
      '--channel', 'discord',
      '--target', target,
      '--message', message
    ], { timeout: 60000 }, (err, stdout) => {
      if (err) {
        console.error('[discord-bmad] Send failed:', err.message);
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Get available BMAD workflows grouped by category
 */
function getWorkflowMenu() {
  return {
    analysis: [
      { value: 'analysis', label: '🔍 Product Brief' },
      { value: 'research', label: '🔬 Research' },
    ],
    planning: [
      { value: 'planning', label: '📋 Create PRD' },
      { value: 'edit-prd', label: '✏️ Edit PRD' },
      { value: 'validate-prd', label: '🔎 Validate PRD' },
      { value: 'ux-design', label: '🎨 UX Design' },
    ],
    solutioning: [
      { value: 'solutioning', label: '🏗️ Architecture + Epics' },
      { value: 'readiness-check', label: '✅ Readiness Check' },
    ],
    implementation: [
      { value: 'sprint-planning', label: '📐 Sprint Planning' },
      { value: 'create-story', label: '📝 Create Story' },
      { value: 'dev-story', label: '💻 Dev Story' },
      { value: 'code-review', label: '🔍 Code Review' },
      { value: 'sprint-status', label: '📊 Sprint Status' },
      { value: 'correct-course', label: '🔄 Correct Course' },
      { value: 'retrospective', label: '🔮 Retrospective' },
      { value: 'quick-spec', label: '⚡ Quick Spec' },
      { value: 'quick-dev', label: '⚡ Quick Dev' },
    ],
    tools: [
      { value: 'document-project', label: '📚 Document Project' },
      { value: 'generate-context', label: '📑 Generate Context' },
      { value: 'e2e-tests', label: '🧪 E2E Tests' },
      { value: 'shard', label: '✂️ Shard Document' },
    ]
  };
}

/**
 * Format workflow list as a readable message
 */
function formatWorkflowList() {
  const menu = getWorkflowMenu();
  const lines = ['**🔮 BMAD Workflows**\n'];
  const labels = {
    analysis: '📊 Analysis',
    planning: '📋 Planning', 
    solutioning: '🏗️ Solutioning',
    implementation: '💻 Implementation',
    tools: '🔧 Tools'
  };
  
  for (const [cat, items] of Object.entries(menu)) {
    lines.push(`**${labels[cat]}**`);
    items.forEach(w => lines.push(`  \`${w.value}\` — ${w.label}`));
    lines.push('');
  }
  
  lines.push('**Usage:** `bmad <workflow> <project> [description]`');
  lines.push('**Example:** `bmad quick-spec "HMIS Lite" Fix pharmacy queue UI`');
  return lines.join('\n');
}

/**
 * Parse a bmad command from a Discord message
 * Format: bmad <workflow> <project-name> [description]
 * Or: bmad list
 * Or: bmad status
 * Or: bmad reply <task-id> <message>
 */
function parseCommand(text) {
  const trimmed = (text || '').trim();
  
  // Check for "bmad" prefix (case insensitive)
  const match = trimmed.match(/^bmad\s+(.+)/i);
  if (!match) return null;
  
  const rest = match[1].trim();
  
  // bmad list
  if (/^list$/i.test(rest)) return { action: 'list' };
  
  // bmad status
  if (/^status$/i.test(rest)) return { action: 'status' };
  
  // bmad reply <task-id> <message>  OR  bmad reply <message> (auto-find awaiting task)
  const replyMatch = rest.match(/^reply\s+(\S+)\s+(.+)/i);
  if (replyMatch) {
    // If first word looks like a task ID (alphanumeric 8+ chars), use it; otherwise treat entire thing as message
    if (/^[a-z0-9]{8,}$/i.test(replyMatch[1])) {
      return { action: 'reply', taskId: replyMatch[1], message: replyMatch[2] };
    }
    // No task ID — auto-find awaiting task
    return { action: 'reply', taskId: null, message: rest.replace(/^reply\s+/i, '') };
  }
  // Simple "reply" with just a message
  const simpleReply = rest.match(/^reply$/i);
  if (simpleReply) return { action: 'help' };
  
  // bmad <workflow> "<project>" [description]
  // Or: bmad <workflow> <project> [description]
  const cmdMatch = rest.match(/^([\w-]+)\s+"([^"]+)"(?:\s+(.+))?$/);
  if (cmdMatch) {
    return { action: 'start', workflow: cmdMatch[1], project: cmdMatch[2], description: cmdMatch[3] || '' };
  }
  
  // bmad <workflow> <project-words> - <description>
  const dashMatch = rest.match(/^([\w-]+)\s+(.+?)\s+-\s+(.+)$/);
  if (dashMatch) {
    return { action: 'start', workflow: dashMatch[1], project: dashMatch[2], description: dashMatch[3] };
  }
  
  // bmad <workflow> <single-project-name>
  const simpleMatch = rest.match(/^([\w-]+)\s+(.+)$/);
  if (simpleMatch) {
    return { action: 'start', workflow: simpleMatch[1], project: simpleMatch[2], description: '' };
  }
  
  return { action: 'help' };
}

/**
 * Find a project by name (fuzzy match)
 */
async function findProject(name, apiBase = STUDIO_URL, cookie = null) {
  try {
    const http = require('http');
    return new Promise((resolve, reject) => {
      const opts = { hostname: '127.0.0.1', port: 3000, path: '/api/projects', headers: {} };
      if (cookie) opts.headers.Cookie = cookie;
      http.get(opts, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const projects = JSON.parse(data);
            if (!Array.isArray(projects)) { resolve(null); return; }
            const lower = name.toLowerCase();
            const exact = projects.find(p => p.name.toLowerCase() === lower);
            if (exact) { resolve(exact); return; }
            const partial = projects.find(p => p.name.toLowerCase().includes(lower));
            resolve(partial || null);
          } catch { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  } catch { return null; }
}

/**
 * Create a task via the Claude Studio API
 */
async function createTask(workflow, projectWorkdir, title, description, cookie) {
  const http = require('http');
  const body = JSON.stringify({
    title,
    description: description || '',
    notes: `[bmad-workflow:${workflow}]`,
    status: 'bmad_workflow',
    workdir: projectWorkdir,
    model: 'sonnet',
    mode: 'auto',
    max_turns: ['quick-dev', 'dev-story'].includes(workflow) ? 100 : 30
  });
  
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 3000,
      path: '/api/tasks', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie || '' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Find the most recent awaiting_input task
 */
async function findAwaitingTask(cookie) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: 3000, path: '/api/tasks', headers: {} };
    if (cookie) opts.headers.Cookie = cookie;
    http.get(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const tasks = JSON.parse(data);
          if (!Array.isArray(tasks)) { resolve(null); return; }
          // Find most recent awaiting_input task
          const awaiting = tasks
            .filter(t => t.status === 'awaiting_input')
            .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
          resolve(awaiting[0] || null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

/**
 * Reply to an awaiting_input task
 */
async function replyToTask(taskId, message, cookie) {
  const http = require('http');
  const body = JSON.stringify({ message });
  
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 3000,
      path: `/api/tasks/${taskId}/reply`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie || '' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Get task status summary
 */
async function getTaskStatus(cookie) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: 3000, path: '/api/tasks', headers: {} };
    if (cookie) opts.headers.Cookie = cookie;
    http.get(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const tasks = JSON.parse(data);
          if (!Array.isArray(tasks)) { resolve('No tasks found'); return; }
          const active = tasks.filter(t => !['done', 'cancelled', 'backlog'].includes(t.status));
          if (!active.length) { resolve('No active tasks'); return; }
          
          const lines = ['**📋 Active Tasks**\n'];
          for (const t of active) {
            const emoji = { todo: '📌', in_progress: '🔄', bmad_workflow: '🔮', awaiting_input: '💬' }[t.status] || '▫️';
            const proj = (t.workdir || '').split('/').pop();
            lines.push(`${emoji} \`${t.id.slice(0, 8)}\` **${t.title}** (${proj}) — ${t.status.replace('_', ' ')}`);
          }
          resolve(lines.join('\n'));
        } catch { resolve('Error fetching tasks'); }
      });
    }).on('error', () => resolve('Error connecting to Claude Studio'));
  });
}

module.exports = {
  sendDiscord,
  getWorkflowMenu,
  formatWorkflowList,
  parseCommand,
  findProject,
  createTask,
  replyToTask,
  findAwaitingTask,
  getTaskStatus,
  activeThreadTasks,
  DISCORD_CHANNEL
};
