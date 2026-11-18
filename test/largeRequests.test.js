// Failure modes:
// - Legitimate GPT history exceeds the former HTTP or WebSocket size ceilings.
// - Compressed JSON expands beyond the former decoded-body ceiling.
// - Aggregate memory pressure must reject work temporarily and release its reservation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { localAuth } from './fixtures/local-auth.js';

const MiB = 1024 * 1024;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-large-requests-'));
process.env.CODEX_CLAUDE_BRIDGE_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const { createBridge } = await import('../src/server.js');
const { DEFAULTS } = await import('../src/config.js');
const { State } = await import('../src/state.js');

function fingerprint(body) {
  return { bytes: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

function conversation(textBytes) {
  return JSON.stringify({ type: 'response.create', model: 'gpt-test', input: [{ role: 'user', content: [{ type: 'input_text', text: 'a'.repeat(textBytes) }] }] });
}

async function fixture(t, limits) {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    req.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); });
    req.on('end', () => {
      const received = { bytes, sha256: hash.digest('hex') };
      requests.push(received);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...received, encoding: req.headers['content-encoding'] ?? null }));
    });
  });
  // The fixture must not introduce a smaller ceiling than the bridge under test.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * MiB, perMessageDeflate: false });
  upstream.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client));
  });
  wss.on('connection', (socket) => {
    socket.on('error', () => {});
    socket.on('message', (data) => {
      const received = fingerprint(data);
      requests.push(received);
      socket.send(JSON.stringify(received));
    });
  });
  const bridgeSockets = new Set();
  let bridge;
  t.after(async () => {
    for (const socket of bridgeSockets) socket.destroy();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    bridge?.server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => bridge ? bridge.server.close(resolve) : resolve()),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
    clearTimeout(bridge?.state.timer);
    clearTimeout(bridge?.state.catalogTimer);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  bridge = createBridge({
    ...DEFAULTS, localAuth, logLevel: 'error', codexComputerUseMcpConfig: null,
    claudePath: '/no-claude-must-be-started',
    upstream: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`, limits,
  }, new State(path.join(home, `${crypto.randomUUID()}.json`)));
  bridge.server.on('connection', (socket) => {
    bridgeSockets.add(socket);
    socket.once('close', () => bridgeSockets.delete(socket));
  });
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${bridge.server.address().port}/${localAuth.token}/backend-api/codex/responses`;
  return { url, requests };
}

async function post(url, body, headers = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(15000) });
}

function receive(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for local upstream acknowledgement.')), 15000);
    const onMessage = (data) => finish(null, JSON.parse(data.toString()));
    const onClose = (code) => finish(new Error(`WebSocket closed before upstream acknowledgement: ${code}`));
    const onError = (error) => finish(error);
    function finish(error, value) {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    }
    socket.once('message', onMessage);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

test('HTTP forwards valid GPT JSON larger than 32 MiB byte-for-byte', async (t) => {
  const { url, requests } = await fixture(t, { maxBufferedBytes: 256 * MiB });
  const body = conversation(34 * MiB);
  const expected = fingerprint(body);

  const response = await post(url, body);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...expected, encoding: null });
  assert.deepEqual(requests, [expected]);
});

test('HTTP accepts gzip JSON expanding beyond 64 MiB when its memory budget permits', async (t) => {
  const { url, requests } = await fixture(t, { maxBufferedBytes: 512 * MiB });
  const body = conversation(66 * MiB);
  const compressed = zlib.gzipSync(body);
  const expected = fingerprint(compressed);
  assert.ok(Buffer.byteLength(body) > 64 * MiB);
  assert.ok(compressed.length < 32 * MiB);

  const response = await post(url, compressed, { 'content-encoding': 'gzip' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...expected, encoding: 'gzip' });
  assert.deepEqual(requests, [expected]);
});

for (const hinted of [true, false]) {
  test(`${hinted ? 'hinted' : 'unhinted'} GPT WebSocket forwards JSON larger than 32 MiB unchanged`, async (t) => {
    const { url, requests } = await fixture(t, { maxBufferedBytes: 256 * MiB });
    const socket = new WebSocket(url.replace('http:', 'ws:'), {
      headers: hinted ? { 'x-codex-routing-hint': 'model=gpt-test' } : {},
      perMessageDeflate: false,
    });
    socket.on('error', () => {});
    t.after(() => socket.terminate());
    await once(socket, 'open');
    const body = conversation(34 * MiB);
    const expected = fingerprint(body);

    const reply = receive(socket);
    socket.send(body);

    assert.deepEqual(await reply, expected);
    assert.deepEqual(requests, [expected]);
  });
}

test('HTTP memory-budget rejection returns 503 and releases capacity for a smaller request', async (t) => {
  const { url, requests } = await fixture(t, { maxBufferedBytes: 4096 });

  const rejected = await post(url, conversation(8192));

  assert.equal(rejected.status, 503);
  await rejected.arrayBuffer();
  assert.equal(requests.length, 0);
  const smallBody = conversation(16);
  const accepted = await post(url, smallBody);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ...fingerprint(smallBody), encoding: null });
  assert.deepEqual(requests, [fingerprint(smallBody)]);
});
