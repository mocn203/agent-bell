/**
 * agent-bell - Git Diff & Inspection Engine (Zero Dependencies)
 * Provides branch awareness, high-density shortstat diffs, secret scrubbing, and safe rollback.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Sensitive and non-informative files to exclude from notification summaries
const DEFAULT_IGNORED_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|crt|pfx|p12)$/i,
  /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i,
  /\.lfs/i,
  /(^|[/\\])\.gitcrypt/i,
  /(^|[/\\])(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i,
  /(^|[/\\])(credentials|service-account.*)\.json$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /(^|[/\\])(kubeconfig|\.kube[/\\]config)$/i
];

/**
 * Execute a git command synchronously with robust error handling
 */
function runGit(args, cwd = process.cwd()) {
  try {
    const result = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true
    });
    return (result || '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  } catch (err) {
    return null;
  }
}

/**
 * Checks whether the given directory is inside a Git repository
 */
export function isGitRepository(cwd = process.cwd()) {
  const res = runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  return res === 'true';
}

/**
 * Retrieves the current branch, remote tracking, and ahead/behind counts
 */
export function getGitBranch(cwd = process.cwd()) {
  if (!isGitRepository(cwd)) return null;

  const statusSb = runGit(['status', '-sb'], cwd);
  if (!statusSb) return { branch: 'unknown', tracking: null, ahead: 0, behind: 0 };

  const firstLine = statusSb.split('\n')[0].replace(/^##\s*/, '').trim();

  let branch = 'unknown';
  let tracking = null;
  let ahead = 0;
  let behind = 0;
  let stats = '';

  if (firstLine.startsWith('No commits yet on ')) {
    branch = firstLine.replace(/^No commits yet on\s+/, '').trim();
  } else if (firstLine.startsWith('Initial commit on ')) {
    branch = firstLine.replace(/^Initial commit on\s+/, '').trim();
  } else if (firstLine.startsWith('HEAD (')) {
    branch = firstLine;
  } else {
    // Robust pattern for <branch>...<tracking> [<ahead/behind>]
    // Handles branch names with dots, slashes, hyphens (e.g. release/v1.0.0)
    const match = firstLine.match(/^(.*?)(?:\.\.\.([^\s\[]+))?(?:\s*\[(.*?)\])?$/);
    if (match) {
      branch = match[1].trim();
      tracking = match[2] || null;
      stats = match[3] || '';
      const aheadMatch = stats.match(/ahead\s+(\d+)/);
      const behindMatch = stats.match(/behind\s+(\d+)/);
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
      if (behindMatch) behind = parseInt(behindMatch[1], 10);
    } else {
      branch = firstLine;
    }
  }

  let trackingDesc = '';
  if (ahead > 0 && behind > 0) {
    trackingDesc = `ahead ${ahead}, behind ${behind}`;
  } else if (ahead > 0) {
    trackingDesc = `ahead ${ahead}`;
  } else if (behind > 0) {
    trackingDesc = `behind ${behind}`;
  } else if (stats && stats.includes('gone')) {
    trackingDesc = 'gone';
  }

  return {
    branch,
    tracking,
    ahead,
    behind,
    trackingDesc: trackingDesc || null
  };
}

/**
 * Check if a file should be excluded from notification diffs
 */
export function isIgnoredFile(filepath) {
  const filename = path.basename(filepath);
  return DEFAULT_IGNORED_PATTERNS.some(pat => pat.test(filename) || pat.test(filepath));
}

/**
 * Retrieves status of modified, added, deleted, unmerged, and untracked files
 */
export function getGitStatus(cwd = process.cwd()) {
  const emptyResult = {
    files: [],
    totalCount: 0,
    hiddenCount: 0,
    untrackedCount: 0,
    modifiedCount: 0,
    addedCount: 0,
    deletedCount: 0,
    conflictCount: 0,
    renamedCount: 0
  };

  if (!isGitRepository(cwd)) return emptyResult;

  const raw = runGit(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall'], cwd);
  if (!raw) return emptyResult;

  const lines = raw.split('\n').filter(Boolean);
  const files = [];
  let hiddenCount = 0;
  let untrackedCount = 0;
  let modifiedCount = 0;
  let addedCount = 0;
  let deletedCount = 0;
  let conflictCount = 0;
  let renamedCount = 0;

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const match = rawLine.match(/^([ MADRC?U!]{1,2})\s+(.*)$/);
    if (!match) continue;

    const statusCode = match[1].trim();
    let filePath = match[2].trim();

    // Strip outer quotes if git output was quoted
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }

    // If renamed: "old -> new"
    if (filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ')[1];
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }
    }

    if (isIgnoredFile(filePath)) {
      hiddenCount++;
      continue;
    }

    let status = 'M';
    let emoji = '📝';
    const isUntracked = statusCode.includes('?');

    // Conflict / Unmerged files
    if (statusCode.includes('U') || statusCode === 'AA' || statusCode === 'DD') {
      status = 'C';
      emoji = '⚠️';
      conflictCount++;
    } else if (isUntracked) {
      status = 'A';
      emoji = '➕';
      untrackedCount++;
    } else if (statusCode.includes('A')) {
      status = 'A';
      emoji = '➕';
      addedCount++;
    } else if (statusCode.includes('D')) {
      status = 'D';
      emoji = '➖';
      deletedCount++;
    } else if (statusCode.includes('R')) {
      status = 'R';
      emoji = '🔄';
      renamedCount++;
    } else {
      status = 'M';
      emoji = '📝';
      modifiedCount++;
    }

    files.push({
      path: filePath.replace(/\\/g, '/'),
      status,
      statusCode,
      isUntracked,
      emoji
    });
  }

  return {
    files,
    totalCount: files.length + hiddenCount,
    hiddenCount,
    untrackedCount,
    modifiedCount,
    addedCount,
    deletedCount,
    conflictCount,
    renamedCount
  };
}

