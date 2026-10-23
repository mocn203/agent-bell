#!/usr/bin/env node

/**
 * Antigravity Telegram Task Notifier Hook
 * Lifecycle Hook handler for the `Stop` event.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Clean user prompt from <USER_REQUEST> tags
function extractUserPrompt(raw) {
  if (!raw) return '';
  const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (match && match[1]) {
    return match[1].trim();
  }
  return raw.replace(/<[^>]+>/g, '').trim();
}

// Load configuration from user home directory or local plugin folder
function loadConfig() {
  const homeConfigPath = path.join(os.homedir(), '.antigravity-telegram.json');
  if (fs.existsSync(homeConfigPath)) {
    try {
      return JSON.parse(fs.readFileSync(homeConfigPath, 'utf8'));
    } catch (_) {}
  }

  // Fallback to local config.json in the plugin directory
  const localConfigPath = path.resolve(import.meta.dirname || path.dirname(process.argv[1]), '../config.json');
  if (fs.existsSync(localConfigPath)) {
    try {
      return JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
    } catch (_) {}
  }

  // Fallback to environment variables
  if (process.env.ANTIGRAVITY_TELEGRAM_WORKER_URL) {
    return {
      workerUrl: process.env.ANTIGRAVITY_TELEGRAM_WORKER_URL,
      authSecret: process.env.ANTIGRAVITY_TELEGRAM_AUTH_SECRET || '',
      enabled: true
    };
  }

  return null;
}

// Read recent lines from transcript.jsonl
function parseTranscript(transcriptPath) {
  let prompt = '';
  let summary = '';
  let durationSeconds = null;
  let errorDetails = '';
  let hasToolCalls = false;
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let turnCacheReadTokens = 0;
  let sessionTotalTokens = 0;

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return {
      prompt,
      summary,
      durationSeconds,
      errorDetails,
      hasToolCalls,
      tokenStats: { turnInput: 0, turnOutput: 0, turnCacheRead: 0, turnTotal: 0, sessionTotal: 0 }
    };
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');

    let lastUserInputTime = null;
    let lastResponseTime = null;

    // Scan backwards from the end
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const item = JSON.parse(line);

        if (item.tool_calls && item.tool_calls.length > 0) {
          hasToolCalls = true;
        }

        // Check for error status or messages
        if (!errorDetails && (item.status === 'ERROR' || item.error)) {
          errorDetails = String(item.error || item.content || 'Gặp lỗi trong quá trình thực thi step');
        }

        if (!summary && item.type === 'PLANNER_RESPONSE' && item.content) {
          summary = item.content;
          if (item.created_at) {
            lastResponseTime = new Date(item.created_at).getTime();
          }
        }

        if (!prompt && item.type === 'USER_INPUT' && item.content) {
          prompt = extractUserPrompt(item.content);
          if (item.created_at) {
            lastUserInputTime = new Date(item.created_at).getTime();
          }
        }

        // Accumulate token statistics across steps
        if (item.type === 'PLANNER_RESPONSE') {
          const inTok = item.input_tokens || 0;
          const outTok = item.output_tokens || 0;
          const cacheTok = item.cache_read_tokens || 0;
          sessionTotalTokens += (inTok + outTok);

          if (turnInputTokens === 0 && turnOutputTokens === 0) {
            turnInputTokens = inTok;
            turnOutputTokens = outTok;
            turnCacheReadTokens = cacheTok;
          }
        }
      } catch (_) {}
    }

    if (lastUserInputTime && lastResponseTime && lastResponseTime >= lastUserInputTime) {
      durationSeconds = Math.round((lastResponseTime - lastUserInputTime) / 1000);
    }
  } catch (_) {}

  const tokenStats = {
    turnInput: turnInputTokens,
    turnOutput: turnOutputTokens,
    turnCacheRead: turnCacheReadTokens,
    turnTotal: turnInputTokens + turnOutputTokens,
    sessionTotal: sessionTotalTokens
  };

  return { prompt, summary, durationSeconds, errorDetails, hasToolCalls, tokenStats };
}

// Find recently created or modified artifacts in artifactDirectoryPath
function findArtifacts(artifactDir) {
  const artifacts = [];
  if (!artifactDir || !fs.existsSync(artifactDir)) {
    return artifacts;
  }

  try {
    const files = fs.readdirSync(artifactDir);
    for (const file of files) {
      if (file.endsWith('.md') && file !== 'walkthrough.md') {
        artifacts.push(file);
      }
    }
  } catch (_) {}

  return artifacts;
}

async function main() {
  // Read hook input from stdin
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let hookPayload = {};
  try {
    if (rawInput.trim()) {
      hookPayload = JSON.parse(rawInput);
    }
  } catch (_) {}

  const config = loadConfig();
  if (!config || config.enabled === false || (!config.workerUrl && !config.telegramBotToken && !config.discordWebhookUrl)) {
    // Graceful exit, no-op
    process.stdout.write('{}\n');
    return;
  }

  const {
    conversationId = '',
    workspacePaths = [],
    transcriptPath = '',
    artifactDirectoryPath = '',
    modelName = 'Auto',
    terminationReason = 'NO_TOOL_CALL'
  } = hookPayload;

  const workspace = workspacePaths.length > 0 ? path.basename(workspacePaths[0]) : 'Workspace';
  const { prompt, summary, durationSeconds, tokenStats } = parseTranscript(transcriptPath);
  const artifacts = findArtifacts(artifactDirectoryPath);

  // Check quota limit reach
  const isQuotaLimit = terminationReason === 'MAX_TOKEN_BUDGET_EXCEEDED';

  // Sound alert: always notify with sound unless user explicitly enabled config.silent
  const isSilent = Boolean(config.silent && !isQuotaLimit);

  // Check minDurationSeconds filter if configured
  if (config.minDurationSeconds && durationSeconds !== null && durationSeconds < config.minDurationSeconds && !isQuotaLimit) {
    process.stdout.write('{}\n');
    return;
  }

  const payload = {
    workspace,
    prompt: prompt || (config.language === 'vi' ? 'Task hoàn thành' : 'Task completed'),
    summary: summary || (config.language === 'vi' ? 'Đã hoàn tất câu trả lời.' : 'Response completed.'),
    status: terminationReason || 'FINISHED',
    model: modelName,
    artifacts,
    durationSeconds,
    conversationId,
    isQuotaLimit,
    isSilent,
    tokenStats,
    language: config.language || 'en'
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    // Mode 1: Cloudflare Edge Mode (Relay Worker)
    if (config.workerUrl) {
      const headers = { 'Content-Type': 'application/json' };
      if (config.authSecret) headers['Authorization'] = `Bearer ${config.authSecret}`;
      await fetch(config.workerUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    }
    // Mode 2: Direct Mode (Zero-Backend direct delivery to Telegram / Discord)
    else {
      const directCalls = [];
      if (config.telegramBotToken && config.telegramChatId) {
        const text = `🚀 <b>${payload.workspace}</b> (${payload.durationSeconds || 0}s)\n• <b>Task:</b> ${payload.prompt}\n• <b>Done:</b> ${payload.summary}`;
        directCalls.push(fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: config.telegramChatId, text, parse_mode: 'HTML' }),
          signal: controller.signal
        }));
      }
      if (config.discordWebhookUrl) {
        directCalls.push(fetch(config.discordWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `🚀 **${payload.workspace}** (${payload.durationSeconds || 0}s)\n• **Task:** ${payload.prompt}\n• **Done:** ${payload.summary}` }),
          signal: controller.signal
        }));
      }
      await Promise.allSettled(directCalls);
    }

    clearTimeout(timeoutId);
  } catch (err) {
    // Write error to local log file for debugging, never crash Antigravity
    try {
      const logPath = path.join(os.homedir(), '.antigravity-telegram.log');
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] Error: ${err.message}\n`);
    } catch (_) {}
  }

  // Antigravity Hook contract requires outputting a JSON object on stdout
  process.stdout.write('{}\n');
}

main().catch(() => {
  process.stdout.write('{}\n');
});
