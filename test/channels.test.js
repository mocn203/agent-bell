import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  verifyDiscordSignature,
  formatDiscordAnsiDiff,
  buildDiscordEmbed,
  buildDiscordComponents,
  ensureDiscordCategoryAndChannel,
  registerDiscordCommands,
  verifySlackSignature,
  buildSlackBlocks,
  timingSafeEqual
} from '../worker/src/index.js';

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

// Convert bytes to hex
function toHex(arr) {
  return Array.from(new Uint8Array(arr))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Helper to generate a test Ed25519 keypair
async function generateEd25519KeyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pubRaw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const pubHex = toHex(pubRaw);
  return { keyPair: kp, pubHex };
}

// Helper to sign message with Ed25519
async function signEd25519(privateKey, message) {
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, enc.encode(message));
  return toHex(sig);
}

// Helper to generate Slack HMAC signature
async function computeSlackSignature(secret, timestamp, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`v0:${timestamp}:${body}`));
  return `v0=${toHex(sig)}`;
}

/* ==========================================================================
 * DISCORD TESTS
 * ========================================================================== */

test('Discord Ed25519 signature verification works correctly with Web Crypto and rejects expired requests', async () => {
  const { keyPair, pubHex } = await generateEd25519KeyPair();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ type: 1 });
  const validSig = await signEd25519(keyPair.privateKey, timestamp + body);

  // 1. Valid signature -> true
  const isValid = await verifyDiscordSignature(pubHex, validSig, timestamp, body);
  assert.equal(isValid, true);

  // 2. Tampered body -> false
  const isTamperedBody = await verifyDiscordSignature(pubHex, validSig, timestamp, body + 'x');
  assert.equal(isTamperedBody, false);

  // 3. Tampered timestamp -> false
  const isTamperedTs = await verifyDiscordSignature(pubHex, validSig, (Math.floor(Date.now() / 1000) + 1).toString(), body);
  assert.equal(isTamperedTs, false);

  // 4. Bad signature -> false
  const badSig = '00'.repeat(64);
  const isBadSig = await verifyDiscordSignature(pubHex, badSig, timestamp, body);
  assert.equal(isBadSig, false);

  // 5. Expired timestamp (> 300s) -> false (replay defense)
  const expiredTs = (Math.floor(Date.now() / 1000) - 301).toString();
  const expiredSig = await signEd25519(keyPair.privateKey, expiredTs + body);
  assert.equal(await verifyDiscordSignature(pubHex, expiredSig, expiredTs, body), false);

  // 6. Expired timestamp with maxAgeSeconds = 0 -> bypass replay check
  assert.equal(await verifyDiscordSignature(pubHex, expiredSig, expiredTs, body, 0), true);

  // 7. Missing / invalid inputs -> false
  assert.equal(await verifyDiscordSignature('', validSig, timestamp, body), false);
  assert.equal(await verifyDiscordSignature(pubHex, '', timestamp, body), false);
  assert.equal(await verifyDiscordSignature(pubHex, validSig, '', body), false);
});

test('Discord /discord/interactions handles PING (type 1) and returns PONG', async () => {
  const { keyPair, pubHex } = await generateEd25519KeyPair();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ type: 1 });
  const sig = await signEd25519(keyPair.privateKey, timestamp + body);

  const env = { DISCORD_PUBLIC_KEY: pubHex };
  const req = new Request('https://agent-bell.workers.dev/discord/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature-Ed25519': sig,
      'X-Signature-Timestamp': timestamp
    },
    body
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.type, 1);
});

test('Discord /discord/interactions rejects invalid signature with 401', async () => {
  const { pubHex } = await generateEd25519KeyPair();
  const env = { DISCORD_PUBLIC_KEY: pubHex };

  const req = new Request('https://agent-bell.workers.dev/discord/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature-Ed25519': 'badbad'.repeat(21) + '00',
      'X-Signature-Timestamp': '1700000000'
    },
    body: JSON.stringify({ type: 1 })
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 401);
});

test('Discord /discord/interactions rejects unauthorized user IDs when whitelist configured', async () => {
  const env = { DISCORD_ALLOWED_USER_IDS: 'user_dev_1, user_dev_2' };

  const req = new Request('https://agent-bell.workers.dev/discord/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 2, // Application Command
      user: { id: 'unauthorized_hacker' },
      data: { name: 'prompt', options: [{ name: 'task', value: 'rm -rf /' }] }
    })
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.type, 4);
  assert.ok(data.data.content.includes('Unauthorized'));
  assert.equal(data.data.flags, 64); // Ephemeral
});

