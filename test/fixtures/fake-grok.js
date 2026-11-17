#!/usr/bin/env node
// Isolated ACP peer: no account, native tools, network, or persistent configuration.
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const scenario = process.env.GROK_FIXTURE_MODE || 'success';
const record = (value) => {
  const file = process.env.GROK_FIXTURE_RECORD || process.env.FAKE_GROK_LOG;
  if (file) fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
};
record({ argv: process.argv.slice(2), sandbox: process.env.GROK_SANDBOX, updater: process.env.GROK_DISABLE_AUTOUPDATER, hasApiKey: Boolean(process.env.XAI_API_KEY) });
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
let sessionId = process.env.GROK_FIXTURE_SESSION || 'grok-session';
let servers = [];
const update = (value) => send({ method: 'session/update', params: { sessionId, update: value } });
let promptId;
let permissionIndex = 0;
const permissionCalls = [
  { toolCallId: 'read', title: 'Read file', kind: 'read', rawInput: { file_path: '/tmp/example' } },
  { toolCallId: 'edit', title: 'Edit file', kind: 'edit', rawInput: { file_path: '/tmp/example' } },
  { toolCallId: 'shell', title: 'Run command', kind: 'execute', rawInput: { command: 'touch arbitrary' } },
  { toolCallId: 'mcp', title: 'codex__exec', kind: 'other', rawInput: {} },
  { toolCallId: 'other', title: 'Unknown action', kind: 'other' },
];
if (scenario === 'hyphenated-codex') permissionCalls.splice(0, permissionCalls.length, {
  toolCallId: 'hyphenated', title: 'use_tool', kind: 'other', rawInput: { tool_name: 'codex__foo-bar', tool_input: {} },
});
function nextPermission() {
  if (permissionIndex === permissionCalls.length) return send({ id: promptId, result: { stopReason: 'end_turn' } });
  send({ id: `permission-${permissionIndex}`, method: 'session/request_permission', params: {
    sessionId, toolCall: permissionCalls[permissionIndex++],
    options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
  } });
}
async function callCodex(promptId) {
  const config = servers.find((server) => server.name === 'codex');
  if (!config) throw new Error('Missing session-scoped codex MCP server');
  const mcp = spawn(config.command, config.args, { env: { ...process.env, ...Object.fromEntries(config.env.map(({ name, value }) => [name, value])) }, stdio: ['pipe', 'pipe', 'pipe'] });
  mcp.stderr.resume();
  const requests = new Map();
  let id = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    requests.set(++id, { resolve, reject });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  readline.createInterface({ input: mcp.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    const pending = requests.get(message.id);
    if (!pending) return;
    requests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  mcp.once('exit', () => {
    for (const pending of requests.values()) pending.reject(new Error('MCP proxy exited'));
    requests.clear();
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-grok', version: '1' } });
  const catalog = await request('tools/list', {});
  const name = process.env.GROK_FIXTURE_TOOL || catalog.tools[0]?.name;
  if (!name) throw new Error('Codex tool catalog is empty');
  const arguments_ = JSON.parse(process.env.GROK_FIXTURE_TOOL_ARGS || '{}');
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Calling Codex. ' } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'grok-codex-1', title: `codex__${name}`, kind: 'other', rawInput: arguments_, status: 'pending' });
  const result = await request('tools/call', { name, arguments: arguments_, _meta: { 'claudecode/toolUseId': 'grok-codex-1' } });
  record({ mcpResult: result });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'grok-codex-1', status: 'completed' });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Codex replied. Done.' } });
  send({ id: promptId, result: { stopReason: 'end_turn' } });
  mcp.stdin.end();
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  record(message);
  if (typeof message.id === 'string' && message.id.startsWith('permission-')) return nextPermission();
  if (message.method === 'initialize') {
    if (scenario === 'malformed') return process.stdout.write('{bad json}\n');
    if (scenario === 'oversized') return process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1));
    if (scenario === 'early-exit') return process.exit(3);
    return send({ id: message.id, result: { protocolVersion: 1,
      authMethods: [{ id: scenario === 'missing-auth' ? 'grok.com' : 'cached_token' }],
      agentCapabilities: { loadSession: scenario !== 'no-load', promptCapabilities: { image: true } },
    } });
  }
  if (message.method === 'authenticate') {
    return send({ id: message.id, ...(scenario === 'auth-error' ? { error: { code: -32000, message: 'secret authentication metadata must not escape', data: { token: 'secret' } } } : { result: {} }) });
  }
  if (message.method === 'session/new' || message.method === 'session/load') {
    if (scenario === 'session-error') return send({ id: message.id, error: { code: -32001, message: 'Session does not exist' } });
    sessionId = message.params.sessionId || sessionId;
    servers = message.params.mcpServers;
    if (scenario !== 'no-compact') update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] });
    if (scenario === 'load-replay') update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD TEXT' } });
    return send({ id: message.id, result: { sessionId, configOptions: [{ id: 'reasoning_effort', options: ['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, name: value })) }] } });
  }
  if (message.method === 'session/set_config_option') return send({ id: message.id, result: {} });
  if (message.method === 'session/prompt') {
    promptId = message.id;
    if (scenario === 'permissions' || scenario === 'hyphenated-codex') {
      if (scenario === 'hyphenated-codex') update({ sessionUpdate: 'tool_call', ...permissionCalls[0], status: 'pending' });
      return nextPermission();
    }
    if (scenario === 'mcp-call') {
      void callCodex(message.id).catch((error) => send({ id: message.id, error: { code: -32000, message: error.message } }));
      return;
    }
    if (scenario === 'hang') {
      const descendant = spawn(process.execPath, ['-e', 'process.on("SIGINT",()=>{}); setInterval(()=>{},1000)'], { stdio: 'inherit' });
      record({ descendant: descendant.pid, native: process.pid });
      return;
    }
    if (scenario === 'prompt-error' || scenario === 'compact-error') return send({ id: message.id, error: { code: -32602, message: 'Unsupported slash command' } });
    if (scenario === 'cancelled') return send({ id: message.id, result: { stopReason: 'cancelled' } });
    if (scenario === 'usage-empty') return send({ id: message.id, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 0, cachedReadTokens: 20 }, _meta: { totalTokens: 123 } } });
    if (scenario === 'usage-sparse') {
      update({ sessionUpdate: 'usage_update', usage: { inputTokens: 100, cachedReadTokens: 20 } });
      update({ sessionUpdate: 'usage_update', usage: { outputTokens: 9 } });
    }
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking.' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    if (scenario === 'mcp-wrapper') {
      update({ sessionUpdate: 'tool_call', toolCallId: 'mcp-1', title: 'use_tool', kind: 'other', status: 'pending' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'mcp-1', rawInput: { tool_name: 'codex__exec', tool_input: { code: 'return 1' } }, status: 'completed' });
    } else {
      update({ sessionUpdate: 'tool_call', toolCallId: 'mcp-1', title: 'codex__exec', kind: 'other', rawInput: { code: 'return 1' }, status: 'pending' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'mcp-1', title: 'codex__exec', kind: 'other', rawInput: { code: 'return 1' }, status: 'completed' });
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world.' } });
    send({ id: message.id, result: { stopReason: 'end_turn', ...(['usage', 'usage-combined'].includes(scenario) ? { usage: { inputTokens: 100, outputTokens: 9, cachedReadTokens: 20 } } : {}), ...(['usage-meta', 'usage-combined', 'usage-sparse'].includes(scenario) ? { _meta: { totalTokens: 123, secret: 'not forwarded' } } : {}) } });
  }
});
process.on('SIGINT', () => { record({ signal: 'SIGINT' }); process.exit(0); });
