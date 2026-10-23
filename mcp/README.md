# 🔌 agent-bell MCP Server Configuration

Connect `agent-bell` to **Cursor**, **Claude Desktop**, or any MCP-compatible client.

## 1. Claude Desktop Configuration
Add to your `claude_desktop_config.json`:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "agent-bell": {
      "command": "node",
      "args": ["/path/to/agent-bell/mcp/server.js"],
      "env": {
        "ANTIGRAVITY_TELEGRAM_URL": "https://your-worker.workers.dev/notify",
        "ANTIGRAVITY_TELEGRAM_SECRET": "your-secret"
      }
    }
  }
}
```

## 2. Cursor Configuration
Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "agent-bell": {
      "command": "npx",
      "args": ["agent-bell", "mcp"],
      "env": {
        "ANTIGRAVITY_TELEGRAM_URL": "https://your-worker.workers.dev/notify"
      }
    }
  }
}
```
