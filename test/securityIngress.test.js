import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import WebSocket, { WebSocketServer } from 'ws';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ingress-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
process.env.CODEX_CLAUDE_BRIDGE_HOME = home;
const { createBridge } = await import('../src/server.js');
const { DEFAULTS } = await import('../src/config.js');
const { State } = await import('../src/state.js');
const { cancelWaitingCodexTurns, waitingCodexTurns } = await import('../src/codexTools.js');
const auth = { token: 'a'.repeat(64), installationId: 'b'.repeat(32) };

async function fixture(t, overrides = {}, { delayUpgrade = false } = {}) {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    req.resume();
    res.end(JSON.stringify({ models: [{ slug: 'gpt-test' }] }));
  });
  const stalled = new Set();
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => {
    if (delayUpgrade) {
      stalled.add(socket);
      socket.once('close', () => stalled.delete(socket));
    } else wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
  });
  wss.on('connection', (socket, req) => {
    requests.push({ url: req.url, headers: req.headers });
    socket.on('message', (data) => socket.send(data));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const state = new State(path.join(home, `${Math.random()}.json`));
  const { server } = createBridge({ ...DEFAULTS, localAuth: auth, logLevel: 'error', claudePath: '/no-claude-must-be-started', upstream: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`, ...overrides }, state);
  const bridgeSockets = new Set();
  server.on('connection', (socket) => { bridgeSockets.add(socket); socket.once('close', () => bridgeSockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of stalled) socket.destroy();
    for (const socket of bridgeSockets) socket.destroy();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
    clearTimeout(state.timer);
    clearTimeout(state.catalogTimer);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, requests, origin, url: `${origin}/${auth.token}/backend-api/codex`, ws: (suffix = '') => new WebSocket(`${origin.replace('http:', 'ws:')}/${auth.token}/backend-api/codex/responses${suffix}`) };
}

test('HTTP rejects missing and forged capabilities before Claude dispatch or upstream access', async (t) => {
  const bridge = await fixture(t);
  const body = JSON.stringify({ model: 'claude-opus-5-5', tools: [{}], input: [{ role: 'developer', content: [{ text: '`sandbox_mode` is `danger-full-access`' }] }, { role: 'user', content: [{ text: '<environment_context><cwd>/tmp</cwd></environment_context>' }] }] });

  for (const prefix of ['', `/${'c'.repeat(64)}`, `/%61${auth.token.slice(1)}`, `/${auth.token}x`]) {
    const response = await fetch(`${bridge.origin}${prefix}/backend-api/codex/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, 401);
  }
  assert.equal(bridge.requests.length, 0);
});

test('HTTP authenticates the model catalog without forwarding the capability or replacing OpenAI auth', async (t) => {
  const bridge = await fixture(t);

  const response = await fetch(`${bridge.url}/models?client_version=test`, { headers: { authorization: 'Bearer upstream-test' } });

  assert.equal(response.status, 200);
  assert.equal(bridge.requests[0].url, '/backend-api/codex/models?client_version=test');
  assert.equal(bridge.requests[0].headers.authorization, 'Bearer upstream-test');
  assert.equal(JSON.stringify(bridge.requests).includes(auth.token), false);
});

test('WebSocket rejects unauthenticated handshakes before upstream access', async (t) => {
  const bridge = await fixture(t);

  for (const prefix of ['', `/${'c'.repeat(64)}`]) {
    const socket = new WebSocket(`${bridge.origin.replace('http:', 'ws:')}${prefix}/backend-api/codex/responses`);
    socket.on('error', () => {});
    const [req, response] = await once(socket, 'unexpected-response');
    assert.equal(response.statusCode, 401);
    response.resume();
    req.destroy();
    socket.terminate();
  }
  assert.equal(bridge.requests.length, 0);
});

test('authenticated unhinted WebSocket forwards GPT without disclosing its capability', async (t) => {
  const bridge = await fixture(t);
  const socket = bridge.ws('?test=1');
  t.after(() => socket.terminate());
  await once(socket, 'open');

  const reply = once(socket, 'message');
  socket.send(JSON.stringify({ model: 'gpt-test', input: [] }));
  await reply;

  assert.equal(bridge.requests[0].url, '/backend-api/codex/responses?test=1');
  assert.equal(JSON.stringify(bridge.requests).includes(auth.token), false);
  socket.terminate();
});

test('public health reveals no chat diagnostics and protected health requires capability', async (t) => {
  const bridge = await fixture(t);

  assert.deepEqual(await (await fetch(`${bridge.origin}/health`)).json(), { ok: true });
  const diagnostic = await (await fetch(`${bridge.origin}/${auth.token}/health`)).json();
  assert.ok(diagnostic.diagnostics);
});

