/**
 * openclaw-notify.js — Send notifications through OpenClaw → Discord
 * Routes notifications to project-specific Discord threads.
 */
'use strict';
const { execFile } = require('child_process');

const NOTIFY_ENABLED = process.env.OPENCLAW_NOTIFY !== 'false';
const DISCORD_CHANNEL = process.env.OPENCLAW_NOTIFY_CHANNEL || '1479520243385765888';

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
  'claude-code-studio':          '1479520243385765888',
  'golf_casino':                 '1479043614628647074',
};

function _getThreadId(projectName, workdir) {
  // Try project name first
  if (projectName && PROJECT_THREADS[projectName]) {
    return PROJECT_THREADS[projectName];
  }
  // Try workdir substring match
  if (workdir) {
    for (const [key, threadId] of Object.entries(WORKDIR_THREADS)) {
      if (workdir.includes(key)) return threadId;
    }
  }
  // Fallback to main thread
  return DISCORD_CHANNEL;
}

function notify(text, projectName, workdir) {
  if (!NOTIFY_ENABLED) return;
  const target = _getThreadId(projectName, workdir);
  try {
    execFile('openclaw', [
      'message', 'send',
      '--channel', 'discord',
      '--target', target,
      '--message', text
    ], { timeout: 30000 }, (err) => {
      if (err) console.error('[openclaw-notify] Failed:', err.message);
    });
  } catch (e) {
    console.error('[openclaw-notify] Error:', e.message);
  }
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
