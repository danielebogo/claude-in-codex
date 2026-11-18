// Failure modes:
// - Idle prewarms exhaust a fixed connection count and interrupt existing chats.
// - Transport allocation bypasses shared memory admission or leaks on failed upgrades.
// - Capacity checks disclose authenticated endpoints or ignore an explicit operator cap.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { localAuth } from './fixtures/local-auth.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ws-admission-'));
const previousHome = process.env.CODEX_CLAUDE_BRIDGE_HOME;
process.env.CODEX_CLAUDE_BRIDGE_HOME = home;
after(() => {
  if (previousHome === undefined) delete process.env.CODEX_CLAUDE_BRIDGE_HOME;
  else process.env.CODEX_CLAUDE_BRIDGE_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});
const { createBridge } = await import('../src/server.js');
const { DEFAULTS } = await import('../src/config.js');
const { State } = await import('../src/state.js');
const { webSocketTransportBytes: transportBytes } = await import('../src/resourceBudget.js');
const request = JSON.stringify({ model: 'gpt-test', input: [] });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t, limits = {}, upstreamOverride) {
  const sockets = new Set();
  const clients = new Set();
  const peers = [];
  const upgrades = [];
  const pending = [];
  const messages = [];
  const upstream = http.createServer((_req, res) => res.end('{}'));
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  let behavior = 'accept';
  upstream.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  function accept(req, socket, head) {
    wss.handleUpgrade(req, socket, head, (peer) => {
      peer.on('error', () => {});
      peer.on('message', (data) => messages.push(data.toString()));
      peers.push(peer);
      wss.emit('connection', peer);
    });
  }
  upstream.on('upgrade', (req, socket, head) => {
    upgrades.push(socket);
    if (behavior === 'reject') return socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    if (behavior === 'fail') return socket.destroy();
    if (behavior === 'pending') {
      pending.push({ req, socket, head });
      socket.once('end', () => socket.destroy());
      socket.resume();
      return;
    }
    accept(req, socket, head);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const bridge = createBridge({
    ...DEFAULTS, localAuth, logLevel: 'error', codexComputerUseMcpConfig: null,
    claudePath: '/no-claude-must-be-started', limits,
    upstream: upstreamOverride ?? `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
  }, new State(path.join(home, `${crypto.randomUUID()}.json`)));
  bridge.server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const client of clients) client.terminate();
    for (const peer of wss.clients) peer.terminate();
    for (const socket of sockets) socket.destroy();
    wss.close();
    bridge.server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise((resolve) => bridge.server.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
    clearTimeout(bridge.state.timer);
    clearTimeout(bridge.state.catalogTimer);
  });
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${bridge.server.address().port}/${localAuth.token}/backend-api/codex/responses`;
  function connect(hinted = false, authenticated = true) {
    const client = new WebSocket(authenticated ? url : url.replace(localAuth.token, 'invalid'), {
      headers: hinted ? { 'x-codex-routing-hint': 'model=gpt-test' } : {}, perMessageDeflate: false,
    });
    clients.add(client);
    client.on('error', () => {});
    const outcome = new Promise((resolve) => {
      client.once('open', () => resolve(101));
      client.once('unexpected-response', (_request, response) => {
        response.resume();
        client.terminate();
        resolve(response.statusCode);
      });
      client.once('error', () => resolve(0));
    });
    return { client, outcome };
  }
  async function open(hinted = false) {
    const attempt = connect(hinted);
    assert.equal(await attempt.outcome, 101);
    return attempt.client;
  }
  return { bridge, open, connect, peers, messages, upgrades,
    acceptPending() { for (const { req, socket, head } of pending.splice(0)) accept(req, socket, head); },
    setBehavior(value) { behavior = value; } };
}

async function eventually(check) {
  const deadline = Date.now() + 2000;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert.fail('Expected transport resources to recover before the deadline.');
}

async function close(client) {
  if (client.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => client.once('close', resolve));
  client.terminate();
  await closed;
  await tick();
}

for (const hinted of [false, true]) {
  const style = hinted ? 'hinted' : 'unhinted';
  test(`${style}: more than 64 authenticated clients preserve idle sockets and an in-flight GPT exchange`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    const active = await f.open(hinted);
    active.send(request);
    await eventually(() => f.messages.length === 1);
    assert.equal(f.messages[0], request);
    const idle = [];
    for (let index = 0; index < 65; index++) idle.push(await f.open(hinted));
    assert.equal(active.readyState, WebSocket.OPEN);
    for (const client of idle) assert.equal(client.readyState, WebSocket.OPEN);
    const response = once(active, 'message');
    f.peers[0].send('existing exchange completed');
    assert.equal((await response)[0].toString(), 'existing exchange completed');
    // An oldest idle session remains usable after the connection burst.
    const pong = once(idle[0], 'pong');
    idle[0].ping('still alive');
    assert.equal((await pong)[0].toString(), 'still alive');
  });

  test(`${style}: shared transport admission refuses excess sockets, checks auth first, and recovers`, { timeout: 10000 }, async (t) => {
    const perClient = hinted ? 2 * transportBytes : transportBytes;
    const f = await fixture(t, { maxBufferedBytes: perClient });
    const existing = await f.open(hinted);
    assert.equal(await f.connect(hinted, false).outcome, 401);
    assert.equal(await f.connect(hinted).outcome, 503);
    assert.equal(existing.readyState, WebSocket.OPEN);
    await close(existing);
    await eventually(async () => {
      const attempt = f.connect(hinted);
      const result = await attempt.outcome;
      await close(attempt.client);
      return result === 101;
    });
  });


  test(`${style}: upstream transport refusal preserves another idle session and recovers`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, { maxBufferedBytes: 2 * transportBytes + 4096 });
    const idle = await f.open();
    if (hinted) {
      assert.equal(await f.connect(true).outcome, 503);
    } else {
      const active = await f.open();
      const closed = once(active, 'close');
      active.send(request);
      assert.equal((await closed)[0], 1013);
    }
    assert.equal(f.upgrades.length, 0, 'An upstream must not be allocated before transport admission.');
    assert.equal(idle.readyState, WebSocket.OPEN);
    await close(idle);
    const recovered = await f.open(hinted);
    const count = f.messages.length;
    recovered.send(request);
    await eventually(() => f.messages.length > count);
  });

  test(`${style}: synchronous upstream constructor failure releases its transport reservation`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, { maxBufferedBytes: 2 * transportBytes + 4096 });
    const original = f.bridge.config.upstream;
    f.bridge.config.upstream = 'http://127.0.0.1/#invalid-websocket-fragment';
    const attempt = f.connect(hinted);
    if (hinted) assert.equal(await attempt.outcome, 502);
    else {
      assert.equal(await attempt.outcome, 101);
      const closed = once(attempt.client, 'close');
      attempt.client.send(request);
      assert.equal((await closed)[0], 1011);
    }
    f.bridge.config.upstream = original;
    const recovered = await f.open(hinted);
    recovered.send(request);
    await eventually(() => f.messages.length === 1);
    assert.equal(f.upgrades.length, 1);
  });

  for (const behavior of ['reject', 'fail', 'pending']) {
    test(`${style}: ${behavior} upstream upgrade releases both transport reservations`, { timeout: 10000 }, async (t) => {
      const f = await fixture(t, { maxBufferedBytes: 2 * transportBytes + 4096 });
      f.setBehavior(behavior);
      const attempt = f.connect(hinted);
      let ended;
      if (hinted) {
        ended = attempt.outcome;
        if (behavior === 'pending') {
          await eventually(() => f.upgrades.length === 1);
          await close(attempt.client);
        } else assert.ok([403, 502].includes(await ended));
      } else {
        assert.equal(await attempt.outcome, 101);
        ended = once(attempt.client, 'close');
        attempt.client.send(request);
        await eventually(() => f.upgrades.length === 1);
        if (behavior === 'pending') attempt.client.terminate();
        await ended;
      }
      f.setBehavior('accept');
      await eventually(() => f.upgrades.every((socket) => socket.destroyed));
      // Repeating admission catches reservations released zero or multiple times.
      for (let index = 0; index < 3; index++) {
        const client = await f.open(hinted);
        if (!hinted) {
          const count = f.peers.length;
          client.send(request);
          await eventually(() => f.peers.length > count);
        }
        await close(client);
        await tick();
      }
      const existing = await f.open(hinted);
      const excess = f.connect(hinted);
      if (hinted) assert.equal(await excess.outcome, 503);
      else {
        assert.equal(await excess.outcome, 101);
        assert.equal(await f.connect(false).outcome, 503);
        await close(excess.client);
      }
      assert.equal(existing.readyState, WebSocket.OPEN);
    });
  }
}

