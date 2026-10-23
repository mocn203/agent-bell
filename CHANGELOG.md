# 📝 CHANGELOG — AGENT-BELL

All notable changes to `agent-bell` are documented in this file.  
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] - 2026-10-24

### 🚀 Major Highlights
`agent-bell` v2.0.0 is a complete architectural leap: transforming from a simple push notifier into a **universal, zero-cost, multi-channel notification and two-way remote control companion for autonomous AI coding agents**.

### 🌟 Added

#### Phase 1: Local Runner & Silent Background Core
- **Invisible Background Daemon (`bin/runner.js`)**: Runs silently with 0 terminal windows on Windows (via `silent-runner.vbs`) and detached unreferenced child process on macOS/Linux. Uses `< 20MB` of RAM.
- **Process Management**: Single-instance lock mechanism (`runner.pid`), process tree termination (`taskkill /pid <PID> /T /F` on Windows, `kill -9 -<PID>` on Unix), and native file watcher (`fs.watch`) hot-reloading on config changes.
- **CLI Commands in `bin/agent-bell.js`**: Added `start`, `stop`, `restart`, `status`, `logs [--tail]`, and `autostart [enable|disable]`.
- **System Startup Registration**: Windows Task Scheduler integration (`schtasks`) to boot silently on user login without elevated UAC prompts.

#### Phase 2: Cloudflare Edge Router & 2-Way Webhooks
- **Global Edge Routing (`worker/src/index.js`)**: Sub-15ms pull queue and webhook endpoints (`/notify`, `/webhook`, `/api/queue/push`, `/api/queue/poll`, `/api/runner/heartbeat`, `/health`).
- **Telegram Inline Callback Query Handler**: Added support for remote approval buttons (`appr:*`, `deny:*`), workspace switching (`ws:*`), and emergency stop (`stop:*`).
- **Transient KV Queue**: Sub-second push/poll queue with automated 24-hour TTL and instant post-consumption deletion.
- **Runner Heartbeat & Offline Warning**: Tracks runner connectivity status and warns developers if the host PC runner is unreachable.

#### Phase 3: Git Diff Engine & Safety Gates
- **Native Git Engine (`lib/git.js`)**: Real-time git status inspection (`git diff --shortstat HEAD`), modified (`M`), added (`A`), and deleted (`D`) file parsing, and untracked scratch file counting.
- **Multi-Layer Regex Secret Scrubber**: Masks API tokens (`sk-***`, `ghp_***`, `github_pat_***`), Bearer auth headers, SSH/RSA private keys, database URIs, and JSON-quoted secrets before dispatch.
- **Sensitive File Exclusion**: Explicitly ignores `.env*`, `*.pem`, `*.key`, `*.lfs`, credentials, and lockfiles.
- **Emergency Revert (`/revert` & `/revert clean`)**: Allows developers to instantly roll back corrupted or conflicting agent changes from Telegram, Discord, or Slack.

#### Phase 4: Multi-Channel Discord & Slack Adapters
- **Discord Integration (`worker/src/discord.js`)**:
  - Zero-dependency Ed25519 signature verification using native Web Crypto API.
  - Dynamic category & channel auto-creation per workspace under `AGENT-BELL` category.
  - High-signal Rich Embeds with ANSI terminal colored diff syntax (`\u001b[32m+ added\u001b[0m`, `\u001b[31m- deleted\u001b[0m`).
  - Interactive approval action row buttons with length-safe `custom_id` <= 100 chars.
  - Discord Slash Commands (`/prompt`, `/run`, `/stop`, `/revert`, `/status`, `/workspaces`).
- **Slack Integration (`worker/src/slack.js`)**:
  - HMAC-SHA256 signature verification with 300-second replay attack protection.
  - Threaded execution isolation (`slack_thread_${conversationId}` in KV) keeping channels clean.
  - Block Kit interactive buttons with value truncation safety <= 2000 chars.
  - Slack Events API and Slash Commands support.

#### Phase 5: CLI Wizard, MCP Server & Self-Updater
- **Interactive Setup Wizard (`bin/setup.js`)**: Interactive `readline` configuration wizard with automated non-interactive mode (`--yes`), Cloudflare test ping verification, and dual config syncing (`~/.agent-bell/config.json` and legacy `~/.antigravity-telegram.json`).
- **Command Wrapper (`bin/wrap.js`)**: `npx agent-bell wrap "<command>"` runs any build or test command, streams live console output, captures exit codes, inspects diffs, and dispatches mobile push alerts.
- **Zero-Dependency Self-Updater (`bin/update.js`)**: Checks npm registry for latest versions, performs SemVer comparison, and seamlessly reboots the background runner.
- **Model Context Protocol (MCP) Server (`mcp/server.js`)**:
  - `ask_user_remote`: Pauses agent execution, pushes question with interactive buttons to mobile, polls KV at 500ms intervals, and resumes agent with user's tapped choice.
  - `get_device_status`: Inspects host runner connectivity and active workspace state.
  - `agent_bell_notify`: Allows agents to send ad-hoc prioritized push notifications.

#### Phase 6: Automated Test Suite, Figma Spec & v2.0.0 Release
- **Comprehensive Test Suite**: Added 100+ native `node --test` assertions across all subsystems (`test/*.test.js`).
- **Figma Design Specification (`FIGMA_SPEC.md`)**: Full design tokens, typography, layer hierarchies, and production-ready SVG graphics for OpenGraph social cards (`1280x640`) and README hero banner (`1200x400`).
- **Privacy & Security Policy (`PRIVACY.md`)**: Complete privacy declaration detailing zero-telemetry, client-side secret scrubbing, and user-owned Cloudflare infrastructure.
- **CI/CD Automation (`.github/workflows/`)**: GitHub Actions workflows for multi-OS CI testing (Ubuntu, Windows, macOS) and automated tag-based releases.

---

## [1.0.0] - 2026-09-15
### Added
- Initial production release of `antigravity-telegram-notifier`.
- Native Antigravity lifecycle hook integration on `Stop` event.
- Cloudflare Worker edge relay.
- Groq LPU AI summarization integration (~0.3s latency).
- Two-way Telegram bot commands (`/clear`, `/quota`).
- Dual-language support (`en` and `vi`).
- Token usage and prompt cache telemetry tracking.

---

## [0.4.0] - 2026-08-20
### Added
- Internationalization support for Vietnamese and English.
- Safe Telegram message deletion logic preserving welcome screens.

---

## [0.3.0] - 2026-07-10
### Added
- Groq AI integration for ultra-fast task summarization.
- KV storage for quota and message ID tracking.

---

## [0.2.0] - 2026-06-01
### Added
- Interactive setup script.
- Telegram Bot API integration.

---

## [0.1.0] - 2026-05-15
### Added
- Initial proof-of-concept lifecycle hook notifier.
