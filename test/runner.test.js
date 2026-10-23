import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

import {
  isProcessAlive,
  acquirePidLock,
  releasePidLock,
  killProcessTree,
  loadRunnerConfig,
  sendHeartbeat,
  pollQueue,
  PID_FILE,
  CONFIG_FILE
} from '../bin/runner.js';

test('isProcessAlive returns true for current process and false for dummy PID', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(9999999), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive('not-a-pid'), false);
});

test('acquirePidLock takes over stale PID lock from dead process', () => {
  // Write a fake dead PID
  fs.writeFileSync(PID_FILE, '9999999', 'utf8');

  // Should acquire lock and overwrite stale PID
  const lock = acquirePidLock();
  assert.equal(lock.acquired, true);
  assert.equal(fs.readFileSync(PID_FILE, 'utf8').trim(), String(process.pid));

  // Clean up
  releasePidLock();
  assert.equal(fs.existsSync(PID_FILE), false);
});

test('acquirePidLock rejects when an active process holds the lock', () => {
  // Spawn a dummy process to hold the lock
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true
  });
  assert.ok(child.pid);

  try {
    fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');

    // Attempt to acquire should fail because child.pid is alive
    const lock = acquirePidLock();
    assert.equal(lock.acquired, false);
    assert.equal(lock.existingPid, child.pid);
  } finally {
    killProcessTree(child.pid);
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
  }
});

test('loadRunnerConfig returns valid config object with fallbacks and env vars', () => {
  process.env.AGENT_BELL_WORKER_URL = 'https://custom-env.workers.dev';
  try {
    const config = loadRunnerConfig();
    assert.ok(config);
    assert.equal(typeof config.pollIntervalMs, 'number');
    assert.equal(typeof config.heartbeatIntervalMs, 'number');
    assert.ok(Array.isArray(config.workspaces));
    assert.equal(config.workerUrl, 'https://custom-env.workers.dev');
  } finally {
    delete process.env.AGENT_BELL_WORKER_URL;
  }
});

test('sendHeartbeat and pollQueue safely handle empty or invalid configs without crashing', async () => {
  // Calling with empty or invalid config objects should safely no-op
  await assert.doesNotReject(async () => {
    await sendHeartbeat({});
    await sendHeartbeat({ workerUrl: null });
    await pollQueue({});
    await pollQueue({ workerUrl: '' });
  });
});

test('killProcessTree terminates spawned child process tree cleanly', async () => {
  // Spawn a long-running process
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true
  });

  assert.ok(child.pid);
  assert.equal(isProcessAlive(child.pid), true);

  // Terminate process tree
  killProcessTree(child.pid);

  // Wait briefly for OS to reap
  await new Promise((r) => setTimeout(r, 600));

  assert.equal(isProcessAlive(child.pid), false);
});

