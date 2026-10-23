#!/usr/bin/env node

/**
 * agent-bell - Local Invisible Background Runner (Zero Dependencies)
 * Runs silently in the background (< 20MB RAM).
 * Features: Single-instance lock (runner.pid), process tree kill (taskkill),
 * fs.watch hot-reloading, HTTPS pull queue & heartbeat.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { inspectWorkspace, revertWorkspace, scrubSecrets } from '../lib/git.js';

export function getBellHomeDir() {
  const dir = process.env.AGENT_BELL_HOME || path.join(os.homedir(), '.agent-bell');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
  }
  return dir;
}

export const BELL_HOME = getBellHomeDir();
export const PID_FILE = path.join(BELL_HOME, 'runner.pid');
export const LOG_FILE = path.join(BELL_HOME, 'runner.log');
export const CONFIG_FILE = path.join(BELL_HOME, 'config.json');

/**
 * Check if a process is alive
 */
export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Cleanly terminate a process tree
 * Windows: taskkill /pid <PID> /T /F
 * Unix: kill -9 -<PID>
 */
export function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch (_) {}
}

/**
 * Append message to runner.log
 */
export function log(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (_) {}
  if (process.stdout.isTTY) {
    process.stdout.write(line);
  }
}

/**
 * Acquire single-instance PID lock
 */
export function acquirePidLock() {
  if (fs.existsSync(PID_FILE)) {
    try {
      const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (existingPid && isProcessAlive(existingPid) && existingPid !== process.pid) {
        return { acquired: false, existingPid };
      }
    } catch (_) {}
  }

  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
    return { acquired: true, existingPid: process.pid };
  } catch (err) {
    return { acquired: false, error: err.message };
  }
}

/**
 * Release PID lock
 */
export function releasePidLock() {
  log('DEBUG', `releasePidLock invoked by PID ${process.pid}`);
  try {
    if (fs.existsSync(PID_FILE)) {
      const stored = fs.readFileSync(PID_FILE, 'utf8').trim();
      if (stored === String(process.pid)) {
        fs.unlinkSync(PID_FILE);
      }
    }
  } catch (_) {}
}