test('Discord Slash Commands (/prompt, /run, /stop, /revert, /status, /workspaces) queue tasks in KV', async () => {
  const kv = createMockKV();
  const env = { NOTIFIER_KV: kv };

  // 1. /prompt
  const promptReq = new Request('https://agent-bell.workers.dev/discord/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 2,
      channel_id: 'chan_discord_1',
      data: {
        name: 'prompt',
        options: [{ name: 'task', value: 'Refactor Discord adapter' }]
      }
    })
  });
  const promptRes = await worker.fetch(promptReq, env);
  assert.equal(promptRes.status, 200);
  const promptData = await promptRes.json();
  assert.ok(promptData.data.content.includes('Prompt Queued for Agent'));

  let queue = await kv.get('queue_tasks', 'json');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].action, 'RUN_PROMPT');
  assert.equal(queue[0].prompt, 'Refactor Discord adapter');

  // 2. /run
  const runReq = new Request('https://agent-bell.workers.dev/discord/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 2,
      channel_id: 'chan_discord_1',
      data: {
        name: 'run',
        options: [{ name: 'command', value: 'npm test' }]
      }
    })
  });
  const runRes = await worker.fetch(runReq, env);
  assert.equal(runRes.status, 200);
  queue = await kv.get('queue_tasks', 'json');
  assert.equal(queue.length, 2);
  assert.equal(queue[1].action, 'RUN_COMMAND');
  assert.equal(queue[1].command, 'npm test');

  // 3. /stop
  const stopReq = new Request('https://agent-bell.workers.dev/discord/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 2,
      channel_id: 'chan_discord_1',
      data: { name: 'stop' }
    })
  });
  const stopRes = await worker.fetch(stopReq, env);
  assert.equal(stopRes.status, 200);
  queue = await kv.get('queue_tasks', 'json');
  assert.equal(queue.length, 3);
  assert.equal(queue[2].action, 'STOP_TASK');

  // 4. /revert
  const revertReq = new Request('https://agent-bell.workers.dev/discord/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 2,
      channel_id: 'chan_discord_1',
      data: {
        name: 'revert',
        options: [{ name: 'clean', value: true }]
      }
    })
  });
  const revertRes = await worker.fetch(revertReq, env);
  assert.equal(revertRes.status, 200);
  queue = await kv.get('queue_tasks', 'json');
  assert.equal(queue.length, 4);
  assert.equal(queue[3].action, 'REVERT');
  assert.equal(queue[3].cleanUntracked, true);

  // 5. /status & /workspaces with heartbeat in KV
  await kv.put('runner_heartbeat', JSON.stringify({
    hostname: 'test-box',
    pid: 7777,
    uptime: 120,
    activeWorkspace: 'Work4',
    workspaces: [{ name: 'Work4', path: '/code/Work4' }],
    timestamp: new Date().toISOString()
  }));

  const statusReq = new Request('https://agent-bell.workers.dev/discord/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 2, data: { name: 'status' } })
  });
  const statusRes = await worker.fetch(statusReq, env);
  const statusData = await statusRes.json();
  assert.ok(statusData.data.content.includes('ONLINE'));
  assert.ok(statusData.data.content.includes('7777'));

  const wsReq = new Request('https://agent-bell.workers.dev/discord/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 2, data: { name: 'workspaces' } })
  });
  const wsRes = await worker.fetch(wsReq, env);
  const wsData = await wsRes.json();
  assert.ok(wsData.data.content.includes('Work4'));
});

test('Discord Interactive Component Buttons (Approve / Deny / Stop) update KV state', async () => {
  const kv = createMockKV();
  const env = { NOTIFIER_KV: kv };

  // 1. Click Approve (appr:task-999)
  const apprReq = new Request('https://agent-bell.workers.dev/discord/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 3,
      data: { custom_id: 'appr:task-999' }
    })
  });
  const apprRes = await worker.fetch(apprReq, env);
  assert.equal(apprRes.status, 200);
  assert.equal(await kv.get('approval_task-999'), 'APPROVED');

  // 2. Click Deny (deny:task-999)
  const denyReq = new Request('https://agent-bell.workers.dev/discord/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 3,
      data: { custom_id: 'deny:task-999' }
    })
  });
  const denyRes = await worker.fetch(denyReq, env);
  assert.equal(denyRes.status, 200);
  assert.equal(await kv.get('approval_task-999'), 'DENIED');

  // 3. Click Stop (stop)
  const stopReq = new Request('https://agent-bell.workers.dev/discord/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 3,
      data: { custom_id: 'stop' }
    })
  });
  const stopRes = await worker.fetch(stopReq, env);
  assert.equal(stopRes.status, 200);
  const queue = await kv.get('queue_tasks', 'json');
  assert.ok(queue.some((t) => t.action === 'STOP_TASK'));
});

