#!/usr/bin/env node

/**
 * agent-bell Command Wrapper (`npx agent-bell wrap "<command>"`)
 * Executes any arbitrary shell command, streams live output, tracks duration and exit code,
 * inspects git status/diff, and dispatches rich push notifications to Telegram, Discord, and Slack.
 * Standard: Node.js >= 20 (Zero Dependencies).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { notify } from '../clients/node/notifier.js';
import { inspectWorkspace } from '../lib/git.js';
import { loadRunnerConfig } from './runner.js';

export function parseWrapArgs(argv) {
  let title = null;
  let workspace = null;
  let isSilent = false;
  const commandParts = [];

  let i = 0;
  let parsingWrapOptions = true;

  while (i < argv.length) {
    const arg = argv[i];
    if (parsingWrapOptions) {
      if (arg === '--') {
        commandParts.push(...argv.slice(i + 1));
        break;
      } else if (arg === '-t' || arg === '--title') {
        title = argv[i + 1];
        i += 2;
        continue;
      } else if (arg === '-w' || arg === '--workspace') {
        workspace = argv[i + 1];
        i += 2;
        continue;
      } else if (arg === '-s' || arg === '--silent') {
        isSilent = true;
        i += 1;
        continue;
      } else if (arg === '-h' || arg === '--help') {
        return { help: true };
      }
      parsingWrapOptions = false;
    }

    commandParts.push(arg);
    i += 1;
  }

  return {
    title,
    workspace,
    isSilent,
    commandParts,
    command: commandParts.join(' ').trim()
  };
}

export async function runWrap(argv) {
  const parsed = parseWrapArgs(argv);

  if (parsed.help || !parsed.command) {
    console.log(`
🔔 agent-bell wrap — Execute shell command & notify upon completion

Usage:
  npx agent-bell wrap "<command>"
  npx agent-bell wrap [options] -- <command>

Options:
  -t, --title <title>       Custom task title for notifications
  -w, --workspace <name>    Custom workspace name (defaults to current folder)
  -s, --silent              Only notify on error/failure
  -h, --help                Show this help screen

Examples:
  npx agent-bell wrap "npm test"
  npx agent-bell wrap --title "Production Build" -- npm run build
  npx agent-bell wrap "python train.py --epochs 10"
`);
    return parsed.help ? 0 : 1;
  }

  const { command, commandParts = [], title, workspace, isSilent } = parsed;
  const runnerCfg = loadRunnerConfig();
  const activeWs = workspace || runnerCfg.activeWorkspace || process.cwd();
  const wsName = path.basename(activeWs) || 'Project';

  console.log(`🔔 [agent-bell] Wrapping command: "${command}" (Workspace: ${wsName})`);
  const startTime = Date.now();

  let stdoutBuf = '';
  let stderrBuf = '';

  let child;
  if (commandParts.length > 1) {
    const isDirectExecutable = fs.existsSync(commandParts[0]) || path.isAbsolute(commandParts[0]);
    if (isDirectExecutable) {
      child = spawn(commandParts[0], commandParts.slice(1), {
        shell: false,
        cwd: activeWs,
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: false
      });
    } else {
      child = spawn(command, {
        shell: true,
        cwd: activeWs,
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: false
      });
    }
  } else {
    child = spawn(command, {
      shell: true,
      cwd: activeWs,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: false
    });
  }

  // Gracefully forward termination signals to child process
  const onSignal = (sig) => {
    try {
      if (child && !child.killed) {
        if (process.platform !== 'win32') {
          child.kill(sig);
        }
      }
    } catch (_) {}
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      stdoutBuf += chunk.toString();
      if (stdoutBuf.length > 50000) stdoutBuf = stdoutBuf.slice(-50000);
    });
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 50000) stderrBuf = stderrBuf.slice(-50000);
    });
  }

  let exitSignal = null;
  const exitCode = await new Promise((resolve) => {
    child.on('close', (code, signal) => {
      exitSignal = signal;
      if (code !== null) {
        resolve(code);
      } else if (signal === 'SIGINT') {
        resolve(130);
      } else if (signal === 'SIGTERM') {
        resolve(143);
      } else {
        resolve(signal ? 1 : 0);
      }
    });
    child.on('error', (err) => {
      console.error(`❌ [agent-bell] Failed to spawn process: ${err.message}`);
      resolve(1);
    });
  });

  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  const durationSeconds = Math.max(1, Math.round((Date.now() - startTime) / 1000));
  const isError = exitCode !== 0;

  // Extract last non-empty lines for high-density summary
  const fullOutput = isError ? (stderrBuf || stdoutBuf) : (stdoutBuf || stderrBuf);
  const lines = fullOutput.trim().split('\n').filter((l) => l.trim().length > 0);
  const snippet = lines.slice(-4).join('\n');

  const statusLabel = isError
    ? (exitSignal ? `🛑 Interrupted by ${exitSignal}` : `❌ Failed (exit code ${exitCode})`)
    : '✅ Succeeded';
  let summary = `${statusLabel} in ${durationSeconds}s.`;
  if (snippet) {
    summary += `\n${snippet}`;
  }

  // Inspect Git diff and working tree
  let gitHeader = null;
  let gitSummary = null;
  try {
    const gitInfo = inspectWorkspace(activeWs);
    if (gitInfo && gitInfo.isGit) {
      gitHeader = gitInfo.header;
      gitSummary = gitInfo.summary;
    }
  } catch (_) {}

  // Dispatch push notification unless silent mode and succeeded
  if (!isSilent || isError) {
    try {
      const res = await notify({
        task: title || command,
        summary,
        durationSeconds,
        isError,
        output: fullOutput,
        workspace: wsName,
        gitHeader,
        gitSummary,
        url: runnerCfg.workerUrl || undefined,
        secret: runnerCfg.authSecret || undefined
      });

      if (res && res.success) {
        console.log(`\n🔔 [agent-bell] Push alert dispatched (${durationSeconds}s).`);
      }
    } catch (err) {
      console.warn(`\n⚠️ [agent-bell] Failed to dispatch push notification: ${err.message}`);
    }
  }

  return exitCode;
}

// Standalone execution
if (process.argv[1]?.endsWith('wrap.js')) {
  runWrap(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
