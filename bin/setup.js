#!/usr/bin/env node

/**
 * agent-bell Interactive Setup Wizard (Zero Dependencies)
 * Guides developer through Cloudflare Worker connection, multi-channel preferences,
 * workspace detection, Antigravity plugin installation, and MCP configuration.
 * Standard: Node.js >= 20 (Zero Dependencies).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BELL_HOME, CONFIG_FILE, loadRunnerConfig } from './runner.js';
import { notify } from '../clients/node/notifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function ask(rl, question, defaultValue = '') {
  if (!rl) return Promise.resolve(defaultValue);
  return new Promise((resolve) => {
    const promptText = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(promptText, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

export function getAntigravityPluginDir(homeDir = null) {
  const home = homeDir || process.env.AGENT_BELL_HOME || os.homedir();
  return path.join(home, '.gemini', 'config', 'plugins', 'antigravity-telegram-notifier');
}

export function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export async function runSetup(options = {}) {
  const isNonInteractive = Boolean(
    options.nonInteractive ||
    options.yes ||
    process.argv.includes('--yes') ||
    process.argv.includes('-y') ||
    !process.stdin.isTTY
  );

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔔 agent-bell — Interactive Setup Wizard');
  console.log('Zero-cost push notification & remote control for AI coding agents.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let rl = null;
  if (!isNonInteractive) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  try {
    const targetHome = options.homeDir || process.env.AGENT_BELL_HOME || os.homedir();
    const bellHome = path.join(targetHome, '.agent-bell');
    const configFile = options.configPath || path.join(bellHome, 'config.json');
    const altConfigPath = path.join(targetHome, '.antigravity-telegram.json');

    let existing = {};
    if (fs.existsSync(configFile)) {
      try {
        existing = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      } catch (_) {}
    } else {
      existing = loadRunnerConfig();
    }

    console.log('📌 STEP 1: CLOUDFLARE WORKER CONFIGURATION');
    console.log('Enter your Cloudflare Worker URL (e.g. https://agent-bell.your-subdomain.workers.dev)');

    const defaultUrl = options.workerUrl || existing.workerUrl || 'https://agent-bell.workers.dev';
    const workerUrl = await ask(rl, '🔗 Worker URL', defaultUrl);

    const defaultSecret = options.authSecret !== undefined ? options.authSecret : (existing.authSecret || '');
    const authSecret = await ask(rl, '🔑 Auth Secret (optional, press Enter if not used)', defaultSecret);

    console.log('\n📌 STEP 2: WORKSPACE & LANGUAGE');
    const defaultLang = options.language || existing.language || 'en';
    const langInput = await ask(rl, '🌐 Notification Language (en = English, vi = Tiếng Việt)', defaultLang);
    const language = langInput.toLowerCase() === 'vi' ? 'vi' : 'en';

    const defaultMinDuration = String(options.minDurationSeconds ?? existing.minDurationSeconds ?? 0);
    const minDurInput = await ask(rl, '⏱ Minimum execution time to trigger alert (seconds, 0 = all tasks)', defaultMinDuration);
    const minDurationSeconds = parseInt(minDurInput, 10) || 0;

    const currentWsPath = process.cwd();
    const currentWsName = path.basename(currentWsPath) || 'Work4';
    const detectedWorkspaces = existing.workspaces && Array.isArray(existing.workspaces) && existing.workspaces.length > 0
      ? [...existing.workspaces]
      : [];
    if (!detectedWorkspaces.some((w) => w.path === currentWsPath)) {
      detectedWorkspaces.push({ name: currentWsName, path: currentWsPath });
    }

    const newConfig = {
      workerUrl,
      authSecret,
      language,
      minDurationSeconds,
      pollIntervalMs: existing.pollIntervalMs || 3000,
      heartbeatIntervalMs: existing.heartbeatIntervalMs || 15000,
      activeWorkspace: currentWsPath,
      workspaces: detectedWorkspaces,
      updatedAt: new Date().toISOString()
    };

    // Save to ~/.agent-bell/config.json (or isolated bellHome)
    if (!fs.existsSync(bellHome)) {
      try { fs.mkdirSync(bellHome, { recursive: true }); } catch (_) {}
    }
    fs.writeFileSync(configFile, JSON.stringify(newConfig, null, 2), 'utf8');
    console.log(`\n✅ Saved primary configuration to: ${configFile}`);

    // Sync to ~/.antigravity-telegram.json for legacy backwards compatibility
    try {
      fs.writeFileSync(altConfigPath, JSON.stringify({
        workerUrl,
        authSecret,
        enabled: true,
        language,
        minDurationSeconds,
        updatedAt: newConfig.updatedAt
      }, null, 2), 'utf8');
      console.log(`✅ Synced legacy config to: ${altConfigPath}`);
    } catch (_) {}

    // Step 3: Install Plugin to ~/.gemini/config/plugins/ if source exists
    console.log('\n📌 STEP 3: ANTIGRAVITY PLUGIN INTEGRATION');
    const sourcePluginDir = path.resolve(__dirname, '../plugin');
    if (options.installPlugin !== false && fs.existsSync(sourcePluginDir)) {
      const targetPluginDir = options.pluginDir || getAntigravityPluginDir(targetHome);
      try {
        copyDirRecursive(sourcePluginDir, targetPluginDir);
        console.log(`📂 Plugin installed to: ${targetPluginDir}`);
      } catch (err) {
        console.warn(`⚠️ Could not auto-install plugin: ${err.message}`);
      }
    } else {
      console.log('ℹ️ Plugin installation skipped or source directory not found.');
    }

    // Step 4: Model Context Protocol (MCP) Configuration
    console.log('\n📌 STEP 4: MODEL CONTEXT PROTOCOL (MCP)');
    console.log('To integrate with Claude Desktop, Cursor, or Antigravity, add to your MCP config:');
    console.log(JSON.stringify({
      mcpServers: {
        'agent-bell': {
          command: 'npx',
          args: ['-y', 'agent-bell', 'mcp']
        }
      }
    }, null, 2));

    // Step 5: Test Ping
    console.log('\n📌 STEP 5: CONNECTION TEST');
    const shouldTest = options.testPing !== undefined
      ? options.testPing
      : (await ask(rl, 'Send a test ping across configured channels now? (y/n)', 'y')).toLowerCase().startsWith('y');

    if (shouldTest) {
      console.log('📡 Sending test ping to Cloudflare Worker...');
      try {
        const testRes = await notify({
          task: 'agent-bell setup check',
          summary: language === 'vi'
            ? 'agent-bell đã được cấu hình thành công trên máy của bạn!'
            : 'agent-bell has been configured successfully on your system!',
          workspace: currentWsName,
          url: workerUrl,
          secret: authSecret,
          language
        });

        if (testRes && (testRes.success || !testRes.error)) {
          console.log('🎉 SUCCESS! Test notification dispatched to your channels!');
        } else {
          console.warn(`⚠️ Worker response: ${testRes?.error || 'Unknown status'}`);
        }
      } catch (err) {
        console.warn(`⚠️ Test ping error: ${err.message}`);
      }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✨ SETUP COMPLETED!');
    console.log('Next steps:');
    console.log('• Start silent background runner: npx agent-bell start');
    console.log('• Wrap any build or script:       npx agent-bell wrap "npm test"');
    console.log('• Check status:                   npx agent-bell status');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return { success: true, config: newConfig };
  } finally {
    if (rl) rl.close();
  }
}

// Standalone execution
if (process.argv[1]?.endsWith('setup.js')) {
  runSetup().catch((err) => {
    console.error('Fatal error during setup:', err);
    process.exit(1);
  });
}
