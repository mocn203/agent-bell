/**
 * agent-bell - Discord Multi-Channel Adapter
 * Features:
 * - Ed25519 signature verification (Web Crypto API, Zero Dependencies)
 * - Dynamic Category & Channel auto-creation per workspace
 * - Rich Embeds with ANSI terminal diff syntax highlighting
 * - Interactive Approval & Stop Buttons
 * - Slash Command interactions (/prompt, /run, /stop, /revert, /status, /workspaces)
 */

function escapeDiscord(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`');
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

export function hexToUint8Array(hex) {
  if (!hex || typeof hex !== 'string') return new Uint8Array(0);
  const clean = hex.trim();
  if (clean.length % 2 !== 0) return new Uint8Array(0);
  const arr = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    arr[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return arr;
}

export function uint8ArrayToHex(arr) {
  if (!arr) return '';
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify Discord Ed25519 Signature using standard Web Crypto API
 * Replay attack prevention: checks timestamp is within maxAgeSeconds (default 300s).
 */
export async function verifyDiscordSignature(publicKeyHex, signatureHex, timestamp, rawBody, maxAgeSeconds = 300) {
  if (!publicKeyHex || !signatureHex || !timestamp) return false;

  if (maxAgeSeconds > 0) {
    const now = Math.floor(Date.now() / 1000);
    const tsNum = Number(timestamp);
    if (isNaN(tsNum) || Math.abs(now - tsNum) > maxAgeSeconds) {
      return false;
    }
  }

  try {
    const cryptoObj = globalThis.crypto;
    const pubKeyBytes = hexToUint8Array(publicKeyHex);
    const sigBytes = hexToUint8Array(signatureHex);
    if (pubKeyBytes.length !== 32 || sigBytes.length !== 64) return false;

    const data = new TextEncoder().encode(timestamp + rawBody);
    const key = await cryptoObj.subtle.importKey(
      'raw',
      pubKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify']
    );

    return await cryptoObj.subtle.verify({ name: 'Ed25519' }, key, sigBytes, data);
  } catch (_) {
    return false;
  }
}

/**
 * Format Git diff lines into Discord ```ansi code block
 * Colors:
 * - Green (\u001b[32m): additions (+, ➕)
 * - Red (\u001b[31m): deletions (-, ➖)
 * - Cyan (\u001b[36m): branches & stats (•, Git:)
 * - Yellow (\u001b[33m): modified files (📝, ⚠️)
 * Ensures total formatted text stays strictly under Discord field limit (1024 chars).
 */
export function formatDiscordAnsiDiff(gitSummary, maxFieldLength = 980) {
  if (!gitSummary || typeof gitSummary !== 'string') return '';
  const lines = gitSummary.split('\n');
  const colored = [];
  const truncateNotice = '\u001b[33m... [diff truncated]\u001b[0m';
  // Account for ```ansi\n (8) and \n``` (4)
  let currentLen = 12;

  for (const line of lines) {
    let formatted = line;
    const trimmed = line.trimStart();
    if (trimmed.startsWith('+') || trimmed.startsWith('➕')) {
      formatted = `\u001b[32m${line}\u001b[0m`;
    } else if (trimmed.startsWith('-') || trimmed.startsWith('➖')) {
      formatted = `\u001b[31m${line}\u001b[0m`;
    } else if (trimmed.startsWith('•') || trimmed.startsWith('Git:')) {
      formatted = `\u001b[36m${line}\u001b[0m`;
    } else if (trimmed.startsWith('📝') || trimmed.startsWith('⚠️')) {
      formatted = `\u001b[33m${line}\u001b[0m`;
    }

    if (currentLen + formatted.length + 1 + truncateNotice.length > maxFieldLength) {
      colored.push(truncateNotice);
      break;
    }
    colored.push(formatted);
    currentLen += formatted.length + 1;
  }

  return '```ansi\n' + colored.join('\n') + '\n```';
}

/**
 * Color Scheme:
 * - Success: Emerald Green (#10b981 -> 0x10b981 = 1096065)
 * - Approval Pending / Quota: Amber (#f59e0b -> 0xf59e0b = 16096779)
 * - Emergency Stop / Error: Crimson Red (#ef4444 -> 0xef4444 = 15680580)
 */
export const DISCORD_COLORS = {
  SUCCESS: 0x10b981,
  APPROVAL: 0xf59e0b,
  ERROR: 0xef4444,
  QUOTA: 0xf59e0b,
  DEFAULT: 0x5865f2
};

/**
 * Build Discord Rich Embed with ANSI diff blocks and metadata
 */
export function buildDiscordEmbed(data, shortSummary) {
  const isError = Boolean(data.isError);
  const isApproval = Boolean(data.isApprovalRequired || data.requiresApproval);
  const isQuota = Boolean(data.isQuotaLimit);

  let color = DISCORD_COLORS.SUCCESS;
  if (isError) {
    color = DISCORD_COLORS.ERROR;
  } else if (isApproval) {
    color = DISCORD_COLORS.APPROVAL;
  } else if (isQuota) {
    color = DISCORD_COLORS.QUOTA;
  }

  const titleWs = truncate(data.gitHeader || data.workspace || 'Project', 100);
  let title = `🚀 ${titleWs}`;
  if (isApproval) {
    title = `⚠️ APPROVAL REQUIRED [${truncate(data.workspace || 'Project', 80)}]`;
  } else if (isError) {
    title = `🛑 Task Failed / Terminated [${truncate(data.workspace || 'Project', 80)}]`;
  } else if (isQuota) {
    title = `⚠️ Quota Limit Reached [${truncate(data.workspace || 'Project', 80)}]`;
  }
  title = truncate(title, 250);

  const fields = [];

  if (data.prompt) {
    fields.push({
      name: 'Task',
      value: truncate(data.prompt, 200),
      inline: false
    });
  }

  if (shortSummary) {
    fields.push({
      name: 'Outcome',
      value: truncate(shortSummary, 300),
      inline: false
    });
  }

  if (data.output && isError) {
    fields.push({
      name: 'Error Details',
      value: '```sh\n' + truncate(data.output, 500) + '\n```',
      inline: false
    });
  }

  if (data.durationSeconds) {
    fields.push({
      name: 'Duration',
      value: `${data.durationSeconds}s`,
      inline: true
    });
  }

  if (data.tokenStats?.turnTotal) {
    let tokVal = formatNumber(data.tokenStats.turnTotal);
    if (data.tokenStats.sessionTotal) {
      tokVal += ` (Total: ${formatNumber(data.tokenStats.sessionTotal)})`;
    }
    fields.push({
      name: 'Tokens',
      value: tokVal,
      inline: true
    });
  }

  if (data.gitSummary) {
    fields.push({
      name: 'Git Diff & Status',
      value: formatDiscordAnsiDiff(data.gitSummary),
      inline: false
    });
  }

  return {
    title,
    color,
    fields,
    footer: { text: 'agent-bell • Zero-Cost Autonomous Companion' },
    timestamp: new Date().toISOString()
  };
}

/**
 * Build Discord Message Action Row with Interactive Buttons
 * Ensures custom_id does not exceed Discord's 100 character limit.
 */
export function buildDiscordComponents(data) {
  const taskId = data.taskId || data.id;
  const isApproval = Boolean(data.isApprovalRequired || data.requiresApproval);
  const choices = Array.isArray(data.choices) && data.choices.length > 0 ? data.choices : null;

  const buttons = [];

  if (choices && taskId) {
    const safeTaskId = truncate(String(taskId), 50);
    const choiceButtons = choices.slice(0, 5).map((choice) => {
      const isApprove = choice.toLowerCase() === 'approve' || choice.toLowerCase() === 'yes';
      const isDeny = choice.toLowerCase() === 'deny' || choice.toLowerCase() === 'no';
      let style = 1; // PRIMARY (Blurple)
      let custom_id = `choice:${safeTaskId}:${truncate(choice, 30)}`;
      let emoji = undefined;

      if (isApprove) {
        style = 3; // SUCCESS (Green)
        emoji = { name: '✅' };
      } else if (isDeny) {
        style = 4; // DANGER (Red)
        emoji = { name: '❌' };
      }

      return {
        type: 2,
        style,
        label: truncate(choice, 80),
        emoji,
        custom_id
      };
    });

    return [
      {
        type: 1, // ACTION_ROW
        components: choiceButtons
      }
    ];
  }

  if (isApproval && taskId) {
    const safeTaskId = truncate(String(taskId), 90);
    // Green Approve button
    buttons.push({
      type: 2,
      style: 3, // SUCCESS (Green)
      label: 'Approve',
      emoji: { name: '✅' },
      custom_id: `appr:${safeTaskId}`
    });

    // Red Deny button
    buttons.push({
      type: 2,
      style: 4, // DANGER (Red)
      label: 'Deny',
      emoji: { name: '❌' },
      custom_id: `deny:${safeTaskId}`
    });
  }

  // Emergency Stop button
  const stopId = taskId ? `stop:${truncate(String(taskId), 90)}` : 'stop';
  buttons.push({
    type: 2,
    style: 4, // DANGER (Red)
    label: 'Stop Task',
    emoji: { name: '🛑' },
    custom_id: stopId
  });

  return [
    {
      type: 1, // ACTION_ROW
      components: buttons
    }
  ];
}

/**
 * Sanitize workspace name to Discord channel format (e.g. "Work4-Core" -> "work4-core")
 */
export function sanitizeChannelName(name) {
  if (!name) return 'general';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'general';
}

/**
 * Dynamic Organization: Auto-create category "AGENT-BELL" and dedicated channel per workspace
 */
export async function ensureDiscordCategoryAndChannel(env, workspaceName) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return null;

  const guildId = env.DISCORD_GUILD_ID;
  const botToken = env.DISCORD_BOT_TOKEN;
  const targetChannelName = sanitizeChannelName(workspaceName);
  const cacheKey = `discord_chan_${guildId}_${targetChannelName}`;

  if (env.NOTIFIER_KV) {
    const cachedId = await env.NOTIFIER_KV.get(cacheKey);
    if (cachedId) return cachedId;
  }

  const authHeader = {
    'Authorization': `Bot ${botToken}`,
    'Content-Type': 'application/json'
  };

  try {
    // 1. Fetch current guild channels
    const listRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: authHeader
    });
    if (!listRes.ok) return null;
    const channels = await listRes.json();

    // 2. Find or create AGENT-BELL Category (type: 4)
    let category = channels.find((c) => c.type === 4 && c.name.toUpperCase() === 'AGENT-BELL');
    if (!category) {
      const catRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          name: 'AGENT-BELL',
          type: 4
        })
      });
      if (catRes.ok) {
        category = await catRes.json();
      }
    }

    // 3. Find or create workspace text channel (type: 0) under AGENT-BELL category
    let channel = channels.find(
      (c) => c.type === 0 && c.name === targetChannelName && (!category || c.parent_id === category.id)
    );

    if (!channel) {
      const chanRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          name: targetChannelName,
          type: 0,
          parent_id: category ? category.id : undefined,
          topic: `agent-bell notifications and remote controls for ${workspaceName}`
        })
      });
      if (chanRes.ok) {
        channel = await chanRes.json();
      }
    }

    if (channel?.id) {
      if (env.NOTIFIER_KV) {
        await env.NOTIFIER_KV.put(cacheKey, channel.id, { expirationTtl: 86400 * 7 });
      }
      return channel.id;
    }
  } catch (_) {}

  return null;
}

