/**
 * agent-bell - Cloudflare Worker Core
 * Multi-channel Universal AI Notifier (Telegram, Discord, Slack) with Groq Summarization.
 */

import {
  handleDiscordInteractions,
  sendDiscordNotification,
  registerDiscordCommands,
  verifyDiscordSignature,
  formatDiscordAnsiDiff,
  buildDiscordEmbed,
  buildDiscordComponents,
  ensureDiscordCategoryAndChannel
} from './discord.js';

import {
  handleSlackEvents,
  handleSlackInteractions,
  sendSlackNotification,
  verifySlackSignature,
  buildSlackBlocks,
  timingSafeEqual
} from './slack.js';


function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
 * Automated Regex Secret Scrubber (Zero Dependencies Edge Mitigation)
 * Masks sensitive tokens, passwords, and private keys before dispatching to channels.
 */
function scrubSecrets(text) {
  if (!text || typeof text !== 'string') return text;

  let cleaned = text;
  cleaned = cleaned.replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  cleaned = cleaned.replace(/\bsk-[a-zA-Z0-9_-]{20,}\b/g, 'sk-***');
  cleaned = cleaned.replace(/\bgsk_[a-zA-Z0-9_-]{20,}\b/g, 'gsk_***');
  cleaned = cleaned.replace(/\b(gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{22,})\b/g, 'ghp_***');
  cleaned = cleaned.replace(/\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/g, 'xox***');
  cleaned = cleaned.replace(/\b\d{8,11}:[a-zA-Z0-9_-]{30,50}\b/g, '***:***');
  cleaned = cleaned.replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***');
  cleaned = cleaned.replace(/\bAIzaSy[0-9a-zA-Z_-]{33}\b/g, 'AIzaSy***');
  cleaned = cleaned.replace(/\bhf_[a-zA-Z0-9]{20,}\b/g, 'hf_***');
  cleaned = cleaned.replace(/\bBearer\s+[a-zA-Z0-9._\-+/=]{15,}\b/gi, 'Bearer ***');
  cleaned = cleaned.replace(/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
  cleaned = cleaned.replace(/(\b[a-z0-9+.-]+:\/\/[^:\s\/]*:)([^@\s\/]+)(@)/gi, '$1***$3');
  cleaned = cleaned.replace(
    /((?:["']?(?:[a-zA-Z0-9_-]*(?:secret|password|passwd|auth_token|token|private_?key|api_?key))["']?\s*[:=]\s*["'`]))([^"'`]{6,})(["'`])/gi,
    '$1***$3'
  );
  cleaned = cleaned.replace(
    /(\b[a-zA-Z0-9_-]*(?:secret|password|passwd|auth_token|token|private_?key|api_?key)\s*=\s*)([^\s;&"']{6,})/gi,
    '$1***'
  );
  return cleaned;
}

/**
 * Universal AI Summarization (OpenAI-compatible: DeepSeek, Groq, Ollama, OpenAI)
 */
async function summarizeWithAI(rawText, prompt, env, lang = 'en') {
  if (!rawText || rawText.length < 25) return rawText;

  let apiKeys = [];
  if (env.AI_API_KEY) {
    apiKeys = [env.AI_API_KEY];
  } else if (env.GROQ_API_KEYS) {
    try {
      apiKeys = JSON.parse(env.GROQ_API_KEYS);
    } catch (_) {
      apiKeys = [env.GROQ_API_KEYS];
    }
  }

  if (apiKeys.length === 0) return truncate(rawText, 140);

  const apiBase = (env.AI_API_BASE || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const model = env.AI_MODEL || 'qwen/qwen3.8-27b';

  const isVi = lang === 'vi';
  const systemPrompt = isVi
    ? 'Bạn là trợ lý tóm tắt. Tóm tắt kết quả công việc thành đúng 1 câu cực ngắn gọn bằng tiếng Việt (dưới 25 từ), chỉ nêu cái đã hoàn thành. Không mở bài, không lời thừa:'
    : 'You are a summarizer. Summarize the task outcome in exactly 1 concise English sentence (under 20 words), focusing on what was completed. No greetings, no filler:';

  const userContent = prompt
    ? `Task: "${truncate(prompt, 80)}"\nOutcome: ${truncate(rawText, 1000)}`
    : `Outcome: ${truncate(rawText, 1000)}`;

  for (const apiKey of apiKeys) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      const res = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          max_tokens: 80,
          temperature: 0.1
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        const summary = data.choices?.[0]?.message?.content?.trim();
        if (summary) return summary.replace(/^["']|["']$/g, '');
      }
    } catch (_) {}
  }

  return truncate(rawText, 140);
}

/**
 * Minimal Telegram layout (No Gmail / Anonymous & clean)
 */
function buildMinimalTelegramMessage(data, shortSummary, lang = 'en') {
  const {
    workspace = 'Project',
    prompt = '',
    durationSeconds = null,
    isQuotaLimit = false,
    tokenStats = null,
    gitHeader = null,
    gitSummary = null
  } = data;

  const isVi = lang === 'vi';

  if (isQuotaLimit) {
    const title = isVi ? 'Hết Quota' : 'Quota Limit';
    const desc = isVi ? 'Đạt giới hạn ngân sách token' : 'Token budget exceeded';
    let msg = `⚠️ <b>${title}:</b> <code>${escapeHtml(workspace)}</code>\n`;
    if (tokenStats && tokenStats.sessionTotal > 0) {
      msg += `• <b>${isVi ? 'Tổng Token' : 'Total Tokens'}:</b> ${formatNumber(tokenStats.sessionTotal)} (${desc})`;
    } else {
      msg += `• ${desc}`;
    }
    return msg;
  }

  const doneLabel = isVi ? 'Xong' : 'Done';
  const tokLabel = isVi ? 'Token' : 'Tokens';
  const totalLabel = isVi ? 'Tổng' : 'Total';

  let titleLine = `🚀 <b>${escapeHtml(workspace)}</b>`;
  if (gitHeader && gitHeader !== workspace) {
    titleLine = `🚀 <b>${escapeHtml(gitHeader)}</b>`;
  }
  if (durationSeconds) titleLine += ` (${durationSeconds}s)`;

  let msg = titleLine + '\n';

  if (gitSummary) {
    msg += `${escapeHtml(gitSummary)}\n`;
  }

  if (prompt) {
    msg += `• <b>Task:</b> ${escapeHtml(truncate(prompt, 100))}\n`;
  }

  if (shortSummary) {
    msg += `• <b>${doneLabel}:</b> ${escapeHtml(shortSummary)}\n`;
  }

  if (tokenStats && tokenStats.turnTotal > 0) {
    msg += `• <b>${tokLabel}:</b> ${formatNumber(tokenStats.turnTotal)}`;
    if (tokenStats.sessionTotal > 0) {
      msg += ` (${totalLabel}: ${formatNumber(tokenStats.sessionTotal)})`;
    }
    msg += `\n`;
  }

  return msg.trim();
}

/**
 * Navigation Menu Inline Keyboard
 */
function getMainMenuMarkup() {
  return {
    inline_keyboard: [
      [
        { text: '📁 Workspaces', callback_data: 'menu:workspaces' },
        { text: '⚡ Status', callback_data: 'menu:status' }
      ],
      [
        { text: '🛑 Stop Active Task', callback_data: 'menu:stop' },
        { text: '🧹 Clear Chat', callback_data: 'menu:clear' }
      ]
    ]
  };
}

function safeTelegramCallbackData(prefix, taskId, text) {
  const safeTaskId = String(taskId).slice(0, 24);
  const head = `${prefix}:${safeTaskId}:`;
  const encoder = new TextEncoder();
  const maxBytes = 64;
  let remaining = maxBytes - encoder.encode(head).length;
  if (remaining <= 0) return head.slice(0, maxBytes);
  let str = String(text).trim();
  while (encoder.encode(str).length > remaining && str.length > 0) {
    str = str.slice(0, -1);
  }
  return head + str;
}

/**
 * Build Telegram Inline Keyboard for approvals and custom choices
 */
function buildTelegramReplyMarkup(data) {
  const taskId = data.taskId || data.id;
  const isApproval = Boolean(data.isApprovalRequired || data.requiresApproval);
  const choices = Array.isArray(data.choices) && data.choices.length > 0 ? data.choices : null;

  if (choices && taskId) {
    const row = choices.slice(0, 5).map((choice) => {
      const isApprove = choice.toLowerCase() === 'approve' || choice.toLowerCase() === 'yes';
      const isDeny = choice.toLowerCase() === 'deny' || choice.toLowerCase() === 'no';
      let text = choice;
      if (isApprove) text = `✅ ${choice}`;
      else if (isDeny) text = `❌ ${choice}`;
      const callback_data = safeTelegramCallbackData('ans', taskId, choice);
      return { text, callback_data };
    });
    return { inline_keyboard: [row] };
  }

  if (isApproval && taskId) {
    const safeTaskId = String(taskId).slice(0, 50);
    return {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `appr:${safeTaskId}` },
          { text: '❌ Deny', callback_data: `deny:${safeTaskId}` }
        ]
      ]
    };
  }

  return null;
}

/**
 * Telegram delivery
 */
async function sendTelegramMessage(botToken, chatId, text, parseMode = 'HTML', disableNotification = false, replyMarkup = null, messageThreadId = null) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: true,
    disable_notification: disableNotification
  };

  if (parseMode) payload.parse_mode = parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (messageThreadId) payload.message_thread_id = messageThreadId;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  if (!response.ok || !result.ok) {
    if (parseMode === 'HTML' && result.description && result.description.includes('can\'t parse entities')) {
      return sendTelegramMessage(botToken, chatId, text.replace(/<[^>]*>/g, ''), null, disableNotification, replyMarkup, messageThreadId);
    }
    throw new Error(`Telegram API Error: ${result.description || response.statusText}`);
  }

  return result;
}

async function editTelegramMessage(botToken, chatId, messageId, text, parseMode = 'HTML', replyMarkup = null) {
  if (!messageId) return null;
  const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    disable_web_page_preview: true
  };

  if (parseMode) payload.parse_mode = parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return await response.json();
}