/**
 * Retrieves diff shortstat (insertions, deletions, files changed)
 */
export function getGitDiffStat(cwd = process.cwd()) {
  if (!isGitRepository(cwd)) return null;

  // Try diff against HEAD first
  let raw = runGit(['diff', '--shortstat', 'HEAD'], cwd);
  // If HEAD not found (e.g. new repo without commits), combine staged and unstaged diffs
  if (raw === null) {
    const cached = runGit(['diff', '--shortstat', '--cached'], cwd) || '';
    const unstaged = runGit(['diff', '--shortstat'], cwd) || '';
    raw = [cached, unstaged].filter(Boolean).join('\n');
  }

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  if (raw) {
    const lines = raw.split('\n');
    for (const line of lines) {
      const filesMatch = line.match(/(\d+)\s+file/);
      const insMatch = line.match(/(\d+)\s+insertion/);
      const delMatch = line.match(/(\d+)\s+deletion/);

      if (filesMatch) filesChanged += parseInt(filesMatch[1], 10);
      if (insMatch) insertions += parseInt(insMatch[1], 10);
      if (delMatch) deletions += parseInt(delMatch[1], 10);
    }
  }

  // Format short string: +45/-12 (3 files)
  const formatted = `+${insertions}/-${deletions} (${filesChanged} ${filesChanged === 1 ? 'file' : 'files'})`;

  return {
    raw: raw || '',
    filesChanged,
    insertions,
    deletions,
    formatted
  };
}

/**
 * Automated Regex Secret Scrubber
 * Masks sensitive tokens, passwords, and private keys before dispatching to webhooks.
 */
