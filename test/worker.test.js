import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';

// In-memory mock KV store
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

test('Worker GET /health returns 200 OK', async () => {
  const req = new Request('https://agent-bell.workers.dev/health');
  const env = {};
  const res = await worker.fetch(req, env);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.service, 'agent-bell');
});

test('Worker POST /api/runner/heartbeat saves heartbeat in KV', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    AUTH_SECRET: 'test-secret'
  };

  const payload = {
    runnerId: 'node-pc-1234',
    pid: 1234,
    hostname: 'test-pc',
    uptime: 100,
    activeWorkspace: 'Work4',
    workspaces: [{ name: 'Work4', path: '/code/Work4' }],
    gitHeader: 'Work4:main (ahead 1)',
    timestamp: new Date().toISOString()
  };

  // Unauthorized attempt
  const reqBad = new Request('https://agent-bell.workers.dev/api/runner/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const resBad = await worker.fetch(reqBad, env);
  assert.equal(resBad.status, 401);

  // Authorized attempt
  const reqGood = new Request('https://agent-bell.workers.dev/api/runner/heartbeat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-secret'
    },
    body: JSON.stringify(payload)
  });
  const resGood = await worker.fetch(reqGood, env);
  assert.equal(resGood.status, 200);

  const saved = await kv.get('runner_heartbeat', 'json');
  assert.ok(saved);
  assert.equal(saved.runnerId, 'node-pc-1234');
  assert.equal(saved.activeWorkspace, 'Work4');
});

test('Worker /api/queue/push and /api/queue/poll workflow', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    AUTH_SECRET: 'secret123'
  };

  // Push task
  const pushReq = new Request('https://agent-bell.workers.dev/api/queue/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer secret123'
    },
    body: JSON.stringify({
      id: 'task-test-1',
      action: 'STOP_TASK',
      params: {}
    })
  });
  const pushRes = await worker.fetch(pushReq, env);
  assert.equal(pushRes.status, 200);

  // Poll task
  const pollReq = new Request('https://agent-bell.workers.dev/api/queue/poll', {
    method: 'GET',
    headers: { 'Authorization': 'Bearer secret123' }
  });
  const pollRes = await worker.fetch(pollReq, env);
  assert.equal(pollRes.status, 200);
  const pollData = await pollRes.json();

  assert.equal(Array.isArray(pollData.tasks), true);
  assert.equal(pollData.tasks.length, 1);
  assert.equal(pollData.tasks[0].id, 'task-test-1');
  assert.equal(pollData.tasks[0].action, 'STOP_TASK');

  // Second poll should now be empty (popped)
  const pollReq2 = new Request('https://agent-bell.workers.dev/api/queue/poll', {
    method: 'GET',
    headers: { 'Authorization': 'Bearer secret123' }
  });
  const pollRes2 = await worker.fetch(pollReq2, env);
  const pollData2 = await pollRes2.json();
  assert.equal(pollData2.tasks.length, 0);
});

test('Telegram Webhook validates X-Telegram-Bot-Api-Secret-Token when configured', async () => {
  const env = {
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'valid-32-char-secret-token-hex123'
  };

  // Missing or wrong token -> 401
  const reqBad = new Request('https://agent-bell.workers.dev/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'wrong-token'
    },
    body: JSON.stringify({ message: { chat: { id: 123456789 }, text: '/menu' } })
  });
  const resBad = await worker.fetch(reqBad, env);
  assert.equal(resBad.status, 401);

  // Valid token -> 200
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: { message_id: 111 } }));
  try {
    const reqGood = new Request('https://agent-bell.workers.dev/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'valid-32-char-secret-token-hex123'
      },
      body: JSON.stringify({ message: { chat: { id: 123456789 }, text: '/menu' } })
    });
    const resGood = await worker.fetch(reqGood, env);
    assert.equal(resGood.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram Webhook rejects unauthorized chat IDs', async () => {
  const env = {
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const req = new Request('https://agent-bell.workers.dev/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        chat: { id: 999999999 },
        text: '/menu'
      }
    })
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 403);
});

