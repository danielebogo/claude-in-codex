#!/usr/bin/env node
// Internal Claude-stream compatibility transport. Grok keeps its own login and
// sessions; only this turn's Codex MCP servers are supplied over ACP.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { createProcessStopper, closeStdioAfterExit, hasPendingProcessCleanup } from './processControl.js';

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const SETUP_TIMEOUT_MS = 30000;
const PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const HELP = 'Internal Grok ACP bridge: -p --input-format stream-json --output-format stream-json|json --model MODEL --permission-mode MODE --permission-prompts none --effort low|medium|high|xhigh --include-partial-messages --resume SESSION';

function parseArgs(args) {
  const options = { output: 'stream-json', model: 'grok-4.7', permission: 'default' };
  const values = {
    '--input-format': 'input', '--output-format': 'output', '--model': 'model',
    '--permission-mode': 'permission', '--permission-prompts': 'prompts', '--effort': 'effort',
    '--resume': 'resume', '--append-system-prompt': 'instructions', '--mcp-config': 'mcp',
    '--allowedTools': 'allowedTools', '--disallowedTools': 'disallowedTools',
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['-p', '--verbose', '--include-partial-messages'].includes(arg)) continue;
    if (arg === '--dangerously-skip-permissions') { options.permission = 'bypassPermissions'; continue; }
    if (arg === '--fork-session') throw new Error('Grok ACP cannot fork sessions; start a new session and replay the conversation.');
    if (arg === '/compact') { options.compact = true; continue; }
    if (!values[arg]) throw new Error(`Unsupported Grok bridge argument: ${arg}`);
    if (args[index + 1] === undefined) throw new Error(`Missing value for ${arg}.`);
    options[values[arg]] = args[++index];
  }
  if (!['stream-json', 'json'].includes(options.output)) throw new Error('Grok bridge output format must be stream-json or json.');
  if (options.input && options.input !== 'stream-json') throw new Error('Grok bridge input format must be stream-json.');
  if (options.prompts && options.prompts !== 'none') throw new Error('Grok bridge cannot show interactive permission prompts.');
  if (!['default', 'dontAsk', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'].includes(options.permission)) throw new Error('Unsupported Grok permission mode.');
  if (options.effort === 'max') options.effort = 'xhigh';
  if (options.effort && !['low', 'medium', 'high', 'xhigh'].includes(options.effort)) throw new Error('Grok reasoning effort must be low, medium, high, or xhigh.');
  return options;
}

async function readPrompt(options) {
  let input = '';
  let bytes = 0;
  const decoder = new StringDecoder('utf8');
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('Grok prompt exceeds the 32 MiB bridge input limit.');
    input += decoder.write(chunk);
  }
  input += decoder.end();
  if (options.compact || input.trimStart().startsWith('/compact')) {
    if (!options.resume) throw new Error('Grok compaction requires an existing session ID.');
    options.compact = true;
    return [{ type: 'text', text: input.trim() || '/compact' }];
  }
  let envelope;
  try { envelope = JSON.parse(input); } catch { throw new Error('Expected one valid Claude user JSON envelope on stdin.'); }
  if (envelope?.type !== 'user' || envelope.message?.role !== 'user' || !Array.isArray(envelope.message.content)) throw new Error('Expected a user message with a content array.');
  const blocks = envelope.message.content.map((block) => {
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
    if (block.type === 'image') {
      if (block.source?.type === 'url') throw new Error('URL image input is not supported by the Grok ACP bridge; provide an inline base64 image.');
      if (block.source?.type === 'base64' && typeof block.source.data === 'string' && typeof block.source.media_type === 'string') return { type: 'image', data: block.source.data, mimeType: block.source.media_type };
    }
    throw new Error(`Unsupported Grok prompt content type: ${String(block.type)}.`);
  });
  if (!blocks.length) throw new Error('Grok prompt content is empty.');
  if (options.instructions) blocks.unshift({ type: 'text', text: `[Codex bridge instructions appended for this turn]\nThese instructions supplement the native Grok system instructions.\nCodex tools described as mcp__codex__NAME are exposed by Grok as codex__NAME; use that native alias when calling them.\n${options.instructions}\n[End Codex bridge instructions]` });
  return blocks;
}

