import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import worker, { buildTelegramReplyMarkup, safeTelegramCallbackData } from '../worker/src/index.js';
import { parseWrapArgs, runWrap } from '../bin/wrap.js';
import { compareSemver, runUpdate } from '../bin/update.js';
import { runSetup } from '../bin/setup.js';
import { askUserRemote, getDeviceStatus, handleMcpRequest, MCP_TOOLS } from '../mcp/server.js';
import { buildDiscordComponents } from '../worker/src/discord.js';
import { buildSlackBlocks } from '../worker/src/slack.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createMockKV() {
  const store = new Map();
  return {
    async get(key, type) {
      const val = store.get(key);
      if (val === undefined) return null;
      if (type === 'json') {
        try { return JSON.parse(val); } catch { return null; }
      }
      return val;
    },
    async put(key, value) {
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async delete(key) {
      store.delete(key);
    },
    _raw: store
  };
}

// ─────────────────────────────────────────────────────────────
// 1. Setup Wizard Tests (bin/setup.js)
// ─────────────────────────────────────────────────────────────

test('Setup wizard runs non-interactively and writes configuration files', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-setup-test-'));

  try {
    const res = await runSetup({
      nonInteractive: true,
      homeDir: tmpHome,
      workerUrl: 'https://custom-wizard-worker.dev',
      authSecret: 'super-secret-123',
      language: 'vi',
      minDurationSeconds: 5,
      testPing: false,
      installPlugin: false
    });

    assert.equal(res.success, true);
    assert.equal(res.config.workerUrl, 'https://custom-wizard-worker.dev');
    assert.equal(res.config.authSecret, 'super-secret-123');
    assert.equal(res.config.language, 'vi');
    assert.equal(res.config.minDurationSeconds, 5);
    assert.ok(Array.isArray(res.config.workspaces));

    // Verify config files were written in isolated tmpHome
    const savedConfig = JSON.parse(fs.readFileSync(path.join(tmpHome, '.agent-bell', 'config.json'), 'utf8'));
    assert.equal(savedConfig.workerUrl, 'https://custom-wizard-worker.dev');
    assert.equal(savedConfig.authSecret, 'super-secret-123');

    const legacyConfig = JSON.parse(fs.readFileSync(path.join(tmpHome, '.antigravity-telegram.json'), 'utf8'));
    assert.equal(legacyConfig.workerUrl, 'https://custom-wizard-worker.dev');
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─────────────────────────────────────────────────────────────
// 2. Command Wrapper Tests (bin/wrap.js)
// ─────────────────────────────────────────────────────────────

test('parseWrapArgs parses title, workspace, silent, and command parts', () => {
  const args1 = ['-t', 'My Test', '-w', 'TestWS', '-s', 'npm', 'test'];
  const p1 = parseWrapArgs(args1);
  assert.equal(p1.title, 'My Test');
  assert.equal(p1.workspace, 'TestWS');
  assert.equal(p1.isSilent, true);
  assert.equal(p1.command, 'npm test');

  const args2 = ['--title', 'Build Job', '--', 'npm', 'run', 'build', '--prod'];
  const p2 = parseWrapArgs(args2);
  assert.equal(p2.title, 'Build Job');
  assert.equal(p2.command, 'npm run build --prod');

  const pHelp = parseWrapArgs(['--help']);
  assert.equal(pHelp.help, true);
});

test('parseWrapArgs preserves command flags even without double-dash separator', () => {
  const p1 = parseWrapArgs(['git', 'log', '-n', '5']);
  assert.equal(p1.command, 'git log -n 5');
  assert.deepEqual(p1.commandParts, ['git', 'log', '-n', '5']);

  const p2 = parseWrapArgs(['-t', 'Test Suite', 'pytest', '-v', '-s']);
  assert.equal(p2.title, 'Test Suite');
  assert.equal(p2.command, 'pytest -v -s');
  assert.deepEqual(p2.commandParts, ['pytest', '-v', '-s']);
});

test('runWrap executes successful shell command and returns 0 exit code', async () => {
  const originalFetch = globalThis.fetch;
  let interceptedPayload = null;

  globalThis.fetch = async (url, opts) => {
    interceptedPayload = JSON.parse(opts.body);
    return new Response(JSON.stringify({ success: true }));
  };

  try {
    const exitCode = await runWrap([
      '-t', 'Echo Test',
      '--',
      process.execPath, '-e', 'console.log("WRAPPER_OUTPUT_SUCCESS")'
    ]);

    assert.equal(exitCode, 0);
    assert.ok(interceptedPayload);
    assert.equal(interceptedPayload.prompt, 'Echo Test');
    assert.equal(interceptedPayload.isError, undefined);
    assert.ok(interceptedPayload.summary.includes('Succeeded'));
    assert.ok(interceptedPayload.output.includes('WRAPPER_OUTPUT_SUCCESS'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runWrap executes failing shell command, captures exit code and marks error', async () => {
  const originalFetch = globalThis.fetch;
  let interceptedPayload = null;

  globalThis.fetch = async (url, opts) => {
    interceptedPayload = JSON.parse(opts.body);
    return new Response(JSON.stringify({ success: true }));
  };

  try {
    const exitCode = await runWrap([
      '-t', 'Fail Test',
      '--',
      process.execPath, '-e', 'console.error("CRITICAL_FAILURE"); process.exit(42)'
    ]);

    assert.equal(exitCode, 42);
    assert.ok(interceptedPayload);
    assert.equal(interceptedPayload.isError, true);
    assert.ok(interceptedPayload.summary.includes('Failed (exit code 42)'));
    assert.ok(interceptedPayload.output.includes('CRITICAL_FAILURE'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────
// 3. Self-Updater Tests (bin/update.js)
// ─────────────────────────────────────────────────────────────

test('compareSemver accurately compares version numbers', () => {
  assert.equal(compareSemver('2.1.0', '2.0.0'), 1);
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0);
  assert.equal(compareSemver('1.9.5', '2.0.0'), -1);
  assert.equal(compareSemver('v2.1.0', '2.1.0'), 0);
  assert.equal(compareSemver('2.0.1', '2.0.0'), 1);
});

test('runUpdate in check mode executes safely without crashing', async () => {
  const res = await runUpdate(['--check']);
  assert.ok(typeof res === 'object');
  assert.ok(res.currentVersion);
});

// ─────────────────────────────────────────────────────────────
// 4. MCP Server Tests (mcp/server.js)
// ─────────────────────────────────────────────────────────────

test('MCP_TOOLS definition lists ask_user_remote, get_device_status, agent_bell_notify', () => {
  const names = MCP_TOOLS.map((t) => t.name);
  assert.ok(names.includes('agent_bell_notify'));
  assert.ok(names.includes('ask_user_remote'));
  assert.ok(names.includes('get_device_status'));
  assert.ok(names.includes('agent_bell_status'));

  const askTool = MCP_TOOLS.find((t) => t.name === 'ask_user_remote');
  assert.ok(askTool.inputSchema.properties.question);
  assert.ok(askTool.inputSchema.properties.choices);
  assert.ok(askTool.inputSchema.properties.timeout_seconds);
});

test('handleMcpRequest executes get_device_status and returns valid environment details', async () => {
  const res = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'get_device_status',
      arguments: {}
    }
  });

  assert.equal(res.id, 10);
  assert.ok(res.result.content);
  const data = JSON.parse(res.result.content[0].text);
  assert.ok(data.runnerStatus === 'running' || data.runnerStatus === 'stopped');
  assert.ok(data.activeWorkspace);
  assert.ok(data.git);
});

test('askUserRemote pushes question and polls for answered choice', async () => {
  const kv = createMockKV();
  const env = { NOTIFIER_KV: kv, AUTH_SECRET: 'mcp-secret' };

  let simulatedPollCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.includes('/notify')) {
      return new Response(JSON.stringify({ success: true, messageId: 999 }));
    }
    if (urlStr.includes('/api/ask/poll')) {
      simulatedPollCount++;
      // Simulate user answering on the 2nd poll
      if (simulatedPollCount >= 2) {
        return new Response(JSON.stringify({
          answered: true,
          status: 'answered',
          answer: 'Option 2: Deploy to Staging',
          choice: 'Option 2: Deploy to Staging'
        }));
      }
      return new Response(JSON.stringify({ answered: false, status: 'pending' }));
    }
    return new Response('Not Found', { status: 404 });
  };

  try {
    const result = await askUserRemote({
      question: 'Which target environment to deploy?',
      choices: ['Option 1: Canary', 'Option 2: Deploy to Staging'],
      timeout_seconds: 5,
      pollIntervalMs: 50,
      url: 'https://test-worker.dev/notify',
      secret: 'mcp-secret'
    });

    assert.equal(result.success, true);
    assert.equal(result.answer, 'Option 2: Deploy to Staging');
    assert.ok(result.taskId.startsWith('ask-'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('askUserRemote handles timeout when developer does not respond', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/notify')) {
      return new Response(JSON.stringify({ success: true }));
    }
    if (urlStr.includes('/api/ask/poll')) {
      return new Response(JSON.stringify({ answered: false, status: 'pending' }));
    }
    return new Response('Not Found', { status: 404 });
  };

  try {
    const result = await askUserRemote({
      question: 'Will you answer?',
      choices: ['Yes', 'No'],
      timeout_seconds: 0.1, // 100ms timeout
      pollIntervalMs: 30,
      url: 'https://test-worker.dev/notify'
    });

    assert.equal(result.success, false);
    assert.equal(result.timeout, true);
    assert.ok(result.error.includes('timeout'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('askUserRemote fails fast on 401 unauthorized without waiting for timeout', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/notify')) {
      return new Response(JSON.stringify({ success: true }));
    }
    if (urlStr.includes('/api/ask/poll')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
    return new Response('Not Found', { status: 404 });
  };

  try {
    const start = Date.now();
    const result = await askUserRemote({
      question: 'Deploy now?',
      choices: ['Yes', 'No'],
      timeout_seconds: 300,
      pollIntervalMs: 40,
      url: 'https://test-worker.dev/notify'
    });

    const elapsed = Date.now() - start;
    assert.equal(result.success, false);
    assert.ok(result.error.includes('401'));
    assert.ok(elapsed < 5000, `Expected elapsed < 5000ms, got ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('handleMcpRequest agent_bell_notify forwards priority and sound parameters', async () => {
  const originalFetch = globalThis.fetch;
  let sentPayload = null;

  globalThis.fetch = async (url, opts) => {
    sentPayload = JSON.parse(opts.body);
    return new Response(JSON.stringify({ success: true }));
  };

  try {
    process.env.AGENT_BELL_WORKER_URL = 'https://mcp-worker.dev/notify';
    const res = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: {
        name: 'agent_bell_notify',
        arguments: {
          task: 'Urgent Alert',
          summary: 'Database connection failed',
          priority: 'urgent',
          sound: 'alarm'
        }
      }
    });

    assert.equal(res.id, 99);
    assert.equal(res.result.isError, undefined);
    assert.ok(sentPayload);
    assert.equal(sentPayload.priority, 'urgent');
    assert.equal(sentPayload.sound, 'alarm');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AGENT_BELL_WORKER_URL;
  }
});

// ─────────────────────────────────────────────────────────────
// 5. Cloudflare Worker API & Multi-Channel Choice Tests
// ─────────────────────────────────────────────────────────────

test('Worker GET & POST /api/ask/poll handles authentication, pending, and answered state', async () => {
  const kv = createMockKV();
  const env = { NOTIFIER_KV: kv, AUTH_SECRET: 'poll-secret' };

  // 1. Missing auth
  const reqUnauth = new Request('https://agent-bell.dev/api/ask/poll?taskId=task-123');
  const resUnauth = await worker.fetch(reqUnauth, env);
  assert.equal(resUnauth.status, 401);

  // 2. Pending (unanswered)
  const reqPending = new Request('https://agent-bell.dev/api/ask/poll?taskId=task-123', {
    headers: { Authorization: 'Bearer poll-secret' }
  });
  const resPending = await worker.fetch(reqPending, env);
  assert.equal(resPending.status, 200);
  const dataPending = await resPending.json();
  assert.equal(dataPending.answered, false);
  assert.equal(dataPending.status, 'pending');

  // 3. Answered via approval key
  await kv.put('approval_task-123', 'APPROVED');
  const resAnswered = await worker.fetch(reqPending, env);
  const dataAnswered = await resAnswered.json();
  assert.equal(dataAnswered.answered, true);
  assert.equal(dataAnswered.answer, 'APPROVED');

  // 4. Answered via answer key (custom choice via POST)
  await kv.put('answer_task-custom', 'Selected Option B');
  const reqPost = new Request('https://agent-bell.dev/api/approval/status', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer poll-secret',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ taskId: 'task-custom' })
  });
  const resPost = await worker.fetch(reqPost, env);
  assert.equal(resPost.status, 200);
  const dataPost = await resPost.json();
  assert.equal(dataPost.answered, true);
  assert.equal(dataPost.answer, 'Selected Option B');
});

test('Telegram Webhook callback query ans:taskId:choice updates KV and confirms selection', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    TELEGRAM_CHAT_ID: '987654321'
  };

  const originalFetch = globalThis.fetch;
  let answerCallbackText = null;

  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.includes('answerCallbackQuery')) {
      const body = JSON.parse(opts.body);
      answerCallbackText = body.text;
      return new Response(JSON.stringify({ ok: true }));
    }
    if (urlStr.includes('editMessageText')) {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response(JSON.stringify({ ok: true }));
  };

  try {
    const callbackPayload = {
      update_id: 99991,
      callback_query: {
        id: 'cb-query-test-choice',
        data: 'ans:task-tg-10:Option-Alpha',
        message: {
          message_id: 456,
          chat: { id: 987654321 },
          text: 'Select deployment option'
        }
      }
    };

    const req = new Request('https://agent-bell.dev/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callbackPayload)
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const saved = await kv.get('approval_task-tg-10');
    assert.equal(saved, 'Option-Alpha');
    assert.ok(answerCallbackText.includes('Option-Alpha'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord buildDiscordComponents and interactive button choices update KV', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: 'app-123'
  };

  // Test component builder
  const components = buildDiscordComponents({
    taskId: 'disc-task-1',
    choices: ['Canary', 'Full Rollout', 'Abort']
  });

  assert.equal(components.length, 1);
  assert.equal(components[0].components.length, 3);
  assert.equal(components[0].components[0].label, 'Canary');
  assert.ok(components[0].components[0].custom_id.startsWith('choice:disc-task-1:'));

  // Test interaction handler for choice:taskId:choice
  const interactionPayload = {
    type: 3, // MESSAGE_COMPONENT
    data: {
      custom_id: 'choice:disc-task-1:Full Rollout'
    },
    member: { user: { id: 'user-777' } }
  };

  const req = new Request('https://agent-bell.dev/discord/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(interactionPayload)
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.data.content.includes('Full Rollout'));

  const saved = await kv.get('approval_disc-task-1');
  assert.equal(saved, 'Full Rollout');
});

test('Slack buildSlackBlocks and interactive button choices update KV', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    SLACK_BOT_TOKEN: 'xoxb-test'
  };

  // Test block builder with choices
  const blocks = buildSlackBlocks({
    taskId: 'slack-task-1',
    choices: ['Merge PR', 'Request Changes']
  }, 'Summary test');

  const actionsBlock = blocks.find((b) => b.type === 'actions');
  assert.ok(actionsBlock);
  assert.equal(actionsBlock.elements.length, 2);
  assert.equal(actionsBlock.elements[0].text.text, 'Merge PR');
  assert.ok(actionsBlock.elements[0].value.startsWith('choice:slack-task-1:'));

  // Test interaction handler
  const slackPayload = {
    user: { id: 'U12345' },
    actions: [
      {
        value: 'choice:slack-task-1:Merge PR'
      }
    ]
  };

  const bodyFormData = 'payload=' + encodeURIComponent(JSON.stringify(slackPayload));
  const req = new Request('https://agent-bell.dev/slack/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: bodyFormData
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.text.includes('Merge PR'));

  const saved = await kv.get('approval_slack-task-1');
  assert.equal(saved, 'Merge PR');
});

test('buildTelegramReplyMarkup strictly bounds callback_data to <= 64 bytes even with long unicode choices', () => {
  const longChoice = 'Tùy chọn triển khai hệ thống lên môi trường phân tán Kubernetes Cluster';
  const markup = buildTelegramReplyMarkup({
    taskId: 'ask-1729701234567-abcde',
    choices: [longChoice, 'Short', 'Deploy now']
  });

  assert.ok(markup);
  assert.ok(markup.inline_keyboard);
  const row = markup.inline_keyboard[0];
  assert.equal(row.length, 3);

  for (const btn of row) {
    const bytes = Buffer.byteLength(btn.callback_data, 'utf8');
    assert.ok(bytes <= 64, `Button callback_data exceeds 64 bytes: ${bytes} bytes ("${btn.callback_data}")`);
    assert.ok(bytes > 0);
  }
});