test('Telegram Webhook callback query menu:stop queues emergency stop', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  const interceptedCalls = [];
  globalThis.fetch = async (url, opts) => {
    interceptedCalls.push({ url, opts });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query: {
          id: 'cb-123',
          from: { id: 123456789 },
          message: {
            chat: { id: 123456789 },
            message_id: 888
          },
          data: 'menu:stop'
        }
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    // Verify task queued in KV
    const queued = await kv.get('queue_tasks', 'json');
    assert.ok(queued);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].action, 'STOP_TASK');

    // Verify editTelegramMessage was called
    const editCall = interceptedCalls.find((c) => c.url.includes('editMessageText'));
    assert.ok(editCall);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram Webhook /revert command queues REVERT action in KV', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  let sentText = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('sendMessage')) {
      const b = JSON.parse(opts.body);
      sentText = b.text;
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 555 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          chat: { id: 123456789 },
          text: '/revert'
        }
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const queued = await kv.get('queue_tasks', 'json');
    assert.ok(queued);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].action, 'REVERT');

    assert.ok(sentText.includes('Emergency Revert Queued'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Inbound /notify formats Git summary, passes threadId, and records telemetry', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  let sentPayload = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('sendMessage')) {
      sentPayload = JSON.parse(opts.body);
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: 'Work4',
        gitHeader: 'Work4:main (ahead 1)',
        gitSummary: '• Git: +45/-12 (3 files)\n  📝 lib/git.js\n  ➕ bin/runner.js',
        prompt: 'Implement Phase 1 runner and git engine',
        summary: 'Runner and git engine deployed cleanly.',
        durationSeconds: 15,
        messageThreadId: 42
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.telegramMessageId, 777);

    // Verify sent message format contains Caveman Git diff and message_thread_id
    assert.ok(sentPayload);
    assert.equal(sentPayload.message_thread_id, 42);
    assert.ok(sentPayload.text.includes('Work4:main (ahead 1)'));
    assert.ok(sentPayload.text.includes('+45/-12 (3 files)'));
    assert.ok(sentPayload.text.includes('📝 lib/git.js'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram Webhook /revert clean command queues REVERT with cleanUntracked: true in KV', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  let sentText = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('sendMessage')) {
      const b = JSON.parse(opts.body);
      sentText = b.text;
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 556 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          chat: { id: 123456789 },
          text: '/revert clean'
        }
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const queued = await kv.get('queue_tasks', 'json');
    assert.ok(queued);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].action, 'REVERT');
    assert.equal(queued[0].cleanUntracked, true);

    assert.ok(sentText.includes('Emergency Revert Queued'));
    assert.ok(sentText.includes('(including untracked files)'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker /notify scrubs API keys and private keys before dispatching to Telegram', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  let sentPayload = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('sendMessage')) {
      sentPayload = JSON.parse(opts.body);
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 888 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: 'Work4',
        prompt: 'Testing leak ' + ['sk', '1234567890abcdef1234567890'].join('-') + ' and Bearer eyJhbGciOiJIUzI1NiJ9.test.sig',
        summary: 'Secret token: ' + ['gsk', '1234567890abcdef1234567890'].join('_') + ' and password="SuperSecretPassword123"',
        gitHeader: 'Work4:main',
        gitSummary: '• Git: +1/-1 (1 file)\n  📝 .env with ' + ['ghp', '1234567890abcdef1234567890'].join('_')
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    assert.ok(sentPayload);
    // Ensure raw secrets are NOT present in the sent message
    assert.ok(!sentPayload.text.includes(['sk', '1234567890abcdef1234567890'].join('-')));
    assert.ok(!sentPayload.text.includes(['gsk', '1234567890abcdef1234567890'].join('_')));
    assert.ok(!sentPayload.text.includes(['ghp', '1234567890abcdef1234567890'].join('_')));
    assert.ok(!sentPayload.text.includes('SuperSecretPassword123'));
    assert.ok(!sentPayload.text.includes('eyJhbGciOiJIUzI1NiJ9.test.sig'));

    // Ensure masked replacements are present
    assert.ok(sentPayload.text.includes('sk-***'));
    assert.ok(sentPayload.text.includes('gsk_***'));
    assert.ok(sentPayload.text.includes('ghp_***'));
    assert.ok(sentPayload.text.includes('Bearer ***'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram Webhook /prompt command queues RUN_PROMPT in KV', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  let sentText = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('sendMessage')) {
      const b = JSON.parse(opts.body);
      sentText = b.text;
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }));
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          chat: { id: 123456789 },
          text: '/prompt Refactor database migration scripts'
        }
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const queued = await kv.get('queue_tasks', 'json');
    assert.ok(queued);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].action, 'RUN_PROMPT');
    assert.equal(queued[0].prompt, 'Refactor database migration scripts');
    assert.ok(sentText.includes('Prompt Queued for Agent'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram Webhook /run command queues RUN_COMMAND in KV', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  let sentText = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('sendMessage')) {
      const b = JSON.parse(opts.body);
      sentText = b.text;
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 102 } }));
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          chat: { id: 123456789 },
          text: '/run npm run build'
        }
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const queued = await kv.get('queue_tasks', 'json');
    assert.ok(queued);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].action, 'RUN_COMMAND');
    assert.equal(queued[0].command, 'npm run build');
    assert.ok(sentText.includes('Remote Command Queued'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram Webhook /stop command queues STOP_TASK in KV', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  let sentText = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('sendMessage')) {
      const b = JSON.parse(opts.body);
      sentText = b.text;
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 103 } }));
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          chat: { id: 123456789 },
          text: '/stop'
        }
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const queued = await kv.get('queue_tasks', 'json');
    assert.ok(queued);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].action, 'STOP_TASK');
    assert.ok(sentText.includes('Emergency Stop Dispatched'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram Webhook /status returns runner connectivity state', async () => {
  const kv = createMockKV();
  await kv.put('runner_heartbeat', JSON.stringify({
    runnerId: 'pc-1',
    pid: 5432,
    hostname: 'devbox',
    uptime: 3600,
    activeWorkspace: 'Work4',
    gitHeader: 'Work4:main (ahead 1)',
    timestamp: new Date().toISOString()
  }));

  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  let sentText = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('sendMessage')) {
      const b = JSON.parse(opts.body);
      sentText = b.text;
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 104 } }));
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          chat: { id: 123456789 },
          text: '/status'
        }
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    assert.ok(sentText.includes('ONLINE'));
    assert.ok(sentText.includes('5432'));
    assert.ok(sentText.includes('Work4'));
    assert.ok(sentText.includes('Work4:main (ahead 1)'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram Webhook /switch command queues SWITCH_WORKSPACE in KV', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  let sentText = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('sendMessage')) {
      const b = JSON.parse(opts.body);
      sentText = b.text;
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 105 } }));
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          chat: { id: 123456789 },
          text: '/switch BackendAPI'
        }
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const queued = await kv.get('queue_tasks', 'json');
    assert.ok(queued);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].action, 'SWITCH_WORKSPACE');
    assert.equal(queued[0].workspace, 'BackendAPI');
    assert.ok(sentText.includes('Switch Workspace Queued'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram Webhook /workspaces command lists configured workspaces', async () => {
  const kv = createMockKV();
  await kv.put('runner_heartbeat', JSON.stringify({
    workspaces: [
      { name: 'Work4', path: '/code/Work4' },
      { name: 'Frontend', path: '/code/Frontend' }
    ],
    activeWorkspace: 'Work4'
  }));

  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  let sentText = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('sendMessage')) {
      const b = JSON.parse(opts.body);
      sentText = b.text;
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 106 } }));
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          chat: { id: 123456789 },
          text: '/workspaces'
        }
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    assert.ok(sentText.includes('Work4'));
    assert.ok(sentText.includes('Frontend'));
    assert.ok(sentText.includes('(Active)'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram Webhook handles commands with @botname suffix', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: { message_id: 107 } }));

  try {
    const req = new Request('https://agent-bell.workers.dev/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          chat: { id: 123456789 },
          text: '/run@agent_bell_bot git status'
        }
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    const queued = await kv.get('queue_tasks', 'json');
    assert.ok(queued);
    assert.equal(queued[0].action, 'RUN_COMMAND');
    assert.equal(queued[0].command, 'git status');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker /notify edge scrubber masks modern JSON keys, GitHub fine-grained PATs, and database URIs', async () => {
  const env = {
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'mock-bot-token'
  };

  const originalFetch = globalThis.fetch;
  let sentPayload = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('sendMessage')) {
      sentPayload = JSON.parse(opts.body);
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 108 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: 'Work4',
        prompt: 'Testing leak: ' + ['github', 'pat', '11ABCD1234567890abcdefghijklmnopqrstuvwxyz'].join('_') + ' and {"token": "verySecretTokenVal"}',
        summary: 'Database connection: postgres://admin:SuperSecretPass999@localhost:5432/core and TOKEN=envsecretval'
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);

    assert.ok(sentPayload);
    assert.ok(!sentPayload.text.includes(['github', 'pat', '11ABCD1234567890abcdefghijklmnopqrstuvwxyz'].join('_')));
    assert.ok(!sentPayload.text.includes('verySecretTokenVal'));
    assert.ok(!sentPayload.text.includes('SuperSecretPass999'));
    assert.ok(!sentPayload.text.includes('envsecretval'));

    assert.ok(sentPayload.text.includes('ghp_***'));
    assert.ok(sentPayload.text.includes('&quot;token&quot;: &quot;***&quot;') || sentPayload.text.includes('"token": "***"'));
    assert.ok(sentPayload.text.includes('postgres://admin:***@localhost:5432/core'));
    assert.ok(sentPayload.text.includes('TOKEN=***'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});