process.on('uncaughtException', (err) => {
  log('FATAL', `Uncaught exception in runner: ${err.stack || err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log('FATAL', `Unhandled rejection in runner: ${reason}`);
});

/**
 * Load runner configuration with fallbacks
 */
export function loadRunnerConfig() {
  let config = {
    workerUrl: '',
    authSecret: '',
    pollIntervalMs: 3000,
    heartbeatIntervalMs: 15000,
    activeWorkspace: process.cwd(),
    workspaces: [{ name: path.basename(process.cwd()), path: process.cwd() }]
  };

  // 1. ~/.agent-bell/config.json
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = { ...config, ...data };
    } catch (_) {}
  }

  // 2. ~/.antigravity-telegram.json fallback
  if (!config.workerUrl) {
    const altPath = path.join(os.homedir(), '.antigravity-telegram.json');
    if (fs.existsSync(altPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(altPath, 'utf8'));
        config.workerUrl = data.workerUrl || config.workerUrl;
        config.authSecret = data.authSecret || config.authSecret;
      } catch (_) {}
    }
  }

  // 3. Environment variables (highest priority for overrides)
  if (process.env.AGENT_BELL_WORKER_URL || process.env.ANTIGRAVITY_TELEGRAM_WORKER_URL) {
    config.workerUrl = process.env.AGENT_BELL_WORKER_URL || process.env.ANTIGRAVITY_TELEGRAM_WORKER_URL;
  }
  if (process.env.AGENT_BELL_AUTH_SECRET || process.env.ANTIGRAVITY_TELEGRAM_AUTH_SECRET) {
    config.authSecret = process.env.AGENT_BELL_AUTH_SECRET || process.env.ANTIGRAVITY_TELEGRAM_AUTH_SECRET;
  }

  return config;
}

// Global state for runner instance
let currentConfig = loadRunnerConfig();
let activeChildProcess = null;
let isShuttingDown = false;
let configWatcher = null;
let pollTimer = null;
let heartbeatTimer = null;

/**
 * Hot-Reloading using native fs.watch
 */
export function setupConfigWatcher(onReload) {
  if (!fs.existsSync(CONFIG_FILE)) {
    // If not exists, write default so it can be watched
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf8');
    } catch (_) {
      return null;
    }
  }

  try {
    let debounceTimer = null;
    const watcher = fs.watch(CONFIG_FILE, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          currentConfig = loadRunnerConfig();
          log('INFO', `Configuration hot-reloaded successfully from ${CONFIG_FILE}`);
          if (typeof onReload === 'function') onReload(currentConfig);
        } catch (err) {
          log('ERROR', `Failed to reload config: ${err.message}`);
        }
      }, 200);
    });
    return watcher;
  } catch (err) {
    log('WARN', `Could not start config watcher: ${err.message}`);
    return null;
  }
}

/**
 * Send heartbeat to Cloudflare Worker
 */
export async function sendHeartbeat(config = currentConfig) {
  if (!config.workerUrl) return;

  const url = config.workerUrl.replace(/\/notify\/?$/, '').replace(/\/+$/, '') + '/api/runner/heartbeat';
  const activeWsPath = config.activeWorkspace || process.cwd();
  const gitInfo = inspectWorkspace(activeWsPath);

  const payload = {
    runnerId: `${os.hostname()}-${process.pid}`,
    pid: process.pid,
    hostname: os.hostname(),
    uptime: Math.round(process.uptime()),
    activeWorkspace: path.basename(activeWsPath),
    activeWorkspacePath: activeWsPath,
    workspaces: config.workspaces || [],
    gitHeader: gitInfo.header,
    timestamp: new Date().toISOString()
  };

  const headers = { 'Content-Type': 'application/json' };
  if (config.authSecret) {
    headers['Authorization'] = `Bearer ${config.authSecret}`;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch (err) {
    // Silently log or ignore network blips
  }
}

/**
 * Truncate utility for output snippets
 */
function truncate(str, maxLength = 200) {
  if (!str) return '';
  const trimmed = String(str).trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength) + '...';
}

/**
 * Dispatch runner notification back to Cloudflare Worker
 */
export async function sendRunnerNotification(config = currentConfig, payload = {}) {
  if (!config.workerUrl) return;
  const baseUrl = config.workerUrl.replace(/\/+$/, '').replace(/\/api\/queue\/?.*$/, '').replace(/\/notify\/?$/, '');
  const url = baseUrl + '/notify';
  const headers = { 'Content-Type': 'application/json' };
  if (config.authSecret) {
    headers['Authorization'] = `Bearer ${config.authSecret}`;
  }

  // Auto-inspect workspace to attach Git shortstat diff if not explicitly provided
  const ws = payload.workspacePath || config.activeWorkspace || process.cwd();
  if (!payload.gitHeader && !payload.gitSummary) {
    try {
      const gitInfo = inspectWorkspace(ws);
      if (gitInfo && gitInfo.isGit) {
        payload.gitHeader = gitInfo.header;
        payload.gitSummary = gitInfo.summary;
      }
    } catch (_) {}
  }

  // Mask sensitive credentials before dispatching
  if (payload.summary) payload.summary = scrubSecrets(payload.summary);
  if (payload.output) payload.output = scrubSecrets(payload.output);
  if (payload.prompt) payload.prompt = scrubSecrets(payload.prompt);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch (_) {}
}

/**
 * Pull pending commands from Cloudflare Worker queue
 */
export async function pollQueue(config = currentConfig) {
  if (!config.workerUrl || isShuttingDown) return;

  const url = config.workerUrl.replace(/\/notify\/?$/, '').replace(/\/+$/, '') + '/api/queue/poll';
  const headers = { 'Content-Type': 'application/json' };
  if (config.authSecret) {
    headers['Authorization'] = `Bearer ${config.authSecret}`;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) return;

    const data = await res.json();
    const tasks = data.tasks || [];

    for (const task of tasks) {
      log('INFO', `Received queue command: ${task.action} (Task ID: ${task.id || 'none'})`);

      const channelMeta = {
        messageThreadId: task.messageThreadId || null,
        discordChannelId: task.discordChannelId || null,
        slackChannelId: task.slackChannelId || null,
        slackThreadTs: task.slackThreadTs || null,
        conversationId: task.conversationId || null
      };

      if (task.action === 'STOP_TASK' || task.action === 'STOP') {
        if (activeChildProcess && activeChildProcess.pid) {
          const targetPid = activeChildProcess.pid;
          log('WARN', `Emergency stop: terminating active process tree [PID: ${targetPid}]`);
          killProcessTree(targetPid);
          activeChildProcess = null;
          log('INFO', `Process tree [PID: ${targetPid}] stopped cleanly.`);
          await sendRunnerNotification(currentConfig, {
            workspace: path.basename(config.activeWorkspace || process.cwd()),
            summary: `🛑 Process [PID: ${targetPid}] stopped cleanly by user.`,
            isStop: true,
            ...channelMeta
          });
        } else {
          log('INFO', 'Stop command received, no active child process was running.');
          await sendRunnerNotification(currentConfig, {
            workspace: path.basename(config.activeWorkspace || process.cwd()),
            summary: 'ℹ️ Stop received: no active agent command was executing.',
            ...channelMeta
          });
        }
      } else if (task.action === 'REVERT') {
        const ws = task.workspace || config.activeWorkspace || process.cwd();
        const cleanUntracked = Boolean(task.cleanUntracked);
        const result = revertWorkspace(ws, { cleanUntracked });
        log('INFO', `Revert result: ${JSON.stringify(result)}`);
        await sendRunnerNotification(currentConfig, {
          workspace: path.basename(ws),
          prompt: cleanUntracked ? 'Emergency Revert (Clean Untracked)' : 'Emergency Revert',
          summary: result.success ? (result.message || 'Emergency revert completed cleanly.') : (`Revert failed: ${result.error}`),
          isError: !result.success,
          ...channelMeta
        });
      } else if (task.action === 'SWITCH_WORKSPACE' && task.workspace) {
        const target = task.workspace;
        let matched = (config.workspaces || []).find(
          w => w.name.toLowerCase() === target.toLowerCase() ||
               path.resolve(w.path).toLowerCase() === path.resolve(target).toLowerCase()
        );
        let newPath = null;
        let newName = null;
        if (matched) {
          newPath = matched.path;
          newName = matched.name;
        } else if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          const resolvedTarget = path.resolve(target);
          // Safety gate: verify target path is jailed within configured workspace bounds
          const isAllowed = !config.workspaces || config.workspaces.length === 0 || config.workspaces.some(w => {
            const root = path.resolve(w.path);
            const rel = path.relative(root, resolvedTarget);
            return !rel.startsWith('..') && !path.isAbsolute(rel);
          });
          if (isAllowed) {
            newPath = resolvedTarget;
            newName = path.basename(newPath);
          } else {
            log('WARN', `Path traversal blocked: target "${target}" is outside configured workspace roots.`);
          }
        }

        if (newPath) {
          currentConfig.activeWorkspace = newPath;
          config.activeWorkspace = newPath;
          log('INFO', `Switched active workspace to: ${newName} (${newPath})`);
          try {
            if (fs.existsSync(CONFIG_FILE)) {
              const diskCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
              diskCfg.activeWorkspace = newPath;
              fs.writeFileSync(CONFIG_FILE, JSON.stringify(diskCfg, null, 2), 'utf8');
            }
          } catch (_) {}
          await sendHeartbeat(currentConfig);
          await sendRunnerNotification(currentConfig, {
            workspace: newName,
            prompt: `Switch workspace to ${newName}`,
            summary: `Active workspace switched to ${newName} (${newPath})`,
            ...channelMeta
          });
        } else {
          log('WARN', `Switch workspace failed: "${target}" not allowed or not found.`);
          await sendRunnerNotification(currentConfig, {
            workspace: path.basename(config.activeWorkspace || process.cwd()),
            prompt: `Switch workspace to ${target}`,
            summary: `⚠️ Switch workspace failed: "${target}" was blocked by security sandbox or does not exist.`,
            isError: true,
            ...channelMeta
          });
        }
      } else if (task.action === 'RUN_PROMPT' && task.prompt) {
        log('INFO', `Received autonomous prompt task: ${task.prompt}`);
        const ws = config.activeWorkspace || process.cwd();
        if (config.agentCommand) {
          const startTime = Date.now();
          try {
            const child = spawn(config.agentCommand, [task.prompt], {
              cwd: ws,
              shell: true,
              windowsHide: true
            });
            activeChildProcess = child;

            let stdoutBuf = '';
            let stderrBuf = '';
            child.stdout?.on('data', (chunk) => {
              if (stdoutBuf.length < 4000) stdoutBuf += chunk.toString('utf8');
            });
            child.stderr?.on('data', (chunk) => {
              if (stderrBuf.length < 4000) stderrBuf += chunk.toString('utf8');
            });

            child.on('close', async (code) => {
              log('INFO', `Agent prompt command exited with code ${code}`);
              if (activeChildProcess === child) activeChildProcess = null;
              const duration = Math.round((Date.now() - startTime) / 1000);
              const combinedOut = (stdoutBuf + (stderrBuf ? '\n' + stderrBuf : '')).trim();
              await sendRunnerNotification(currentConfig, {
                workspace: path.basename(ws),
                prompt: task.prompt,
                summary: code === 0 ? 'Agent completed prompt task' : `Agent failed with exit code ${code}`,
                output: combinedOut ? truncate(combinedOut, 1500) : null,
                durationSeconds: duration,
                isError: code !== 0,
                ...channelMeta
              });
            });
          } catch (err) {
            log('ERROR', `Failed to spawn agent command: ${err.message}`);
            await sendRunnerNotification(currentConfig, {
              workspace: path.basename(ws),
              prompt: task.prompt,
              summary: `Failed to spawn agent command: ${err.message}`,
              isError: true,
              ...channelMeta
            });
          }
        } else {
          await sendRunnerNotification(currentConfig, {
            workspace: path.basename(ws),
            prompt: task.prompt,
            summary: '⚠️ Runner agentCommand not configured in config.json. Set agentCommand to an AI CLI tool (e.g. claude, antigravity) to enable remote prompts.',
            isError: true,
            ...channelMeta
          });
        }
      } else if (task.action === 'RUN_COMMAND' && task.command) {
        log('INFO', `Executing remote command: ${task.command}`);
        const ws = config.activeWorkspace || process.cwd();
        const startTime = Date.now();
        try {
          const child = spawn(task.command, {
            cwd: ws,
            shell: true,
            windowsHide: true
          });
          activeChildProcess = child;

          let stdoutBuf = '';
          let stderrBuf = '';
          child.stdout?.on('data', (chunk) => {
            if (stdoutBuf.length < 4000) stdoutBuf += chunk.toString('utf8');
          });
          child.stderr?.on('data', (chunk) => {
            if (stderrBuf.length < 4000) stderrBuf += chunk.toString('utf8');
          });

          child.on('close', async (code) => {
            log('INFO', `Remote command exited with code ${code}`);
            if (activeChildProcess === child) activeChildProcess = null;
            const duration = Math.round((Date.now() - startTime) / 1000);
            const isError = code !== 0;
            const combinedOut = (stdoutBuf + (stderrBuf ? '\n' + stderrBuf : '')).trim();
            const summary = isError
              ? `Command failed with exit code ${code}`
              : `Command completed successfully (${duration}s)`;

            await sendRunnerNotification(currentConfig, {
              workspace: path.basename(ws),
              prompt: task.command,
              summary,
              output: combinedOut ? truncate(combinedOut, 1500) : null,
              durationSeconds: duration,
              isError,
              ...channelMeta
            });
          });
        } catch (err) {
          log('ERROR', `Failed to spawn command: ${err.message}`);
          await sendRunnerNotification(currentConfig, {
            workspace: path.basename(ws),
            prompt: task.command,
            summary: `Failed to spawn command: ${err.message}`,
            isError: true,
            ...channelMeta
          });
        }
      }
    }
  } catch (err) {
    // Network blip during poll
  }
}

/**
 * Runner main entry point
 */
export async function startRunner() {
  const lock = acquirePidLock();
  if (!lock.acquired) {
    log('WARN', `agent-bell runner is already active under PID ${lock.existingPid}. Exiting.`);
    process.exit(0);
  }

  log('INFO', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log('INFO', `🔔 agent-bell invisible runner started [PID: ${process.pid}]`);
  log('INFO', `• Active Workspace: ${currentConfig.activeWorkspace || process.cwd()}`);
  log('INFO', `• Worker URL:       ${currentConfig.workerUrl || '(not configured)'}`);
  log('INFO', `• Poll Interval:    ${currentConfig.pollIntervalMs}ms`);
  log('INFO', `• Heartbeat:        ${currentConfig.heartbeatIntervalMs}ms`);
  log('INFO', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  configWatcher = setupConfigWatcher((newCfg) => {
    currentConfig = newCfg;
    sendHeartbeat(currentConfig);
  });

  // Immediate initial heartbeat
  await sendHeartbeat(currentConfig);

  // Periodic intervals
  heartbeatTimer = setInterval(() => sendHeartbeat(currentConfig), currentConfig.heartbeatIntervalMs || 15000);
  pollTimer = setInterval(() => pollQueue(currentConfig), currentConfig.pollIntervalMs || 3000);

  const cleanShutdown = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('INFO', `Received ${signal}. Shutting down runner...`);

    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    if (configWatcher) {
      try { configWatcher.close(); } catch (_) {}
    }

    if (activeChildProcess && activeChildProcess.pid) {
      killProcessTree(activeChildProcess.pid);
      activeChildProcess = null;
    }

    releasePidLock();
    log('INFO', 'agent-bell runner terminated cleanly.');
    process.exit(0);
  };

  process.on('SIGINT', () => cleanShutdown('SIGINT'));
  process.on('SIGTERM', () => cleanShutdown('SIGTERM'));
}

// Auto-run if executed as main
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  startRunner();
}
