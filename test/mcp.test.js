import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('MCP server responds to initialize and tools/list via JSON-RPC stdio', async () => {
  const serverPath = path.resolve(__dirname, '../mcp/server.js');
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  });

  const responses = [];

  child.stdout.on('data', (chunk) => {
    const lines = chunk.toString('utf8').trim().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        try {
          responses.push(JSON.parse(line));
        } catch (_) {}
      }
    }
  });

  // 1. Send initialize
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { capabilities: {} }
  }) + '\n');

  // 2. Send tools/list
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list'
  }) + '\n');

  for (let i = 0; i < 20 && responses.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();

  const initRes = responses.find((r) => r.id === 1);
  assert.ok(initRes);
  assert.equal(initRes.result.serverInfo.name, 'agent-bell-mcp');

  const toolsRes = responses.find((r) => r.id === 2);
  assert.ok(toolsRes);
  assert.ok(Array.isArray(toolsRes.result.tools));
  assert.ok(toolsRes.result.tools.some((t) => t.name === 'agent_bell_notify'));
});