export function scrubSecrets(text) {
  if (!text || typeof text !== 'string') return text;

  let cleaned = text;

  // Mask private keys
  cleaned = cleaned.replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');

  // Mask OpenAI / Anthropic / AI API keys (sk-..., sk-ant-..., sk-proj-...)
  cleaned = cleaned.replace(/\bsk-[a-zA-Z0-9_-]{20,}\b/g, 'sk-***');

  // Mask Groq API keys (gsk_...)
  cleaned = cleaned.replace(/\bgsk_[a-zA-Z0-9_-]{20,}\b/g, 'gsk_***');

  // Mask GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_ and fine-grained github_pat_...)
  cleaned = cleaned.replace(/\b(gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{22,})\b/g, 'ghp_***');

  // Mask Slack tokens (xoxb-, xoxp-, etc., including multi-segmented tokens)
  cleaned = cleaned.replace(/\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/g, 'xox***');

  // Mask Telegram bot tokens (123456789:ABCdefGhIjkLmNoPqRsTuVwXyZ...)
  cleaned = cleaned.replace(/\b\d{8,11}:[a-zA-Z0-9_-]{30,50}\b/g, '***:***');

  // Mask AWS access key IDs
  cleaned = cleaned.replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***');

  // Mask Google Gemini / Cloud API keys
  cleaned = cleaned.replace(/\bAIzaSy[0-9a-zA-Z_-]{33}\b/g, 'AIzaSy***');

  // Mask Hugging Face tokens (hf_...)
  cleaned = cleaned.replace(/\bhf_[a-zA-Z0-9]{20,}\b/g, 'hf_***');

  // Mask Bearer tokens
  cleaned = cleaned.replace(/\bBearer\s+[a-zA-Z0-9._\-+/=]{15,}\b/gi, 'Bearer ***');

  // Mask standalone JWT tokens (header.payload.signature)
  cleaned = cleaned.replace(/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, '[REDACTED_JWT]');

  // Mask database and service URIs containing credentials (postgres://user:pass@host or redis://:pass@host)
  cleaned = cleaned.replace(/(\b[a-z0-9+.-]+:\/\/[^:\s\/]*:)([^@\s\/]+)(@)/gi, '$1***$3');

  // Mask config assignments like "apiKey": "...", apiKey: '...', password = `...` (supports JSON quotes around keys)
  cleaned = cleaned.replace(
    /((?:["']?(?:[a-zA-Z0-9_-]*(?:secret|password|passwd|auth_token|token|private_?key|api_?key))["']?\s*[:=]\s*["'`]))([^"'`]{6,})(["'`])/gi,
    '$1***$3'
  );

  // Mask unquoted env style assignments: PASSWORD=supersecret or TOKEN=supersecret or DB_PASSWORD=supersecret
  cleaned = cleaned.replace(
    /(\b[a-zA-Z0-9_-]*(?:secret|password|passwd|auth_token|token|private_?key|api_?key)\s*=\s*)([^\s;&"']{6,})/gi,
    '$1***'
  );

  return cleaned;
}

/**
 * High-Density Signal: Inspect workspace and format Caveman Git Summary
 * Example format:
 *   Work4:main (ahead 1)
 *   • Git: +45/-12 (3 files)
 *     📝 worker/src/index.js
 *     ➕ bin/runner.js
 *     ➖ old-script.tmp
 */
export function inspectWorkspace(cwd = process.cwd(), options = {}) {
  const maxFiles = options.maxFiles || 5;

  if (!isGitRepository(cwd)) {
    return {
      isGit: false,
      summary: null,
      files: [],
      branch: null,
      stats: null
    };
  }

  const branchInfo = getGitBranch(cwd);
  const statusInfo = getGitStatus(cwd);
  const diffStat = getGitDiffStat(cwd);

  const workspaceName = path.basename(cwd) || 'Project';
  const branchName = branchInfo?.branch || 'main';
  const trackingStr = branchInfo?.trackingDesc ? ` (${branchInfo.trackingDesc})` : '';

  const header = `${workspaceName}:${branchName}${trackingStr}`;

  // effectiveFilesChanged should account for all changed files (tracked + untracked)
  const effectiveFilesChanged = Math.max(diffStat?.filesChanged || 0, statusInfo.files.length);

  // If there are untracked files, calculate line counts to accurately reflect added code
  let totalInsertions = diffStat?.insertions || 0;
  if (statusInfo.untrackedCount > 0) {
    for (const f of statusInfo.files) {
      if (f.isUntracked) {
        try {
          const fullPath = path.resolve(cwd, f.path);
          const stat = fs.statSync(fullPath);
          if (stat.isFile() && stat.size < 1024 * 512) {
            const content = fs.readFileSync(fullPath, 'utf8');
            const linesCount = content ? content.split('\n').length : 0;
            totalInsertions += linesCount;
          }
        } catch (_) {}
      }
    }
  }

  const statFormatted = `+${totalInsertions}/-${diffStat?.deletions || 0} (${effectiveFilesChanged} ${effectiveFilesChanged === 1 ? 'file' : 'files'})`;

  const lines = [];
  if (statusInfo.files.length > 0 || effectiveFilesChanged > 0) {
    lines.push(`• Git: ${statFormatted}`);

    const displayFiles = statusInfo.files.slice(0, maxFiles);
    for (const f of displayFiles) {
      lines.push(`  ${f.emoji} ${scrubSecrets(f.path)}`);
    }

    if (statusInfo.files.length > maxFiles) {
      const remaining = statusInfo.files.length - maxFiles;
      lines.push(`  ...and ${remaining} more ${remaining === 1 ? 'file' : 'files'}`);
    }
  }

  const summary = lines.join('\n');

  return {
    isGit: true,
    header,
    branchInfo,
    statusInfo,
    diffStat,
    summary,
    displayLines: lines
  };
}

/**
 * Emergency rollback helper (/revert)
 * Discards unstaged and staged modifications cleanly on the working tree.
 */
export function revertWorkspace(cwd = process.cwd(), options = {}) {
  if (!isGitRepository(cwd)) {
    return { success: false, error: 'Not a Git repository' };
  }

  try {
    const hasHead = runGit(['rev-parse', '--verify', 'HEAD'], cwd) !== null;

    // 0. Abort in-progress merge, rebase, cherry-pick, or revert if any
    runGit(['merge', '--abort'], cwd);
    runGit(['rebase', '--abort'], cwd);
    runGit(['cherry-pick', '--abort'], cwd);
    runGit(['revert', '--abort'], cwd);

    // 1. Unstage any staged changes back to HEAD if repository has commits
    if (options.resetStaged !== false) {
      if (hasHead) {
        runGit(['reset', 'HEAD', '--', '.'], cwd);
      } else {
        runGit(['rm', '--cached', '-r', '.'], cwd);
      }
    }

    // 2. Discard tracked changes on working tree (only applicable if repository has commits)
    if (hasHead) {
      const resCheckout = runGit(['checkout', '--', '.'], cwd);
      if (resCheckout === null) {
        const resRestore = runGit(['restore', '.'], cwd);
        if (resRestore === null) {
          return { success: false, error: 'Failed to restore modified files on working tree.' };
        }
      }
    }

    // 3. Clean untracked files and directories if requested
    if (options.cleanUntracked) {
      runGit(['clean', '-fd'], cwd);
    }

    return { success: true, message: 'Cleanly reverted modified files on working tree.' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
