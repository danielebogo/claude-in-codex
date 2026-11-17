import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureRoute } from '../scripts/configure-route.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { healthProof, readLocalAuth } from '../src/localAuth.js';

async function isolatedInstaller(t, health = 'valid') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-installer-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scripts = path.join(directory, 'scripts');
  const bin = path.join(directory, 'bin');
  const home = path.join(directory, 'test-home');
  fs.mkdirSync(scripts);
  fs.mkdirSync(path.join(directory, 'src'));
  fs.copyFileSync(new URL('../src/localAuth.js', import.meta.url), path.join(directory, 'src/localAuth.js'));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  for (const name of ['install.sh', 'uninstall.sh', 'configure-route.js', 'bridge-endpoint.js']) {
    const source = fs.readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
    fs.writeFileSync(path.join(scripts, name), source.replace(/\$HOME\b/g, '$TEST_INSTALLER_HOME')); // Redirect script paths in the test copy without changing HOME or touching the user's service/config.
  }
  for (const [name, script] of Object.entries({ npm: 'exit 0', claude: 'echo "fake Claude"', launchctl: '[ "$1" != print ]', lsof: 'exit 1', curl: 'exit 0', sleep: 'exit 0' })) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  const config = path.join(home, '.codex/config.toml');
  const healthRequests = [];
  const endpoint = http.createServer((req, res) => {
    healthRequests.push(req.url);
    if (health === 'invalid-json') return res.end('not json');
    if (health === 'impostor') return res.end(JSON.stringify({ ok: true }));
    const auth = readLocalAuth(path.join(home, '.codex-claude-bridge'));
    const challenge = new URL(req.url, 'http://localhost').searchParams.get('challenge');
    res.end(JSON.stringify(healthProof(auth, challenge, endpoint.address().port)));
  });
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(() => { endpoint.closeAllConnections(); endpoint.close(); });
  const port = endpoint.address().port;
  const run = (name, env = {}) => new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(scripts, name)], { env: { ...process.env, CODEX_CLAUDE_BRIDGE_PORT: String(port), TEST_INSTALLER_HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  return { config, run, home, port, healthRequests };
}

test('reinstalling on a different port updates only the managed Codex route', async (t) => {
  const installer = await isolatedInstaller(t);
  fs.writeFileSync(installer.config, 'openai_base_url = "http://127.0.0.1:18787/backend-api/codex" # codex-claude-bridge\nmodel = "gpt-test"\n');
  const result = await installer.run('install.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(installer.home, '.codex-claude-bridge/config.json'))).port, installer.port);
  assert.equal(fs.readFileSync(installer.config, 'utf8'), `openai_base_url = "http://127.0.0.1:${installer.port}/${readLocalAuth(path.join(installer.home, '.codex-claude-bridge')).token}/backend-api/codex" # codex-claude-bridge\nmodel = "gpt-test"\n`);
});

test('uninstall restores the direct route even when the bridge line is the entire config', async (t) => {
  const installer = await isolatedInstaller(t);
  fs.writeFileSync(installer.config, 'openai_base_url = "http://127.0.0.1:18787/backend-api/codex" # codex-claude-bridge\n');
  const result = await installer.run('uninstall.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(installer.config, 'utf8'), '');
});

// Reproduce this M1's selected custom provider without touching its real config.
test('custom ChatGPT provider installs and uninstalls without losing unrelated settings', async (t) => {
  const installer = await isolatedInstaller(t);
  const original = 'model_provider = "openai-custom"\nmodel = "gpt-test"\n[model_providers."openai-custom"]\nname = "OpenAI"\nbase_url = "https://chatgpt.com/backend-api/codex" # owner choice\nwire_api = "responses"\n';
  fs.writeFileSync(installer.config, original);
  assert.equal((await installer.run('install.sh')).status, 0);
  assert.match(fs.readFileSync(installer.config, 'utf8'), /base_url = "http:\/\/127.0.0.1:\d+\/[a-f0-9]{64}\/backend-api\/codex/);
  assert.equal((await installer.run('uninstall.sh')).status, 0);
  assert.equal(fs.readFileSync(installer.config, 'utf8'), original);
});

test('custom non-ChatGPT endpoints are rejected before service installation', async (t) => {
  const installer = await isolatedInstaller(t);
  const original = 'model_provider = "private"\n[model_providers.private]\nbase_url = "https://example.test/private"\n';
  fs.writeFileSync(installer.config, original);
  assert.notEqual((await installer.run('install.sh')).status, 0);
  assert.equal(fs.readFileSync(installer.config, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(installer.home, 'Library/LaunchAgents/com.codex-claude-bridge.plist')), false);
});

test('uninstall restores a managed provider even after selecting another provider', () => {
  const original = 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://chatgpt.com/backend-api/codex"\n';
  const installed = configureRoute(original, 'http://127.0.0.1:18787/backend-api/codex');
  assert.equal(configureRoute(installed.replace('model_provider = "custom"', 'model_provider = "openai"'), '', true), original.replace('model_provider = "custom"', 'model_provider = "openai"'));
});

for (const health of ['impostor', 'invalid-json']) test(`installer refuses ${health} health responses before changing Codex route`, async (t) => {
  const installer = await isolatedInstaller(t, health);
  const original = 'model = "gpt-test"\n';
  fs.writeFileSync(installer.config, original);

  const result = await installer.run('install.sh');

  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(installer.config, 'utf8'), original);
  assert.ok(installer.healthRequests.length > 0);
  const token = readLocalAuth(path.join(installer.home, '.codex-claude-bridge')).token;
  assert.equal(installer.healthRequests.some((url) => url.includes(token)), false);
  assert.match(result.stderr, /identity|proof|start/i);
});