function mcpServers(options) {
  if (!options.mcp) return [];
  let config;
  try { config = JSON.parse(options.mcp); } catch { throw new Error('Grok MCP configuration must be valid JSON.'); }
  if (!config?.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) throw new Error('Grok MCP configuration requires an mcpServers object.');
  return Object.entries(config.mcpServers).map(([name, server]) => {
    if (!server || typeof server.command !== 'string' || !server.command) throw new Error(`Grok MCP server ${name} requires a stdio command.`);
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))) throw new Error(`Grok MCP server ${name} arguments must be strings.`);
    if (server.env !== undefined && (!server.env || typeof server.env !== 'object' || Array.isArray(server.env) || Object.values(server.env).some((value) => typeof value !== 'string'))) throw new Error(`Grok MCP server ${name} environment values must be strings.`);
    return { name, command: server.command, args: server.args || [], env: Object.entries(server.env || {}).map(([key, value]) => ({ name: key, value })) };
  });
}

function nativeName(title) {
  return typeof title === 'string' && title.startsWith('codex__') ? `mcp__${title}` : title;
}

function toolDetails(call) {
  // Grok exposes deferred MCP tools through use_tool; Codex displays the actual
  // offered tool itself, so unwrap only the verified Codex namespace.
  if (call.title === 'use_tool' && /^codex__[A-Za-z0-9_-]+$/.test(call.rawInput?.tool_name || '')) {
    return { name: nativeName(call.rawInput.tool_name), input: call.rawInput.tool_input || {} };
  }
  return { name: nativeName(call.title || call.name || ''), input: call.rawInput || {} };
}

function permissionOutcome(params, options, sessionId) {
  const call = params?.toolCall || {};
  const { name } = toolDetails(call);
  const deniedNames = new Set((options.disallowedTools || '').split(','));
  let allowed = params?.sessionId === sessionId && !deniedNames.has(name);
  if (allowed) {
    const codex = /^mcp__codex__[A-Za-z0-9_-]+$/.test(name);
    const readable = ['read', 'search'].includes(call.kind);
    const editable = options.permission === 'acceptEdits' && call.kind === 'edit';
    allowed = codex || readable || editable || options.permission === 'bypassPermissions';
  }
  const option = (params?.options || []).find((entry) => entry.kind === (allowed ? 'allow_once' : 'reject_once'));
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
}