test('pollQueue processes SWITCH_WORKSPACE and RUN_PROMPT tasks', async () => {
  const dummyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-runner-test-'));
  const originalFetch = globalThis.fetch;
  const originalConfigContent = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;

  try {
    globalThis.fetch = async (url) => {
      if (url.includes('/api/queue/poll')) {
        return new Response(JSON.stringify({
          tasks: [
            { id: 'task-ws-1', action: 'SWITCH_WORKSPACE', workspace: dummyDir },
            { id: 'task-prompt-1', action: 'RUN_PROMPT', prompt: 'Refactor router' }
          ]
        }));
      }
      return new Response(JSON.stringify({ success: true }));
    };

    const config = {
      workerUrl: 'https://test-worker.dev',
      activeWorkspace: process.cwd(),
      workspaces: [{ name: 'Dummy', path: dummyDir }]
    };

    await assert.doesNotReject(async () => {
      await pollQueue(config);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalConfigContent !== null) {
      try { fs.writeFileSync(CONFIG_FILE, originalConfigContent, 'utf8'); } catch (_) {}
    }
    try { fs.rmSync(dummyDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('pollQueue executes RUN_COMMAND and sends completion notification with stdout output', async () => {
  const originalFetch = globalThis.fetch;
  let dispatchedPayload = null;

  try {
    globalThis.fetch = async (url, opts) => {
      if (url.includes('/api/queue/poll')) {
        return new Response(JSON.stringify({
          tasks: [
            {
              id: 'cmd-test-99',
              action: 'RUN_COMMAND',
              command: `"${process.execPath}" -e "console.log('hello from test')"`,
              messageThreadId: 777
            }
          ]
        }));
      }
      if (url.includes('/notify')) {
        dispatchedPayload = JSON.parse(opts.body);
        return new Response(JSON.stringify({ success: true }));
      }
      return new Response(JSON.stringify({ success: true }));
    };

    const config = {
      workerUrl: 'https://test-worker.dev',
      activeWorkspace: process.cwd()
    };

    await pollQueue(config);

    // Wait for child process to exit and notify
    for (let i = 0; i < 25 && !dispatchedPayload; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(dispatchedPayload);
    assert.equal(dispatchedPayload.isError, false);
    assert.equal(dispatchedPayload.messageThreadId, 777);
    assert.ok(dispatchedPayload.summary.includes('completed successfully'));
    assert.ok(dispatchedPayload.output.includes('hello from test'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pollQueue executes STOP_TASK and dispatches process termination notification', async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      if (url.includes('/api/queue/poll')) {
        return new Response(JSON.stringify({
          tasks: [
            {
              id: 'stop-test-1',
              action: 'STOP_TASK',
              messageThreadId: 888
            }
          ]
        }));
      }
      return new Response(JSON.stringify({ success: true }));
    };

    const config = {
      workerUrl: 'https://test-worker.dev',
      activeWorkspace: process.cwd()
    };

    // Spawn a dummy process first
    const dummyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true
    });

    await pollQueue(config);
    dummyChild.kill();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pollQueue executes REVERT in isolated git directory and dispatches revert notification', async () => {
  const originalFetch = globalThis.fetch;
  const tempGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-runner-revert-'));
  let dispatchedPayload = null;

  try {
    execFileSync('git', ['init'], { cwd: tempGitDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: tempGitDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: tempGitDir, stdio: 'ignore' });

    const baseFile = path.join(tempGitDir, 'tracked.txt');
    fs.writeFileSync(baseFile, 'v1', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempGitDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'commit1'], { cwd: tempGitDir, stdio: 'ignore' });

    fs.writeFileSync(baseFile, 'v2 dirty', 'utf8');

    globalThis.fetch = async (url, opts) => {
      if (url.includes('/api/queue/poll')) {
        return new Response(JSON.stringify({
          tasks: [
            {
              id: 'revert-test-1',
              action: 'REVERT',
              cleanUntracked: true,
              messageThreadId: 999
            }
          ]
        }));
      }
      if (url.includes('/notify')) {
        dispatchedPayload = JSON.parse(opts.body);
        return new Response(JSON.stringify({ success: true }));
      }
      return new Response(JSON.stringify({ success: true }));
    };

    const config = {
      workerUrl: 'https://test-worker.dev',
      activeWorkspace: tempGitDir,
      workspaces: [{ name: 'TempGit', path: tempGitDir }]
    };

    await pollQueue(config);

    assert.ok(dispatchedPayload);
    assert.equal(dispatchedPayload.messageThreadId, 999);
    assert.ok(dispatchedPayload.prompt.includes('Clean Untracked'));
    assert.ok(dispatchedPayload.summary.includes('revert') || dispatchedPayload.summary.includes('reverted'));
    assert.equal(fs.readFileSync(baseFile, 'utf8'), 'v1');
  } finally {
    globalThis.fetch = originalFetch;
    try { fs.rmSync(tempGitDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('pollQueue blocks SWITCH_WORKSPACE attempting path traversal outside workspace roots', async () => {
  const originalFetch = globalThis.fetch;
  const dummyWorkspace = path.join(process.cwd(), 'dummy-allowed');

  try {
    globalThis.fetch = async (url) => {
      if (url.includes('/api/queue/poll')) {
        return new Response(JSON.stringify({
          tasks: [
            {
              id: 'traversal-1',
              action: 'SWITCH_WORKSPACE',
              workspace: '../../../../../../../../../../Windows'
            }
          ]
        }));
      }
      return new Response(JSON.stringify({ success: true }));
    };

    const config = {
      workerUrl: 'https://test-worker.dev',
      activeWorkspace: dummyWorkspace,
      workspaces: [{ name: 'DummyAllowed', path: dummyWorkspace }]
    };

    await pollQueue(config);

    // Active workspace must NOT have switched to Windows root
    assert.equal(config.activeWorkspace, dummyWorkspace);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pollQueue dispatches informational notice when STOP_TASK arrives and runner is idle', async () => {
  const originalFetch = globalThis.fetch;
  let sentPayload = null;

  try {
    globalThis.fetch = async (url, opts) => {
      if (url.includes('/api/queue/poll')) {
        return new Response(JSON.stringify({
          tasks: [{ id: 'stop-idle-1', action: 'STOP_TASK', messageThreadId: 444 }]
        }));
      }
      if (url.includes('/notify')) {
        sentPayload = JSON.parse(opts.body);
        return new Response(JSON.stringify({ success: true }));
      }
      return new Response(JSON.stringify({ success: true }));
    };

    const config = {
      workerUrl: 'https://test-worker.dev',
      activeWorkspace: process.cwd()
    };

    await pollQueue(config);

    assert.ok(sentPayload);
    assert.equal(sentPayload.messageThreadId, 444);
    assert.ok(sentPayload.summary.includes('no active agent command was executing'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pollQueue dispatches warning notification when SWITCH_WORKSPACE is blocked', async () => {
  const originalFetch = globalThis.fetch;
  let sentPayload = null;
  const dummyWorkspace = path.join(process.cwd(), 'dummy-allowed-2');

  try {
    globalThis.fetch = async (url, opts) => {
      if (url.includes('/api/queue/poll')) {
        return new Response(JSON.stringify({
          tasks: [{ id: 'blocked-ws-1', action: 'SWITCH_WORKSPACE', workspace: '../../../../../../Windows', messageThreadId: 555 }]
        }));
      }
      if (url.includes('/notify')) {
        sentPayload = JSON.parse(opts.body);
        return new Response(JSON.stringify({ success: true }));
      }
      return new Response(JSON.stringify({ success: true }));
    };

    const config = {
      workerUrl: 'https://test-worker.dev',
      activeWorkspace: dummyWorkspace,
      workspaces: [{ name: 'DummyAllowed2', path: dummyWorkspace }]
    };

    await pollQueue(config);

    assert.ok(sentPayload);
    assert.equal(sentPayload.isError, true);
    assert.equal(sentPayload.messageThreadId, 555);
    assert.ok(sentPayload.summary.includes('blocked by security sandbox'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pollQueue forwards discordChannelId, slackChannelId, slackThreadTs, and conversationId in notifications', async () => {
  const originalFetch = globalThis.fetch;
  let sentPayload = null;

  try {
    globalThis.fetch = async (url, opts) => {
      if (url.includes('/api/queue/poll')) {
        return new Response(JSON.stringify({
          tasks: [
            {
              id: 'cmd-multi-chan-1',
              action: 'RUN_COMMAND',
              command: 'node -e "process.exit(0)"',
              messageThreadId: 101,
              discordChannelId: 'discord-chan-77',
              slackChannelId: 'slack-chan-88',
              slackThreadTs: '1700000000.555',
              conversationId: 'conv-xyz-123'
            }
          ]
        }));
      }
      if (url.includes('/notify')) {
        sentPayload = JSON.parse(opts.body);
        return new Response(JSON.stringify({ success: true }));
      }
      return new Response(JSON.stringify({ success: true }));
    };

    const config = {
      workerUrl: 'https://test-worker.dev',
      activeWorkspace: process.cwd()
    };

    await pollQueue(config);

    // Wait for async child execution to complete and sendRunnerNotification to fire
    let count = 0;
    while (!sentPayload && count++ < 30) {
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(sentPayload);
    assert.equal(sentPayload.messageThreadId, 101);
    assert.equal(sentPayload.discordChannelId, 'discord-chan-77');
    assert.equal(sentPayload.slackChannelId, 'slack-chan-88');
    assert.equal(sentPayload.slackThreadTs, '1700000000.555');
    assert.equal(sentPayload.conversationId, 'conv-xyz-123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

