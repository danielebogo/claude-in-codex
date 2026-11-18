// Failure modes:
// - An admitted native tool handoff consumes the memory needed for its result.
// - Another thread or headerless prewarm borrows reserved continuation credit.
// - A completed native turn retains its input or unused continuation reservation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { localAuth } from './fixtures/local-auth.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-native-credit-'));
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
const { webSocketTransportBytes } = await import('../src/resourceBudget.js');
const { cancelWaitingCodexTurns } = await import('../src/codexTools.js');

function message(text) {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
}

for (const protocol of ['HTTP', 'WebSocket']) {
  test(`${protocol} reserves memory for a full-history tool result and resumes the same native process`, { timeout: 15000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(home, `${protocol}-`));
    const thread = crypto.randomUUID();
    const otherThread = crypto.randomUUID();
    const log = path.join(directory, 'claude.jsonl');
    const variables = { FAKE_CLAUDE_SCENARIO: 'codex-tools', FAKE_CLAUDE_LOG: log };
    const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
    Object.assign(process.env, variables);
    const requests = [];
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests.push(req.url);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const sockets = new Set();
    let bridge;
    let socket;
    const prewarms = [];
    t.after(async () => {
      await cancelWaitingCodexTurns(thread);
      socket?.terminate();
      for (const prewarm of prewarms) prewarm.terminate();
      for (const connection of sockets) connection.destroy();
      bridge?.server.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => bridge ? bridge.server.close(resolve) : resolve()),
        new Promise((resolve) => upstream.close(resolve)),
      ]);
      clearTimeout(bridge?.state.timer);
      clearTimeout(bridge?.state.catalogTimer);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    bridge = createBridge({
      ...DEFAULTS, localAuth, logLevel: 'error', codexComputerUseMcpConfig: null,
      claudePath: new URL('./fixtures/fake-claude.js', import.meta.url).pathname,
      upstream: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
      limits: { maxBufferedBytes: 192 * 1024 + (protocol === 'WebSocket' ? webSocketTransportBytes : 0) },
    }, new State(path.join(directory, 'state.json')));
    bridge.server.on('connection', (connection) => {
      sockets.add(connection);
      connection.once('close', () => sockets.delete(connection));
    });
    await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${bridge.server.address().port}/${localAuth.token}/backend-api/codex/responses`;
    async function post(body, owner) {
      return fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json', 'thread-id': owner },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      });
    }
    if (protocol === 'WebSocket') {
      socket = new WebSocket(url.replace('http:', 'ws:'), { headers: { 'thread-id': thread } });
      socket.on('error', () => {});
      await once(socket, 'open');
    }
    async function turn(body) {
      if (protocol === 'HTTP') {
        const response = await post(body, thread);
        assert.equal(response.status, 200);
        const data = await response.text();
        const events = data.split('\n').filter((line) => line.startsWith('data: ') && !line.includes('[DONE]')).map((line) => JSON.parse(line.slice(6)));
        return events.find((event) => event.type === 'response.completed');
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error('Native WebSocket response did not complete.')), 10000);
        function finish(error, event) {
          clearTimeout(timeout);
          socket.off('message', onMessage);
          socket.off('close', onClose);
          if (error) reject(error);
          else resolve(event);
        }
        const onClose = (code) => finish(new Error(`Native WebSocket closed before completion: ${code}`));
        const onMessage = (data) => {
          const event = JSON.parse(data.toString());
          if (event.type === 'response.completed' || event.type === 'error') finish(null, event);
        };
        socket.on('message', onMessage);
        socket.once('close', onClose);
        socket.send(JSON.stringify(body));
      });
    }
    const input = [
      message(`<environment_context><cwd>${directory}</cwd></environment_context>`),
      message(`List tasks. ${'p'.repeat(16 * 1024)}`),
    ];
    const body = {
      model: 'claude-opus-5-5', client_metadata: { thread_id: thread }, input,
      tools: [{ type: 'namespace', name: 'codex_app', tools: [{ type: 'function', name: 'list_threads', description: 'List tasks.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } }] }],
    };

    const first = await turn(body);

    assert.equal(first?.type, 'response.completed');
    const call = first.response.output.find((item) => item.type === 'function_call');
    assert.ok(call, 'The fixture must yield a real native MCP tool handoff.');
    const before = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(before.length, 1);
    assert.equal(before[0].cwd, fs.realpathSync(directory));
    const unrelated = { model: 'gpt-test', input: [message('u'.repeat(32 * 1024))] };
    const rejected = await post(unrelated, otherThread);
    assert.equal(rejected.status, 503);
    await rejected.arrayBuffer();
    assert.equal(requests.length, 0);

    // Headerless prewarms must use unreserved global capacity while this native
    // process is waiting; keep any incorrectly admitted sockets open through resume.
    const prewarmStatuses = [];
    for (let index = 0; index < 2; index++) {
      const prewarm = new WebSocket(url.replace('http:', 'ws:'));
      prewarms.push(prewarm);
      prewarm.on('error', () => {});
      prewarmStatuses.push(await new Promise((resolve) => {
        prewarm.once('open', () => resolve(101));
        prewarm.once('unexpected-response', (_request, response) => {
          response.resume();
          prewarm.terminate();
          resolve(response.statusCode);
        });
        prewarm.once('error', () => resolve(0));
      }));
    }

    const continued = await turn({
      ...body,
      input: [...input, ...first.response.output, { type: 'function_call_output', call_id: call.call_id, output: 'reserved continuation succeeded' }],
    });

    assert.equal(continued?.type, 'response.completed');
    assert.equal(continued.response.end_turn, true);
    assert.match(JSON.stringify(continued.response.output), /reserved continuation succeeded/);
    const after = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(after.length, 1, 'Continuation must resume the original process rather than spawn another.');
    assert.equal(after[0].pid, before[0].pid);
    assert.deepEqual(prewarmStatuses, [503, 503], 'Prewarms cannot borrow native continuation credit.');
    // Completion can precede the native handler's final cleanup by one event-loop turn.
    let recovered;
    const deadline = Date.now() + 1500;
    do {
      recovered = await post(unrelated, otherThread);
      await recovered.arrayBuffer();
      if (recovered.status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(recovered.status, 200, 'The native turn must release memory for another thread.');
    assert.deepEqual(requests, ['/backend-api/codex/responses']);
  });
}
