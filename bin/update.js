#!/usr/bin/env node

/**
 * agent-bell Self-Updater (`npx agent-bell update`)
 * Checks latest release from npm registry, updates package globally, and restarts background runner cleanly.
 * Standard: Node.js >= 20 (Zero Dependencies).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Compare two semver strings (v1 > v2: 1, v1 < v2: -1, v1 == v2: 0)
 */
export function compareSemver(v1, v2) {
  const p1 = (v1 || '0.0.0').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const p2 = (v2 || '0.0.0').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < 3; i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

export async function fetchLatestVersion(timeoutMs = 5000) {
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch('https://registry.npmjs.org/agent-bell/latest', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.version) return data.version;
    }
  } catch (_) {
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Fallback to npm view if network fetch fails
  try {
    const out = execSync('npm view agent-bell version', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs
    });
    return out.trim();
  } catch (_) {
    return null;
  }
}

export async function runUpdate(argv = []) {
  const isCheckOnly = argv.includes('--check') || argv.includes('-c') || argv.includes('--dry-run');

  const pkgPath = path.resolve(__dirname, '../package.json');
  let currentVersion = '2.0.0';
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.version) currentVersion = pkg.version;
    } catch (_) {}
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🔔 agent-bell Self-Updater (Current: v${currentVersion})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('🔍 Checking latest release from npm registry...');
  const latestVersion = await fetchLatestVersion(6000);

  if (!latestVersion) {
    console.log('⚠️  Unable to reach npm registry. Please check your internet connection.');
    return { success: false, reason: 'offline', currentVersion };
  }

  console.log(`• Installed version: v${currentVersion}`);
  console.log(`• Latest version:    v${latestVersion}\n`);

  const cmp = compareSemver(latestVersion, currentVersion);

  if (cmp <= 0) {
    console.log('✅ agent-bell is already up to date!');
    return { success: true, updated: false, currentVersion, latestVersion };
  }

  console.log(`🚀 Newer version available: v${currentVersion} -> v${latestVersion}`);

  if (isCheckOnly) {
    console.log('ℹ️  Check mode: update skipped. Run "npx agent-bell update" to install.');
    return { success: true, updated: false, updateAvailable: true, currentVersion, latestVersion };
  }

  console.log('\n📦 Installing update via "npm install -g agent-bell@latest"...');
  try {
    execSync('npm install -g agent-bell@latest', { stdio: 'inherit' });
    console.log(`\n🎉 agent-bell updated successfully to v${latestVersion}!`);

    // Restart active background runner if alive
    const { PID_FILE, isProcessAlive } = await import('./runner.js');
    if (fs.existsSync(PID_FILE)) {
      try {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (pid && isProcessAlive(pid)) {
          console.log('\n🔄 Restarting active background runner with updated release...');
          const cliPath = path.resolve(__dirname, 'agent-bell.js');
          execSync(`"${process.execPath}" "${cliPath}" restart`, { stdio: 'inherit' });
        }
      } catch (_) {}
    }

    return { success: true, updated: true, currentVersion, latestVersion };
  } catch (err) {
    console.error(`\n❌ Failed to install update: ${err.message}`);
    console.log('👉 Try manual installation: npm install -g agent-bell@latest');
    return { success: false, error: err.message, currentVersion, latestVersion };
  }
}

// Standalone execution
if (process.argv[1]?.endsWith('update.js')) {
  runUpdate(process.argv.slice(2)).then((res) => {
    process.exitCode = res.success ? 0 : 1;
  });
}
