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

/** Returns a known thread ID without triggering creation, or null if unknown. */
function _getExistingThreadId(projectName, workdir) {
  // 1. Hardcoded project mapping (highest priority)
  if (projectName && PROJECT_THREADS[projectName]) return PROJECT_THREADS[projectName];

  // 2. Persisted project mapping
  if (projectName && _store.projects[projectName]) return _store.projects[projectName].threadId;

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
function _createThread(projectName) {
  if (_pendingThreads.has(projectName)) return _pendingThreads.get(projectName);

  const promise = new Promise((resolve) => {
    execFile(OPENCLAW_BIN, [
      'message', 'thread-create',
      '--channel', 'discord',
      '--target',  DISCORD_CHANNEL,
      '--name',    `${projectName} Tasks`,
      '--message', `Task notifications for ${projectName}`,
    ], { timeout: 30000 }, (err, stdout) => {
      _pendingThreads.delete(projectName);

      if (err) {
        console.error('[openclaw-notify] Thread creation failed for', projectName, ':', err.message);
        resolve(null);
        return;
      }

      // Parse thread ID — try JSON first, then a bare Snowflake (17-20 digit number)
      let threadId = null;
      try {
        const parsed = JSON.parse(stdout.trim());
        threadId = String(parsed.id || parsed.threadId || parsed.thread_id || '');
      } catch {
        const m = stdout.match(/"?id"?\s*[=:]\s*"?(\d{17,20})"?/i) || stdout.match(/\b(\d{17,20})\b/);
        if (m) threadId = m[1];
      }

      if (!threadId) {
        console.error('[openclaw-notify] Could not parse thread ID from response:', stdout.trim().slice(0, 200));
        resolve(null);
        return;
      }

      // Persist and log
      _store.projects[projectName] = { threadId, createdAt: new Date().toISOString() };
      _saveThreads();
      console.log(`[openclaw-notify] Auto-created Discord thread for "${projectName}": ${threadId}`);
      resolve(threadId);
    });
  });

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

function taskStarted(task, projectName) {
  const model = task.model || 'sonnet';
  const phase = (task.notes || '').match(/\[bmad-phase:(\w+)\]/)?.[1] || '';
  const phaseLabel = phase ? ` → ${phase.replace('bmad_', '').toUpperCase()}` : '';
  notify(
    `🚀 ${_projectTag(projectName)}${_taskTag(task)}Task Started${phaseLabel}: ${task.title}\nModel: ${model}`,
    projectName, task.workdir
  );
}

function taskCompleted(task, durationMs, projectName, summary) {
  const mins = Math.round((durationMs || 0) / 60000);
  const phase = (task.notes || '').match(/\[bmad-phase:(\w+)\]/)?.[1] || '';
  const phaseLabel = phase ? ` (${phase.replace('bmad_', '')})` : '';
  const summaryText = summary ? `\n\n${summary}` : '';
  notify(
    `✅ ${_projectTag(projectName)}${_taskTag(task)}Task Done${phaseLabel}: ${task.title}\n⏱️ ${mins}min${summaryText}`,
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
    `Backlog: ${stats.backlog} · Todo: ${stats.todo} · Active: ${stats.active} · Done: ${stats.done}`,
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
