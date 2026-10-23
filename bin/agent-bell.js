#!/usr/bin/env node

/**
 * agent-bell CLI
 * Universal entry point: npx agent-bell [start|stop|restart|status|logs|autostart|setup|notify|ping|git|mcp]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const command = args[0] || 'setup';

switch (command) {
  case 'start': {
    const { PID_FILE, isProcessAlive } = await import('./runner.js');
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pid && isProcessAlive(pid)) {
        console.log(`🔔 agent-bell runner is already running (PID: ${pid}).`);
        break;
      }
    }

    const runnerPath = path.join(__dirname, 'runner.js');
    const vbsPath = path.join(__dirname, 'silent-runner.vbs');
    const preferVbs = process.platform === 'win32' && fs.existsSync(vbsPath) && !args.includes('--direct');

    let child;
    if (preferVbs) {
      child = spawn('wscript.exe', [vbsPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
    } else {
      child = spawn(process.execPath, [runnerPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
    }
    child.unref();

    // Wait briefly for PID file
    await new Promise((r) => setTimeout(r, 600));
    let childPid = null;
    if (fs.existsSync(PID_FILE)) {
      childPid = fs.readFileSync(PID_FILE, 'utf8').trim();
    }

    if (childPid && isProcessAlive(Number(childPid))) {
      console.log(`✅ agent-bell runner started in background (PID: ${childPid}).`);
    } else {
      console.log('✅ agent-bell runner launch signal sent.');
    }
    break;
  }

  case 'stop': {
    const { PID_FILE, isProcessAlive, killProcessTree } = await import('./runner.js');
    if (!fs.existsSync(PID_FILE)) {
      console.log('⚠️  agent-bell runner is not running.');
      break;
    }

    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!pid || !isProcessAlive(pid)) {
      console.log('⚠️  agent-bell runner was not active (cleaned stale PID file).');
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
      break;
    }

    console.log(`🛑 Stopping agent-bell runner process tree [PID: ${pid}]...`);
    killProcessTree(pid);
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    console.log(`✅ agent-bell runner (PID: ${pid}) stopped.`);
    break;
  }

  case 'restart': {
    const { PID_FILE, isProcessAlive, killProcessTree } = await import('./runner.js');
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pid && isProcessAlive(pid)) {
        console.log(`🛑 Stopping agent-bell runner [PID: ${pid}]...`);
        killProcessTree(pid);
        try { fs.unlinkSync(PID_FILE); } catch (_) {}
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const runnerPath = path.join(__dirname, 'runner.js');
    const child = spawn(process.execPath, [runnerPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();

    await new Promise((r) => setTimeout(r, 600));
    if (fs.existsSync(PID_FILE)) {
      const newPid = fs.readFileSync(PID_FILE, 'utf8').trim();
      console.log(`✅ agent-bell runner restarted successfully (PID: ${newPid}).`);
    } else {
      console.log('✅ agent-bell runner restart completed.');
    }
    break;
  }

  case 'status': {
    const { PID_FILE, LOG_FILE, CONFIG_FILE, isProcessAlive, loadRunnerConfig } = await import('./runner.js');
    const { inspectWorkspace } = await import('../lib/git.js');
    const config = loadRunnerConfig();
    let isRunning = false;
    let activePid = null;

    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pid && isProcessAlive(pid)) {
        isRunning = true;
        activePid = pid;
      }
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🔔 agent-bell Runner Status: ${isRunning ? '🟢 RUNNING' : '🔴 STOPPED'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (isRunning) {
      console.log(`• PID:              ${activePid}`);
    }
    console.log(`• Active Workspace: ${config.activeWorkspace || process.cwd()}`);
    console.log(`• Config File:      ${CONFIG_FILE}`);
    console.log(`• Log File:         ${LOG_FILE}`);

    const gitInfo = inspectWorkspace(config.activeWorkspace || process.cwd());
    if (gitInfo.isGit) {
      console.log(`• Git:              ${gitInfo.header}`);
      if (gitInfo.summary) {
        console.log(gitInfo.summary);
      }
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    break;
  }

  case 'logs': {
    const { LOG_FILE } = await import('./runner.js');
    if (!fs.existsSync(LOG_FILE)) {
      console.log(`ℹ️  No log file found at: ${LOG_FILE}`);
      break;
    }

    const isTail = args.includes('--tail') || args.includes('-f');
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.trim().split('\n');
    const recent = lines.slice(-40).join('\n');
    console.log(recent);

    if (isTail) {
      console.log('\n--- Streaming runner logs (Ctrl+C to exit) ---');
      let currentSize = fs.statSync(LOG_FILE).size;
      const interval = setInterval(() => {
        try {
          const newSize = fs.statSync(LOG_FILE).size;
          if (newSize > currentSize) {
            const stream = fs.createReadStream(LOG_FILE, {
              start: currentSize,
              end: newSize
            });
            stream.pipe(process.stdout);
            currentSize = newSize;
          }
        } catch (_) {}
      }, 500);

      process.on('SIGINT', () => {
        clearInterval(interval);
        process.exit(0);
      });
    }
    break;
  }

  case 'autostart': {
    const subCommand = args[1] || 'status';
    const { execFileSync } = await import('node:child_process');

    if (process.platform === 'win32') {
      const taskName = 'AgentBellRunner';
      const vbsPath = path.resolve(__dirname, 'silent-runner.vbs');

      if (subCommand === 'enable') {
        try {
          execFileSync('schtasks', [
            '/create',
            '/tn', taskName,
            '/tr', `wscript.exe "${vbsPath}"`,
            '/sc', 'onlogon',
            '/f'
          ], { stdio: 'inherit' });
          console.log('✅ agent-bell autostart task registered with Windows Task Scheduler.');
        } catch (err) {
          console.error('❌ Failed to register autostart task:', err.message);
        }
      } else if (subCommand === 'disable') {
        try {
          execFileSync('schtasks', ['/delete', '/tn', taskName, '/f'], { stdio: 'inherit' });
          console.log('✅ agent-bell autostart task removed from Windows Task Scheduler.');
        } catch (err) {
          console.error('❌ Failed to delete autostart task:', err.message);
        }
      } else {
        try {
          const out = execFileSync('schtasks', ['/query', '/tn', taskName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          console.log('🟢 Autostart is ENABLED on Windows Task Scheduler:');
          console.log(out.trim());
        } catch (_) {
          console.log('🔴 Autostart is DISABLED (task not found). Run "npx agent-bell autostart enable" to enable.');
        }
      }
    } else {
      console.log('ℹ️  On macOS/Linux, add "@reboot npx agent-bell start" to your crontab via "crontab -e".');
    }
    break;
  }

  case 'git': {
    const sub = args[1] || 'status';
    const { inspectWorkspace, revertWorkspace } = await import('../lib/git.js');
    if (sub === 'revert') {
      const cleanUntracked = args.includes('--clean') || args.includes('-f') || args.includes('clean') || args.includes('all');
      const res = revertWorkspace(process.cwd(), { cleanUntracked });
      if (res.success) {
        console.log('✅ ' + res.message);
      } else {
        console.error('❌ ' + res.error);
      }
    } else {
      const info = inspectWorkspace(process.cwd());
      if (!info.isGit) {
        console.log('⚠️  Not a Git repository.');
      } else {
        console.log(info.header);
        if (info.summary) console.log(info.summary);
      }
    }
    break;
  }

  case 'wrap': {
    const { runWrap } = await import('./wrap.js');
    const exitCode = await runWrap(args.slice(1));
    process.exitCode = exitCode;
    break;
  }

  case 'update': {
    const { runUpdate } = await import('./update.js');
    const res = await runUpdate(args.slice(1));
    process.exitCode = res && res.success !== false ? 0 : 1;
    break;
  }

  case 'setup':
    await import('./setup.js');
    break;

  case 'ping':
  case 'test':
    await import('../plugin/scripts/test-ping.js');
    break;

  case 'notify': {
    const task = args[1] || 'Manual Task';
    const summary = args[2] || 'Completed via agent-bell CLI';
    const { loadRunnerConfig } = await import('./runner.js');
    const cfg = loadRunnerConfig();
    const { notify } = await import('../clients/node/notifier.js');
    const res = await notify({
      task,
      summary,
      url: cfg.workerUrl || undefined,
      secret: cfg.authSecret || undefined
    });
    console.log(res);
    break;
  }

  case 'mcp':
    await import('../mcp/server.js');
    break;

  case 'version':
  case '--version':
  case '-v': {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    console.log(`agent-bell v${pkg.version}`);
    break;
  }

  case 'help':
  case '--help':
  case '-h':
    console.log(`
🔔 agent-bell - Universal Notification & Remote Control for AI Coding Agents

Runner Daemon:
  npx agent-bell start           Spawn silent background runner (< 20MB RAM)
  npx agent-bell stop            Terminate background runner process tree
  npx agent-bell restart         Clean reboot of background runner
  npx agent-bell status          Display runner PID, workspace, and git state
  npx agent-bell logs [--tail]   Stream or view runner logs
  npx agent-bell autostart [e|d] Enable/disable autostart on system boot

Command Wrapper & Updates:
  npx agent-bell wrap "<cmd>"    Execute command & send push alert on completion
  npx agent-bell update          Check & update agent-bell from npm registry

Git Engine:
  npx agent-bell git status      Inspect branch and high-density diffs
  npx agent-bell git revert      Emergency rollback of dirty working tree

Setup & MCP:
  npx agent-bell setup           Interactive configuration wizard
  npx agent-bell ping            Send test notification to configured channels
  npx agent-bell notify <t> <s>  Send custom push notification
  npx agent-bell mcp             Run stdio Model Context Protocol server
  npx agent-bell help            Show this help screen
`);
    break;

  default:
    console.error(`Unknown command: "${command}". Run "npx agent-bell help" for usage.`);
    process.exit(1);
}

export { notify } from '../clients/node/notifier.js';