test('Discord Rich Embed format correctly renders ANSI diffs, colors, and approval buttons', () => {
  const diffSummary = '• Git: +45/-12 (2 files)\n➕ worker/src/discord.js\n➖ old-code.tmp\n📝 worker/src/index.js';
  const ansiFormatted = formatDiscordAnsiDiff(diffSummary);

  assert.ok(ansiFormatted.startsWith('```ansi\n'));
  assert.ok(ansiFormatted.includes('\u001b[32m➕ worker/src/discord.js\u001b[0m')); // Green
  assert.ok(ansiFormatted.includes('\u001b[31m➖ old-code.tmp\u001b[0m')); // Red
  assert.ok(ansiFormatted.includes('\u001b[36m• Git: +45/-12 (2 files)\u001b[0m')); // Cyan

  // Color tests:
  // Success -> 0x10b981 (1096065)
  const embedSuccess = buildDiscordEmbed({ workspace: 'Work4', durationSeconds: 5 }, 'All tests pass');
  assert.equal(embedSuccess.color, 0x10b981);

  // Approval -> 0xf59e0b (16096779)
  const embedAppr = buildDiscordEmbed({ workspace: 'Work4', isApprovalRequired: true }, 'Need approval');
  assert.equal(embedAppr.color, 0xf59e0b);

  // Error -> 0xef4444 (15680580)
  const embedErr = buildDiscordEmbed({ workspace: 'Work4', isError: true }, 'Build failed');
  assert.equal(embedErr.color, 0xef4444);
});

