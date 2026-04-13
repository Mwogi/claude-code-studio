#!/usr/bin/env node
'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// When launched via npx/global install, store user data in the current
// working directory (where the user runs the command), not inside the
// npm package directory.
if (!process.env.APP_DIR) {
  process.env.APP_DIR = process.cwd();
}

// Ensure data and skills directories exist in APP_DIR
const dataDir = path.join(process.env.APP_DIR, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const skillsDir = path.join(process.env.APP_DIR, 'skills');
if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });

// Seed config.json from bundled template on first run (config.json is gitignored)
const configDest = path.join(process.env.APP_DIR, 'config.json');
if (!fs.existsSync(configDest)) {
  const template = path.join(__dirname, '..', 'config.example.json');
  if (fs.existsSync(template)) fs.copyFileSync(template, configDest);
}

// Seed .env from .env.example on first run
const envDest = path.join(process.env.APP_DIR, '.env');
if (!fs.existsSync(envDest)) {
  const envTemplate = path.join(__dirname, '..', '.env.example');
  if (fs.existsSync(envTemplate)) fs.copyFileSync(envTemplate, envDest);
}

// Default workspace to APP_DIR/workspace (can be overridden by WORKDIR env)
if (!process.env.WORKDIR) {
  process.env.WORKDIR = path.join(process.env.APP_DIR, 'workspace');
}

// Ensure ~/.local/bin/claude and ~/.local/bin/openclaw symlinks exist so the
// systemd service (which runs without a login shell / nvm) can find both binaries.
(function ensureLocalBinSymlinks() {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  try { fs.mkdirSync(localBin, { recursive: true }); } catch {}

  /** Try to locate a binary via `which`, return its real path or null. */
  function whichBin(name) {
    try {
      const { execSync: _exec } = require('child_process');
      return _exec(`which ${name} 2>/dev/null`, { encoding: 'utf8' }).trim() || null;
    } catch { return null; }
  }

  for (const bin of ['claude', 'openclaw']) {
    const symlink = path.join(localBin, bin);
    if (fs.existsSync(symlink)) continue; // already there

    const resolved = whichBin(bin);
    if (!resolved) {
      console.warn(`   [setup] '${bin}' not found in PATH — symlink skipped.`);
      continue;
    }

    try {
      fs.symlinkSync(resolved, symlink);
      console.log(`   [setup] Created symlink: ${symlink} → ${resolved}`);
    } catch (e) {
      // Non-fatal: systemd service may still find the binary via PATH
      console.warn(`   [setup] Could not create ${symlink} symlink: ${e.message}`);
    }
  }
})();

const pkg = require('../package.json');
console.log(`\n🚀 Claude Code Chat v${pkg.version}`);
console.log(`   Data dir : ${process.env.APP_DIR}`);
console.log(`   Workspace: ${process.env.WORKDIR}`);
console.log(`   Port     : ${process.env.PORT || 3000}\n`);

require('../server.js');
