import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleEvent } from '../src/claudeRunner.js';

// Failure modes: unavailable cached login; malformed/oversized ACP; failed load or
// compact; unapproved native actions; stale loaded messages; cancellation; orphans.
const adapter = fileURLToPath(new URL('../src/grokBridgeCli.js', import.meta.url));
const fakeGrok = fileURLToPath(new URL('./fixtures/fake-grok.js', import.meta.url));
const envelope = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } });
const commonArgs = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'grok-4.7', '--include-partial-messages', '--permission-prompts', 'none'];

function launch(t, { scenario = 'success', args = [], input = envelope, inputChunks, environment = {} } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-grok-cli-'));
  const record = path.join(cwd, 'record.jsonl');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const argv = [adapter, ...commonArgs, ...args];
  const chunkHarness = `
    process.argv = ${JSON.stringify([process.execPath, ...argv])};
    const iterate = process.stdin[Symbol.asyncIterator].bind(process.stdin);
    process.stdin[Symbol.asyncIterator] = async function* () {
      try {
        for await (const chunk of iterate()) {
          yield chunk;
          process.send('next');
        }
      } finally { process.disconnect(); }
    };
    await import(${JSON.stringify(new URL('../src/grokBridgeCli.js', import.meta.url).href)});
    process.send('ready');
  `;
  const child = spawn(process.execPath, inputChunks ? ['--input-type=module', '-e', chunkHarness] : argv, { cwd, env: {
    ...process.env, CODEX_BRIDGE_GROK_PATH: fakeGrok, GROK_FIXTURE_MODE: scenario, GROK_FIXTURE_RECORD: record,
    XAI_API_KEY: 'must-not-be-used', ...environment,
  }, stdio: inputChunks ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'] });
  if (inputChunks) {
    let next = 0;
    child.on('message', () => {
      if (next < inputChunks.length) child.stdin.write(inputChunks[next++]);
      else child.stdin.end();
    });
  } else child.stdin.end(input);
  let output = '';
  let stderr = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({
    code, signal, stderr, events: output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    record: fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [],
  })));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  return { child, done, record, cwd };
}

for (const compact of [false, true]) test(`Grok ${compact ? 'compaction input' : 'prompt envelope'} preserves UTF-8 split across stdin chunks`, async (t) => {
  // Arrange
  const text = 'ciao 🦊, già 中文';
  const input = Buffer.from(compact ? `/compact Preserve this tool result: ${text}` : JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }));
  const cuts = ['🦊', 'à', '中'].map((character) => input.indexOf(Buffer.from(character)) + 1);
  const boundaries = [0, ...cuts, input.length];
  const inputChunks = boundaries.slice(1).map((end, index) => input.subarray(boundaries[index], end));

  // Act
  const result = await launch(t, { inputChunks, ...(compact ? { args: ['--resume', 'grok-session', '--output-format', 'json'] } : {}) }).done;

  // Assert
  assert.equal(result.code, 0, result.stderr);
  const prompt = result.record.find((entry) => entry.method === 'session/prompt').params.prompt;
  assert.equal(prompt.at(-1).text, compact ? input.toString('utf8') : text);
});