test('Discord ensureDiscordCategoryAndChannel auto-creates AGENT-BELL category and workspace channel', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    DISCORD_BOT_TOKEN: 'mock-bot-token',
    DISCORD_GUILD_ID: 'guild_1234'
  };

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    requests.push({ url, opts });
    if (url.endsWith('/channels') && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        id: body.type === 4 ? 'cat_agent_bell' : 'chan_work4',
        name: body.name,
        type: body.type,
        parent_id: body.parent_id
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // GET /channels returns empty initially
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const chanId = await ensureDiscordCategoryAndChannel(env, 'Work4');
    assert.equal(chanId, 'chan_work4');

    // Verify channel ID cached in KV
    const cached = await kv.get('discord_chan_guild_1234_work4');
    assert.equal(cached, 'chan_work4');

    // Calling again returns cached without fetch
    requests.length = 0;
    const cachedChanId = await ensureDiscordCategoryAndChannel(env, 'Work4');
    assert.equal(cachedChanId, 'chan_work4');
    assert.equal(requests.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('registerDiscordCommands sends valid slash command definitions to Discord REST API', async () => {
  let calledUrl = '';
  let payloadBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calledUrl = url;
    payloadBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const res = await registerDiscordCommands('app_123', 'bot_token_abc', 'guild_456');
    assert.equal(res.ok, true);
    assert.ok(calledUrl.includes('/applications/app_123/guilds/guild_456/commands'));
    assert.ok(Array.isArray(payloadBody));
    assert.ok(payloadBody.some((cmd) => cmd.name === 'prompt'));
    assert.ok(payloadBody.some((cmd) => cmd.name === 'run'));
    assert.ok(payloadBody.some((cmd) => cmd.name === 'stop'));
    assert.ok(payloadBody.some((cmd) => cmd.name === 'revert'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ==========================================================================
 * SLACK TESTS
 * ========================================================================== */

test('Slack HMAC-SHA256 signature verification validates signature and rejects expired requests', async () => {
  const secret = 'slack_test_secret_12345';
  const now = Math.floor(Date.now() / 1000).toString();
  const body = '{"type":"url_verification","challenge":"test_challenge"}';
  const sig = await computeSlackSignature(secret, now, body);

  // 1. Valid signature -> true
  const isValid = await verifySlackSignature(secret, sig, now, body);
  assert.equal(isValid, true);

  // 2. Tampered body -> false
  const isTampered = await verifySlackSignature(secret, sig, now, body + 'tamper');
  assert.equal(isTampered, false);

  // 3. Expired timestamp (> 300s) -> false
  const expiredTs = (Number(now) - 305).toString();
  const expiredSig = await computeSlackSignature(secret, expiredTs, body);
  const isExpired = await verifySlackSignature(secret, expiredSig, expiredTs, body);
  assert.equal(isExpired, false);

  // 4. Bad signature -> false
  assert.equal(await verifySlackSignature(secret, 'v0=badhex', now, body), false);
});

test('Slack /slack/events handles url_verification handshake', async () => {
  const env = {};
  const req = new Request('https://agent-bell.workers.dev/slack/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'url_verification',
      token: 'mock-token',
      challenge: 'echomeback_challenge_string'
    })
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text, 'echomeback_challenge_string');
});

test('Slack /slack/commands handles Slash Commands (/prompt, /run, /stop, /revert, /status, /workspaces)', async () => {
  const kv = createMockKV();
  const env = { NOTIFIER_KV: kv };

  // 1. /prompt
  const promptForm = 'command=%2Fprompt&text=Fix+failing+tests&user_id=U12345&channel_id=C67890';
  const promptReq = new Request('https://agent-bell.workers.dev/slack/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: promptForm
  });
  const promptRes = await worker.fetch(promptReq, env);
  assert.equal(promptRes.status, 200);
  const promptData = await promptRes.json();
  assert.ok(promptData.text.includes('Prompt Queued for Agent'));

  let queue = await kv.get('queue_tasks', 'json');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].action, 'RUN_PROMPT');
  assert.equal(queue[0].prompt, 'Fix failing tests');

  // 2. /run
  const runForm = 'command=%2Frun&text=npm+test&user_id=U12345&channel_id=C67890';
  const runReq = new Request('https://agent-bell.workers.dev/slack/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: runForm
  });
  const runRes = await worker.fetch(runReq, env);
  assert.equal(runRes.status, 200);
  queue = await kv.get('queue_tasks', 'json');
  assert.equal(queue.length, 2);
  assert.equal(queue[1].action, 'RUN_COMMAND');

  // 3. /stop
  const stopForm = 'command=%2Fstop&user_id=U12345&channel_id=C67890';
  const stopReq = new Request('https://agent-bell.workers.dev/slack/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: stopForm
  });
  const stopRes = await worker.fetch(stopReq, env);
  assert.equal(stopRes.status, 200);
  queue = await kv.get('queue_tasks', 'json');
  assert.equal(queue.length, 3);
  assert.equal(queue[2].action, 'STOP_TASK');

  // 4. /revert
  const revertForm = 'command=%2Frevert&text=clean&user_id=U12345&channel_id=C67890';
  const revertReq = new Request('https://agent-bell.workers.dev/slack/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: revertForm
  });
  const revertRes = await worker.fetch(revertReq, env);
  assert.equal(revertRes.status, 200);
  queue = await kv.get('queue_tasks', 'json');
  assert.equal(queue.length, 4);
  assert.equal(queue[3].action, 'REVERT');
  assert.equal(queue[3].cleanUntracked, true);

  // 5. /status with heartbeat
  await kv.put('runner_heartbeat', JSON.stringify({
    hostname: 'slack-host',
    pid: 54321,
    uptime: 60,
    activeWorkspace: 'Backend',
    timestamp: new Date().toISOString()
  }));

  const statusForm = 'command=%2Fstatus&user_id=U12345&channel_id=C67890';
  const statusReq = new Request('https://agent-bell.workers.dev/slack/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: statusForm
  });
  const statusRes = await worker.fetch(statusReq, env);
  const statusData = await statusRes.json();
  assert.ok(statusData.text.includes('ONLINE'));
  assert.ok(statusData.text.includes('54321'));
});

