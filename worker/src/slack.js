/**
 * agent-bell - Slack Multi-Channel Adapter
 * Features:
 * - HMAC-SHA256 signature verification (Web Crypto API, Zero Dependencies)
 * - Threaded Isolation (groups all execution steps & diffs under parent prompt thread)
 * - Interactive Block Kit Buttons with strict value length safety
 * - Slack Events API & Slash Commands (/prompt, /run, /stop, /revert, /status, /workspaces)
 */

function escapeSlack(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(str, maxLength = 200) {
  if (!str) return '';
  const trimmed = String(str).trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength) + '...';
}

function formatNumber(num) {
  if (num === null || num === undefined) return '0';
  return Number(num).toLocaleString('en-US');
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Verify Slack HMAC-SHA256 Signature using standard Web Crypto API
 * Replay attack prevention: checks timestamp is within 300s.
 * Constant-time comparison: timing attack defense.
 */
export async function verifySlackSignature(signingSecret, signature, timestamp, rawBody) {
  if (!signingSecret || !signature || !timestamp) return false;

  const now = Math.floor(Date.now() / 1000);
  const tsNum = Number(timestamp);
  if (isNaN(tsNum) || Math.abs(now - tsNum) > 300) {
    return false;
  }

  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(signingSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const data = enc.encode(`v0:${timestamp}:${rawBody}`);
    const mac = await crypto.subtle.sign('HMAC', key, data);
    const hashHex = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const expectedSig = `v0=${hashHex}`;
    return timingSafeEqual(signature, expectedSig);
  } catch (_) {
    return false;
  }
}

/**
 * Build Slack Block Kit Blocks
 * Strict value safety: ensures button values never exceed Slack's 2000 character limit.
 */
export function buildSlackBlocks(data, shortSummary) {
  const isError = Boolean(data.isError);
  const isApproval = Boolean(data.isApprovalRequired || data.requiresApproval);
  const isQuota = Boolean(data.isQuotaLimit);
  const ws = data.gitHeader || data.workspace || 'Project';

  let headerText = `🚀 ${ws}`;
  if (isApproval) {
    headerText = `⚠️ APPROVAL REQUIRED [${data.workspace || 'Project'}]`;
  } else if (isError) {
    headerText = `🛑 Task Terminated / Failed [${data.workspace || 'Project'}]`;
  } else if (isQuota) {
    headerText = `⚠️ Quota Limit Reached [${data.workspace || 'Project'}]`;
  }

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: truncate(headerText, 150),
        emoji: true
      }
    }
  ];

  const sectionFields = [];

  if (data.prompt) {
    sectionFields.push({
      type: 'mrkdwn',
      text: `*Task:*\n${escapeSlack(truncate(data.prompt, 200))}`
    });
  }

  if (shortSummary) {
    sectionFields.push({
      type: 'mrkdwn',
      text: `*Outcome:*\n${escapeSlack(truncate(shortSummary, 250))}`
    });
  }

  if (data.durationSeconds) {
    sectionFields.push({
      type: 'mrkdwn',
      text: `*Duration:*\n${data.durationSeconds}s`
    });
  }

  if (data.tokenStats?.turnTotal) {
    let tok = formatNumber(data.tokenStats.turnTotal);
    if (data.tokenStats.sessionTotal) {
      tok += ` (Total: ${formatNumber(data.tokenStats.sessionTotal)})`;
    }
    sectionFields.push({
      type: 'mrkdwn',
      text: `*Tokens:*\n${tok}`
    });
  }

  if (sectionFields.length > 0) {
    blocks.push({
      type: 'section',
      fields: sectionFields.slice(0, 10)
    });
  }

  // Git Diff / Status
  if (data.gitSummary) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Git Diff & Status:*\n\`\`\`\n${truncate(data.gitSummary, 800)}\n\`\`\``
      }
    });
  }

  // Error Details snippet
  if (data.output && isError) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Output:*\n\`\`\`\n${truncate(data.output, 600)}\n\`\`\``
      }
    });
  }

  // Interactive Buttons Block
  const taskId = data.taskId || data.id;
  const choices = Array.isArray(data.choices) && data.choices.length > 0 ? data.choices : null;
  const elements = [];

  if (choices && taskId) {
    const safeTaskId = truncate(String(taskId), 50);
    choices.slice(0, 5).forEach((choice, idx) => {
      const isApprove = choice.toLowerCase() === 'approve' || choice.toLowerCase() === 'yes';
      const isDeny = choice.toLowerCase() === 'deny' || choice.toLowerCase() === 'no';
      let style = undefined;
      let value = `choice:${safeTaskId}:${truncate(choice, 40)}`;

      if (isApprove) {
        style = 'primary';
      } else if (isDeny) {
        style = 'danger';
      }

      elements.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: truncate(choice, 75),
          emoji: true
        },
        style,
        action_id: `btn_choice_${idx}`,
        value
      });
    });

    blocks.push({
      type: 'actions',
      elements
    });

    return blocks;
  }

  if (isApproval && taskId) {
    const safeTaskId = truncate(String(taskId), 100);
    elements.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: '✅ Approve',
        emoji: true
      },
      style: 'primary',
      action_id: 'btn_approve',
      value: `appr:${safeTaskId}`
    });

    elements.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: '❌ Deny',
        emoji: true
      },
      style: 'danger',
      action_id: 'btn_deny',
      value: `deny:${safeTaskId}`
    });
  }

  // Emergency Stop button
  elements.push({
    type: 'button',
    text: {
      type: 'plain_text',
      text: '🛑 Stop Task',
      emoji: true
    },
    style: 'danger',
    action_id: 'btn_stop',
    value: taskId ? `stop:${truncate(String(taskId), 100)}` : 'stop'
  });

  blocks.push({
    type: 'actions',
    elements
  });

  return blocks;
}

