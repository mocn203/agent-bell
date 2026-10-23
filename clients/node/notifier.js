import path from 'node:path';
import { inspectWorkspace, scrubSecrets } from '../../lib/git.js';

export async function notify({
  task,
  summary,
  workspace = (process.cwd() ? path.basename(process.cwd()) : '') || 'Project',
  user = process.env.USER || process.env.USERNAME,
  durationSeconds = null,
  url = process.env.AGENT_BELL_WORKER_URL || process.env.ANTIGRAVITY_TELEGRAM_WORKER_URL || process.env.ANTIGRAVITY_TELEGRAM_URL,
  secret = process.env.AGENT_BELL_AUTH_SECRET || process.env.ANTIGRAVITY_TELEGRAM_AUTH_SECRET || process.env.ANTIGRAVITY_TELEGRAM_SECRET,
  language = 'en',
  gitHeader = null,
  gitSummary = null,
  messageThreadId = null,
  discordChannelId = null,
  slackChannelId = null,
  slackThreadTs = null,
  conversationId = null,
  taskId = null,
  message = null,
  prompt = null,
  priority = 'normal',
  sound = null,
  isApprovalRequired = false,
  requiresApproval = false,
  choices = null,
  output = null,
  isError = false,
  isSilent = false,
  isQuotaLimit = false
}) {
  if (!url) return { error: 'Missing worker URL' };

  let header = gitHeader;
  let gSummary = gitSummary;
  if (!header && !gSummary) {
    try {
      const gitInfo = inspectWorkspace(process.cwd());
      if (gitInfo && gitInfo.isGit) {
        header = gitInfo.header;
        gSummary = gitInfo.summary;
      }
    } catch (_) {}
  }

  // Pre-scrub secrets before sending over wire
  const effectiveTask = task || message || prompt;
  const scrubbedTask = effectiveTask ? scrubSecrets(effectiveTask) : effectiveTask;
  const scrubbedSummary = summary ? scrubSecrets(summary) : summary;
  const scrubbedOutput = output ? scrubSecrets(output) : output;

  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['Authorization'] = `Bearer ${secret}`;

  const payload = {
    workspace,
    prompt: scrubbedTask,
    summary: scrubbedSummary,
    user,
    durationSeconds,
    language,
    gitHeader: header,
    gitSummary: gSummary,
    messageThreadId,
    discordChannelId,
    slackChannelId,
    slackThreadTs,
    conversationId,
    taskId
  };

  if (isApprovalRequired || requiresApproval) payload.isApprovalRequired = true;
  if (choices) payload.choices = choices;
  if (priority && priority !== 'normal') payload.priority = priority;
  if (sound) payload.sound = sound;
  if (scrubbedOutput) payload.output = scrubbedOutput;
  if (isError) payload.isError = true;
  if (isSilent) payload.isSilent = true;
  if (isQuotaLimit) payload.isQuotaLimit = true;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