test('Slack /slack/commands rejects unauthorized users when SLACK_ALLOWED_USER_IDS is set', async () => {
  const env = { SLACK_ALLOWED_USER_IDS: 'U_OWNER1, U_OWNER2' };
  const form = 'command=%2Fstop&user_id=U_STRANGER&channel_id=C123';
  const req = new Request('https://agent-bell.workers.dev/slack/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.text.includes('Unauthorized'));
  assert.equal(data.response_type, 'ephemeral');
});

test('Slack /slack/interactions handles button clicks (Approve, Deny, Stop)', async () => {
  const kv = createMockKV();
  const env = { NOTIFIER_KV: kv };

  // 1. Approve
  const apprPayload = JSON.stringify({
    type: 'block_actions',
    actions: [{ action_id: 'btn_approve', value: 'appr:task-slack-777' }]
  });
  const apprReq = new Request('https://agent-bell.workers.dev/slack/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'payload=' + encodeURIComponent(apprPayload)
  });
  const apprRes = await worker.fetch(apprReq, env);
  assert.equal(apprRes.status, 200);
  assert.equal(await kv.get('approval_task-slack-777'), 'APPROVED');

  // 2. Deny
  const denyPayload = JSON.stringify({
    type: 'block_actions',
    actions: [{ action_id: 'btn_deny', value: 'deny:task-slack-777' }]
  });
  const denyReq = new Request('https://agent-bell.workers.dev/slack/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'payload=' + encodeURIComponent(denyPayload)
  });
  const denyRes = await worker.fetch(denyReq, env);
  assert.equal(denyRes.status, 200);
  assert.equal(await kv.get('approval_task-slack-777'), 'DENIED');

  // 3. Stop
  const stopPayload = JSON.stringify({
    type: 'block_actions',
    actions: [{ action_id: 'btn_stop', value: 'stop' }]
  });
  const stopReq = new Request('https://agent-bell.workers.dev/slack/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'payload=' + encodeURIComponent(stopPayload)
  });
  const stopRes = await worker.fetch(stopReq, env);
  assert.equal(stopRes.status, 200);
  const queue = await kv.get('queue_tasks', 'json');
  assert.ok(queue.some((t) => t.action === 'STOP_TASK'));
});

test('Slack Block Kit formatting respects 2000 character value limit on buttons', () => {
  const hugeTaskId = 'task-'.repeat(600); // 3000 chars
  const blocks = buildSlackBlocks({
    workspace: 'Work4',
    taskId: hugeTaskId,
    isApprovalRequired: true,
    gitSummary: '• Git: +10/-5'
  }, 'Completed task');

  assert.ok(Array.isArray(blocks));
  const actionsBlock = blocks.find((b) => b.type === 'actions');
  assert.ok(actionsBlock);

  // Check every button value is <= 2000 characters
  for (const el of actionsBlock.elements) {
    if (el.value) {
      assert.ok(el.value.length <= 2000, `Button value length ${el.value.length} exceeds 2000`);
    }
  }
});

test('Inbound /notify dispatches to Discord and Slack in parallel', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/mock/test',
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/mock/test'
  };

  const dispatched = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    dispatched.push({ url, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const req = new Request('https://agent-bell.workers.dev/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: 'Work4',
        prompt: 'Build Discord & Slack Phase 4 adapters',
        summary: 'All adapters tested and verified',
        durationSeconds: 15,
        gitSummary: '• Git: +120/-10 (2 files)'
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.channels.discord, true);
    assert.equal(data.channels.slack, true);

    // Verify calls to Discord and Slack were made
    assert.ok(dispatched.some((d) => d.url.includes('discord.com')));
    assert.ok(dispatched.some((d) => d.url.includes('hooks.slack.com')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Slack /slack/interactions rejects unauthorized user IDs when SLACK_ALLOWED_USER_IDS is set', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    SLACK_ALLOWED_USER_IDS: 'U_DEV_LEAD, U_OPERATOR'
  };

  const formPayload = JSON.stringify({
    type: 'block_actions',
    user: { id: 'U_UNAUTHORIZED_GUEST' },
    actions: [{ action_id: 'btn_approve', value: 'appr:task-critical-99' }]
  });

  const req = new Request('https://agent-bell.workers.dev/slack/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'payload=' + encodeURIComponent(formPayload)
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.response_type, 'ephemeral');
  assert.ok(data.text.includes('Unauthorized'));

  // Ensure approval was NOT written to KV
  const approved = await kv.get('approval_task-critical-99');
  assert.equal(approved, null);
});

test('Slack event callbacks (mentions) reject unauthorized user IDs when SLACK_ALLOWED_USER_IDS is set', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    SLACK_ALLOWED_USER_IDS: 'U_DEV_LEAD'
  };

  const req = new Request('https://agent-bell.workers.dev/slack/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U_ATTACKER',
        channel: 'C12345',
        text: '<@U_BOT> prompt rm -rf /'
      }
    })
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);

  // Queue must be empty - unauthorized user should not be able to queue tasks
  const queue = await kv.get('queue_tasks', 'json');
  assert.equal(queue, null);
});