test('installer verifier authenticates the actual bridge challenge response', async (t) => {
  const bridge = await fixture(t);
  const privateHome = fs.mkdtempSync(path.join(home, 'proof-'));
  fs.writeFileSync(path.join(privateHome, 'local-auth.json'), JSON.stringify(auth), { mode: 0o600 });

  const child = spawn(process.execPath, [new URL('../scripts/bridge-endpoint.js', import.meta.url).pathname, 'verify', privateHome, String(bridge.server.address().port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '';
  child.stderr.on('data', (data) => { error += data; });
  const [status] = await once(child, 'close');

  assert.equal(status, 0, error);
});

test('HTTP debug integration never persists request values', async (t) => {
  const directory = path.join(home, 'debug-metadata');
  const bridge = await fixture(t, { debugDumpDir: directory });
  const secret = 'prompt-with-private-source-and-credentials';

  const response = await fetch(`${bridge.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', input: [{ text: secret }] }) });

  assert.equal(response.status, 200);
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  const contents = fs.readFileSync(path.join(directory, files[0]), 'utf8');
  assert.equal(contents.includes(secret), false);
  assert.equal(contents.includes('gpt-test'), false);
  assert.ok(JSON.parse(contents).structure);
});

test('oversized HTTP bodies and compressed expansion fail locally before passthrough', async (t) => {
  const bridge = await fixture(t, { limits: { maxBodyBytes: 1024, maxDecodedBytes: 2048 } });
  const cases = [
    { body: 'x'.repeat(1025), headers: {}, status: 413 },
    { body: zlib.gzipSync('x'.repeat(4096)), headers: { 'content-encoding': 'gzip' }, status: 413 },
    { body: 'broken', headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' }, status: 400 },
    { body: 'data', headers: { 'content-encoding': 'unknown' }, status: 415 },
  ];

  for (const entry of cases) {
    const response = await fetch(`${bridge.url}/responses`, { method: 'POST', ...entry });
    assert.equal(response.status, entry.status);
  }
  assert.equal(bridge.requests.length, 0);
  assert.equal((await fetch(`${bridge.url}/responses`, { method: 'POST', body: 'valid' })).status, 200);
  assert.equal(bridge.requests.length, 1);
});

test('HTTP streamed overflow and stalled body return errors before the sender finishes', async (t) => {
  const bridge = await fixture(t, { limits: { maxBodyBytes: 128, bodyTimeoutMs: 150 } });

  async function partialBody(chunk) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${bridge.url}/responses`, { method: 'POST' }, (res) => {
        res.resume();
        res.on('end', () => { req.destroy(); resolve(res.statusCode); });
      });
      req.on('error', reject);
      req.write(chunk);
    });
  }

  assert.equal(await partialBody('x'.repeat(256)), 413);
  assert.equal(await partialBody('unfinished'), 408);
  assert.equal(bridge.requests.length, 0);
});

