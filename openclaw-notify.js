/**
 * openclaw-notify.js — Send notifications through OpenClaw → Discord
 * Routes notifications to project-specific Discord threads.
 * New projects get threads auto-created and persisted to data/discord-threads.json.
 */
'use strict';
const { execFile } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const NOTIFY_ENABLED   = process.env.OPENCLAW_NOTIFY !== 'false';
const DISCORD_CHANNEL  = process.env.OPENCLAW_NOTIFY_CHANNEL || '1479520243385765888';
const DISCORD_PARENT_CHANNEL = process.env.OPENCLAW_THREAD_PARENT_CHANNEL || '1475490143635767468'; // Parent text channel for creating threads

// Persistent storage for auto-created thread mappings
const DATA_DIR     = process.env.APP_DIR ? path.join(process.env.APP_DIR, 'data') : path.join(__dirname, 'data');
const THREADS_FILE = path.join(DATA_DIR, 'discord-threads.json');

// ---------------------------------------------------------------------------
// Hardcoded mappings — these always take priority over persisted entries
// ---------------------------------------------------------------------------

/**
 * Project → Discord thread mapping.
 * Each project's notifications go to its own thread to reduce noise.
 * Fallback: main Claude Studio thread.
 */
const PROJECT_THREADS = {
  'Helpdesk':            '1485938994775588945',
  'HMIS Lite - Frontend':'1485939027759857829',
  'HMIS Backend':        '1485939083925651486',
  'HMIS-Frontend':       '1476556097312522311',  // existing thread
  'HMIS Frontend':       '1476556097312522311',  // project name in DB
  'Golf Casino Backend': '1479043614628647074',  // existing Golf Project thread
  'Claude Code Studio':  '1479520243385765888',  // main thread
  'NiMiMi Backend':      '1503011240774205553',  // consolidated thread
  'NiMiMi-V2':           '1503011240774205553',  // same thread as NiMiMi Backend
};

/**
 * Also map by workdir substring for when project name isn't available.
 */
const WORKDIR_THREADS = {
  'bmad-project/helpdesk':       '1485938994775588945',
  'vue-apps/hmis-lite':          '1485939027759857829',
  'frappe-bench/apps/hmis':      '1485939083925651486',
  'hmis_frontend':               '1476556097312522311',
  'projects/hmis-lite':          '1476556097312522311',
  'claude-code-studio':          '1479520243385765888',
  'golf_casino':                 '1479043614628647074',
  'projects/nimimi':               '1503011240774205553',
};

// ---------------------------------------------------------------------------
// Persistent thread store — loaded from disk, merged with hardcoded defaults
// { projects: { "Name": { threadId, createdAt } }, workdirs: { "key": { threadId, createdAt } } }
// ---------------------------------------------------------------------------

let _store = { projects: {}, workdirs: {} };

function _loadThreads() {
  try {
    if (fs.existsSync(THREADS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8'));
      _store = { projects: {}, workdirs: {}, ...parsed };
    }
  } catch (e) {
    console.error('[openclaw-notify] Failed to load discord-threads.json:', e.message);
  }
}

function _saveThreads() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(THREADS_FILE, JSON.stringify(_store, null, 2), 'utf8');
  } catch (e) {
    console.error('[openclaw-notify] Failed to save discord-threads.json:', e.message);
  }
}

// Load persisted mappings on startup
_loadThreads();

// ---------------------------------------------------------------------------
// Binary resolution — mirrors findClaudeBin() in claude-cli.js
// ---------------------------------------------------------------------------