test('Slack event callbacks support run, stop, revert, status, and workspaces commands', async () => {
  const kv = createMockKV();
  const env = { NOTIFIER_KV: kv };

  // 1. run command
  const runReq = new Request('https://agent-bell.workers.dev/slack/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U_VALID',
        channel: 'C123',
        text: '<@U_BOT> run npm test'
      }
    })
  });
  await worker.fetch(runReq, env);

  let queue = await kv.get('queue_tasks', 'json');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].action, 'RUN_COMMAND');
  assert.equal(queue[0].command, 'npm test');
  assert.equal(queue[0].slackChannelId, 'C123');

  // 2. revert command
  const revertReq = new Request('https://agent-bell.workers.dev/slack/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U_VALID',
        channel: 'C123',
        text: '<@U_BOT> revert clean'
      }
    })
  });
  await worker.fetch(revertReq, env);
  queue = await kv.get('queue_tasks', 'json');
  assert.equal(queue.length, 2);
  assert.equal(queue[1].action, 'REVERT');
  assert.equal(queue[1].cleanUntracked, true);
});

test('Discord buttons truncate long taskId so custom_id <= 100 characters', () => {
  const hugeTaskId = 'task-uuid-very-long-'.repeat(20); // ~400 characters
  const components = buildDiscordComponents({
    taskId: hugeTaskId,
    isApprovalRequired: true
  });

  assert.ok(Array.isArray(components));
  const row = components[0];
  assert.ok(row.components.length >= 3);

  for (const btn of row.components) {
    assert.ok(btn.custom_id);
    assert.ok(btn.custom_id.length <= 100, `custom_id ${btn.custom_id.length} exceeds 100 chars`);
  }
});

test('Discord ANSI diff formatting truncates large git diffs so field value <= 1024 characters', () => {
  const hugeGitDiff = Array.from({ length: 60 }, (_, i) => `+ line added in large pull request #${i}`).join('\n');
  const formatted = formatDiscordAnsiDiff(hugeGitDiff);

  assert.ok(formatted.startsWith('```ansi\n'));
  assert.ok(formatted.endsWith('\n```'));
  assert.ok(formatted.includes('... [diff truncated]'));
  assert.ok(formatted.length <= 1024, `ANSI diff length ${formatted.length} exceeds Discord field max 1024`);

  const embed = buildDiscordEmbed({
    workspace: 'LargeProject',
    gitSummary: hugeGitDiff
  }, 'Completed big refactor');

  const diffField = embed.fields.find((f) => f.name === 'Git Diff & Status');
  assert.ok(diffField);
  assert.ok(diffField.value.length <= 1024);
});

test('Inbound /notify routes to specific discordChannelId and slackChannelId when present in payload', async () => {
  const kv = createMockKV();
  const env = {
    NOTIFIER_KV: kv,
    DISCORD_BOT_TOKEN: 'discord_bot_token_mock',
    SLACK_BOT_TOKEN: 'slack_bot_token_mock'
    // Notice: DISCORD_CHANNEL_ID and SLACK_CHANNEL_ID are deliberately omitted from env
  };

  const posted = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    posted.push({ url, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ ok: true, id: 'msg-123', ts: '1700000000.123' }), {
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
        prompt: 'Specific channel test',
        discordChannelId: 'discord_chan_custom_99',
        slackChannelId: 'slack_chan_custom_88'
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.channels.discord, true);
    assert.equal(data.channels.slack, true);

    const discordCall = posted.find((p) => p.url.includes('discord.com'));
    assert.ok(discordCall);
    assert.ok(discordCall.url.includes('discord_chan_custom_99'));

    const slackCall = posted.find((p) => p.url.includes('slack.com'));
    assert.ok(slackCall);
    assert.equal(slackCall.body.channel, 'slack_chan_custom_88');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timingSafeEqual correctly performs constant-time comparison', () => {
  assert.equal(timingSafeEqual('v0=abcdef1234567890', 'v0=abcdef1234567890'), true);
  assert.equal(timingSafeEqual('v0=abcdef1234567890', 'v0=abcdef1234567891'), false);
  assert.equal(timingSafeEqual('short', 'longer_string'), false);
  assert.equal(timingSafeEqual('', ''), true);
  assert.equal(timingSafeEqual(null, 'test'), false);
  assert.equal(timingSafeEqual('test', undefined), false);
});