test('disconnecting during decompression retains capacity until work settles and prevents dispatch', async (t) => {
  const bridge = await fixture(t, { limits: { maxConcurrentRequests: 1 } });
  let finishDecompression;
  let decodingStarted;
  const started = new Promise((resolve) => { decodingStarted = resolve; });
  t.mock.method(zlib, 'gunzip', (_raw, _options, callback) => {
    finishDecompression = callback;
    decodingStarted();
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const request = http.request(`${bridge.url}/responses`, { method: 'POST', headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' } });
  request.on('error', () => {});
  request.end('compressed-fixture');
  await started;
  const disconnected = new Promise((resolve) => request.once('close', resolve));
  request.destroy();
  await disconnected;
  await new Promise((resolve) => setTimeout(resolve, 20));

  try {
    assert.equal((await fetch(`${bridge.url}/models`)).status, 503);
  } finally {
    finishDecompression(null, Buffer.from(JSON.stringify({ model: 'gpt-test' })));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(bridge.requests.length, 0);
  assert.equal((await fetch(`${bridge.origin}/health`)).status, 200);
});

for (const budget of [{ maxWebSocketQueueBytes: 70 }, { maxWebSocketQueueMessages: 2 }]) {
  test(`WebSocket aggregate pending queue is bounded by ${Object.keys(budget)[0]}`, async (t) => {
    const bridge = await fixture(t, { limits: budget }, { delayUpgrade: true });
    const socket = bridge.ws();
    t.after(() => socket.terminate());
    await once(socket, 'open');
    const closed = once(socket, 'close');

    for (let i = 0; i < 3; i++) socket.send(JSON.stringify({ model: 'gpt-test', input: [] }));

    assert.equal((await closed)[0], 1009);
  });
}

test('WebSocket decompressed messages are limited before routing', async (t) => {
  const bridge = await fixture(t, { limits: { maxWebSocketPayloadBytes: 128 } });
  const socket = bridge.ws();
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const closed = once(socket, 'close');

  socket.send(JSON.stringify({ model: 'gpt-test', input: 'x'.repeat(1024) }));

  assert.equal((await closed)[0], 1009);
  assert.equal(bridge.requests.length, 0);
});

test('connection and request capacity refuse extra work without growing queues', async (t) => {
  const bridge = await fixture(t, { limits: { maxWebSockets: 1, maxConcurrentRequests: 1, bodyTimeoutMs: 500 } });
  const first = bridge.ws();
  t.after(() => first.terminate());
  await once(first, 'open');
  const second = bridge.ws();
  second.on('error', () => {});
  const [upgrade, response] = await once(second, 'unexpected-response');
  assert.equal(response.statusCode, 503);
  response.resume();
  upgrade.destroy();
  second.terminate();
  first.terminate();

  const stalled = http.request(`${bridge.url}/responses`, { method: 'POST' });
  stalled.on('error', () => {});
  stalled.write('partial');
  t.after(() => stalled.destroy());
  await once(stalled, 'socket').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await fetch(`${bridge.url}/models`)).status, 503);
  stalled.destroy();
});

for (const protocol of ['HTTP', 'WebSocket']) test(`${protocol} turn capacity still admits results for its waiting Claude process`, async (t) => {
  const previous = { scenario: process.env.FAKE_CLAUDE_SCENARIO, log: process.env.FAKE_CLAUDE_LOG };
  process.env.FAKE_CLAUDE_SCENARIO = 'codex-tools';
  process.env.FAKE_CLAUDE_LOG = path.join(home, `capacity-${protocol}-claude.log`);
  t.after(async () => {
    await cancelWaitingCodexTurns('capacity-tool-thread');
    if (previous.scenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = previous.scenario;
    if (previous.log === undefined) delete process.env.FAKE_CLAUDE_LOG;
    else process.env.FAKE_CLAUDE_LOG = previous.log;
  });
  const bridge = await fixture(t, { claudePath: new URL('./fixtures/fake-claude.js', import.meta.url).pathname, codexComputerUseMcpConfig: null, limits: { maxConcurrentRequests: 1 } });
  const socket = bridge.ws();
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list tasks' }] }];
  const body = { model: 'claude-opus-5-5', client_metadata: { thread_id: 'capacity-tool-thread' }, input, tools: [{ type: 'namespace', name: 'codex_app', tools: [{ type: 'function', name: 'list_threads', description: 'List tasks.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } }] }] };
  async function turn(request) {
    if (protocol === 'HTTP') {
      const response = await fetch(`${bridge.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'thread-id': request.client_metadata.thread_id }, body: JSON.stringify(request) });
      if (response.status === 503) return { type: 'error', status: 503 };
      const data = await response.text();
      return data.split('\n').filter((line) => line.startsWith('data: ') && !line.includes('[DONE]')).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === 'response.completed');
    }
    const completed = new Promise((resolve) => {
      function onMessage(data) {
        const event = JSON.parse(data);
        if (event.type === 'response.completed' || event.type === 'error') { socket.off('message', onMessage); resolve(event); }
      }
      socket.on('message', onMessage);
    });
    socket.send(JSON.stringify(request));
    return completed;
  }

  const first = await turn(body);
  const call = first.response.output.find((item) => item.type === 'function_call');
  assert.ok(call);
  if (protocol === 'WebSocket') {
    const extra = await turn({ ...body, client_metadata: { thread_id: 'extra-capacity-thread' } });
    assert.equal(extra.status, 503);
  }
  const continued = await turn({ ...body, input: [...input, ...first.response.output, { type: 'function_call_output', call_id: call.call_id, output: 'capacity continuation worked' }] });

  assert.equal(continued.type, 'response.completed');
  assert.equal(continued.response.end_turn, true);
  assert.match(JSON.stringify(continued.response.output), /capacity continuation worked/);
  socket.terminate();
});

async function waitingCapacityFixture(t, name) {
  const log = path.join(home, `${name}.log`);
  const release = path.join(home, `${name}.release`);
  const keys = ['FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_HOLD_FILE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const threads = new Set([name]);
  process.env.FAKE_CLAUDE_SCENARIO = 'codex-tools';
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.FAKE_CLAUDE_HOLD_FILE = release;
  t.after(async () => {
    fs.writeFileSync(release, 'release fixture processes');
    for (const thread of threads) await cancelWaitingCodexTurns(thread);
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const bridge = await fixture(t, { claudePath: new URL('./fixtures/fake-claude.js', import.meta.url).pathname, codexComputerUseMcpConfig: null, limits: { maxConcurrentRequests: 1 } });
  const body = { model: 'claude-opus-5-5', client_metadata: { thread_id: name }, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list tasks' }] }], tools: [{ type: 'namespace', name: 'codex_app', tools: [{ type: 'function', name: 'list_threads', description: 'List tasks.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } }] }] };
  async function connect() {
    const socket = bridge.ws();
    t.after(() => socket.terminate());
    await once(socket, 'open');
    return socket;
  }
  function turn(socket, request) {
    threads.add(request.client_metadata.thread_id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off('message', onMessage); reject(new Error('Capacity fixture turn did not complete within 3 seconds.')); }, 3000);
      function onMessage(data) {
        const event = JSON.parse(data);
        if (event.type !== 'response.completed' && event.type !== 'error') return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(event);
      }
      socket.on('message', onMessage);
      socket.send(JSON.stringify(request));
    });
  }
  return { ...bridge, body, connect, turn, release, calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] };
}

for (const action of ['replace', 'reconnect', 'compact', 'compact-with-result']) test(`full WebSocket capacity admits same-thread ${action} after stopping its waiting turn`, async (t) => {
  // Arrange
  const fixture = await waitingCapacityFixture(t, `waiting-${action}`);
  let socket = await fixture.connect();
  const first = await fixture.turn(socket, fixture.body);
  const call = first.response.output.find((item) => item.type === 'function_call');
  assert.ok(call);
  const oldPid = fixture.calls()[0].pid;
  const unrelated = await fixture.turn(socket, { ...fixture.body, client_metadata: { thread_id: `${action}-unrelated` } });
  assert.equal(unrelated.status, 503);
  if (action === 'reconnect') {
    const closed = once(socket, 'close');
    socket.close();
    await closed;
    socket = await fixture.connect();
  }
  process.env.FAKE_CLAUDE_SCENARIO = 'tools';
  const compact = action.startsWith('compact');
  const history = first.response.output.filter((item) => item.type !== 'function_call'); // Reconnects may omit the preempted call; the session marker still identifies the waiting chat.
  const input = [...fixture.body.input, ...history];
  if (action === 'compact-with-result') input.push({ type: 'function_call_output', call_id: call.call_id, output: 'preserve this completed result' });
  input.push(compact ? { type: 'compaction_trigger' } : { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'replace the abandoned tool request' }] });

  // Act
  const result = await fixture.turn(socket, { ...fixture.body, input });

  // Assert
  assert.equal(result.type, 'response.completed');
  assert.equal(result.response.end_turn, true);
  assert.equal(fixture.calls().length, 2);
  assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
  assert.equal(waitingCodexTurns(fixture.body.client_metadata.thread_id).length, 0);
  if (compact) {
    assert.equal(result.response.output.filter((item) => item.type === 'compaction').length, 1);
    assert.equal(result.response.output.some((item) => item.type === 'function_call'), false);
    assert.equal(fixture.calls()[1].args.includes('/compact') || fixture.calls()[1].stdin.startsWith('/compact '), true);
    if (action === 'compact-with-result') assert.match(fixture.calls()[1].stdin, /preserve this completed result/);
  } else assert.match(JSON.stringify(result.response.output), /Done\./);
  socket.terminate();
});

test('concurrent same-thread replacements share only one reserved WebSocket slot', async (t) => {
  // Arrange
  const fixture = await waitingCapacityFixture(t, 'waiting-concurrent');
  const firstSocket = await fixture.connect();
  const first = await fixture.turn(firstSocket, fixture.body);
  const secondSocket = await fixture.connect();
  process.env.FAKE_CLAUDE_SCENARIO = 'hold-native';
  const request = { ...fixture.body, input: [...fixture.body.input, ...first.response.output, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'replace waiting work' }] }] };

  // Act
  const results = [fixture.turn(firstSocket, request), fixture.turn(secondSocket, request)];
  const rejected = await Promise.race(results);
  assert.equal(rejected.status, 503);
  const deadline = Date.now() + 2000;
  while (fixture.calls().length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const extraSocket = await fixture.connect();
  const unrelated = await fixture.turn(extraSocket, { ...fixture.body, client_metadata: { thread_id: 'waiting-concurrent-other' } });
  fs.writeFileSync(fixture.release, 'finish replacement');
  const completed = await Promise.all(results);

  // Assert
  assert.equal(unrelated.status, 503);
  assert.equal(completed.filter((event) => event.type === 'response.completed').length, 1);
  assert.equal(completed.filter((event) => event.status === 503).length, 1);
  assert.equal(fixture.calls().length, 2);
  firstSocket.terminate();
  secondSocket.terminate();
  extraSocket.terminate();
});

test('HTTP-created waiting turns cannot reclaim another thread WebSocket slot', async (t) => {
  // Arrange
  const fixture = await waitingCapacityFixture(t, 'waiting-websocket-owner');
  const socket = await fixture.connect();
  await fixture.turn(socket, fixture.body);
  const httpThread = 'waiting-http-owner';
  const httpBody = { ...fixture.body, client_metadata: { thread_id: httpThread } };
  const httpResponse = await fetch(`${fixture.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'thread-id': httpThread }, body: JSON.stringify(httpBody) });
  await httpResponse.text();
  assert.equal(waitingCodexTurns(httpThread).length, 1);

  // Act
  const replacement = await fixture.turn(socket, httpBody);

  // Assert
  assert.equal(replacement.status, 503);
  assert.equal(waitingCodexTurns(httpThread).length, 1);
  assert.equal(waitingCodexTurns(fixture.body.client_metadata.thread_id).length, 1);
  assert.equal(fixture.calls().length, 2);
  socket.terminate();
});

test('a disconnected replacement releases its reserved slot without starting native work', { timeout: 5000 }, async (t) => {
  // Arrange
  let releaseStop;
  t.after(() => releaseStop?.());
  const fixture = await waitingCapacityFixture(t, 'waiting-disconnected');
  const socket = await fixture.connect();
  const first = await fixture.turn(socket, fixture.body);
  const waiting = waitingCodexTurns(fixture.body.client_metadata.thread_id)[0];
  const cancel = waiting.cancel.bind(waiting);
  let stopping;
  const stopStarted = new Promise((resolve) => { stopping = resolve; });
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  t.mock.method(waiting, 'cancel', async (reason) => { stopping(); await stopGate; await cancel(reason); });

  // Act
  socket.send(JSON.stringify({ ...fixture.body, input: [...fixture.body.input, ...first.response.output, { type: 'compaction_trigger' }] }));
  await stopStarted;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
  process.env.FAKE_CLAUDE_SCENARIO = 'tools';
  releaseStop();
  const nextSocket = await fixture.connect();
  const nextRequest = { ...fixture.body, client_metadata: { thread_id: 'after-disconnected-replacement' } };
  const deadline = Date.now() + 2000;
  let next;
  do {
    next = await fixture.turn(nextSocket, nextRequest);
    if (next.status === 503) await new Promise((resolve) => setTimeout(resolve, 10));
  } while (next.status === 503 && Date.now() < deadline);

  // Assert
  assert.equal(next.type, 'response.completed');
  assert.equal(fixture.calls().length, 2);
  assert.match(JSON.stringify(next.response.output), /Done\./);
  assert.equal(fixture.calls().some((call) => call.args.includes('/compact')), false);
  nextSocket.terminate();
});

test('a cancellation failure after native cleanup releases the reserved WebSocket slot', async (t) => {
  // Arrange
  const fixture = await waitingCapacityFixture(t, 'waiting-cancel-error');
  const socket = await fixture.connect();
  const first = await fixture.turn(socket, fixture.body);
  const waiting = waitingCodexTurns(fixture.body.client_metadata.thread_id)[0];
  const cancel = waiting.cancel.bind(waiting);
  t.mock.method(waiting, 'cancel', async (reason) => {
    await cancel(reason);
    await new Promise((resolve) => setImmediate(resolve)); // The native handler performs its post-exit cleanup on the next immediate.
    throw new Error('Fixture cancellation failed after native cleanup.');
  });

  // Act
  const closed = once(socket, 'close');
  socket.send(JSON.stringify({ ...fixture.body, input: [...fixture.body.input, ...first.response.output, { type: 'compaction_trigger' }] }));
  const [code] = await closed;
  process.env.FAKE_CLAUDE_SCENARIO = 'tools';
  const nextSocket = await fixture.connect();
  const next = await fixture.turn(nextSocket, { ...fixture.body, client_metadata: { thread_id: 'after-cancellation-error' } });

  // Assert
  assert.equal(code, 1011);
  assert.equal(next.type, 'response.completed');
  assert.equal(fixture.calls().length, 2);
  nextSocket.terminate();
});