/**
 * Dispatch Slack notification with Threaded Isolation
 * If conversationId is present, stores thread_ts in KV to group all subsequent logs/diffs.
 */
export async function sendSlackNotification(env, data, shortSummary) {
  const blocks = buildSlackBlocks(data, shortSummary);
  const fallbackText = `🚀 ${data.workspace || 'Project'}: ${shortSummary || data.prompt || 'Notification'}`;

  // 1. Thread Grouping: Determine thread_ts
  let threadTs = data.slackThreadTs || data.threadTs || data.messageThreadId || null;
  const convId = data.conversationId;

  if (!threadTs && convId && env.NOTIFIER_KV) {
    threadTs = await env.NOTIFIER_KV.get(`slack_thread_${convId}`);
  }

  // 2. Dispatch via Slack Bot Web API (chat.postMessage)
  if (env.SLACK_BOT_TOKEN) {
    const channel = data.slackChannelId || env.SLACK_CHANNEL_ID || '#general';
    const payload = {
      channel,
      text: fallbackText,
      blocks
    };
    if (threadTs) payload.thread_ts = threadTs;

    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const json = await res.json();
      if (json.ok && json.ts) {
        // If this was a new thread root and conversationId is known, cache the thread_ts
        if (convId && !threadTs && env.NOTIFIER_KV) {
          await env.NOTIFIER_KV.put(`slack_thread_${convId}`, json.ts, { expirationTtl: 86400 * 3 });
        }
        return json;
      }
    } catch (_) {}
  }

  // 3. Fallback to Slack Incoming Webhook
  if (env.SLACK_WEBHOOK_URL) {
    try {
      const payload = {
        text: fallbackText,
        blocks
      };
      if (threadTs) payload.thread_ts = threadTs;

      const res = await fetch(env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) return { success: true };

      // Retry without thread_ts if webhook rejected thread
      if (!res.ok && payload.thread_ts) {
        delete payload.thread_ts;
        const retryRes = await fetch(env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (retryRes.ok) return { success: true };
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Parse URL-encoded body helper
 */
export function parseUrlEncoded(bodyStr) {
  const params = new URLSearchParams(bodyStr);
  const obj = {};
  for (const [key, value] of params.entries()) {
    obj[key] = value;
  }
  return obj;
}

/**
 * Handle Slack Events and Slash Commands (/slack/events, /slack/commands)
 */
export async function handleSlackEvents(request, env) {
  const signature = request.headers.get('x-slack-signature');
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const contentType = request.headers.get('content-type') || '';

  const rawBody = await request.text();

  // Threat Defense: Validate Slack HMAC-SHA256 Signature
  if (env.SLACK_SIGNING_SECRET) {
    const isValid = await verifySlackSignature(env.SLACK_SIGNING_SECRET, signature, timestamp, rawBody);
    if (!isValid) {
      return new Response('Invalid request signature', { status: 401 });
    }
  }

  let body = {};
  if (contentType.includes('application/x-www-form-urlencoded')) {
    body = parseUrlEncoded(rawBody);
  } else {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
  }

  // 1. Slack URL Verification Handshake
  if (body.type === 'url_verification') {
    return new Response(body.challenge, {
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // 2. Slack Slash Commands (e.g. /prompt, /run, /stop, /revert, /status, /workspaces)
  if (body.command) {
    const userId = body.user_id;

    // Security Whitelist Defense
    if (env.SLACK_ALLOWED_USER_IDS) {
      const allowed = env.SLACK_ALLOWED_USER_IDS.split(',').map((id) => id.trim());
      if (!userId || !allowed.includes(userId)) {
        return new Response(
          JSON.stringify({
            response_type: 'ephemeral',
            text: '⛔ *Unauthorized*: Your Slack user ID is not authorized to control agent-bell.'
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    const cmd = body.command.toLowerCase().replace(/^\//, '');
    const text = (body.text || '').trim();
    const channelId = body.channel_id;

    if (cmd === 'prompt') {
      if (!text) {
        return new Response(
          JSON.stringify({
            response_type: 'ephemeral',
            text: '⚠️ *Usage*: `/prompt <task instructions>`'
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'prompt-' + Date.now(),
          action: 'RUN_PROMPT',
          prompt: text,
          slackChannelId: channelId,
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
      }

      return new Response(
        JSON.stringify({
          response_type: 'in_channel',
          text: `🤖 *Prompt Queued for Agent*\n• Task: _"${escapeSlack(truncate(text, 120))}"_\nDispatched to local runner.`
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (cmd === 'run') {
      if (!text) {
        return new Response(
          JSON.stringify({
            response_type: 'ephemeral',
            text: '⚠️ *Usage*: `/run <command>`'
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'cmd-' + Date.now(),
          action: 'RUN_COMMAND',
          command: text,
          slackChannelId: channelId,
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
      }

      return new Response(
        JSON.stringify({
          response_type: 'in_channel',
          text: `⚡ *Remote Command Queued*\n• Command: \`${escapeSlack(text)}\`\nExecuting in active workspace on local host...`
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (cmd === 'stop') {
      if (env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'stop-' + Date.now(),
          action: 'STOP_TASK',
          slackChannelId: channelId,
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
      }

      return new Response(
        JSON.stringify({
          response_type: 'in_channel',
          text: '🛑 *Emergency Stop Dispatched*\nA termination signal has been queued to stop the local runner process tree.'
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (cmd === 'revert') {
      const cleanUntracked = text.includes('clean') || text.includes('all');
      if (env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'revert-' + Date.now(),
          action: 'REVERT',
          cleanUntracked,
          slackChannelId: channelId,
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
      }

      const cleanNotice = cleanUntracked ? ' (including untracked files)' : '';
      return new Response(
        JSON.stringify({
          response_type: 'in_channel',
          text: `🔄 *Emergency Revert Queued*\nA command to discard uncommitted working tree modifications${cleanNotice} has been sent to the local runner.`
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (cmd === 'status') {
      let statusText = '';
      let hb = null;
      if (env.NOTIFIER_KV) {
        hb = await env.NOTIFIER_KV.get('runner_heartbeat', 'json');
      }

      if (hb && hb.timestamp) {
        const lastSeen = Math.round((Date.now() - new Date(hb.timestamp).getTime()) / 1000);
        if (lastSeen < 60) {
          statusText = `⚡ *Local Runner: 🟢 ONLINE*\n• Host: \`${escapeSlack(hb.hostname || 'localhost')}\`\n• PID: \`${hb.pid}\`\n• Uptime: \`${hb.uptime || 0}s\`\n• Workspace: *${escapeSlack(hb.activeWorkspace || 'Default')}*\n`;
          if (hb.gitHeader) statusText += `• Git: \`${escapeSlack(hb.gitHeader)}\`\n`;
          statusText += `• Last ping: _${lastSeen}s ago_`;
        } else {
          statusText = `⚡ *Local Runner: 🔴 OFFLINE*\n• Last seen: _${lastSeen}s ago_\n• Host: \`${escapeSlack(hb.hostname || 'Unknown')}\``;
        }
      } else {
        statusText = '⚡ *Local Runner: 🔴 OFFLINE*\n_No runner heartbeat received yet. Start runner via:_\n`npx agent-bell start`';
      }

      return new Response(
        JSON.stringify({
          response_type: 'in_channel',
          text: statusText
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (cmd === 'workspaces' || cmd === 'ws') {
      let wsText = '📁 *Configured Workspaces:*\n';
      let hb = null;
      if (env.NOTIFIER_KV) {
        hb = await env.NOTIFIER_KV.get('runner_heartbeat', 'json');
      }

      if (hb && hb.workspaces && hb.workspaces.length > 0) {
        for (const ws of hb.workspaces) {
          const isActive = ws.name === hb.activeWorkspace || ws.path === hb.activeWorkspacePath;
          wsText += `• *${escapeSlack(ws.name)}*${isActive ? ' _(Active)_' : ''}\n  \`${escapeSlack(ws.path)}\`\n`;
        }
      } else if (hb && hb.activeWorkspace) {
        wsText += `• *${escapeSlack(hb.activeWorkspace)}* _(Active)_\n  \`${escapeSlack(hb.activeWorkspacePath || '')}\`\n`;
      } else {
        wsText += '_No active workspace reported by local runner yet._\n';
      }

      return new Response(
        JSON.stringify({
          response_type: 'in_channel',
          text: wsText
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // 3. Slack Event Callbacks (app_mention, message)
  if (body.type === 'event_callback' && body.event) {
    const event = body.event;
    if (event.bot_id || event.subtype === 'bot_message') {
      return new Response('OK', { status: 200 });
    }

    const userId = event.user;
    const threadTs = event.thread_ts || event.ts;
    const channelId = event.channel;

    // Security Whitelist Defense
    if (env.SLACK_ALLOWED_USER_IDS) {
      const allowed = env.SLACK_ALLOWED_USER_IDS.split(',').map((id) => id.trim());
      if (!userId || !allowed.includes(userId)) {
        if (env.SLACK_BOT_TOKEN) {
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              channel: channelId,
              thread_ts: threadTs,
              text: '⛔ *Unauthorized*: Your Slack user ID is not authorized to control agent-bell.'
            })
          }).catch(() => {});
        }
        return new Response('OK', { status: 200 });
      }
    }

    const rawText = (event.text || '').replace(/<@[^>]+>/g, '').trim();

    // Check command prefixes: prompt, run, stop, revert, status, workspaces
    if (rawText.startsWith('/prompt') || rawText.startsWith('prompt')) {
      const promptText = rawText.replace(/^\/?prompt\s*/i, '').trim();
      if (promptText && env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'prompt-' + Date.now(),
          action: 'RUN_PROMPT',
          prompt: promptText,
          slackChannelId: channelId,
          slackThreadTs: threadTs,
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });

        if (env.SLACK_BOT_TOKEN) {
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              channel: channelId,
              thread_ts: threadTs,
              text: `🤖 *Prompt Queued for Agent*\n• Task: _"${escapeSlack(truncate(promptText, 120))}"_\nDispatched to local runner.`
            })
          }).catch(() => {});
        }
      }
    } else if (rawText.startsWith('/run') || rawText.startsWith('run')) {
      const commandText = rawText.replace(/^\/?run\s*/i, '').trim();
      if (commandText && env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'cmd-' + Date.now(),
          action: 'RUN_COMMAND',
          command: commandText,
          slackChannelId: channelId,
          slackThreadTs: threadTs,
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });

        if (env.SLACK_BOT_TOKEN) {
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              channel: channelId,
              thread_ts: threadTs,
              text: `⚡ *Remote Command Queued*\n• Command: \`${escapeSlack(commandText)}\`\nExecuting on host...`
            })
          }).catch(() => {});
        }
      }
    } else if (rawText.startsWith('/stop') || rawText.startsWith('stop')) {
      if (env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'stop-' + Date.now(),
          action: 'STOP_TASK',
          slackChannelId: channelId,
          slackThreadTs: threadTs,
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });

        if (env.SLACK_BOT_TOKEN) {
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              channel: channelId,
              thread_ts: threadTs,
              text: '🛑 *Emergency Stop Dispatched*\nA termination signal has been sent to the local runner process tree.'
            })
          }).catch(() => {});
        }
      }
    } else if (rawText.startsWith('/revert') || rawText.startsWith('revert')) {
      const cleanUntracked = rawText.includes('clean') || rawText.includes('all');
      if (env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'revert-' + Date.now(),
          action: 'REVERT',
          cleanUntracked,
          slackChannelId: channelId,
          slackThreadTs: threadTs,
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });

        if (env.SLACK_BOT_TOKEN) {
          const cleanNotice = cleanUntracked ? ' (including untracked files)' : '';
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              channel: channelId,
              thread_ts: threadTs,
              text: `🔄 *Emergency Revert Queued*\nDiscarding uncommitted working tree modifications${cleanNotice}...`
            })
          }).catch(() => {});
        }
      }
    } else if (rawText.startsWith('/status') || rawText.startsWith('status')) {
      let statusText = '';
      let hb = null;
      if (env.NOTIFIER_KV) {
        hb = await env.NOTIFIER_KV.get('runner_heartbeat', 'json');
      }

      if (hb && hb.timestamp) {
        const lastSeen = Math.round((Date.now() - new Date(hb.timestamp).getTime()) / 1000);
        if (lastSeen < 60) {
          statusText = `⚡ *Local Runner: 🟢 ONLINE*\n• Host: \`${escapeSlack(hb.hostname || 'localhost')}\`\n• PID: \`${hb.pid}\`\n• Uptime: \`${hb.uptime || 0}s\`\n• Workspace: *${escapeSlack(hb.activeWorkspace || 'Default')}*\n`;
          if (hb.gitHeader) statusText += `• Git: \`${escapeSlack(hb.gitHeader)}\`\n`;
          statusText += `• Last ping: _${lastSeen}s ago_`;
        } else {
          statusText = `⚡ *Local Runner: 🔴 OFFLINE*\n• Last seen: _${lastSeen}s ago_\n• Host: \`${escapeSlack(hb.hostname || 'Unknown')}\``;
        }
      } else {
        statusText = '⚡ *Local Runner: 🔴 OFFLINE*\n_No runner heartbeat received yet. Start runner via:_\n`npx agent-bell start`';
      }

      if (env.SLACK_BOT_TOKEN) {
        await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            channel: channelId,
            thread_ts: threadTs,
            text: statusText
          })
        }).catch(() => {});
      }
    } else if (rawText.startsWith('/workspaces') || rawText.startsWith('workspaces') || rawText.startsWith('/ws') || rawText.startsWith('ws')) {
      let wsText = '📁 *Configured Workspaces:*\n';
      let hb = null;
      if (env.NOTIFIER_KV) {
        hb = await env.NOTIFIER_KV.get('runner_heartbeat', 'json');
      }

      if (hb && hb.workspaces && hb.workspaces.length > 0) {
        for (const ws of hb.workspaces) {
          const isActive = ws.name === hb.activeWorkspace || ws.path === hb.activeWorkspacePath;
          wsText += `• *${escapeSlack(ws.name)}*${isActive ? ' _(Active)_' : ''}\n  \`${escapeSlack(ws.path)}\`\n`;
        }
      } else if (hb && hb.activeWorkspace) {
        wsText += `• *${escapeSlack(hb.activeWorkspace)}* _(Active)_\n  \`${escapeSlack(hb.activeWorkspacePath || '')}\`\n`;
      } else {
        wsText += '_No active workspace reported by local runner yet._\n';
      }

      if (env.SLACK_BOT_TOKEN) {
        await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            channel: channelId,
            thread_ts: threadTs,
            text: wsText
          })
        }).catch(() => {});
      }
    }

    return new Response('OK', { status: 200 });
  }

  return new Response('OK', { status: 200 });
}

/**
 * Handle Slack Interactive Component Clicks (/slack/interactions)
 * Form field: payload (JSON string)
 */
export async function handleSlackInteractions(request, env) {
  const signature = request.headers.get('x-slack-signature');
  const timestamp = request.headers.get('x-slack-request-timestamp');

  const rawBody = await request.text();

  // Threat Defense: Validate Slack HMAC-SHA256 Signature
  if (env.SLACK_SIGNING_SECRET) {
    const isValid = await verifySlackSignature(env.SLACK_SIGNING_SECRET, signature, timestamp, rawBody);
    if (!isValid) {
      return new Response('Invalid request signature', { status: 401 });
    }
  }

  let payload = {};
  try {
    const params = new URLSearchParams(rawBody);
    const payloadStr = params.get('payload');
    if (payloadStr) {
      payload = JSON.parse(payloadStr);
    } else {
      payload = JSON.parse(rawBody);
    }
  } catch {
    return new Response('Invalid payload', { status: 400 });
  }

  // Security Whitelist Defense: Enforce authorized Slack user IDs on interactive clicks
  const userId = payload.user?.id;
  if (env.SLACK_ALLOWED_USER_IDS) {
    const allowed = env.SLACK_ALLOWED_USER_IDS.split(',').map((id) => id.trim());
    if (!userId || !allowed.includes(userId)) {
      return new Response(
        JSON.stringify({
          replace_original: false,
          response_type: 'ephemeral',
          text: '⛔ *Unauthorized*: Your Slack user ID is not authorized to control agent-bell.'
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  const actions = payload.actions || [];
  for (const action of actions) {
    const val = action.value || '';

    if (val.startsWith('appr:')) {
      const taskId = val.slice(5);
      if (env.NOTIFIER_KV) {
        await env.NOTIFIER_KV.put(`approval_${taskId}`, 'APPROVED', { expirationTtl: 3600 });
        await env.NOTIFIER_KV.put(`answer_${taskId}`, 'APPROVED', { expirationTtl: 3600 });
      }
      return new Response(
        JSON.stringify({
          replace_original: false,
          response_type: 'ephemeral',
          text: `✅ *Action Approved by developer* (Task: \`${taskId}\`)`
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (val.startsWith('deny:')) {
      const taskId = val.slice(5);
      if (env.NOTIFIER_KV) {
        await env.NOTIFIER_KV.put(`approval_${taskId}`, 'DENIED', { expirationTtl: 3600 });
        await env.NOTIFIER_KV.put(`answer_${taskId}`, 'DENIED', { expirationTtl: 3600 });
      }
      return new Response(
        JSON.stringify({
          replace_original: false,
          response_type: 'ephemeral',
          text: `❌ *Action Denied by developer* (Task: \`${taskId}\`)`
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (val.startsWith('choice:')) {
      const parts = val.split(':');
      const taskId = parts[1];
      const choice = parts.slice(2).join(':');
      const isApprove = choice.toLowerCase() === 'approve' || choice.toLowerCase() === 'yes';
      const isDeny = choice.toLowerCase() === 'deny' || choice.toLowerCase() === 'no';
      if (env.NOTIFIER_KV) {
        const approvalVal = isApprove ? 'APPROVED' : (isDeny ? 'DENIED' : choice);
        await env.NOTIFIER_KV.put(`approval_${taskId}`, approvalVal, { expirationTtl: 3600 });
        await env.NOTIFIER_KV.put(`answer_${taskId}`, choice, { expirationTtl: 3600 });
      }
      return new Response(
        JSON.stringify({
          replace_original: false,
          response_type: 'ephemeral',
          text: `👉 Selected choice: *${choice}* (Task: \`${taskId}\`)`
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (val === 'stop' || val.startsWith('stop:')) {
      if (env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'stop-' + Date.now(),
          action: 'STOP_TASK',
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
      }

      return new Response(
        JSON.stringify({
          replace_original: false,
          response_type: 'ephemeral',
          text: '🛑 *Emergency Stop Dispatched*\nA stop signal has been sent to the local runner process tree.'
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  return new Response('OK', { status: 200 });
}
