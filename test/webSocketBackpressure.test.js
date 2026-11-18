// Failure mode: a hinted GPT relay keeps reading upstream responses while a
// slow downstream send still owns its buffered-message reservation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { localAuth } from './fixtures/local-auth.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ws-backpressure-'));
const previousHome = process.env.CODEX_CLAUDE_BRIDGE_HOME;
process.env.CODEX_CLAUDE_BRIDGE_HOME = home;
const { createBridge } = await import('../src/server.js');
const { DEFAULTS } = await import('../src/config.js');
const { State } = await import('../src/state.js');

test('hinted GPT response relay pauses upstream until the downstream send completes', { timeout: 10000 }, async (t) => {
  const upstream = http.createServer();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const bridgeSockets = new Set();
  let bridge;
  let client;
  let releaseSend;
  t.after(async () => {
    releaseSend?.();
    client?.terminate();
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
    if (previousHome === undefined) delete process.env.CODEX_CLAUDE_BRIDGE_HOME;
    else process.env.CODEX_CLAUDE_BRIDGE_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  upstream.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (peer) => wss.emit('connection', peer));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/backend-api/codex`;
  const relayUrl = `${upstreamUrl.replace('http:', 'ws:')}/responses`;
  bridge = createBridge({
    ...DEFAULTS, localAuth, logLevel: 'error', codexComputerUseMcpConfig: null,
    claudePath: '/no-claude-must-be-started', upstream: upstreamUrl,
  }, new State(path.join(home, 'state.json')));
  bridge.server.on('connection', (socket) => {
    bridgeSockets.add(socket);
    socket.once('close', () => bridgeSockets.delete(socket));
  });
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  const connected = once(wss, 'connection');
  client = new WebSocket(`ws://127.0.0.1:${bridge.server.address().port}/${localAuth.token}/backend-api/codex/responses`, {
    headers: { 'x-codex-routing-hint': 'model=gpt-test' }, perMessageDeflate: false,
  });
  client.on('error', () => {});
  const [peer] = await connected;
  peer.on('error', () => {});
  await once(client, 'open');

  const payload = `local-slow-send-${crypto.randomUUID()}`;
  const transitions = [];
  let relay;
  for (const operation of ['pause', 'resume']) {
    const original = WebSocket.prototype[operation];
    t.mock.method(WebSocket.prototype, operation, function (...args) {
      if (this.url === relayUrl) { relay = this; transitions.push(operation); }
      return original.apply(this, args);
    });
  }
  const originalSend = WebSocket.prototype.send;
  let sendCompleted;
  const completed = new Promise((resolve) => { sendCompleted = resolve; });
  t.mock.method(WebSocket.prototype, 'send', function (data, options, callback) {
    // Match only the bridge's accepted client, excluding both fixture endpoints.
    if (this !== client && this !== peer && this.url === undefined && data.toString() === payload) {
      assert.equal(typeof callback, 'function');
      return originalSend.call(this, data, options, (error) => {
        let released = false;
        releaseSend = () => {
          if (released) return;
          released = true;
          callback(error);
        };
        sendCompleted();
      });
    }
    return originalSend.call(this, data, options, callback);
  });
  const received = once(client, 'message');

  try {
    peer.send(payload);
    await completed;
    const [message] = await received;
    assert.equal(message.toString(), payload);
    assert.deepEqual(transitions, ['pause']);
    assert.equal(relay.isPaused, true);

    releaseSend();

    assert.deepEqual(transitions, ['pause', 'resume']);
    assert.equal(relay.isPaused, false);
  } finally {
    releaseSend?.();
  }
});

for (const hinted of [true, false]) {
  test(`${hinted ? 'hinted' : 'unhinted'} GPT send-budget pressure closes the client with 1013 while upstream is paused`, { timeout: 10000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ws-pressure-'));
    const upstream = http.createServer();
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    const bridgeSockets = new Set();
    let bridge;
    let client;
    let releaseSend;
    let deadline;
    t.after(async () => {
      clearTimeout(deadline);
      releaseSend?.();
      client?.terminate();
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
      fs.rmSync(directory, { recursive: true, force: true });
    });
    upstream.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (peer) => wss.emit('connection', peer));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/backend-api/codex`;
    bridge = createBridge({
      ...DEFAULTS, localAuth, logLevel: 'error', codexComputerUseMcpConfig: null,
      claudePath: '/no-claude-must-be-started', upstream: upstreamUrl,
      limits: { maxBufferedBytes: 4096 },
    }, new State(path.join(directory, 'state.json')));
    bridge.server.on('connection', (socket) => {
      bridgeSockets.add(socket);
      socket.once('close', () => bridgeSockets.delete(socket));
    });
    await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
    const connected = new Promise((resolve) => wss.once('connection', (peer) => {
      peer.on('error', () => {});
      resolve({ peer, firstMessage: once(peer, 'message') });
    }));
    client = new WebSocket(`ws://127.0.0.1:${bridge.server.address().port}/${localAuth.token}/backend-api/codex/responses`, {
      headers: hinted ? { 'x-codex-routing-hint': 'model=gpt-test' } : {}, perMessageDeflate: false,
    });
    client.on('error', () => {});
    await once(client, 'open');
    client.send(JSON.stringify({ model: 'gpt-test', input: [] }));
    const { peer, firstMessage } = await connected;
    await firstMessage;
    await new Promise((resolve) => setImmediate(resolve));

    const reverse = `${crypto.randomUUID()}${'r'.repeat(864)}`;
    assert.equal(Buffer.byteLength(reverse), 900);
    let sendCompleted;
    const completed = new Promise((resolve) => { sendCompleted = resolve; });
    const originalSend = WebSocket.prototype.send;
    t.mock.method(WebSocket.prototype, 'send', function (data, options, callback) {
      if (this !== client && this !== peer && this.url === undefined && data.toString() === reverse) {
        return originalSend.call(this, data, options, (error) => {
          let released = false;
          releaseSend = () => {
            if (released) return;
            released = true;
            callback(error);
          };
          sendCompleted();
        });
      }
      return originalSend.call(this, data, options, callback);
    });
    const received = once(client, 'message');
    try {
      peer.send(reverse);
      await completed;
      await received;
      const prefix = JSON.stringify({ model: 'gpt-test', input: '' });
      const request = JSON.stringify({ model: 'gpt-test', input: 'a'.repeat(830 - Buffer.byteLength(prefix)) });
      assert.equal(Buffer.byteLength(request), 830);
      // 900 held + 3 * 830 parse bytes fit; the extra 830 send bytes do not.
      const closed = once(client, 'close');
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Client did not receive capacity close while upstream send callback remained held.')), 1500);
      });

      client.send(request);

      const [code] = await Promise.race([closed, timeout]);
      assert.equal(code, 1013);
    } finally {
      clearTimeout(deadline);
      releaseSend?.();
    }
  });
}
