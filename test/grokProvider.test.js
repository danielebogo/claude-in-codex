import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createBridge } from '../src/server.js';
import { DEFAULTS } from '../src/config.js';
import { State } from '../src/state.js';
import { parseMarker } from '../src/codexInput.js';
import { cancelWaitingCodexTurns } from '../src/codexTools.js';
import { localAuth } from './fixtures/local-auth.js';

// Failure modes: foreign native sessions/tool results, Grok-only configuration,
// broken HTTP/WS replay, unscoped fork compaction, and lost MCP continuations.
const message = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const grokModel = { slug: 'grok-4.7', displayName: 'Grok 4.7', provider: 'grok', model: 'grok-4.7' };

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-grok-provider-'));
  const record = path.join(directory, 'grok.jsonl');
  const claudeLog = path.join(directory, 'claude.jsonl');
  const threads = new Set();
  const variables = { GROK_FIXTURE_RECORD: record, GROK_FIXTURE_MODE: 'success', GROK_FIXTURE_SESSION: 'grok-session', FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_SCENARIO: 'tools' };
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  t.after(async () => {
    for (const thread of threads) await cancelWaitingCodexTurns(thread);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({ path: req.url, body: Buffer.concat(chunks).toString() });
    res.end(JSON.stringify(req.url.includes('/models') ? { models: [{ slug: 'gpt-test', display_name: 'GPT test', visibility: 'list', priority: 1 }] } : { ok: true }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const state = new State(path.join(directory, 'state.json'));
  const bridge = createBridge({ ...DEFAULTS, localAuth, logLevel: 'error', codexComputerUseMcpConfig: null,
    models: [...DEFAULTS.models, grokModel], fallbackModel: 'gpt-test',
    claudePath: new URL('./fixtures/fake-claude.js', import.meta.url).pathname,
    grokPath: new URL('./fixtures/fake-grok.js', import.meta.url).pathname,
    upstream: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
  }, state);
  const sockets = new Set();
  bridge.server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    bridge.server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise((r) => bridge.server.close(r)), new Promise((r) => upstream.close(r))]);
    clearTimeout(state.timer); clearTimeout(state.catalogTimer);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${bridge.server.address().port}/${localAuth.token}/backend-api/codex`;
  const thread = crypto.randomUUID();
  threads.add(thread);
  const tools = [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }];
  const body = (input, extra = {}) => ({ model: grokModel.slug, input, tools, ...extra });
  async function request(payload, owner = thread) {
    threads.add(owner);
    const response = await fetch(`${base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'thread-id': owner }, body: JSON.stringify(payload) });
    const text = await response.text();
    return { status: response.status, text, events: text.split('\n').filter((line) => line.startsWith('data: ') && !line.includes('[DONE]')).map((line) => JSON.parse(line.slice(6))) };
  }
  const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { ...bridge, base, directory, thread, body, request, upstreamRequests, records: () => read(record), claudeCalls: () => read(claudeLog) };
}

function completed(result) {
  const event = result.events.find((event) => event.type === 'response.completed');
  assert.ok(event, result.text);
  return event.response;
}
const marker = (response) => parseMarker(response.output.find((item) => item.encrypted_content)?.encrypted_content);

test('HTTP dispatch resumes Grok and replays history across native provider switches', async (t) => {
  const bridge = await setup(t);
  const first = completed(await bridge.request(bridge.body([message('hello Grok')], { reasoning: { effort: 'max' } })));
  const firstMarker = marker(first);
  assert.equal(firstMarker.provider, 'grok');
  assert.match(JSON.stringify(first.output), /Hello world\./);
  const argv = bridge.records()[0].argv;
  assert.equal(argv[argv.indexOf('--reasoning-effort') + 1], 'xhigh');
  assert.equal(bridge.state.ownerThread(`grok:${firstMarker.sid}`), bridge.thread);
  const second = completed(await bridge.request(bridge.body([message('hello Grok'), ...first.output, message('continue Grok')])));
  assert.equal(bridge.records().filter((entry) => entry.method === 'session/load').length, 1);
  const claude = completed(await bridge.request(bridge.body([...first.output, ...second.output, message('switch to Claude')], { model: 'claude-opus-5-5' })));
  assert.equal(marker(claude).provider, undefined);
  assert.equal(bridge.claudeCalls()[0].args.includes('--resume'), false);
  assert.match(bridge.claudeCalls()[0].stdin, /Hello world/);
  process.env.GROK_FIXTURE_SESSION = 'grok-returned';
  completed(await bridge.request(bridge.body([...first.output, ...second.output, ...claude.output, message('back to Grok')])));
  assert.equal(bridge.records().filter((entry) => entry.method === 'session/load').length, 1);
  const prompts = bridge.records().filter((entry) => entry.method === 'session/prompt');
  assert.match(JSON.stringify(prompts.at(-1).params.prompt), /Done\./);
});