async function answerTelegramCallbackQuery(botToken, callbackQueryId, text = null, showAlert = false) {
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  const payload = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  if (showAlert) payload.show_alert = showAlert;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (_) {}
}

async function deleteTelegramMessage(botToken, chatId, messageId) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/deleteMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId })
    });
  } catch (_) {}
}

/**
 * Discord delivery (Rich Embed with ANSI diff & Action Row)
 */
async function sendDiscordWebhook(webhookUrl, data, shortSummary) {
  return sendDiscordNotification({ DISCORD_WEBHOOK_URL: webhookUrl }, data, shortSummary);
}

/**
 * Slack delivery (Block Kit with threaded isolation & buttons)
 */
async function sendSlackWebhook(webhookUrl, data, shortSummary) {
  return sendSlackNotification({ SLACK_WEBHOOK_URL: webhookUrl }, data, shortSummary);
}

async function trackSentMessage(kv, messageId) {
  if (!kv || !messageId) return;
  try {
    const current = (await kv.get('recent_messages', 'json')) || [];
    current.push(messageId);
    const trimmed = current.slice(-100);
    await kv.put('recent_messages', JSON.stringify(trimmed), { expirationTtl: 86400 * 7 });
  } catch (_) {}
}

async function trackDailyStats(kv, tokenStats) {
  if (!kv) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const key = `stats_${today}`;
    const stats = (await kv.get(key, 'json')) || { tasks: 0, tokens: 0, cacheRead: 0 };

    stats.tasks += 1;
    if (tokenStats) {
      stats.tokens += tokenStats.turnTotal || 0;
      stats.cacheRead += tokenStats.turnCacheRead || 0;
    }

    await kv.put(key, JSON.stringify(stats), { expirationTtl: 86400 * 14 });
  } catch (_) {}
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'agent-bell',
          version: '2.0.0 (Multi-Channel: Telegram, Discord, Slack)',
          timestamp: new Date().toISOString()
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Two-Way Telegram Webhook (/webhook)
    if (request.method === 'POST' && url.pathname === '/webhook') {
      try {
        // Threat Defense: Validate X-Telegram-Bot-Api-Secret-Token if configured
        if (env.TELEGRAM_WEBHOOK_SECRET) {
          const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
          if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
            return new Response('Unauthorized webhook token', { status: 401 });
          }
        }

        const update = await request.json();
        const botToken = env.TELEGRAM_BOT_TOKEN;
        const configuredChatId = String(env.TELEGRAM_CHAT_ID);
        const lang = env.DEFAULT_LANGUAGE || 'en';
        const isVi = lang === 'vi';

        // 1. Handle Inline Keyboard Callback Queries
        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = String(cb.message?.chat?.id || cb.from?.id);

          if (chatId !== configuredChatId) {
            await answerTelegramCallbackQuery(botToken, cb.id, 'Unauthorized user', true);
            return new Response('Unauthorized chat', { status: 403 });
          }

          const data = cb.data || '';
          const messageId = cb.message?.message_id;

          if (data === 'menu:main') {
            await answerTelegramCallbackQuery(botToken, cb.id);
            if (messageId) {
              await editTelegramMessage(
                botToken,
                chatId,
                messageId,
                '🔔 <b>agent-bell Control Panel</b>\nSelect an option below to manage active tasks or workspaces:',
                'HTML',
                getMainMenuMarkup()
              );
            }
            return new Response('OK', { status: 200 });
          }

          if (data === 'menu:workspaces') {
            await answerTelegramCallbackQuery(botToken, cb.id);
            let text = '📁 <b>Configured Workspaces:</b>\n';
            let hb = null;
            if (env.NOTIFIER_KV) {
              hb = await env.NOTIFIER_KV.get('runner_heartbeat', 'json');
            }

            if (hb && hb.workspaces && hb.workspaces.length > 0) {
              for (const ws of hb.workspaces) {
                const isActive = ws.name === hb.activeWorkspace || ws.path === hb.activeWorkspacePath;
                text += `• <b>${escapeHtml(ws.name)}</b>${isActive ? ' <i>(Active)</i>' : ''}\n  <code>${escapeHtml(ws.path)}</code>\n`;
              }
            } else if (hb && hb.activeWorkspace) {
              text += `• <b>${escapeHtml(hb.activeWorkspace)}</b> <i>(Active)</i>\n  <code>${escapeHtml(hb.activeWorkspacePath || '')}</code>\n`;
            } else {
              text += '<i>No active workspace reported by local runner yet.</i>\n';
            }

            if (messageId) {
              await editTelegramMessage(
                botToken,
                chatId,
                messageId,
                text,
                'HTML',
                {
                  inline_keyboard: [
                    [{ text: '🔙 Back to Menu', callback_data: 'menu:main' }]
                  ]
                }
              );
            }
            return new Response('OK', { status: 200 });
          }

          if (data === 'menu:status') {
            await answerTelegramCallbackQuery(botToken, cb.id);
            let text = '';
            let hb = null;
            if (env.NOTIFIER_KV) {
              hb = await env.NOTIFIER_KV.get('runner_heartbeat', 'json');
            }

            if (hb && hb.timestamp) {
              const lastSeenSeconds = Math.round((Date.now() - new Date(hb.timestamp).getTime()) / 1000);
              const isOnline = lastSeenSeconds < 60;

              if (isOnline) {
                text = `⚡ <b>Local Runner:</b> 🟢 ONLINE\n`;
                text += `• Host: <code>${escapeHtml(hb.hostname || 'localhost')}</code>\n`;
                text += `• PID: <code>${hb.pid}</code>\n`;
                text += `• Uptime: <code>${hb.uptime || 0}s</code>\n`;
                text += `• Workspace: <b>${escapeHtml(hb.activeWorkspace || 'Default')}</b>\n`;
                if (hb.gitHeader) text += `• Git: <code>${escapeHtml(hb.gitHeader)}</code>\n`;
                text += `• Last ping: <i>${lastSeenSeconds}s ago</i>`;
              } else {
                text = `⚡ <b>Local Runner:</b> 🔴 OFFLINE\n• Last seen: ${lastSeenSeconds}s ago\n• Host: <code>${escapeHtml(hb.hostname || 'Unknown')}</code>`;
              }
            } else {
              text = `⚡ <b>Local Runner:</b> 🔴 OFFLINE\n<i>No runner heartbeat received yet. Start runner via:</i>\n<code>npx agent-bell start</code>`;
            }

            if (messageId) {
              await editTelegramMessage(
                botToken,
                chatId,
                messageId,
                text,
                'HTML',
                {
                  inline_keyboard: [
                    [
                      { text: '🔄 Refresh', callback_data: 'menu:status' },
                      { text: '🔙 Back to Menu', callback_data: 'menu:main' }
                    ]
                  ]
                }
              );
            }
            return new Response('OK', { status: 200 });
          }

          if (data === 'menu:stop' || data.startsWith('stop:')) {
            if (env.NOTIFIER_KV) {
              const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
              currentQueue.push({
                id: 'stop-' + Date.now(),
                action: 'STOP_TASK',
                created_at: Date.now()
              });
              await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
            }

            await answerTelegramCallbackQuery(botToken, cb.id, '🛑 Emergency Stop dispatched!', true);
            if (messageId) {
              await editTelegramMessage(
                botToken,
                chatId,
                messageId,
                '🛑 <b>Emergency Stop Dispatched</b>\nA stop signal has been dispatched to the local runner process tree.',
                'HTML',
                {
                  inline_keyboard: [
                    [{ text: '🔙 Back to Menu', callback_data: 'menu:main' }]
                  ]
                }
              );
            }
            return new Response('OK', { status: 200 });
          }

          if (data === 'menu:clear') {
            if (env.NOTIFIER_KV) {
              const stored = (await env.NOTIFIER_KV.get('recent_messages', 'json')) || [];
              for (const id of stored) {
                if (id !== messageId) {
                  await deleteTelegramMessage(botToken, chatId, id);
                }
              }
              await env.NOTIFIER_KV.put('recent_messages', JSON.stringify([]));
            }
            await answerTelegramCallbackQuery(botToken, cb.id, '🧹 Chat notifications cleared!', false);
            return new Response('OK', { status: 200 });
          }

          if (data.startsWith('appr:')) {
            const taskId = data.slice(5);
            if (env.NOTIFIER_KV) {
              await env.NOTIFIER_KV.put(`approval_${taskId}`, 'APPROVED', { expirationTtl: 3600 });
              await env.NOTIFIER_KV.put(`answer_${taskId}`, 'APPROVED', { expirationTtl: 3600 });
            }
            await answerTelegramCallbackQuery(botToken, cb.id, '✅ Approved!');
            if (messageId) {
              await editTelegramMessage(
                botToken,
                chatId,
                messageId,
                (cb.message?.text || 'Approval Request') + '\n\n✅ <b>Action Approved by developer</b>',
                'HTML'
              );
            }
            return new Response('OK', { status: 200 });
          }

          if (data.startsWith('deny:')) {
            const taskId = data.slice(5);
            if (env.NOTIFIER_KV) {
              await env.NOTIFIER_KV.put(`approval_${taskId}`, 'DENIED', { expirationTtl: 3600 });
              await env.NOTIFIER_KV.put(`answer_${taskId}`, 'DENIED', { expirationTtl: 3600 });
            }
            await answerTelegramCallbackQuery(botToken, cb.id, '❌ Denied!');
            if (messageId) {
              await editTelegramMessage(
                botToken,
                chatId,
                messageId,
                (cb.message?.text || 'Approval Request') + '\n\n❌ <b>Action Denied by developer</b>',
                'HTML'
              );
            }
            return new Response('OK', { status: 200 });
          }

          if (data.startsWith('ans:') || data.startsWith('choice:')) {
            const parts = data.split(':');
            const taskId = parts[1];
            const choice = parts.slice(2).join(':');
            const isApprove = choice.toLowerCase() === 'approve' || choice.toLowerCase() === 'yes';
            const isDeny = choice.toLowerCase() === 'deny' || choice.toLowerCase() === 'no';
            if (env.NOTIFIER_KV) {
              const approvalVal = isApprove ? 'APPROVED' : (isDeny ? 'DENIED' : choice);
              await env.NOTIFIER_KV.put(`approval_${taskId}`, approvalVal, { expirationTtl: 3600 });
              await env.NOTIFIER_KV.put(`answer_${taskId}`, choice, { expirationTtl: 3600 });
            }
            await answerTelegramCallbackQuery(botToken, cb.id, `👉 ${choice}`);
            if (messageId) {
              await editTelegramMessage(
                botToken,
                chatId,
                messageId,
                (cb.message?.text || 'Question') + `\n\n👉 <b>Selected:</b> ${escapeHtml(choice)}`,
                'HTML'
              );
            }
            return new Response('OK', { status: 200 });
          }

          await answerTelegramCallbackQuery(botToken, cb.id);
          return new Response('OK', { status: 200 });
        }

        // 2. Handle Text Messages and Commands
        const message = update.message;
        if (!message || !message.text) return new Response('OK', { status: 200 });

        const chatId = String(message.chat.id);
        if (chatId !== configuredChatId) return new Response('Unauthorized chat', { status: 403 });

        const text = message.text.trim();
        const threadId = message.message_thread_id || null;

        // Parse command: /cmd[@botname] [arguments]
        const cmdMatch = text.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
        if (cmdMatch) {
          const cmd = cmdMatch[1].toLowerCase();
          const rest = (cmdMatch[2] || '').trim();

          // Command: /menu
          if (cmd === 'menu') {
            const menuMsg = await sendTelegramMessage(
              botToken,
              chatId,
              '🔔 <b>agent-bell Control Panel</b>\nSelect an option below to manage active tasks or workspaces:',
              'HTML',
              false,
              getMainMenuMarkup(),
              threadId
            );
            if (env.NOTIFIER_KV && menuMsg.result?.message_id) {
              await trackSentMessage(env.NOTIFIER_KV, menuMsg.result.message_id);
            }
            return new Response('OK', { status: 200 });
          }

          // Command: /prompt (Instruct autonomous coding agent)
          if (cmd === 'prompt') {
            if (!rest) {
              await sendTelegramMessage(
                botToken,
                chatId,
                '⚠️ <b>Usage:</b> <code>/prompt &lt;task instructions&gt;</code>\nExample: <code>/prompt Fix failing tests in auth module</code>',
                'HTML',
                false,
                null,
                threadId
              );
              return new Response('OK', { status: 200 });
            }

            if (env.NOTIFIER_KV) {
              const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
              currentQueue.push({
                id: 'prompt-' + Date.now(),
                action: 'RUN_PROMPT',
                prompt: rest,
                messageThreadId: threadId,
                created_at: Date.now()
              });
              await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
            }

            await sendTelegramMessage(
              botToken,
              chatId,
              `🤖 <b>Prompt Queued for Agent</b>\n• Task: <i>"${escapeHtml(truncate(rest, 120))}"</i>\nDispatched to local runner.`,
              'HTML',
              false,
              null,
              threadId
            );
            return new Response('OK', { status: 200 });
          }

          // Command: /run (Execute remote script/command on host PC)
          if (cmd === 'run') {
            if (!rest) {
              await sendTelegramMessage(
                botToken,
                chatId,
                '⚠️ <b>Usage:</b> <code>/run &lt;command&gt;</code>\nExample: <code>/run npm test</code>',
                'HTML',
                false,
                null,
                threadId
              );
              return new Response('OK', { status: 200 });
            }

            if (env.NOTIFIER_KV) {
              const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
              currentQueue.push({
                id: 'cmd-' + Date.now(),
                action: 'RUN_COMMAND',
                command: rest,
                messageThreadId: threadId,
                created_at: Date.now()
              });
              await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
            }

            await sendTelegramMessage(
              botToken,
              chatId,
              `⚡ <b>Remote Command Queued</b>\n• Command: <code>${escapeHtml(rest)}</code>\nExecuting in active workspace on local host...`,
              'HTML',
              false,
              null,
              threadId
            );
            return new Response('OK', { status: 200 });
          }

          // Command: /stop (Emergency stop process tree)
          if (cmd === 'stop') {
            if (env.NOTIFIER_KV) {
              const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
              currentQueue.push({
                id: 'stop-' + Date.now(),
                action: 'STOP_TASK',
                messageThreadId: threadId,
                created_at: Date.now()
              });
              await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
            }

            await sendTelegramMessage(
              botToken,
              chatId,
              '🛑 <b>Emergency Stop Dispatched</b>\nA termination signal has been queued to stop the local runner process tree.',
              'HTML',
              false,
              null,
              threadId
            );
            return new Response('OK', { status: 200 });
          }

          // Command: /revert (Emergency rollback dirty files)
          if (cmd === 'revert') {
            const isClean = rest.includes('clean') || rest.includes('all');
            if (env.NOTIFIER_KV) {
              const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
              currentQueue.push({
                id: 'revert-' + Date.now(),
                action: 'REVERT',
                cleanUntracked: isClean,
                messageThreadId: threadId,
                created_at: Date.now()
              });
              await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
            }
            const cleanNotice = isClean ? ' (including untracked files)' : '';
            await sendTelegramMessage(
              botToken,
              chatId,
              `🔄 <b>Emergency Revert Queued</b>\nA command to discard uncommitted working tree modifications${cleanNotice} has been sent to the local runner.`,
              'HTML',
              false,
              null,
              threadId
            );
            return new Response('OK', { status: 200 });
          }

          // Command: /switch or /ws <name>
          if (cmd === 'switch' || (cmd === 'ws' && rest)) {
            if (!rest) {
              await sendTelegramMessage(
                botToken,
                chatId,
                '⚠️ <b>Usage:</b> <code>/switch &lt;workspace_name&gt;</code>\nUse <code>/workspaces</code> to view configured workspaces.',
                'HTML',
                false,
                null,
                threadId
              );
              return new Response('OK', { status: 200 });
            }

            if (env.NOTIFIER_KV) {
              const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
              currentQueue.push({
                id: 'switch-' + Date.now(),
                action: 'SWITCH_WORKSPACE',
                workspace: rest,
                messageThreadId: threadId,
                created_at: Date.now()
              });
              await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
            }

            await sendTelegramMessage(
              botToken,
              chatId,
              `📁 <b>Switch Workspace Queued</b>\nSwitching active workspace to <code>${escapeHtml(rest)}</code>...`,
              'HTML',
              false,
              null,
              threadId
            );
            return new Response('OK', { status: 200 });
          }

          // Command: /status
          if (cmd === 'status') {
            let statusText = '';
            let hb = null;
            if (env.NOTIFIER_KV) {
              hb = await env.NOTIFIER_KV.get('runner_heartbeat', 'json');
            }

            if (hb && hb.timestamp) {
              const lastSeenSeconds = Math.round((Date.now() - new Date(hb.timestamp).getTime()) / 1000);
              const isOnline = lastSeenSeconds < 60;
              if (isOnline) {
                statusText = `⚡ <b>Local Runner:</b> 🟢 ONLINE\n• Host: <code>${escapeHtml(hb.hostname || 'localhost')}</code>\n• PID: <code>${hb.pid}</code>\n• Uptime: <code>${hb.uptime || 0}s</code>\n• Workspace: <b>${escapeHtml(hb.activeWorkspace || 'Default')}</b>\n`;
                if (hb.gitHeader) statusText += `• Git: <code>${escapeHtml(hb.gitHeader)}</code>\n`;
                statusText += `• Last ping: <i>${lastSeenSeconds}s ago</i>`;
              } else {
                statusText = `⚡ <b>Local Runner:</b> 🔴 OFFLINE\n• Last seen: ${lastSeenSeconds}s ago\n• Host: <code>${escapeHtml(hb.hostname || 'Unknown')}</code>`;
              }
            } else {
              statusText = '⚡ <b>Local Runner:</b> 🔴 OFFLINE\n<i>No runner heartbeat received yet. Start runner via:</i>\n<code>npx agent-bell start</code>';
            }

            await sendTelegramMessage(botToken, chatId, statusText, 'HTML', false, null, threadId);
            return new Response('OK', { status: 200 });
          }

          // Command: /workspaces or /ws
          if (cmd === 'workspaces' || cmd === 'ws') {
            let wsText = '📁 <b>Configured Workspaces:</b>\n';
            let hb = null;
            if (env.NOTIFIER_KV) {
              hb = await env.NOTIFIER_KV.get('runner_heartbeat', 'json');
            }

            if (hb && hb.workspaces && hb.workspaces.length > 0) {
              for (const ws of hb.workspaces) {
                const isActive = ws.name === hb.activeWorkspace || ws.path === hb.activeWorkspacePath;
                wsText += `• <b>${escapeHtml(ws.name)}</b>${isActive ? ' <i>(Active)</i>' : ''}\n  <code>${escapeHtml(ws.path)}</code>\n`;
              }
            } else if (hb && hb.activeWorkspace) {
              wsText += `• <b>${escapeHtml(hb.activeWorkspace)}</b> <i>(Active)</i>\n  <code>${escapeHtml(hb.activeWorkspacePath || '')}</code>\n`;
            } else {
              wsText += '<i>No active workspace reported by local runner yet.</i>\n';
            }

            await sendTelegramMessage(botToken, chatId, wsText, 'HTML', false, null, threadId);
            return new Response('OK', { status: 200 });
          }

          // Command: /clear (Deletes notifications only, preserves /start)
          if (cmd === 'clear') {
            await deleteTelegramMessage(botToken, chatId, message.message_id);

            if (env.NOTIFIER_KV) {
              const stored = (await env.NOTIFIER_KV.get('recent_messages', 'json')) || [];
              for (const id of stored) {
                await deleteTelegramMessage(botToken, chatId, id);
              }
              await env.NOTIFIER_KV.put('recent_messages', JSON.stringify([]));
            }

            return new Response('OK', { status: 200 });
          }

          // Command: /quota
          if (cmd === 'quota') {
            let statsText = '';
            if (env.NOTIFIER_KV) {
              const today = new Date().toISOString().slice(0, 10);
              const key = `stats_${today}`;
              const stats = (await env.NOTIFIER_KV.get(key, 'json')) || { tasks: 0, tokens: 0, cacheRead: 0 };

              if (isVi) {
                statsText = `📊 <b>Hoạt động Hôm nay (${today}):</b>\n`;
                statsText += `• Task đã chạy: <b>${stats.tasks}</b>\n`;
                statsText += `• Token tiêu thụ: <b>${formatNumber(stats.tokens)}</b>\n`;
                if (stats.cacheRead > 0) statsText += `• Cache tiết kiệm: <b>${formatNumber(stats.cacheRead)}</b>\n`;
              } else {
                statsText = `📊 <b>Today's Activity (${today}):</b>\n`;
                statsText += `• Tasks Finished: <b>${stats.tasks}</b>\n`;
                statsText += `• Tokens Consumed: <b>${formatNumber(stats.tokens)}</b>\n`;
                if (stats.cacheRead > 0) statsText += `• Cache Saved: <b>${formatNumber(stats.cacheRead)}</b>\n`;
              }
            } else {
              statsText = isVi ? '📊 Chưa có số liệu quota.' : '📊 No quota stats recorded yet.';
            }

            const qMsg = await sendTelegramMessage(botToken, chatId, statsText, 'HTML', false, null, threadId);
            if (env.NOTIFIER_KV && qMsg.result?.message_id) {
              await trackSentMessage(env.NOTIFIER_KV, qMsg.result.message_id);
            }
            return new Response('OK', { status: 200 });
          }

          // Command: /start (Permanent welcome message)
          if (cmd === 'start') {
            await sendTelegramMessage(
              botToken,
              chatId,
              `🔔 <b>agent-bell</b>\n• <code>/menu</code> - ${isVi ? 'Menu điều khiển từ xa' : 'Remote control menu'}\n• <code>/prompt &lt;task&gt;</code> - ${isVi ? 'Giao việc cho AI Agent' : 'Dispatch prompt to AI agent'}\n• <code>/run &lt;cmd&gt;</code> - ${isVi ? 'Chạy lệnh trên máy tính' : 'Execute shell script on host'}\n• <code>/stop</code> - ${isVi ? 'Dừng tiến trình khẩn cấp' : 'Emergency process stop'}\n• <code>/revert [clean]</code> - ${isVi ? 'Khôi phục file làm việc' : 'Discard uncommitted changes'}\n• <code>/status</code> - ${isVi ? 'Trạng thái máy tính' : 'Host & git status'}\n• <code>/workspaces</code> - ${isVi ? 'Danh sách dự án' : 'Configured workspaces'}\n• <code>/quota</code> - ${isVi ? 'Xem thống kê token' : 'View usage stats'}\n• <code>/clear</code> - ${isVi ? 'Dọn sạch thông báo' : 'Clear notification alerts'}`,
              'HTML',
              true,
              null,
              threadId
            );
            return new Response('OK', { status: 200 });
          }
        }

      } catch (err) {
        return new Response('Error: ' + err.message, { status: 500 });
      }
    }

    // Two-Way Discord Interactions (/discord/interactions, /discord)
    if (request.method === 'POST' && (url.pathname === '/discord/interactions' || url.pathname === '/discord')) {
      return await handleDiscordInteractions(request, env);
    }

    // Register Discord Slash Commands (/discord/register-commands)
    if (request.method === 'POST' && url.pathname === '/discord/register-commands') {
      try {
        if (env.AUTH_SECRET) {
          const authHeader = request.headers.get('Authorization') || '';
          const customHeader = request.headers.get('X-Auth-Key') || '';
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : customHeader;
          if (token !== env.AUTH_SECRET) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }
        const body = await request.json().catch(() => ({}));
        const appId = body.applicationId || env.DISCORD_APPLICATION_ID;
        const botToken = body.botToken || env.DISCORD_BOT_TOKEN;
        const guildId = body.guildId || env.DISCORD_GUILD_ID || null;
        const result = await registerDiscordCommands(appId, botToken, guildId);
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 400,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Two-Way Slack Events & Slash Commands (/slack/events, /slack/commands)
    if (request.method === 'POST' && (url.pathname === '/slack/events' || url.pathname === '/slack/commands')) {
      return await handleSlackEvents(request, env);
    }

    // Two-Way Slack Interactive Components (/slack/interactions)
    if (request.method === 'POST' && url.pathname === '/slack/interactions') {
      return await handleSlackInteractions(request, env);
    }

    // Local Runner Heartbeat (/api/runner/heartbeat)
    if (request.method === 'POST' && url.pathname === '/api/runner/heartbeat') {
      try {
        if (env.AUTH_SECRET) {
          const authHeader = request.headers.get('Authorization') || '';
          const customHeader = request.headers.get('X-Auth-Key') || '';
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : customHeader;
          if (token !== env.AUTH_SECRET) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }

        const heartbeat = await request.json();
        if (env.NOTIFIER_KV) {
          await env.NOTIFIER_KV.put('runner_heartbeat', JSON.stringify(heartbeat), { expirationTtl: 300 });
          if (heartbeat.workspaces) {
            await env.NOTIFIER_KV.put('workspaces', JSON.stringify(heartbeat.workspaces), { expirationTtl: 86400 });
          }
        }

        return new Response(JSON.stringify({ success: true, timestamp: Date.now() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Pull Queue over HTTPS (/api/queue/poll)
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/api/queue/poll') {
      try {
        if (env.AUTH_SECRET) {
          const authHeader = request.headers.get('Authorization') || '';
          const customHeader = request.headers.get('X-Auth-Key') || '';
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : customHeader;
          if (token !== env.AUTH_SECRET) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }

        let tasks = [];
        if (env.NOTIFIER_KV) {
          tasks = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
          if (tasks.length > 0) {
            await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify([]));
          }
        }

        return new Response(JSON.stringify({ tasks }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Push Queue Command (/api/queue/push)
    if (request.method === 'POST' && url.pathname === '/api/queue/push') {
      try {
        if (env.AUTH_SECRET) {
          const authHeader = request.headers.get('Authorization') || '';
          const customHeader = request.headers.get('X-Auth-Key') || '';
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : customHeader;
          if (token !== env.AUTH_SECRET) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }

        const body = await request.json();
        const task = {
          id: body.id || 'task-' + Date.now(),
          action: body.action || 'RUN_COMMAND',
          command: body.command || '',
          params: body.params || {},
          created_at: Date.now()
        };

        if (env.NOTIFIER_KV) {
          const currentQueue = (await env.NOTIFIER_KV.get('queue_tasks', 'json')) || [];
          currentQueue.push(task);
          await env.NOTIFIER_KV.put('queue_tasks', JSON.stringify(currentQueue), { expirationTtl: 86400 });
        }

        return new Response(JSON.stringify({ success: true, task }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Ask / Approval Status Polling (/api/ask/poll, /api/approval/status)
    if ((request.method === 'GET' || request.method === 'POST') &&
        (url.pathname === '/api/ask/poll' || url.pathname === '/api/approval/status')) {
      try {
        if (env.AUTH_SECRET) {
          const authHeader = request.headers.get('Authorization') || '';
          const customHeader = request.headers.get('X-Auth-Key') || '';
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : customHeader;
          if (token !== env.AUTH_SECRET) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }

        let taskId = url.searchParams.get('taskId');
        if (!taskId && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          taskId = body.taskId;
        }

        if (!taskId) {
          return new Response(JSON.stringify({ error: 'Missing taskId' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        let answer = null;
        if (env.NOTIFIER_KV) {
          answer = (await env.NOTIFIER_KV.get(`approval_${taskId}`)) ||
                   (await env.NOTIFIER_KV.get(`answer_${taskId}`));
        }

        if (answer) {
          return new Response(JSON.stringify({
            answered: true,
            status: 'answered',
            answer,
            choice: answer,
            taskId
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        return new Response(JSON.stringify({
          answered: false,
          status: 'pending',
          taskId
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Inbound Notification (/notify)
    if (request.method === 'POST' && (url.pathname === '/notify' || url.pathname === '/')) {
      try {
        if (env.AUTH_SECRET) {
          const authHeader = request.headers.get('Authorization') || '';
          const customHeader = request.headers.get('X-Auth-Key') || '';
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : customHeader;

          if (token !== env.AUTH_SECRET) {
            return new Response(
              JSON.stringify({ error: 'Unauthorized: Invalid auth token' }),
              { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
          }
        }

        const body = await request.json();

        // Defense-in-depth: Mask sensitive API keys, passwords, and private keys
        if (body.summary) body.summary = scrubSecrets(body.summary);
        if (body.prompt) body.prompt = scrubSecrets(body.prompt);
        if (body.output) body.output = scrubSecrets(body.output);
        if (body.gitSummary) body.gitSummary = scrubSecrets(body.gitSummary);
        if (body.gitHeader) body.gitHeader = scrubSecrets(body.gitHeader);

        // Server-side Deduplication via KV
        if (env.NOTIFIER_KV && (body.conversationId || body.prompt)) {
          const dedupId = body.conversationId || 'default';
          const tokSign = body.tokenStats?.turnTotal || body.durationSeconds || (body.prompt ? body.prompt.slice(0, 20) : 'msg');
          const dedupKey = `dedup_${dedupId}_${tokSign}`;
          const alreadyProcessed = await env.NOTIFIER_KV.get(dedupKey);
          if (alreadyProcessed) {
            return new Response(
              JSON.stringify({ success: true, deduplicated: true }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          await env.NOTIFIER_KV.put(dedupKey, '1', { expirationTtl: 60 });
        }

        const lang = body.language || env.DEFAULT_LANGUAGE || 'vi';

        // Summarize with AI (OpenAI-compatible / Groq / DeepSeek / Ollama) or fallback
        let shortSummary = body.summary || '';
        if (body.summary && (env.AI_API_KEY || env.GROQ_API_KEYS)) {
          shortSummary = await summarizeWithAI(body.summary, body.prompt, env, lang);
        } else {
          shortSummary = truncate(body.summary, 120);
        }

        // Multi-Channel Dispatch (Telegram, Discord, Slack)
        const deliveries = [];
        let tgMessageId = null;

        // 1. Telegram
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          const formattedText = buildMinimalTelegramMessage(body, shortSummary, lang);
          const disableNotification = Boolean(body.isSilent && !body.isQuotaLimit);
          const threadId = body.messageThreadId || body.threadId || env.TELEGRAM_THREAD_ID || null;
          const replyMarkup = buildTelegramReplyMarkup(body);
          deliveries.push(
            sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, formattedText, 'HTML', disableNotification, replyMarkup, threadId)
              .then(res => { tgMessageId = res.result?.message_id; })
              .catch(() => {})
          );
        }

        // 2. Discord (Bot REST API with auto-created channel/category or Webhook)
        const canDispatchDiscord = Boolean(env.DISCORD_WEBHOOK_URL || (env.DISCORD_BOT_TOKEN && (body.discordChannelId || env.DISCORD_CHANNEL_ID || env.DISCORD_GUILD_ID)));
        if (canDispatchDiscord) {
          deliveries.push(sendDiscordNotification(env, body, shortSummary));
        }

        // 3. Slack (Bot Web API with threaded isolation or Webhook)
        const canDispatchSlack = Boolean(env.SLACK_WEBHOOK_URL || (env.SLACK_BOT_TOKEN && (body.slackChannelId || env.SLACK_CHANNEL_ID)));
        if (canDispatchSlack) {
          deliveries.push(sendSlackNotification(env, body, shortSummary));
        }

        await Promise.allSettled(deliveries);

        // Record message ID & stats in KV
        if (env.NOTIFIER_KV) {
          if (tgMessageId) await trackSentMessage(env.NOTIFIER_KV, tgMessageId);
          await trackDailyStats(env.NOTIFIER_KV, body.tokenStats);
        }

        return new Response(
          JSON.stringify({
            success: true,
            telegramMessageId: tgMessageId,
            channels: {
              telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
              discord: canDispatchDiscord,
              slack: canDispatchSlack
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err.message || 'Internal Server Error' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

export {
  verifyDiscordSignature,
  formatDiscordAnsiDiff,
  buildDiscordEmbed,
  buildDiscordComponents,
  ensureDiscordCategoryAndChannel,
  handleDiscordInteractions,
  sendDiscordNotification,
  registerDiscordCommands,
  verifySlackSignature,
  buildSlackBlocks,
  handleSlackEvents,
  handleSlackInteractions,
  sendSlackNotification,
  timingSafeEqual,
  buildTelegramReplyMarkup,
  safeTelegramCallbackData
};