test('Grok ACP turn authenticates cached login, scopes MCP and streams each text once', async (t) => {
  const mcp = { mcpServers: { codex: { command: '/usr/bin/node', args: ['/proxy.js'], env: { SOCKET: '/private/socket' }, timeout: 86400000 } } };
  const { done, cwd } = launch(t, { args: ['--permission-mode', 'acceptEdits', '--effort', 'xhigh', '--mcp-config', JSON.stringify(mcp), '--allowedTools', 'mcp__codex', '--disallowedTools', 'AskUserQuestion', '--append-system-prompt', 'Bridge instructions'] });
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.record[0], { argv: ['agent', '--no-leader', '-m', 'grok-4.7', '--reasoning-effort', 'xhigh', 'stdio'], sandbox: 'workspace', updater: '1', hasApiKey: false });
  assert.deepEqual(result.record.find((entry) => entry.method === 'initialize').params.clientCapabilities, {});
  assert.deepEqual(result.record.find((entry) => entry.method === 'authenticate').params, { methodId: 'cached_token', _meta: { headless: true } });
  assert.deepEqual(result.record.find((entry) => entry.method === 'session/new').params, { cwd: fs.realpathSync(cwd), mcpServers: [{ name: 'codex', command: '/usr/bin/node', args: ['/proxy.js'], env: [{ name: 'SOCKET', value: '/private/socket' }] }] });
  const prompt = result.record.find((entry) => entry.method === 'session/prompt').params.prompt;
  assert.match(prompt[0].text, /Bridge instructions/);
  assert.equal(prompt.at(-1).text, 'Hello');
  const shown = [];
  const ctx = { tools: new Map(), streamedMessageIds: new Set(), cwd };
  const stream = { textDelta: (text) => shown.push(text), reasoningDelta() {}, closeOpen() {}, hasOpenMessage: () => false };
  for (const event of result.events) handleEvent(event, ctx, stream);
  assert.equal(shown.join(''), 'Hello world.');
  assert.equal(ctx.tools.get('mcp-1').name, 'mcp__codex__exec');
  assert.equal(result.events.filter((event) => event.type === 'assistant' && event.message.content.some((block) => block.type === 'tool_use')).length, 1);
  assert.equal(result.events.at(-1).session_id, 'grok-session');
  assert.equal(result.events.at(-1).usage, undefined);
});

test('Grok resume waits for session/load and discards replayed old messages', async (t) => {
  const { done } = launch(t, { scenario: 'load-replay', args: ['--resume', 'grok-session'] });
  const result = await done;
  assert.equal(result.code, 0);
  assert.equal(result.record.some((entry) => entry.method === 'session/new'), false);
  assert.equal(result.record.find((entry) => entry.method === 'session/load').params.sessionId, 'grok-session');
  assert.equal(JSON.stringify(result.events).includes('OLD TEXT'), false);
});

test('Grok unwraps deferred Codex MCP tool names after their arguments arrive', async (t) => {
  const result = await launch(t, { scenario: 'mcp-wrapper' }).done;
  const calls = result.events.filter((event) => event.type === 'assistant').flatMap((event) => event.message.content).filter((block) => block.type === 'tool_use');
  assert.deepEqual(calls, [{ type: 'tool_use', id: 'mcp-1', name: 'mcp__codex__exec', input: { code: 'return 1' } }]);
});

test('Grok preserves hyphenated Codex tools and delegates approval in read-only mode', async (t) => {
  const result = await launch(t, { scenario: 'hyphenated-codex', args: ['--permission-mode', 'dontAsk'] }).done;
  const calls = result.events.filter((event) => event.type === 'assistant').flatMap((event) => event.message.content).filter((block) => block.type === 'tool_use');
  assert.deepEqual(calls, [{ type: 'tool_use', id: 'hyphenated', name: 'mcp__codex__foo-bar', input: {} }]);
  assert.equal(result.record.find((entry) => entry.id === 'permission-0').result.outcome.optionId, 'once');
  assert.equal(result.record[0].sandbox, 'read-only');
});

for (const [mode, expected, sandbox] of [
  ['default', ['once', 'deny', 'deny', 'once', 'deny'], 'read-only'],
  ['acceptEdits', ['once', 'once', 'deny', 'once', 'deny'], 'workspace'],
  ['plan', ['once', 'deny', 'deny', 'once', 'deny'], 'read-only'],
  ['bypassPermissions', ['once', 'once', 'once', 'once', 'once'], 'off'],
]) {
  test(`Grok ${mode} permissions deny actions outside explicit policy`, async (t) => {
    const result = await launch(t, { scenario: 'permissions', args: ['--permission-mode', mode] }).done;
    assert.equal(result.code, 0);
    assert.deepEqual(result.record.filter((entry) => String(entry.id).startsWith('permission-')).map((entry) => entry.result.outcome.optionId), expected);
    assert.equal(result.record[0].sandbox, sandbox);
  });
}

for (const scenario of ['missing-auth', 'auth-error', 'malformed', 'oversized', 'early-exit', 'session-error', 'prompt-error', 'cancelled']) {
  test(`Grok fails promptly and explicitly on ${scenario}`, async (t) => {
    const started = Date.now();
    const result = await launch(t, { scenario }).done;
    assert.notEqual(result.code, 0);
    assert.equal(result.events.at(-1).is_error, true);
    assert.ok(Date.now() - started < 8000);
    assert.equal(JSON.stringify(result.events).includes('secret authentication metadata'), false);
    if (['missing-auth', 'auth-error'].includes(scenario)) assert.equal(result.record.some((entry) => entry.method === 'session/new'), false);
  });
}