/**
 * Dispatch Discord notification (supports Bot REST API or Webhook fallback)
 */
export async function sendDiscordNotification(env, data, shortSummary) {
  const embed = buildDiscordEmbed(data, shortSummary);
  const components = buildDiscordComponents(data);

  // 1. Try Discord Bot REST API with dynamic channel auto-creation or explicit channel
  if (env.DISCORD_BOT_TOKEN) {
    let channelId = data.discordChannelId || env.DISCORD_CHANNEL_ID;
    if (!data.discordChannelId && env.DISCORD_GUILD_ID && data.workspace) {
      const dynamicChanId = await ensureDiscordCategoryAndChannel(env, data.workspace);
      if (dynamicChanId) channelId = dynamicChanId;
    }

    if (channelId) {
      try {
        const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            embeds: [embed],
            components
          })
        });
        if (res.ok) return await res.json();
      } catch (_) {}
    }
  }

  // 2. Fallback to Discord Webhook
  if (env.DISCORD_WEBHOOK_URL) {
    try {
      const res = await fetch(env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'agent-bell',
          embeds: [embed],
          components
        })
      });
      if (res.ok) return { success: true };

      // Retry without components in case standard webhook rejects interactive components
      if (!res.ok && components && components.length > 0) {
        const retryRes = await fetch(env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'agent-bell',
            embeds: [embed]
          })
        });
        if (retryRes.ok) return { success: true };
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Handle Two-Way Discord Interactions (/discord/interactions)
 */