function observedUsage(source) {
  if (!source || typeof source !== 'object') return undefined;
  const usage = {};
  for (const [target, keys] of Object.entries({
    input_tokens: ['input_tokens', 'inputTokens'], output_tokens: ['output_tokens', 'outputTokens'],
    total_tokens: ['total_tokens', 'totalTokens'],
    cache_read_input_tokens: ['cache_read_input_tokens', 'cachedReadTokens'],
    cache_creation_input_tokens: ['cache_creation_input_tokens', 'cachedWriteTokens'],
  })) {
    const value = keys.map((key) => source[key]).find((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0);
    if (value !== undefined) usage[target] = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}

/** Owns bounded JSON-RPC lines and deadlines; never forwards native auth metadata or stderr. */
class AcpConnection {
  constructor(child, onUpdate, onRequest) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 0;
    this.failure = null;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      if (this.failure) return;
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) return this.fail(new Error('Grok ACP line exceeded the 4 MiB limit.'));
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { return this.fail(new Error('Grok ACP returned malformed JSON.')); }
        if (!message || message.jsonrpc !== '2.0') return this.fail(new Error('Grok ACP returned an invalid JSON-RPC message.'));
        if (message.method && message.id !== undefined) {
          try { this.send({ id: message.id, ...onRequest(message) }); } catch (error) { this.fail(error); }
        } else if (message.method === 'session/update') {
          try { onUpdate(message.params); } catch (error) { this.fail(error); }
        } else if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) {
            const detail = pending.method === 'authenticate' ? 'Cached Grok login could not be used. Sign in with the Grok CLI separately, then retry.' : String(message.error.message || 'Native request rejected').slice(0, 2000);
            pending.reject(new Error(`Grok ${pending.method} failed: ${detail}`));
          } else if (!Object.hasOwn(message, 'result')) pending.reject(new Error(`Grok ${pending.method} returned no result.`));
          else pending.resolve(message.result);
        }
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) this.fail(new Error('Grok ACP line exceeded the 4 MiB limit.'));
    });
    child.on('error', () => this.fail(new Error('Could not start the Grok executable. Check grokPath and the existing Grok installation.')));
    child.on('exit', (code, signal) => this.fail(new Error(`Grok ACP exited before completing the request (${signal || code}).`)));
    child.stdin.on('error', () => this.fail(new Error('Grok ACP input pipe closed before the request completed.')));
    // Drain a bounded tail for process hygiene; native stderr is never emitted because it may contain login metadata.
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  }

  send(message) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  request(method, params, timeoutMs = SETUP_TIMEOUT_MS) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Grok ${method} timed out after ${timeoutMs / 1000} seconds.`)), timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { this.fail(error); }
    });
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

/** Translates ACP chunks into the shared runner's stream without replaying text in aggregates. */
class ClaudeEvents {
  constructor(options) {
    this.options = options;
    this.sessionId = null;
    this.active = false;
    this.messageId = null;
    this.blocks = [];
    this.index = -1;
    this.tools = new Set();
    this.toolCalls = new Map();
    this.text = '';
  }

  emit(event) {
    if (this.options.output === 'stream-json') process.stdout.write(`${JSON.stringify(event)}\n`);
  }

  stream(event) { this.emit({ type: 'stream_event', session_id: this.sessionId, event }); }

  chunk(type, text) {
    if (!this.messageId) {
      this.messageId = randomUUID();
      this.stream({ type: 'message_start', message: { id: this.messageId, role: 'assistant', content: [] } });
    }
    if (this.blocks.at(-1)?.type !== type) {
      if (this.index >= 0) this.stream({ type: 'content_block_stop', index: this.index });
      this.index++;
      this.blocks.push(type === 'text' ? { type, text: '' } : { type, thinking: '' });
      this.stream({ type: 'content_block_start', index: this.index, content_block: this.blocks.at(-1) });
    }
    const key = type === 'text' ? 'text' : 'thinking';
    this.blocks.at(-1)[key] += text;
    if (type === 'text') this.text += text;
    this.stream({ type: 'content_block_delta', index: this.index, delta: { type: `${key}_delta`, [key]: text } });
  }

  update(params) {
    if (params?.update?.sessionUpdate === 'available_commands_update') {
      this.compactAvailable = params.update.availableCommands?.some((command) => command.name === 'compact');
      return;
    }
    if (!this.active || params?.sessionId !== this.sessionId) return;
    const update = params.update || {};
    if (['agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate)) {
      if (update.content?.type !== 'text' || typeof update.content.text !== 'string') throw new Error('Grok returned unsupported non-text assistant content.');
      this.chunk(update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking', update.content.text);
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      if (!update.toolCallId) return;
      const call = { ...this.toolCalls.get(update.toolCallId), ...update };
      this.toolCalls.set(update.toolCallId, call);
      if (!call.title || this.tools.has(call.toolCallId)) return;
      // The wrapper's first update can precede its argument delta. Wait until
      // its identity is known, otherwise Codex would briefly show a duplicate.
      if (call.title === 'use_tool' && !call.rawInput?.tool_name) return;
      this.tools.add(call.toolCallId);
      const tool = toolDetails(call);
      this.emit({ type: 'assistant', session_id: this.sessionId, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: call.toolCallId, ...tool }] } });
    } else if (update.sessionUpdate === 'usage_update') {
      const usage = observedUsage(update.usage || update);
      if (usage) this.usage = { ...this.usage, ...usage };
    }
  }

  finish(result) {
    if (this.index >= 0) this.stream({ type: 'content_block_stop', index: this.index });
    const reported = { ...this.usage, ...observedUsage(result?._meta), ...observedUsage(result?.usage) };
    const usage = Object.keys(reported).length ? reported : undefined;
    if (this.messageId) {
      this.stream({ type: 'message_stop' });
      this.emit({ type: 'assistant', session_id: this.sessionId, message: { id: this.messageId, role: 'assistant', content: this.blocks, ...(usage ? { usage } : {}) } });
    }
    return usage;
  }

  result(error, usage) {
    const event = { type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: Boolean(error), session_id: this.sessionId, result: error ? error.message : this.text, ...(usage ? { usage } : {}) };
    if (this.options.output === 'json') process.stdout.write(`${JSON.stringify(event)}\n`);
    else this.emit(event);
  }
}

async function run() {
  if (process.argv.slice(2).includes('--help')) { process.stdout.write(`${HELP}\n`); return; }
  let options = { output: process.argv.includes('json') ? 'json' : 'stream-json' };
  let events = new ClaudeEvents(options);
  let child;
  let stopper;
  let rpc;
  let interrupted = null;
  const interrupt = (signal) => {
    interrupted = signal;
    rpc?.fail(new Error(`Grok turn interrupted by ${signal}.`));
    void stopper?.stop();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    options = parseArgs(process.argv.slice(2));
    events = new ClaudeEvents(options);
    const prompt = await readPrompt(options);
    const servers = mcpServers(options);
    if (interrupted) throw new Error(`Grok turn interrupted by ${interrupted}.`);
    const args = ['agent', '--no-leader', '-m', options.model];
    if (options.effort) args.push('--reasoning-effort', options.effort);
    args.push('stdio');
    const env = {
      ...process.env,
      GROK_DISABLE_AUTOUPDATER: '1',
      GROK_SANDBOX_AUTO_ALLOW_BASH: '0',
      GROK_SANDBOX: options.permission === 'bypassPermissions' ? 'off' : options.permission === 'acceptEdits' ? 'workspace' : 'read-only',
    };
    delete env.XAI_API_KEY;
    child = spawn(process.env.CODEX_BRIDGE_GROK_PATH || 'grok', args, { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    stopper = createProcessStopper(child, { graceMs: 500, killGraceMs: 500 });
    closeStdioAfterExit(child, 1200);
    rpc = new AcpConnection(child, (params) => events.update(params), (message) => message.method === 'session/request_permission'
      ? { result: permissionOutcome(message.params, options, events.sessionId) }
      : { error: { code: -32601, message: 'Codex Grok bridge does not provide this ACP client method.' } });
    const init = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codex-grok-bridge', version: '1' } });
    if (init?.protocolVersion !== 1) throw new Error('Grok returned an unsupported ACP protocol version.');
    if (!init.authMethods?.some((method) => method.id === 'cached_token')) throw new Error('Grok has no cached-token authentication method. Sign in with the Grok CLI separately, then retry.');
    await rpc.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } });
    if (options.resume && !init.agentCapabilities?.loadSession) throw new Error('Installed Grok does not support ACP session/load.');
    if (prompt.some((block) => block.type === 'image') && !init.agentCapabilities?.promptCapabilities?.image) throw new Error('Installed Grok does not support ACP image prompts.');
    const session = await rpc.request(options.resume ? 'session/load' : 'session/new', { ...(options.resume ? { sessionId: options.resume } : {}), cwd: process.cwd(), mcpServers: servers });
    events.sessionId = options.resume || session?.sessionId;
    if (typeof events.sessionId !== 'string' || !events.sessionId) throw new Error('Grok session/new returned no session ID.');
    if (options.resume && session?.sessionId && session.sessionId !== options.resume) throw new Error('Grok session/load returned a different session ID.');
    if (options.compact && !events.compactAvailable) throw new Error('Installed Grok did not advertise the native /compact command; compaction cannot be confirmed.');
    if (options.effort && session?.configOptions?.some((option) => option.id === 'reasoning_effort')) await rpc.request('session/set_config_option', { sessionId: events.sessionId, configId: 'reasoning_effort', value: options.effort });
    events.emit({ type: 'system', subtype: 'init', session_id: events.sessionId, model: options.model });
    events.active = true;
    const result = await rpc.request('session/prompt', { sessionId: events.sessionId, prompt }, PROMPT_TIMEOUT_MS);
    events.active = false;
    const usage = events.finish(result);
    if (!result?.stopReason || ['cancelled', 'refusal'].includes(result.stopReason)) throw new Error(`Grok prompt did not complete (${result?.stopReason || 'missing stop reason'}).`);
    events.result(null, usage);
  } catch (error) {
    process.exitCode = interrupted === 'SIGTERM' ? 143 : interrupted ? 130 : 1;
    events.result(error);
  } finally {
    rpc?.fail(new Error('Grok ACP transport closed.'));
    if (stopper) {
      await stopper.stop();
      // Keep escalation timers alive even if Grok exits before its MCP children.
      const deadline = Date.now() + 5000;
      while (hasPendingProcessCleanup() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

process.stdout.on('error', () => { process.emit('SIGTERM', 'SIGTERM'); });
void run();
