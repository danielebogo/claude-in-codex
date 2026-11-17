import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccb command's test "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scripts = path.join(directory, 'scripts');
  const source = path.join(directory, 'src');
  const bin = path.join(directory, 'bin');
  const bridgeHome = path.join(directory, 'bridge');
  for (const folder of [scripts, source, bin]) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  for (const name of ['codexbridge.js', 'discover-models.js']) fs.copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(scripts, name));
  for (const name of ['modelConfig.js', 'models.json']) fs.copyFileSync(new URL(`../src/${name}`, import.meta.url), path.join(source, name));
  for (const name of ['install.sh', 'uninstall.sh']) fs.writeFileSync(path.join(scripts, name), 'printf "%s\\n" "$0" > "$CLI_SCRIPT_RECORD"\nexit "${CLI_SCRIPT_STATUS:-0}"\n');
  fs.writeFileSync(path.join(bin, 'grok'), `#!${process.execPath}\n${fs.readFileSync(new URL('./fixtures/discovery-cli.js', import.meta.url), 'utf8')}`, { mode: 0o755 });
  const configFile = path.join(bridgeHome, 'config.json');
  const record = path.join(directory, 'scripts.jsonl');
  const env = { ...process.env, CODEX_CLAUDE_BRIDGE_HOME: bridgeHome, CODEX_CLAUDE_BRIDGE_CLAUDE: path.join(directory, 'missing'), CODEX_CLAUDE_BRIDGE_GROK: path.join(bin, 'grok'), CLI_SCRIPT_RECORD: record, DISCOVERY_FIXTURE: '{}' };
  const run = (args, extra = {}, executable = process.execPath) => new Promise((resolve, reject) => {
    const child = spawn(executable, executable === process.execPath ? [path.join(scripts, 'codexbridge.js'), ...args] : args, { env: { ...env, ...extra }, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  const configure = (data) => { fs.mkdirSync(bridgeHome, { recursive: true }); fs.writeFileSync(configFile, JSON.stringify(data)); };
  return { directory, bin, scripts, bridgeHome, configFile, record, run, configure };
}

for (const command of ['install', 'uninstall']) test(`test_command_${command}_delegatesFromAnyDirectoryAndPreservesExitStatus`, async (t) => {
  const f = fixture(t);

  const result = await f.run([command], { CLI_SCRIPT_STATUS: '7' });

  assert.equal(result.status, 7);
  assert.equal(fs.readFileSync(f.record, 'utf8').trim(), fs.realpathSync(path.join(f.scripts, `${command}.sh`)));
});

test('test_command_add_discoversModelsPreservingPortAndPrivateServiceStateWithoutReinstall', async (t) => {
  const f = fixture(t);
  const manual = { slug: 'manual-claude', displayName: 'Manual', claudeModel: 'claude-opus-5-5' };
  f.configure({ port: 18888, models: [manual], extraSystemPrompt: 'keep' });
  const auth = path.join(f.bridgeHome, 'local-auth.json');
  fs.writeFileSync(auth, 'private-service-identity');

  const result = await f.run(['add']);

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(config.port, 18888);
  assert.equal(config.extraSystemPrompt, 'keep');
  assert.deepEqual(config.models.find((model) => model.slug === manual.slug), manual);
  assert.ok(config.models.some((model) => model.provider === 'grok'));
  assert.equal(fs.readFileSync(auth, 'utf8'), 'private-service-identity');
  assert.equal(fs.existsSync(f.record), false);
});

test('test_command_addBeforeInstall_providesInstallInstructionWithoutCreatingConfig', async (t) => {
  const f = fixture(t);

  const result = await f.run(['add']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /codexbridge install/);
  assert.equal(fs.existsSync(f.configFile), false);
});

test('test_command_failedDiscovery_leavesExistingConfigUntouched', async (t) => {
  const f = fixture(t);
  f.configure({ port: 18888, models: [] });
  const original = fs.readFileSync(f.configFile, 'utf8');

  const result = await f.run(['add'], { DISCOVERY_FIXTURE: JSON.stringify({ grok: { loggedIn: false } }) });

  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
  assert.doesNotMatch(result.stderr, /private-token-do-not-print/);
});

test('test_command_setup_registersAnIdempotentLauncherWithQuotedPaths', async (t) => {
  const f = fixture(t);
  const destination = path.join(f.directory, "user's local bin");

  const first = await f.run(['setup', destination]);
  const second = await f.run(['setup', destination]);
  const help = await f.run(['--help'], {}, path.join(destination, 'codexbridge'));

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /codexbridge install/);
  assert.match(help.stdout, /codexbridge add/);
});

for (const symlink of [false, true]) test('test_command_setup_preservesUnrelatedExistingCommands', async (t) => {
  const f = fixture(t);
  const target = path.join(f.directory, 'unrelated');
  const command = path.join(f.bin, 'codexbridge');
  fs.writeFileSync(target, 'unrelated command');
  if (symlink) fs.symlinkSync(target, command);
  else fs.writeFileSync(command, 'unrelated command');

  const result = await f.run(['setup', f.bin]);

  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(command, 'utf8'), 'unrelated command');
  assert.equal(fs.lstatSync(command).isSymbolicLink(), symlink);
});

for (const args of [['unknown'], ['add', 'unexpected']]) test('test_command_invalidArguments_failWithoutRunningInstallers', async (t) => {
  const f = fixture(t);

  const result = await f.run(args);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage|usage|Unknown/);
  assert.equal(fs.existsSync(f.record), false);
});
