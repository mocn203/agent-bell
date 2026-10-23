#!/usr/bin/env node

/**
 * agent-bell MCP Server (Model Context Protocol)
 * Enables Cursor, Claude Desktop, Antigravity, and Zed to invoke push alerts and remote mobile decisions.
 * Standard: JSON-RPC 2.0 over Stdio (Zero Dependencies).
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { notify } from '../clients/node/notifier.js';

export const MCP_TOOLS = [
  {
    name: 'agent_bell_notify',
    description: 'Send an instant push alert to developer via Telegram, Discord, or Slack when an agent finishes or needs review.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Short title or description of the task completed.'
        },
        message: {
          type: 'string',
          description: 'Alias for task or notification message.'
        },
        summary: {
          type: 'string',
          description: 'Brief outcome or key result of the task.'
        },
        workspace: {
          type: 'string',
          description: 'Name of the current workspace or project.'
        },
        priority: {
          type: 'string',
          description: 'Notification priority (normal, high, urgent).'
        },
        sound: {
          type: 'string',
          description: 'Sound alert preference.'
        }
      },
      required: ['task', 'summary']
    }
  },
  {
    name: 'ask_user_remote',
    description: 'Pause execution and ask the developer a question with interactive choice buttons pushed to mobile (Telegram, Discord, Slack). Resumes when tapped.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question or decision to present to developer on mobile.'
        },
        choices: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of button choices for the developer (e.g. ["Approve", "Deny"] or ["Option A", "Option B"]). Defaults to ["Approve", "Deny"].'
        },
        timeout_seconds: {
          type: 'number',
          description: 'Timeout in seconds before giving up (default: 300).'
        },
        workspace: {
          type: 'string',
          description: 'Name of the workspace or project.'
        }
      },
      required: ['question']
    }
  },
  {
    name: 'get_device_status',
    description: 'Inspect host runner connectivity, process ID, active workspace, and git diff/status.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'agent_bell_status',
    description: 'Check agent-bell configuration and connectivity status.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

/**
 * Ask user a question remotely via mobile push notification and poll for button choice.
 */
export async function askUserRemote({
  question,
  choices = ['Approve', 'Deny'],
  timeout_seconds = 300,
  timeoutSeconds = 300,
  workspace = 'MCP Project',
  url = null,
  secret = null,
  pollIntervalMs = 500
} = {}) {
  const validChoices = Array.isArray(choices) && choices.length > 0 ? choices : ['Approve', 'Deny'];
  const timeoutSec = timeout_seconds || timeoutSeconds || 300;
  let targetUrl = url || process.env.AGENT_BELL_WORKER_URL || process.env.ANTIGRAVITY_TELEGRAM_WORKER_URL || process.env.ANTIGRAVITY_TELEGRAM_URL;
  let targetSecret = secret || process.env.AGENT_BELL_AUTH_SECRET || process.env.ANTIGRAVITY_TELEGRAM_AUTH_SECRET || process.env.ANTIGRAVITY_TELEGRAM_SECRET;

  if (!targetUrl) {
    try {
      const { loadRunnerConfig } = await import('../bin/runner.js');
      const cfg = loadRunnerConfig();
      if (cfg.workerUrl) targetUrl = cfg.workerUrl;
      if (!targetSecret && cfg.authSecret) targetSecret = cfg.authSecret;
    } catch (_) {}
  }

  if (!targetUrl) {
    return { success: false, error: 'No Cloudflare Worker URL configured' };
  }

  const taskId = 'ask-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

  // 1. Send push notification with inline choice buttons
  const notifyRes = await notify({
    task: question,
    prompt: question,
    summary: `Waiting for remote response: [${validChoices.join(' | ')}]`,
    workspace,
    isApprovalRequired: true,
    choices: validChoices,
    taskId,
    url: targetUrl,
    secret: targetSecret
  });

  if (notifyRes && notifyRes.error) {
    return { success: false, error: notifyRes.error, taskId };
  }

  // 2. Poll Cloudflare Worker KV for user's tapped button choice
  const startTime = Date.now();
  const base = targetUrl.replace(/\/notify\/?$/, '').replace(/\/+$/, '');
  const pollUrl = `${base}/api/ask/poll?taskId=${encodeURIComponent(taskId)}`;

  const headers = {};
  if (targetSecret) headers['Authorization'] = `Bearer ${targetSecret}`;

  while (Date.now() - startTime < timeoutSec * 1000) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    try {
      const res = await fetch(pollUrl, { headers });
      if (res.status === 401 || res.status === 403) {
        return {
          success: false,
          error: `Worker authentication failed (${res.status}): check AUTH_SECRET`,
          taskId
        };
      }
      if (res.status === 404) {
        return {
          success: false,
          error: `Worker poll endpoint not found (404): check Worker URL`,
          taskId
        };
      }

      if (res.ok) {
        const data = await res.json();
        if (data && data.answered) {
          const answer = data.answer || data.choice;
          const durationSeconds = Math.round((Date.now() - startTime) / 1000);
          return {
            success: true,
            taskId,
            answer,
            choice: answer,
            durationSeconds
          };
        }
      }
    } catch (_) {}
  }

  return {
    success: false,
    timeout: true,
    error: `User did not respond within ${timeoutSec}s timeout.`,
    taskId
  };
}