test('explicit maxWebSockets remains an operator-controlled cap', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { maxWebSockets: 2 });
  const first = await f.open();
  const second = await f.open();
  assert.equal(await f.connect().outcome, 503);
  assert.equal(first.readyState, WebSocket.OPEN);
  assert.equal(second.readyState, WebSocket.OPEN);
  await close(first);
  await f.open();
});


test('hinted pending upgrade preserves an early client frame while observing disconnects', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  f.setBehavior('pending');
  const socket = net.createConnection({ host: '127.0.0.1', port: f.bridge.server.address().port });
  socket.on('error', () => {});
  socket.on('data', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const key = crypto.randomBytes(16).toString('base64');
  socket.write([
    `GET /${localAuth.token}/backend-api/codex/responses HTTP/1.1`,
    'Host: 127.0.0.1', 'Connection: Upgrade', 'Upgrade: websocket',
    'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${key}`,
    'x-codex-routing-hint: model=gpt-test', '', '',
  ].join('\r\n'));
  await eventually(() => f.upgrades.length === 1);
  const payload = Buffer.from(request);
  assert.ok(payload.length < 126);
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask,
    Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))]);
  socket.write(frame);
  // Exercise readability while the bridge is still awaiting the upstream handshake.
  await new Promise((resolve) => setTimeout(resolve, 20));
  f.acceptPending();
  await eventually(() => f.messages.length === 1);
  assert.equal(f.messages[0], request);
});