export async function handleDiscordInteractions(request, env) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');

  const rawBody = await request.text();

  // Threat Defense: Validate Ed25519 Signature
  if (env.DISCORD_PUBLIC_KEY) {
    const isValid = await verifyDiscordSignature(env.DISCORD_PUBLIC_KEY, signature, timestamp, rawBody);
    if (!isValid) {
      return new Response('Invalid request signature', { status: 401 });
    }
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // 1. Type 1: PING -> Respond with PONG
  if (interaction.type === 1) {
    return new Response(JSON.stringify({ type: 1 }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Security Whitelist Defense
  const userId = interaction.member?.user?.id || interaction.user?.id;
  if (env.DISCORD_ALLOWED_USER_IDS) {
    const allowed = env.DISCORD_ALLOWED_USER_IDS.split(',').map((id) => id.trim());
    if (!userId || !allowed.includes(userId)) {
      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: '⛔ **Unauthorized**: Your Discord user ID is not authorized to control agent-bell.',
            flags: 64 // Ephemeral
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // 2. Type 3: Component Interactions (Buttons)
  if (interaction.type === 3) {
    const customId = interaction.data?.custom_id || '';

    if (customId.startsWith('appr:')) {
      const taskId = customId.slice(5);
      if (env.NOTIFIER_KV) {
        await env.NOTIFIER_KV.put(`approval_${taskId}`, 'APPROVED', { expirationTtl: 3600 });
        await env.NOTIFIER_KV.put(`answer_${taskId}`, 'APPROVED', { expirationTtl: 3600 });
      }
      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `✅ **Action Approved by developer** (Task: \`${taskId}\`)`,
            flags: 64
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (customId.startsWith('deny:')) {
      const taskId = customId.slice(5);
      if (env.NOTIFIER_KV) {
        await env.NOTIFIER_KV.put(`approval_${taskId}`, 'DENIED', { expirationTtl: 3600 });
        await env.NOTIFIER_KV.put(`answer_${taskId}`, 'DENIED', { expirationTtl: 3600 });
      }
      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `❌ **Action Denied by developer** (Task: \`${taskId}\`)`,
            flags: 64
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (customId.startsWith('choice:')) {
      const parts = customId.split(':');
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
          type: 4,
          data: {
            content: `👉 **Selected choice:** \`${choice}\` (Task: \`${taskId}\`)`,
            flags: 64
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (customId === 'stop' || customId.startsWith('stop:')) {
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
          type: 4,
          data: {
            content: '🛑 **Emergency Stop Dispatched**\nA stop signal has been sent to the local runner process tree.',
            flags: 64
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ type: 6 }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 3. Type 2: Slash Commands
  if (interaction.type === 2) {
    const cmdName = (interaction.data?.name || '').toLowerCase();
    const options = interaction.data?.options || [];
    const getOption = (name) => options.find((o) => o.name === name)?.value;

    if (cmdName === 'prompt') {
      const taskText = getOption('task') || getOption('text') || '';
      if (!taskText) {
        return new Response(
          JSON.stringify({
            type: 4,
            data: { content: '⚠️ **Usage**: `/prompt <task instructions>`', flags: 64 }
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'prompt-' + Date.now(),
          action: 'RUN_PROMPT',
          prompt: taskText,
          discordChannelId: interaction.channel_id,
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
      }

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `🤖 **Prompt Queued for Agent**\n• Task: *"${escapeDiscord(truncate(taskText, 120))}"*\nDispatched to local runner.`
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (cmdName === 'run') {
      const commandText = getOption('command') || getOption('cmd') || '';
      if (!commandText) {
        return new Response(
          JSON.stringify({
            type: 4,
            data: { content: '⚠️ **Usage**: `/run <command>`', flags: 64 }
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'cmd-' + Date.now(),
          action: 'RUN_COMMAND',
          command: commandText,
          discordChannelId: interaction.channel_id,
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
      }

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `⚡ **Remote Command Queued**\n• Command: \`${escapeDiscord(commandText)}\`\nExecuting in active workspace on local host...`
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (cmdName === 'stop') {
      if (env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'stop-' + Date.now(),
          action: 'STOP_TASK',
          discordChannelId: interaction.channel_id,
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
      }

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: '🛑 **Emergency Stop Dispatched**\nA termination signal has been queued to stop the local runner process tree.'
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (cmdName === 'revert') {
      const cleanUntracked = Boolean(getOption('clean'));
      if (env.NOTIFIER_KV) {
        const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
        currentQueue.push({
          id: 'revert-' + Date.now(),
          action: 'REVERT',
          cleanUntracked,
          discordChannelId: interaction.channel_id,
          created_at: Date.now()
        });
        await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
      }

      const cleanNotice = cleanUntracked ? ' (including untracked files)' : '';
      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `🔄 **Emergency Revert Queued**\nA command to discard uncommitted working tree modifications${cleanNotice} has been sent to the local runner.`
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (cmdName === 'status') {
      let statusText = '';
      let hb = null;
      if (env.NOTIFIER_KV) {
        hb = await env.NOTIFIER_KV.get('runner_heartbeat', 'json');
      }

      if (hb && hb.timestamp) {
        const lastSeen = Math.round((Date.now() - new Date(hb.timestamp).getTime()) / 1000);
        if (lastSeen < 60) {
          statusText = `⚡ **Local Runner: 🟢 ONLINE**\n• Host: \`${escapeDiscord(hb.hostname || 'localhost')}\`\n• PID: \`${hb.pid}\`\n• Uptime: \`${hb.uptime || 0}s\`\n• Workspace: **${escapeDiscord(hb.activeWorkspace || 'Default')}**\n`;
          if (hb.gitHeader) statusText += `• Git: \`${escapeDiscord(hb.gitHeader)}\`\n`;
          statusText += `• Last ping: *${lastSeen}s ago*`;
        } else {
          statusText = `⚡ **Local Runner: 🔴 OFFLINE**\n• Last seen: *${lastSeen}s ago*\n• Host: \`${escapeDiscord(hb.hostname || 'Unknown')}\``;
        }
      } else {
        statusText = '⚡ **Local Runner: 🔴 OFFLINE**\n*No runner heartbeat received yet. Start runner via:*\n`npx agent-bell start`';
      }

      return new Response(
        JSON.stringify({
          type: 4,
          data: { content: statusText }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (cmdName === 'workspaces' || cmdName === 'ws') {
      let wsText = '📁 **Configured Workspaces:**\n';
      let hb = null;
      if (env.NOTIFIER_KV) {
        hb = await env.NOTIFIER_KV.get('runner_heartbeat', 'json');
      }

      if (hb && hb.workspaces && hb.workspaces.length > 0) {
        for (const ws of hb.workspaces) {
          const isActive = ws.name === hb.activeWorkspace || ws.path === hb.activeWorkspacePath;
          wsText += `• **${escapeDiscord(ws.name)}**${isActive ? ' *(Active)*' : ''}\n  \`${escapeDiscord(ws.path)}\`\n`;
        }
      } else if (hb && hb.activeWorkspace) {
        wsText += `• **${escapeDiscord(hb.activeWorkspace)}** *(Active)*\n  \`${escapeDiscord(hb.activeWorkspacePath || '')}\`\n`;
      } else {
        wsText += '*No active workspace reported by local runner yet.*\n';
      }

      return new Response(
        JSON.stringify({
          type: 4,
          data: { content: wsText }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  return new Response(JSON.stringify({ type: 4, data: { content: 'Unknown command' } }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Register Discord Slash Commands with Discord REST API
 */
export async function registerDiscordCommands(applicationId, botToken, guildId = null) {
  if (!applicationId || !botToken) return { error: 'Missing applicationId or botToken' };

  const commands = [
    {
      name: 'prompt',
      description: 'Dispatch autonomous coding task to agent',
      options: [
        {
          name: 'task',
          description: 'Instructions for the AI coding agent',
          type: 3, // STRING
          required: true
        }
      ]
    },
    {
      name: 'run',
      description: 'Execute shell command in active workspace on host PC',
      options: [
        {
          name: 'command',
          description: 'Shell script or CLI command (e.g. npm test)',
          type: 3, // STRING
          required: true
        }
      ]
    },
    {
      name: 'stop',
      description: 'Emergency stop local runner process tree'
    },
    {
      name: 'revert',
      description: 'Discard uncommitted working tree changes',
      options: [
        {
          name: 'clean',
          description: 'Also remove untracked files',
          type: 5, // BOOLEAN
          required: false
        }
      ]
    },
    {
      name: 'status',
      description: 'Check local runner connectivity and active workspace state'
    },
    {
      name: 'workspaces',
      description: 'List configured workspaces'
    }
  ];

  const url = guildId
    ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${applicationId}/commands`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bot ${botToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });

  return { ok: res.ok, status: res.status, data: await res.json() };
}