/**
 * Get device status and runner connectivity
 */
export async function getDeviceStatus() {
  const { PID_FILE, CONFIG_FILE, LOG_FILE, isProcessAlive, loadRunnerConfig } = await import('../bin/runner.js');
  const { inspectWorkspace } = await import('../lib/git.js');

  const config = loadRunnerConfig();
  let isRunning = false;
  let pid = null;

  if (fs.existsSync(PID_FILE)) {
    try {
      const storedPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (storedPid && isProcessAlive(storedPid)) {
        isRunning = true;
        pid = storedPid;
      }
    } catch (_) {}
  }

  const activeWs = config.activeWorkspace || process.cwd();
  const gitInfo = inspectWorkspace(activeWs);

  return {
    runnerStatus: isRunning ? 'running' : 'stopped',
    pid,
    activeWorkspace: activeWs,
    workspaces: config.workspaces || [{ name: path.basename(activeWs), path: activeWs }],
    configFile: CONFIG_FILE,
    logFile: LOG_FILE,
    git: {
      isGit: gitInfo.isGit,
      branch: gitInfo.branch,
      header: gitInfo.header,
      summary: gitInfo.summary
    }
  };
}

/**
 * Handle incoming MCP JSON-RPC Request
 */
export async function handleMcpRequest(request) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'agent-bell-mcp',
            version: '2.1.0'
          }
        }
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS }
      };

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      if (toolName === 'agent_bell_notify') {
        const task = toolArgs.task || toolArgs.message;
        const summary = toolArgs.summary || task;
        const workspace = toolArgs.workspace || 'MCP Project';
        const priority = toolArgs.priority || 'normal';
        const sound = toolArgs.sound || undefined;

        let targetUrl = process.env.AGENT_BELL_WORKER_URL || process.env.ANTIGRAVITY_TELEGRAM_WORKER_URL || process.env.ANTIGRAVITY_TELEGRAM_URL;
        let targetSecret = process.env.AGENT_BELL_AUTH_SECRET || process.env.ANTIGRAVITY_TELEGRAM_AUTH_SECRET || process.env.ANTIGRAVITY_TELEGRAM_SECRET;
        if (!targetUrl) {
          try {
            const { loadRunnerConfig } = await import('../bin/runner.js');
            const cfg = loadRunnerConfig();
            if (cfg.workerUrl) targetUrl = cfg.workerUrl;
            if (!targetSecret && cfg.authSecret) targetSecret = cfg.authSecret;
          } catch (_) {}
        }

        try {
          const res = await notify({
            task,
            summary,
            workspace,
            priority,
            sound,
            url: targetUrl || undefined,
            secret: targetSecret || undefined
          });
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: true, result: res })
                }
              ]
            }
          };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: err.message })
                }
              ],
              isError: true
            }
          };
        }
      }

      if (toolName === 'ask_user_remote') {
        const question = toolArgs.question || toolArgs.prompt || toolArgs.task;
        const choices = Array.isArray(toolArgs.choices) && toolArgs.choices.length > 0 ? toolArgs.choices : ['Approve', 'Deny'];
        const timeout_seconds = toolArgs.timeout_seconds || toolArgs.timeoutSeconds || 300;
        const workspace = toolArgs.workspace || 'MCP Project';

        if (!question) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Missing question parameter' }) }],
              isError: true
            }
          };
        }

        try {
          const res = await askUserRemote({ question, choices, timeout_seconds, workspace });
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(res)
                }
              ],
              isError: !res.success
            }
          };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: err.message })
                }
              ],
              isError: true
            }
          };
        }
      }

      if (toolName === 'get_device_status') {
        try {
          const status = await getDeviceStatus();
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(status, null, 2)
                }
              ]
            }
          };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
              isError: true
            }
          };
        }
      }

      if (toolName === 'agent_bell_status') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: 'agent-bell MCP Server running. Ready to broadcast to Telegram, Discord, and Slack.'
              }
            ]
          }
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Tool "${toolName}" not found.` }
      };
    }

    default:
      if (id !== undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method "${method}" not supported.` }
        };
      }
      return null;
  }
}

// Stdio JSON-RPC interface
if (process.stdin.isTTY === false || process.argv[1]?.endsWith('server.js')) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (_) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }

    const response = await handleMcpRequest(request);
    if (response) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  });
}
