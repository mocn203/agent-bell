import test from 'node:test';
import assert from 'node:assert/strict';

import { notify } from '../clients/node/notifier.js';

test('Node client notify returns error on missing worker URL', async () => {
  const originalUrl = process.env.AGENT_BELL_WORKER_URL;
  const originalAntigravityUrl = process.env.ANTIGRAVITY_TELEGRAM_URL;
  delete process.env.AGENT_BELL_WORKER_URL;
  delete process.env.ANTIGRAVITY_TELEGRAM_URL;

  try {
    const res = await notify({ task: 'Test task', summary: 'Test summary' });
    assert.deepEqual(res, { error: 'Missing worker URL' });
  } finally {
    if (originalUrl) process.env.AGENT_BELL_WORKER_URL = originalUrl;
    if (originalAntigravityUrl) process.env.ANTIGRAVITY_TELEGRAM_URL = originalAntigravityUrl;
  }
});

test('Node client notify posts payload with env auth and auto-attached git diff', async () => {
  const originalFetch = globalThis.fetch;
  let interceptedUrl = null;
  let interceptedHeaders = null;
  let interceptedBody = null;

  globalThis.fetch = async (url, opts) => {
    interceptedUrl = url;
    interceptedHeaders = opts.headers;
    interceptedBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({ success: true, messageId: 123 }));
  };

  process.env.AGENT_BELL_WORKER_URL = 'https://custom-worker.dev/notify';
  process.env.AGENT_BELL_AUTH_SECRET = 'test-token-xyz';

  try {
    const res = await notify({
      task: 'Build feature',
      summary: 'Feature implemented cleanly',
      workspace: 'Work4',
      durationSeconds: 12,
      messageThreadId: 99
    });

    assert.equal(res.success, true);
    assert.equal(interceptedUrl, 'https://custom-worker.dev/notify');
    assert.equal(interceptedHeaders['Authorization'], 'Bearer test-token-xyz');
    assert.equal(interceptedBody.workspace, 'Work4');
    assert.equal(interceptedBody.prompt, 'Build feature');
    assert.equal(interceptedBody.summary, 'Feature implemented cleanly');
    assert.equal(interceptedBody.durationSeconds, 12);
    assert.equal(interceptedBody.messageThreadId, 99);
    // Auto-attached Git header and summary should be present because current repo is a git workspace
    assert.ok(interceptedBody.gitHeader);
    assert.ok(interceptedBody.gitSummary);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AGENT_BELL_WORKER_URL;
    delete process.env.AGENT_BELL_AUTH_SECRET;
  }
});

test('Node client notify automatically sanitizes credentials from task and summary and defaults workspace', async () => {
  const originalFetch = globalThis.fetch;
  let interceptedBody = null;

  globalThis.fetch = async (url, opts) => {
    interceptedBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({ success: true }));
  };

  process.env.AGENT_BELL_WORKER_URL = 'https://custom-worker.dev/notify';

  try {
    const res = await notify({
      task: 'Check key ' + ['sk', '1234567890abcdef1234567890'].join('-') + ' in config',
      summary: 'Found leak: {"apiKey": "Secret12345"} and TOKEN=mySecretToken123'
    });

    assert.equal(res.success, true);
    assert.ok(interceptedBody);
    assert.ok(!interceptedBody.prompt.includes(['sk', '1234567890abcdef1234567890'].join('-')));
    assert.ok(interceptedBody.prompt.includes('sk-***'));
    assert.ok(!interceptedBody.summary.includes('Secret12345'));
    assert.ok(interceptedBody.summary.includes('"apiKey": "***"'));
    assert.ok(!interceptedBody.summary.includes('mySecretToken123'));
    assert.ok(interceptedBody.summary.includes('TOKEN=***'));
    assert.ok(interceptedBody.workspace.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AGENT_BELL_WORKER_URL;
  }
});

test('Node client notify passes discordChannelId, slackChannelId, slackThreadTs, and conversationId', async () => {
  const originalFetch = globalThis.fetch;
  let interceptedBody = null;

  globalThis.fetch = async (url, opts) => {
    interceptedBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({ success: true }));
  };

  process.env.AGENT_BELL_WORKER_URL = 'https://custom-worker.dev/notify';

  try {
    const res = await notify({
      task: 'Multi-channel notification',
      summary: 'Delivered to custom threads',
      discordChannelId: 'discord-1234',
      slackChannelId: 'slack-5678',
      slackThreadTs: '1700000000.999',
      conversationId: 'conv-abc',
      taskId: 'task-456'
    });

    assert.equal(res.success, true);
    assert.equal(interceptedBody.discordChannelId, 'discord-1234');
    assert.equal(interceptedBody.slackChannelId, 'slack-5678');
    assert.equal(interceptedBody.slackThreadTs, '1700000000.999');
    assert.equal(interceptedBody.conversationId, 'conv-abc');
    assert.equal(interceptedBody.taskId, 'task-456');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AGENT_BELL_WORKER_URL;
  }
});

