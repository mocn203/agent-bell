import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  isGitRepository,
  getGitBranch,
  getGitStatus,
  getGitDiffStat,
  isIgnoredFile,
  scrubSecrets,
  inspectWorkspace,
  revertWorkspace
} from '../lib/git.js';

test('isGitRepository returns true for current project', () => {
  const result = isGitRepository(process.cwd());
  assert.equal(result, true);
});

test('isGitRepository returns false for non-git temporary directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-test-'));
  try {
    const result = isGitRepository(tempDir);
    assert.equal(result, false);
  } finally {
    fs.rmdirSync(tempDir);
  }
});

test('getGitBranch returns current branch details', () => {
  const branchInfo = getGitBranch(process.cwd());
  assert.ok(branchInfo);
  assert.equal(typeof branchInfo.branch, 'string');
  assert.ok(branchInfo.branch.length > 0);
});

test('getGitBranch parses branch with dots, slashes, and detached HEAD properly in isolated repo', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-git-branch-'));
  try {
    execFileSync('git', ['init', '-b', 'release/v1.0.0'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: tempDir, stdio: 'ignore' });

    // 1. Before any commit: should recognize branch release/v1.0.0 without commits
    const b1 = getGitBranch(tempDir);
    assert.equal(b1.branch, 'release/v1.0.0');

    // 2. Commit a file
    fs.writeFileSync(path.join(tempDir, 'init.txt'), 'hello', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'ignore' });

    const b2 = getGitBranch(tempDir);
    assert.equal(b2.branch, 'release/v1.0.0');

    // 3. Detached HEAD
    const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tempDir, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', commitHash], { cwd: tempDir, stdio: 'ignore' });

    const b3 = getGitBranch(tempDir);
    assert.ok(b3.branch.includes('HEAD'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('isIgnoredFile correctly filters sensitive files, SSH keys, credentials, and lockfiles', () => {
  assert.equal(isIgnoredFile('.env'), true);
  assert.equal(isIgnoredFile('.env.production'), true);
  assert.equal(isIgnoredFile('id_rsa.pem'), true);
  assert.equal(isIgnoredFile('cert.key'), true);
  assert.equal(isIgnoredFile('id_rsa'), true);
  assert.equal(isIgnoredFile('id_dsa'), true);
  assert.equal(isIgnoredFile('id_ed25519'), true);
  assert.equal(isIgnoredFile('service-account.json'), true);
  assert.equal(isIgnoredFile('path/to/credentials.json'), true);
  assert.equal(isIgnoredFile('.npmrc'), true);
  assert.equal(isIgnoredFile('.pypirc'), true);
  assert.equal(isIgnoredFile('.netrc'), true);
  assert.equal(isIgnoredFile('package-lock.json'), true);
  assert.equal(isIgnoredFile('yarn.lock'), true);
  assert.equal(isIgnoredFile('pnpm-lock.yaml'), true);

  // Normal code files should NOT be ignored
  assert.equal(isIgnoredFile('index.js'), false);
  assert.equal(isIgnoredFile('src/runner.js'), false);
  assert.equal(isIgnoredFile('README.md'), false);
});

test('scrubSecrets properly masks API keys, Groq, Slack multi-segment, and Gemini tokens', () => {
  const rawText = `
    OpenAI: ${['sk', 'proj', '1234567890abcdefghijklmnop'].join('-')}
    Groq: ${['gsk', '1234567890abcdefghijklmnopqrstuvwxyz123456'].join('_')}
    GitHub: ${['ghp', '1234567890abcdefghijklmnopqrstuvwxyz'].join('_')}
    Slack: ${['xoxb', '1234567890', '1234567890123', 'abcdefghijklmnop'].join('-')}
    Google: ${['AIzaSy', 'D9uABCDEFGHIJKLM1234567890abcdefg'].join('')}
    Telegram: 1234567890:ABCdefGhIjkLmNoPqRsTuVwXyZ12345678
    HuggingFace: ${['hf', '1234567890abcdefghijklmnopqrstuvwxyz'].join('_')}
    Bearer: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test
    Config: apiKey="super_secret_key_123"
    Password: password: 'mySecretPassword999'
    Backtick: token: \`backtick_secret_key_xyz\`
    EnvStyle: PASSWORD=supersecretunquotedpass
    Private:
    -----BEGIN RSA PRIVATE KEY-----
    MIIEowIBAAKCAQEA0...secret...
    -----END RSA PRIVATE KEY-----
  `;

  const scrubbed = scrubSecrets(rawText);

  assert.ok(!scrubbed.includes(['sk', 'proj', '1234567890abcdefghijklmnop'].join('-')));
  assert.ok(scrubbed.includes('sk-***'));

  assert.ok(!scrubbed.includes(['gsk', '1234567890abcdefghijklmnopqrstuvwxyz123456'].join('_')));
  assert.ok(scrubbed.includes('gsk_***'));

  assert.ok(!scrubbed.includes(['ghp', '1234567890abcdefghijklmnopqrstuvwxyz'].join('_')));
  assert.ok(scrubbed.includes('ghp_***'));

  // Ensure full Slack token is masked without leaking second or third segments
  assert.ok(!scrubbed.includes(['1234567890123', 'abcdefghijklmnop'].join('-')));
  assert.ok(scrubbed.includes('xox***'));

  assert.ok(!scrubbed.includes(['AIzaSy', 'D9uABCDEFGHIJKLM1234567890abcdefg'].join('')));
  assert.ok(scrubbed.includes('AIzaSy***'));

  assert.ok(!scrubbed.includes(['hf', '1234567890abcdefghijklmnopqrstuvwxyz'].join('_')));
  assert.ok(scrubbed.includes('hf_***'));

  assert.ok(!scrubbed.includes('1234567890:ABCdefGhIjkLmNoPqRsTuVwXyZ12345678'));
  assert.ok(scrubbed.includes('***:***'));

  assert.ok(!scrubbed.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test'));
  assert.ok(scrubbed.includes('Bearer ***'));

  assert.ok(!scrubbed.includes('super_secret_key_123'));
  assert.ok(!scrubbed.includes('mySecretPassword999'));
  assert.ok(!scrubbed.includes('backtick_secret_key_xyz'));
  assert.ok(!scrubbed.includes('supersecretunquotedpass'));

  assert.ok(!scrubbed.includes('MIIEowIBAAKCAQEA0...secret...'));
  assert.ok(scrubbed.includes('[REDACTED PRIVATE KEY]'));
});

test('inspectWorkspace returns formatted structure', () => {
  const result = inspectWorkspace(process.cwd());
  assert.equal(result.isGit, true);
  assert.ok(result.header);
  assert.ok(result.header.includes(':'));
  assert.ok(Array.isArray(result.statusInfo.files));
});

test('revertWorkspace restores modified files cleanly in isolated git repo', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-revert-test-'));
  try {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: tempDir, stdio: 'ignore' });

    // Initial commit
    const testFile = path.join(tempDir, 'tracked.txt');
    fs.writeFileSync(testFile, 'initial content', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'first'], { cwd: tempDir, stdio: 'ignore' });

    // Modify file
    fs.writeFileSync(testFile, 'modified dirty content', 'utf8');
    assert.equal(fs.readFileSync(testFile, 'utf8'), 'modified dirty content');

    // Run revert
    const res = revertWorkspace(tempDir);
    assert.equal(res.success, true);
    assert.equal(fs.readFileSync(testFile, 'utf8'), 'initial content');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('revertWorkspace returns false on non-git directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-revert-'));
  try {
    const result = revertWorkspace(tempDir);
    assert.equal(result.success, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getGitStatus accurately categorizes untracked, added, modified, and deleted files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-status-test-'));
  try {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: tempDir, stdio: 'ignore' });

    // Commit baseline file
    const file1 = path.join(tempDir, 'file1.txt');
    const file2 = path.join(tempDir, 'file2.txt');
    fs.writeFileSync(file1, 'file1', 'utf8');
    fs.writeFileSync(file2, 'file2', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tempDir, stdio: 'ignore' });

    // 1. Modify file1 (M)
    fs.writeFileSync(file1, 'file1 modified', 'utf8');

    // 2. Delete file2 (D)
    fs.unlinkSync(file2);

    // 3. Stage new file3 (A)
    const file3 = path.join(tempDir, 'file3.txt');
    fs.writeFileSync(file3, 'file3', 'utf8');
    execFileSync('git', ['add', 'file3.txt'], { cwd: tempDir, stdio: 'ignore' });

    // 4. Untracked file4 (?)
    const file4 = path.join(tempDir, 'file4.txt');
    fs.writeFileSync(file4, 'file4 untracked', 'utf8');

    const status = getGitStatus(tempDir);
    assert.equal(status.modifiedCount, 1);
    assert.equal(status.deletedCount, 1);
    assert.equal(status.addedCount, 1);
    assert.equal(status.untrackedCount, 1);
    assert.equal(status.totalCount, 4);

    const untrackedFile = status.files.find(f => f.path === 'file4.txt');
    assert.ok(untrackedFile);
    assert.equal(untrackedFile.isUntracked, true);
    assert.equal(untrackedFile.status, 'A');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('revertWorkspace with cleanUntracked discards staged changes and untracked files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-revert-staged-'));
  try {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: tempDir, stdio: 'ignore' });

    const baseFile = path.join(tempDir, 'tracked.txt');
    fs.writeFileSync(baseFile, 'v1', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'commit1'], { cwd: tempDir, stdio: 'ignore' });

    // Modify baseFile and STAGE it
    fs.writeFileSync(baseFile, 'v2 staged', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: tempDir, stdio: 'ignore' });

    // Create untracked file
    const untrackedFile = path.join(tempDir, 'rogue.js');
    fs.writeFileSync(untrackedFile, 'console.log("bad")', 'utf8');

    // Run revert with cleanUntracked: true
    const res = revertWorkspace(tempDir, { cleanUntracked: true });
    assert.equal(res.success, true);

    // Verify tracked file was restored to v1
    assert.equal(fs.readFileSync(baseFile, 'utf8'), 'v1');
    // Verify untracked file was deleted
    assert.equal(fs.existsSync(untrackedFile), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getGitDiffStat accurately parses shortstat in isolated repository with modifications, insertions, and deletions', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-diffstat-'));
  try {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: tempDir, stdio: 'ignore' });

    const f1 = path.join(tempDir, 'file1.txt');
    fs.writeFileSync(f1, 'line 1\nline 2\nline 3\nline 4\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'commit1'], { cwd: tempDir, stdio: 'ignore' });

    // Modify file: delete 1 line, add 3 lines
    fs.writeFileSync(f1, 'line 1\nnew line A\nnew line B\nnew line C\nline 4\n', 'utf8');

    const stat = getGitDiffStat(tempDir);
    assert.ok(stat);
    assert.equal(stat.filesChanged, 1);
    assert.ok(stat.insertions >= 2);
    assert.ok(stat.formatted.includes('+'));
    assert.ok(stat.formatted.includes('1 file'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getGitDiffStat properly computes staged insertions in an empty repository without commits', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-diffstat-empty-'));
  try {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    const f1 = path.join(tempDir, 'new.txt');
    fs.writeFileSync(f1, 'line 1\nline 2\nline 3\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });

    const stat = getGitDiffStat(tempDir);
    assert.ok(stat);
    assert.equal(stat.filesChanged, 1);
    assert.equal(stat.insertions, 3);
    assert.equal(stat.deletions, 0);
    assert.equal(stat.formatted, '+3/-0 (1 file)');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('inspectWorkspace calculates accurate line insertions for untracked scratch files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-inspect-untracked-'));
  try {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    const scratch = path.join(tempDir, 'scratch.js');
    fs.writeFileSync(scratch, 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf8');

    const info = inspectWorkspace(tempDir);
    assert.equal(info.isGit, true);
    assert.equal(info.statusInfo.untrackedCount, 1);
    assert.ok(info.summary.includes('+3/-0 (1 file)') || info.summary.includes('+4/-0 (1 file)'));
    assert.ok(info.summary.includes('➕ scratch.js'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('revertWorkspace successfully cleans empty repository without commits', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-revert-empty-'));
  try {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    const stagedFile = path.join(tempDir, 'staged.txt');
    const untrackedFile = path.join(tempDir, 'untracked.txt');
    fs.writeFileSync(stagedFile, 'staged content', 'utf8');
    fs.writeFileSync(untrackedFile, 'untracked content', 'utf8');
    execFileSync('git', ['add', 'staged.txt'], { cwd: tempDir, stdio: 'ignore' });

    const res = revertWorkspace(tempDir, { cleanUntracked: true });
    assert.equal(res.success, true);
    assert.equal(fs.existsSync(stagedFile), false);
    assert.equal(fs.existsSync(untrackedFile), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('revertWorkspace cleanly aborts in-progress merge conflict and restores working tree', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-merge-abort-'));
  try {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: tempDir, stdio: 'ignore' });

    const baseFile = path.join(tempDir, 'conflict.txt');
    fs.writeFileSync(baseFile, 'base line\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: tempDir, stdio: 'ignore' });

    execFileSync('git', ['branch', 'feature'], { cwd: tempDir, stdio: 'ignore' });
    fs.writeFileSync(baseFile, 'master branch line\n', 'utf8');
    execFileSync('git', ['commit', '-am', 'master update'], { cwd: tempDir, stdio: 'ignore' });

    execFileSync('git', ['checkout', 'feature'], { cwd: tempDir, stdio: 'ignore' });
    fs.writeFileSync(baseFile, 'feature branch line\n', 'utf8');
    execFileSync('git', ['commit', '-am', 'feature update'], { cwd: tempDir, stdio: 'ignore' });

    // Trigger merge conflict
    try {
      execFileSync('git', ['merge', 'master'], { cwd: tempDir, stdio: 'ignore' });
    } catch (_) {}

    const res = revertWorkspace(tempDir);
    assert.equal(res.success, true);

    // Verify git status is clean and not in merging state
    const status = execFileSync('git', ['status'], { cwd: tempDir, encoding: 'utf8' });
    assert.ok(!status.includes('still merging'));
    assert.ok(status.includes('nothing to commit, working tree clean'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('scrubSecrets masks JSON quoted keys, GitHub fine-grained PATs, and database URIs', () => {
  const payload = `
    jsonConfig: {"apiKey": "super_secret_api_key_123", "token": "sensitive_session_token_xyz"}
    githubPat: ${['github', 'pat', '11AAAAAA0123456789abcdefghijklmnopqrstuvwxyz_secure'].join('_')}
    dbUri: postgres://postgres:SecretPassword999@db.prod.internal:5432/core
    envVar: TOKEN=unquoted_secret_token_12345
  `;

  const scrubbed = scrubSecrets(payload);

  assert.ok(!scrubbed.includes('super_secret_api_key_123'));
  assert.ok(!scrubbed.includes('sensitive_session_token_xyz'));
  assert.ok(scrubbed.includes('"apiKey": "***"'));
  assert.ok(scrubbed.includes('"token": "***"'));

  assert.ok(!scrubbed.includes(['github', 'pat', '11AAAAAA0123456789abcdefghijklmnopqrstuvwxyz_secure'].join('_')));
  assert.ok(scrubbed.includes('ghp_***'));

  assert.ok(!scrubbed.includes('SecretPassword999'));
  assert.ok(scrubbed.includes('postgres://postgres:***@db.prod.internal:5432/core'));

  assert.ok(!scrubbed.includes('unquoted_secret_token_12345'));
  assert.ok(scrubbed.includes('TOKEN=***'));
});

test('getGitStatus correctly preserves Unicode filenames without octal escaping', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-unicode-status-'));
  try {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    const uniFile = path.join(tempDir, 'tài-liệu-hướng-dẫn.txt');
    fs.writeFileSync(uniFile, 'unicode content', 'utf8');

    const status = getGitStatus(tempDir);
    assert.equal(status.files.length, 1);
    assert.equal(status.files[0].path, 'tài-liệu-hướng-dẫn.txt');
    assert.ok(!status.files[0].path.includes('\\303'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getGitBranch parses gone tracking status properly', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bell-gone-branch-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: tempDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(tempDir, 'f.txt'), 'init', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'ignore' });

    // Set tracking branch config to a non-existent remote branch
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fake/repo.git'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'branch.main.remote', 'origin'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'branch.main.merge', 'refs/heads/deleted-branch'], { cwd: tempDir, stdio: 'ignore' });

    const b = getGitBranch(tempDir);
    assert.ok(b);
    assert.equal(b.branch, 'main');
    assert.equal(b.trackingDesc, 'gone');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('isIgnoredFile filters .git-credentials and kubeconfig', () => {
  assert.equal(isIgnoredFile('.git-credentials'), true);
  assert.equal(isIgnoredFile('path/to/.git-credentials'), true);
  assert.equal(isIgnoredFile('kubeconfig'), true);
  assert.equal(isIgnoredFile('.kube/config'), true);
});