test('Grok catalog and housekeeping preserve the GPT route and advertised Grok limits', async (t) => {
  const bridge = await setup(t);
  const response = await fetch(`${bridge.base}/models`);
  const catalog = await response.json();
  const grok = catalog.models.find((model) => model.slug === grokModel.slug);
  assert.equal(grok.context_window, 256000);
  assert.deepEqual(grok.supported_reasoning_levels.map((level) => level.effort), ['low', 'medium', 'high', 'xhigh']);
  assert.ok(catalog.models.some((model) => model.slug === 'claude-opus-5-5'));
  const housekeeping = await bridge.request(bridge.body([message('make a title')], { tools: [] }));
  assert.equal(housekeeping.status, 200);
  assert.equal(bridge.records().length, 0);
  assert.equal(JSON.parse(bridge.upstreamRequests.at(-1).body).model, 'gpt-test');
});

test('WebSocket Grok follow-ups resolve connection-local previous response IDs', async (t) => {
  const bridge = await setup(t);
  const socket = new WebSocket(`${bridge.base.replace('http:', 'ws:')}/responses`, { headers: { 'thread-id': bridge.thread } });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  async function turn(payload) {
    const result = new Promise((resolve) => {
      function receive(data) {
        const event = JSON.parse(data);
        if (event.type === 'response.completed' || event.type === 'error') { socket.off('message', receive); resolve(event); }
      }
      socket.on('message', receive);
    });
    socket.send(JSON.stringify(payload));
    return result;
  }
  const first = await turn(bridge.body([message('first Grok WebSocket turn')]));
  const second = await turn(bridge.body([message('next turn')], { previous_response_id: first.response.id }));
  assert.equal(second.type, 'response.completed');
  assert.equal(marker(second.response).provider, 'grok');
  assert.equal(bridge.records().filter((entry) => entry.method === 'session/load').length, 1);
  socket.terminate();
});

test('Grok fork replays into a new session and cannot compact its parent session', async (t) => {
  const bridge = await setup(t);
  const parent = completed(await bridge.request(bridge.body([message('parent context')])));
  const parentMarker = marker(parent);
  const forkThread = crypto.randomUUID();
  const rejected = await bridge.request(bridge.body([...parent.output, { type: 'compaction_trigger' }]), forkThread);
  assert.ok(rejected.events.some((event) => event.type === 'response.failed'));
  assert.equal(bridge.records().filter((entry) => entry.method === 'session/load').length, 0);
  process.env.GROK_FIXTURE_SESSION = 'fork-session';
  const fork = completed(await bridge.request(bridge.body([...parent.output, message('new fork prompt')]), forkThread));
  assert.equal(bridge.records().filter((entry) => entry.method === 'session/new').length, 2);
  assert.equal(bridge.state.ownerThread(`grok:${parentMarker.sid}`), bridge.thread);
  assert.equal(bridge.state.ownerThread(`grok:${marker(fork).sid}`), forkThread);
  assert.match(JSON.stringify(bridge.records().filter((entry) => entry.method === 'session/prompt').at(-1).params.prompt), /Hello world/);
});

test('failed Grok startup cannot route its prompt to Claude or GPT', async (t) => {
  const bridge = await setup(t);
  process.env.GROK_FIXTURE_MODE = 'missing-auth';
  const result = completed(await bridge.request(bridge.body([message('private native prompt')])));
  assert.match(JSON.stringify(result.output), /Grok Build stopped/);
  assert.equal(bridge.claudeCalls().length, 0);
  assert.equal(bridge.upstreamRequests.length, 0);
  assert.equal(bridge.records().some((entry) => entry.method === 'session/prompt'), false);
});

for (const protocol of ['HTTP', 'WebSocket']) test(`${protocol} returns Codex MCP results to the same waiting Grok process`, async (t) => {
  const bridge = await setup(t);
  process.env.GROK_FIXTURE_MODE = 'mcp-call';
  let socket;
  if (protocol === 'WebSocket') {
    socket = new WebSocket(`${bridge.base.replace('http:', 'ws:')}/responses`, { headers: { 'thread-id': bridge.thread } });
    t.after(() => socket.terminate());
    await once(socket, 'open');
  }
  async function turn(payload) {
    if (!socket) return completed(await bridge.request(payload));
    const done = new Promise((resolve) => {
      function receive(data) {
        const event = JSON.parse(data);
        if (event.type === 'response.completed') { socket.off('message', receive); resolve(event.response); }
      }
      socket.on('message', receive);
    });
    socket.send(JSON.stringify(payload));
    return done;
  }

  const first = await turn(bridge.body([message('use the offered Codex tool')]));
  assert.equal(first.end_turn, false);
  const call = first.output.find((item) => item.type === 'function_call');
  assert.equal(call.name, 'shell');
  const next = await turn(bridge.body([...first.output, { type: 'function_call_output', call_id: call.call_id, output: 'result from Codex executor' }]));

  assert.equal(next.end_turn, true);
  assert.match(JSON.stringify(next.output), /Codex replied/);
  assert.equal(bridge.records().filter((entry) => entry.method === 'initialize').length, 1);
  assert.equal(bridge.records().filter((entry) => entry.method === 'session/prompt').length, 1);
  assert.match(JSON.stringify(bridge.records().find((entry) => entry.mcpResult)), /result from Codex executor/);
  socket?.terminate();
});