test('Grok emits only usage reported by ACP', async (t) => {
  const result = await launch(t, { scenario: 'usage' }).done;
  assert.deepEqual(result.events.at(-1).usage, { input_tokens: 100, output_tokens: 9, cache_read_input_tokens: 20 });
});

test('Grok preserves observed total tokens without inventing an input/output split', async (t) => {
  const result = await launch(t, { scenario: 'usage-meta' }).done;
  assert.deepEqual(result.events.at(-1).usage, { total_tokens: 123 });
  assert.equal(JSON.stringify(result.events).includes('not forwarded'), false);
});

test('Grok compact sends native /compact through the loaded session and returns one JSON result', async (t) => {
  const result = await launch(t, { args: ['--resume', 'grok-session', '--output-format', 'json', '/compact'], input: '' }).done;
  assert.equal(result.code, 0);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].session_id, 'grok-session');
  assert.deepEqual(result.record.find((entry) => entry.method === 'session/prompt').params.prompt, [{ type: 'text', text: '/compact' }]);
});

test('Grok compact cannot report success for a native command error', async (t) => {
  const result = await launch(t, { scenario: 'compact-error', args: ['--resume', 'grok-session', '--output-format', 'json', '/compact'], input: '' }).done;
  assert.notEqual(result.code, 0);
  assert.equal(result.events[0].is_error, true);
  assert.match(result.events[0].result, /Unsupported slash command/);
});

test('Grok compact refuses a native version that does not advertise the command', async (t) => {
  const result = await launch(t, { scenario: 'no-compact', args: ['--resume', 'grok-session', '--output-format', 'json', '/compact'], input: '' }).done;
  assert.notEqual(result.code, 0);
  assert.match(result.events[0].result, /did not advertise/);
  assert.equal(result.record.some((entry) => entry.method === 'session/prompt'), false);
});

test('Grok image input converts inline image blocks but rejects remote image links', async (t) => {
  const input = (source) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', source }] } });
  const inline = await launch(t, { input: input({ type: 'base64', media_type: 'image/png', data: 'YWJj' }) }).done;
  assert.deepEqual(inline.record.find((entry) => entry.method === 'session/prompt').params.prompt, [{ type: 'image', mimeType: 'image/png', data: 'YWJj' }]);
  const remote = await launch(t, { input: input({ type: 'url', url: 'https://example.com/image.png' }) }).done;
  assert.notEqual(remote.code, 0);
  assert.match(remote.events.at(-1).result, /URL image/);
  assert.equal(remote.record.some((entry) => entry.method === 'session/prompt'), false);
});

test('Grok rejects unsupported fork and malformed input before starting native agent', async (t) => {
  for (const options of [{ args: ['--fork-session'] }, { input: '{bad}' }, { input: `${envelope}\n${envelope}` }]) {
    const result = await launch(t, options).done;
    assert.notEqual(result.code, 0);
    assert.equal(result.events.at(-1).is_error, true);
    assert.equal(result.record.length, 0);
  }
});

test('Grok rejects malformed session MCP configuration before starting native agent', async (t) => {
  for (const mcp of ['{bad}', '{"mcpServers":[]}', '{"mcpServers":{"codex":{"command":"node","env":{"TOKEN":123}}}}']) {
    const result = await launch(t, { args: ['--mcp-config', mcp] }).done;
    assert.notEqual(result.code, 0);
    assert.equal(result.events.at(-1).is_error, true);
    assert.equal(result.record.length, 0);
  }
});

test('Grok shutdown forwards interruption and reaps native descendants', async (t) => {
  const running = launch(t, { scenario: 'hang' });
  let processes;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !processes) {
    if (fs.existsSync(running.record)) processes = fs.readFileSync(running.record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.descendant);
    if (!processes) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(processes, 'native child started');
  running.child.kill('SIGTERM');
  const result = await running.done;
  assert.equal(result.code, 143);
  assert.ok(result.record.some((entry) => entry.signal === 'SIGINT'));
  for (const pid of [processes.native, processes.descendant]) assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
