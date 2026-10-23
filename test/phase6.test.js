import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

test('Phase 6: FIGMA_SPEC.md contains required specifications and all 3 valid SVG blocks', () => {
  const figmaPath = path.join(ROOT_DIR, 'FIGMA_SPEC.md');
  assert.ok(fs.existsSync(figmaPath), 'FIGMA_SPEC.md must exist in root directory');

  const content = fs.readFileSync(figmaPath, 'utf8');
  assert.match(content, /1280 x 640 px/, 'Must specify OpenGraph frame dimensions 1280x640');
  assert.match(content, /1200 x 400 px/, 'Must specify README hero banner dimensions 1200x400');
  assert.match(content, /800 x 320 px/, 'Must specify Ponytail Scoreboard dimensions 800x320');
  assert.match(content, /#0a0d12/, 'Must specify OLED dark background token #0a0d12');
  assert.match(content, /#10b981/, 'Must specify neon emerald accent token #10b981');
  assert.match(content, /#06b6d4/, 'Must specify neon cyan accent token #06b6d4');

  // Must match at least 3 distinct complete standalone SVG code blocks
  const svgMatches = content.match(/<svg[\s\S]+?<\/svg>/g);
  assert.ok(svgMatches && svgMatches.length >= 3, `Must include 3 standalone SVG blocks. Found: ${svgMatches ? svgMatches.length : 0}`);
});

test('Phase 6: Standalone SVG asset files exist in docs/assets and are referenced in README.md', () => {
  const assetsDir = path.join(ROOT_DIR, 'docs', 'assets');
  assert.ok(fs.existsSync(assetsDir), 'docs/assets directory must exist');

  const requiredAssets = ['opengraph.svg', 'hero-banner.svg', 'scoreboard.svg'];
  for (const asset of requiredAssets) {
    const assetPath = path.join(assetsDir, asset);
    assert.ok(fs.existsSync(assetPath), `Asset file ${asset} must exist in docs/assets`);
    const content = fs.readFileSync(assetPath, 'utf8').trim();
    assert.ok(content.startsWith('<svg'), `${asset} must start with <svg`);
    assert.ok(content.endsWith('</svg>'), `${asset} must end with </svg>`);
  }

  const readmeContent = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
  assert.match(readmeContent, /docs\/assets\/hero-banner\.svg/, 'README.md must embed hero-banner.svg');
  assert.match(readmeContent, /docs\/assets\/scoreboard\.svg/, 'README.md must embed scoreboard.svg');
});

test('Phase 6: PRIVACY.md documents zero-telemetry, secret scrubbing, and TTL guarantees', () => {
  const privacyPath = path.join(ROOT_DIR, 'PRIVACY.md');
  assert.ok(fs.existsSync(privacyPath), 'PRIVACY.md must exist in root directory');

  const content = fs.readFileSync(privacyPath, 'utf8');
  assert.match(content, /Zero Tracking or Telemetry/i, 'Must declare zero telemetry');
  assert.match(content, /24-hour Time-to-Live|24h TTL/i, 'Must specify 24h transient KV queue TTL');
  assert.match(content, /Secret Scrubbing|Regex Secret Scrubber/i, 'Must document secret scrubbing');
  assert.match(content, /\.env/i, 'Must document exclusion of sensitive .env files');
  assert.match(content, /GDPR/i, 'Must document GDPR compliance');
});

test('Phase 6: CHANGELOG.md documents version 2.0.0 and all completed roadmap phases', () => {
  const changelogPath = path.join(ROOT_DIR, 'CHANGELOG.md');
  assert.ok(fs.existsSync(changelogPath), 'CHANGELOG.md must exist in root directory');

  const content = fs.readFileSync(changelogPath, 'utf8');
  assert.match(content, /## \[2\.0\.0\]/, 'Must document version [2.0.0]');
  assert.match(content, /Phase 1:/i, 'Must document Phase 1');
  assert.match(content, /Phase 2:/i, 'Must document Phase 2');
  assert.match(content, /Phase 3:/i, 'Must document Phase 3');
  assert.match(content, /Phase 4:/i, 'Must document Phase 4');
  assert.match(content, /Phase 5:/i, 'Must document Phase 5');
  assert.match(content, /Phase 6:/i, 'Must document Phase 6');
});

test('Phase 6: GitHub Actions CI and Release workflows are defined and valid', () => {
  const ciPath = path.join(ROOT_DIR, '.github', 'workflows', 'ci.yml');
  const releasePath = path.join(ROOT_DIR, '.github', 'workflows', 'release.yml');

  assert.ok(fs.existsSync(ciPath), '.github/workflows/ci.yml must exist');
  assert.ok(fs.existsSync(releasePath), '.github/workflows/release.yml must exist');

  const ciContent = fs.readFileSync(ciPath, 'utf8');
  assert.match(ciContent, /matrix:/, 'CI workflow must use matrix execution');
  assert.match(ciContent, /windows-latest/, 'CI matrix must include windows-latest');
  assert.match(ciContent, /ubuntu-latest/, 'CI matrix must include ubuntu-latest');
  assert.match(ciContent, /macos-latest/, 'CI matrix must include macos-latest');
  assert.match(ciContent, /npm test/, 'CI must execute npm test');

  const releaseContent = fs.readFileSync(releasePath, 'utf8');
  assert.match(releaseContent, /tags:\s+-\s+'v\*'/, 'Release workflow must trigger on v* tags');
  assert.match(releaseContent, /action-gh-release/, 'Release workflow must create GitHub Release');
  // Must set NODE_AUTH_TOKEN at job level so step if condition functions correctly
  assert.match(releaseContent, /env:\s+NODE_AUTH_TOKEN:\s+\${{\s*secrets\.NPM_TOKEN\s*}}/, 'Release workflow must set NODE_AUTH_TOKEN in job env');
});

test('Phase 6: package.json strictly enforces ZERO runtime dependencies, files whitelist, engines, and safe main export', () => {
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  const deps = Object.keys(pkg.dependencies || {});
  assert.equal(deps.length, 0, `Runtime dependencies MUST be zero. Found: ${deps.join(', ')}`);

  assert.equal(pkg.name, 'agent-bell', 'Package name must be agent-bell');
  assert.ok(pkg.bin && pkg.bin['agent-bell'], 'package.json must declare bin.agent-bell');

  const binPath = path.resolve(ROOT_DIR, pkg.bin['agent-bell']);
  assert.ok(fs.existsSync(binPath), `Declared bin file does not exist: ${binPath}`);

  assert.equal(pkg.main, './clients/node/notifier.js', 'package.json main must point to clients/node/notifier.js');
  assert.ok(pkg.engines && pkg.engines.node, 'package.json must declare engines.node');
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('bin'), 'package.json must specify files whitelist');

  for (const [exportKey, exportPath] of Object.entries(pkg.exports || {})) {
    const resolvedPath = path.resolve(ROOT_DIR, exportPath);
    assert.ok(fs.existsSync(resolvedPath), `Declared export "${exportKey}" points to missing file: ${resolvedPath}`);
  }
});

test('Phase 6: CLI binary handles --version, -v, and version flags correctly', () => {
  const cliPath = path.join(ROOT_DIR, 'bin', 'agent-bell.js');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const expectedVersionOutput = `agent-bell v${pkg.version}`;

  for (const flag of ['--version', '-v', 'version']) {
    const proc = spawnSync(process.execPath, [cliPath, flag], {
      encoding: 'utf8'
    });
    assert.equal(proc.status, 0, `CLI "${flag}" should exit with status 0`);
    assert.ok(
      proc.stdout.trim().includes(expectedVersionOutput),
      `CLI "${flag}" output "${proc.stdout}" should include "${expectedVersionOutput}"`
    );
  }
});

test('Phase 6: CLI binary handles --help and unknown command gracefully', () => {
  const cliPath = path.join(ROOT_DIR, 'bin', 'agent-bell.js');

  const helpProc = spawnSync(process.execPath, [cliPath, '--help'], {
    encoding: 'utf8'
  });
  assert.equal(helpProc.status, 0, 'CLI --help should exit with status 0');
  assert.match(helpProc.stdout, /agent-bell - Universal Notification & Remote Control/);

  const unknownProc = spawnSync(process.execPath, [cliPath, 'nonexistent-command-xyz'], {
    encoding: 'utf8'
  });
  assert.equal(unknownProc.status, 1, 'Unknown command should exit with status 1');
  assert.match(unknownProc.stderr, /Unknown command: "nonexistent-command-xyz"/);
});

test('Phase 6: Extended secret scrubber sanitizes complex database URIs, Redis URI, JWTs, AWS keys, and prefixed vars', async () => {
  const { scrubSecrets } = await import('../lib/git.js');

  const rawText = `
Connecting to postgresql://admin_user:SuperSecretPassword123!@db.internal.net:5432/production_db
Connecting to redis://:mypassword123@localhost:6379/0
Exporting AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
Standalone JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
GitHub PAT: ${['ghp', '111122223333444455556666777788889999'].join('_')}
Fine-grained PAT: ${['github', 'pat', '11AAAAAAA_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'].join('_')}
OpenAI Key: ${['sk', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')}
db_password = mysecretpassword123
signing_secret = mysecretpassword123
access_token = mysecretpassword123
refresh_token = mysecretpassword123
JSON: {"client_secret": "mySecretClientPassword123", "db_password": "mySecretDbPassword456"}
  `;

  const scrubbed = scrubSecrets(rawText);

  assert.ok(!scrubbed.includes('SuperSecretPassword123!'), 'Database password must be scrubbed');
  assert.ok(!scrubbed.includes('mypassword123'), 'Redis password without username must be scrubbed');
  assert.ok(scrubbed.includes('redis://:***@localhost:6379/0'), 'Redis URI should format with masked password');
  assert.ok(!scrubbed.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'JWT token must be scrubbed');
  assert.ok(!scrubbed.includes(['ghp', '111122223333444455556666777788889999'].join('_')), 'GitHub PAT must be scrubbed');
  assert.ok(!scrubbed.includes(['github', 'pat', '11AAAAAAA_'].join('_')), 'Fine-grained PAT must be scrubbed');
  assert.ok(!scrubbed.includes(['sk', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')), 'OpenAI key must be scrubbed');
  assert.ok(!scrubbed.includes('mysecretpassword123'), 'Prefixed secret variables must be scrubbed');
  assert.ok(!scrubbed.includes('mySecretClientPassword123'), 'JSON client_secret must be scrubbed');
  assert.ok(!scrubbed.includes('mySecretDbPassword456'), 'JSON db_password must be scrubbed');
});