function findOpenclawBin() {
  if (process.platform !== 'win32') {
    const candidates = [
      path.join(os.homedir(), '.local', 'bin', 'openclaw'),
      '/opt/homebrew/bin/openclaw',
      '/usr/local/bin/openclaw',
      '/usr/bin/openclaw',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return 'openclaw'; // fall back to PATH
}

const OPENCLAW_BIN = findOpenclawBin();

// ---------------------------------------------------------------------------
// Thread resolution — check hardcoded → persisted → auto-create
// ---------------------------------------------------------------------------

/** Normalize project name for thread-map key (case-insensitive dedup). */
function _normalizeKey(name) { return name ? name.toLowerCase().replace(/[\s_]+/g, '-') : ''; }

/** Returns a known thread ID without triggering creation, or null if unknown. */
function _getExistingThreadId(projectName, workdir) {
  // 1. Hardcoded project mapping (highest priority — exact match)
  if (projectName && PROJECT_THREADS[projectName]) return PROJECT_THREADS[projectName];

  // 2. Persisted project mapping (normalized key)
  const nk = _normalizeKey(projectName);
  if (nk) {
    // Check normalized key first, then scan existing keys for normalized match
    for (const [key, data] of Object.entries(_store.projects)) {
      if (_normalizeKey(key) === nk) return data.threadId;
    }
  }

  // 3. Hardcoded workdir substring match
  if (workdir) {
    for (const [key, threadId] of Object.entries(WORKDIR_THREADS)) {
      if (workdir.includes(key)) return threadId;
    }
    // 4. Persisted workdir mapping
    for (const [key, data] of Object.entries(_store.workdirs)) {
      if (workdir.includes(key)) return data.threadId;
    }
  }

  return null;
}

/**
 * In-flight creation promises — prevents duplicate thread creation when
 * multiple notifications arrive for the same new project simultaneously.
 */
const _pendingThreads = new Map();

/** Creates a new Discord thread and persists the mapping. Returns threadId or null on failure. */
function _getDiscordToken() {
  // Read from OpenClaw config
  try {
    const home = os.homedir();
    const cfgPath = path.join(home, '.openclaw', 'openclaw.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const token = cfg?.channels?.discord?.token;
      if (token) return token;
    }
  } catch (e) {
    console.error('[openclaw-notify] Failed to read Discord token from openclaw.json:', e.message);
  }
  return process.env.DISCORD_BOT_TOKEN || null;
}

function _createThread(projectName) {
  // Check pending threads by normalized key to prevent concurrent duplicate creation
  const nk = _normalizeKey(projectName);
  for (const [key, promise] of _pendingThreads.entries()) {
    if (_normalizeKey(key) === nk) return promise;
  }

  const promise = (async () => {
    try {
      const token = _getDiscordToken();
      if (!token) {
        console.error('[openclaw-notify] No Discord bot token available for thread creation');
        return null;
      }

      const https = require('https');
      const threadName = `${projectName} Tasks`;

      // First send a message to the channel, then create a thread from it
      const msgPayload = JSON.stringify({
        content: `📋 Task notifications for **${projectName}**`
      });

      // Step 1: Send a message
      const msgResponse = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'discord.com',
          path: `/api/v10/channels/${DISCORD_PARENT_CHANNEL}/messages`,
          method: 'POST',
          headers: {
            'Authorization': `Bot ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(msgPayload)
          }
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(body));
            } else {
              reject(new Error(`Discord API ${res.statusCode}: ${body.slice(0, 200)}`));
            }
          });
        });
        req.on('error', reject);
        req.write(msgPayload);
        req.end();
      });

      // Step 2: Create a public thread from the message
      const threadPayload = JSON.stringify({
        name: threadName,
        auto_archive_duration: 10080 // 7 days
      });

      const threadResponse = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'discord.com',
          path: `/api/v10/channels/${msgResponse.id}/messages/${msgResponse.id}/threads`,
          method: 'POST',
          headers: {
            'Authorization': `Bot ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(threadPayload)
          }
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(body));
            } else {
              // If thread-from-message fails, try creating a standalone thread
              reject(new Error(`Discord API ${res.statusCode}: ${body.slice(0, 200)}`));
            }
          });
        });
        req.on('error', reject);
        req.write(threadPayload);
        req.end();
      }).catch(async () => {
        // Fallback: create a standalone public thread in the channel
        const standalonePayload = JSON.stringify({
          name: threadName,
          auto_archive_duration: 10080,
          type: 11, // PUBLIC_THREAD
          message: { content: `📋 Task notifications for **${projectName}**` }
        });
        return new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'discord.com',
            path: `/api/v10/channels/${DISCORD_PARENT_CHANNEL}/threads`,
            method: 'POST',
            headers: {
              'Authorization': `Bot ${token}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(standalonePayload)
            }
          }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(JSON.parse(body));
              } else {
                reject(new Error(`Discord thread API ${res.statusCode}: ${body.slice(0, 200)}`));
              }
            });
          });
          req.on('error', reject);
          req.write(standalonePayload);
          req.end();
        });
      });

      const threadId = threadResponse.id;
      if (!threadId) {
        console.error('[openclaw-notify] No thread ID in response');
        return null;
      }

      // Persist
      // Store under normalized key to prevent duplicates from name variants
      const nk = _normalizeKey(projectName);
      // Remove any existing entries that normalize to the same key
      for (const key of Object.keys(_store.projects)) {
        if (_normalizeKey(key) === nk && key !== projectName) delete _store.projects[key];
      }
      _store.projects[projectName] = { threadId, createdAt: new Date().toISOString() };
      _saveThreads();
      console.log(`[openclaw-notify] Auto-created Discord thread for "${projectName}": ${threadId}`);
      return threadId;
    } catch (e) {
      console.error('[openclaw-notify] Thread creation failed for', projectName, ':', e.message);
      return null;
    } finally {
      _pendingThreads.delete(projectName);
    }
  })();

  _pendingThreads.set(projectName, promise);
  return promise;
}

/**
 * Resolves the target thread ID for a notification.
 * Auto-creates a thread if the project is unknown (async, non-blocking for caller).
 */
async function _resolveThreadId(projectName, workdir) {
  const existing = _getExistingThreadId(projectName, workdir);
  if (existing) return existing;

  // Only auto-create when we have a named project to label the thread
  if (projectName) {
    const created = await _createThread(projectName);
    if (created) return created;
  }

  return DISCORD_CHANNEL; // fallback — never lose a notification
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function notify(text, projectName, workdir) {
  if (!NOTIFY_ENABLED) return;

  _resolveThreadId(projectName, workdir).then(target => {
    execFile(OPENCLAW_BIN, [
      'message', 'send',
      '--channel', 'discord',
      '--target',  target,
      '--message', text,
    ], { timeout: 30000 }, (err) => {
      if (err) console.error('[openclaw-notify] Failed:', err.message);
    });
  }).catch(e => {
    console.error('[openclaw-notify] Error:', e.message);
  });
}

function _projectTag(projectName) {
  return projectName ? `**[${projectName}]** ` : '';
}

function _taskTag(task) {
  return task.task_number ? `#${task.task_number} ` : '';
}

// Human-friendly labels for BMAD workflow types
const _WORKFLOW_LABELS = {
  'create-story':         'Plan',
  'dev-story':            'Implement',
  'quick-dev':            'Quick Dev',
  'quick-spec':           'Quick Spec',
  'quick-dev-new-preview':'Quick Dev (preview)',
  'quick-flow-solo-dev':  'Solo Dev',
  'playwright-qa':        'QA',
  'code-review':          'Code Review',
  'e2e-tests':            'E2E Tests',
  'solutioning':          'Architecture',
  'sprint-planning':      'Sprint Planning',
  'planning':             'Planning',
  'edit-prd':             'Edit PRD',
  'validate-prd':         'Validate PRD',
  'ux-design':            'UX Design',
  'analysis':             'Analysis',
  'research':             'Research',
  'brainstorming':        'Brainstorm',
  'domain-research':      'Domain Research',
  'adversarial-review':   'Adversarial QA',
  'edge-case-review':     'Edge Case QA',
};

function _workflowLabel(task) {
  const m = (task.notes || '').match(/\[bmad-workflow:([\w-]+)\]/);
  if (!m) return '';
  return _WORKFLOW_LABELS[m[1]] || m[1];
}

function taskStarted(task, projectName) {
  const model = task.model || 'sonnet';
  const effort = task.effort ? `/${task.effort}` : '';
  const wfLabel = _workflowLabel(task);
  const stageTag = wfLabel ? ` — ${wfLabel}` : '';
  notify(
    `🚀 ${_projectTag(projectName)}${_taskTag(task)}Task Started${stageTag}: ${task.title}\nModel: ${model}${effort}`,
    projectName, task.workdir
  );
}

function taskCompleted(task, durationMs, projectName, summary) {
  const mins = Math.round((durationMs || 0) / 60000);
  const wfLabel = _workflowLabel(task);
  const stageTag = wfLabel ? ` — ${wfLabel}` : '';
  const summaryText = summary ? `\n\n${summary}` : '';
  notify(
    `✅ ${_projectTag(projectName)}${_taskTag(task)}Task Done${stageTag}: ${task.title}\n⏱️ ${mins}min${summaryText}`,
    projectName, task.workdir
  );
}

function taskFailed(task, reason, projectName) {
  notify(
    `❌ ${_projectTag(projectName)}${_taskTag(task)}Task Failed: ${task.title}\n💬 ${(reason || 'Unknown error').substring(0, 200)}`,
    projectName, task.workdir
  );
}

function progressSummary(projectName, stats) {
  const lines = [
    `📊 **Sprint Progress — ${projectName}**`,
    `Backlog: ${stats.backlog} · Queue: ${stats.todo} · Active: ${stats.active} · Done: ${stats.done}`,
    `Progress: ${stats.done}/${stats.total} (${Math.round(stats.done/Math.max(stats.total,1)*100)}%)`,
  ];
  if (stats.recentlyCompleted?.length) {
    lines.push(`\nRecently completed:`);
    for (const t of stats.recentlyCompleted.slice(0, 5)) {
      lines.push(`  ✅ ${t}`);
    }
  }
  notify(lines.join('\n'), projectName);
}

function taskAwaitingInput(task, projectName, contextSnippet) {
  const prefix = projectName ? `**[${projectName}]** ` : '';
  const context = contextSnippet ? `\n\n${contextSnippet}` : '';
  notify(
    `💬 ${prefix}${_taskTag(task)}Awaiting Input: ${task.title}${context}\n\nReply in Claude Studio to continue.`,
    projectName, task.workdir
  );
}

// Also update the sendNotification alias used by auto-epic and other direct calls
function sendNotification(text, projectName, workdir) {
  notify(text, projectName, workdir);
}

module.exports = { notify, sendNotification, taskStarted, taskCompleted, taskFailed, progressSummary, taskAwaitingInput };