for (const from of ['claude', 'grok']) test(`switching from waiting ${from} never delivers its tool result to the wrong provider`, async (t) => {
  const bridge = await setup(t);
  const tools = [{ type: 'namespace', name: 'codex_app', tools: [{ type: 'function', name: 'list_threads', description: 'List tasks', parameters: { type: 'object', properties: { limit: { type: 'number' } } } }] }];
  process.env.FAKE_CLAUDE_SCENARIO = 'codex-tools';
  process.env.GROK_FIXTURE_MODE = 'mcp-call';
  const first = completed(await bridge.request(bridge.body([message('make a Codex tool call')], { tools, model: from === 'claude' ? 'claude-opus-5-5' : grokModel.slug })));
  assert.equal(first.end_turn, false);
  const call = first.output.find((item) => item.type === 'function_call');
  process.env.FAKE_CLAUDE_SCENARIO = 'tools';
  process.env.GROK_FIXTURE_MODE = 'success';

  const switched = completed(await bridge.request(bridge.body([...first.output, { type: 'function_call_output', call_id: call.call_id, output: 'foreign completed tool output' }, message('continue with the other provider')], { tools, model: from === 'claude' ? grokModel.slug : 'claude-opus-5-5' })));

  assert.equal(switched.end_turn, true);
  assert.equal(marker(switched).provider ?? 'claude', from === 'claude' ? 'grok' : 'claude');
  if (from === 'grok') {
    assert.equal(bridge.records().some((entry) => entry.mcpResult), false);
    assert.match(bridge.claudeCalls().at(-1).stdin, /foreign completed tool output/);
  } else assert.match(JSON.stringify(bridge.records().filter((entry) => entry.method === 'session/prompt').at(-1).params.prompt), /foreign completed tool output/);
});

test('Grok compaction after a tool handoff returns a provider-qualified compaction item', async (t) => {
  const bridge = await setup(t);
  process.env.GROK_FIXTURE_MODE = 'mcp-call';
  const first = completed(await bridge.request(bridge.body([message('make a Codex tool call')])));
  const call = first.output.find((item) => item.type === 'function_call');
  process.env.GROK_FIXTURE_MODE = 'success';

  const result = completed(await bridge.request(bridge.body([...first.output, { type: 'function_call_output', call_id: call.call_id, output: 'retain this tool result in the native summary' }, { type: 'compaction_trigger' }])));

  const compaction = result.output.find((item) => item.type === 'compaction');
  assert.equal(parseMarker(compaction.encrypted_content).provider, 'grok');
  assert.equal(result.output.some((item) => item.type === 'function_call'), false);
  const prompt = bridge.records().filter((entry) => entry.method === 'session/prompt').at(-1).params.prompt;
  assert.match(JSON.stringify(prompt), /retain this tool result/);
});

for (const protocol of ['HTTP', 'WebSocket']) {
  for (const [scenario, expected] of [
    ['usage-meta', { input: 0, output: 0, cached: 0, total: 123 }],
    ['usage', { input: 100, output: 9, cached: 20, total: 109 }],
    ['usage-empty', { input: 100, output: 0, cached: 20, total: 123 }],
    ['usage-combined', { input: 100, output: 9, cached: 20, total: 123 }],
    ['usage-sparse', { input: 100, output: 9, cached: 20, total: 123 }],
  ]) test(`${protocol} completion preserves observed Grok ${scenario} without inferring missing token components`, async (t) => {
    // Arrange
    const bridge = await setup(t);
    process.env.GROK_FIXTURE_MODE = scenario;
    let socket;
    if (protocol === 'WebSocket') {
      socket = new WebSocket(`${bridge.base.replace('http:', 'ws:')}/responses`, { headers: { 'thread-id': bridge.thread } });
      t.after(() => socket.terminate());
      await once(socket, 'open');
    }
    const request = bridge.body([message('report the actual native usage')]);

    // Act
    let response;
    if (!socket) response = completed(await bridge.request(request));
    else {
      const completedEvent = new Promise((resolve) => {
        function receive(data) {
          const event = JSON.parse(data);
          if (event.type === 'response.completed') { socket.off('message', receive); resolve(event.response); }
        }
        socket.on('message', receive);
      });
      socket.send(JSON.stringify(request));
      response = await completedEvent;
    }

    // Assert
    assert.equal(response.usage.total_tokens, expected.total);
    assert.equal(response.usage.input_tokens, expected.input);
    assert.equal(response.usage.output_tokens, expected.output);
    assert.equal(response.usage.input_tokens_details.cached_tokens, expected.cached);
    assert.equal(JSON.stringify(response).includes('not forwarded'), false);
    if (scenario === 'usage-empty') assert.equal(response.output.some((item) => item.type === 'message'), false);
    socket?.terminate();
  });
}
