// Installer discovery is metadata-only: never send a prompt or create a native session.
// Failure modes: absent/logged-out CLIs, stalled or incompatible protocols, invalid
// configuration, model slug collisions, and older routes still used by open chats.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { modelsFromConfig } from '../src/modelConfig.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const LABELS = { claude: 'Claude Code', grok: 'Grok' };
const LIMIT = 1024 * 1024;

// Each probe owns its process group, output budget, deadline and empty working
// directory. Provider diagnostics may contain account details, so never relay them.
async function probe(executable, args, options, onMessage, initial) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-model-probe-'));
  try {
    return await new Promise((resolve, reject) => {
      const env = { ...(options.env ?? process.env), GROK_DISABLE_AUTOUPDATER: '1', GROK_MEMORY: '0', DISABLE_AUTOUPDATER: '1' };
      delete env.XAI_API_KEY;
      // launchd does not inherit the installer's shell overrides. Discover the
      // persistent Claude login and routing the background service will use.
      for (const key of Object.keys(env)) {
        if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_') || ['CLAUDE_CONFIG_DIR', 'CLAUDECODE'].includes(key)) delete env[key];
      }
      const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '', bytes = 0, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Discovery has no work to save. Kill the entire isolated probe group so
        // a helper retaining stdout cannot outlive the installer's deadline.
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        error ? reject(error) : resolve(value);
      };
      const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
      const timer = setTimeout(() => finish(new Error('CLI discovery timed out; retry after checking the CLI login.')), options.timeoutMs ?? 30000);
      child.on('error', () => finish(new Error('CLI could not be started; check its executable path.')));
      child.stdin.on('error', () => finish(new Error('CLI discovery input closed unexpectedly.')));
      child.stdout.setEncoding('utf8');
      const count = (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > LIMIT) finish(new Error('CLI discovery output exceeded its limit.'));
      };
      child.stderr.on('data', count);
      child.stdout.on('data', (chunk) => {
        count(chunk);
        if (settled) return;
        buffer += chunk;
        if (!onMessage) return;
        let newline;
        while (!settled && (newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try { onMessage(JSON.parse(line), send, finish); }
          catch { finish(new Error('CLI returned an incompatible discovery response; update the CLI and retry.')); }
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        if (!onMessage && code === 0) {
          try { finish(null, JSON.parse(buffer)); }
          catch { finish(new Error('CLI returned invalid discovery JSON.')); }
        } else finish(new Error('CLI discovery failed; update the CLI and check its login.'));
      });
      if (initial) send(initial);
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function normalizeModels(provider, entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('CLI returned no model catalog.');
  const seen = new Set();
  const models = [];
  for (const entry of entries) {
    const id = provider === 'grok' ? entry?.modelId : entry?.resolvedModel || entry?.value;
    const name = provider === 'grok' ? entry?.name : entry?.displayName;
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) throw new Error('CLI returned an invalid model catalog.');
    // These Claude entries select a mode/account default, rather than one model.
    if (provider === 'claude' && ['default', 'opusplan'].includes(entry.value)) continue;
    if (provider === 'claude' && ['opus', 'sonnet', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]'].includes(id)) throw new Error('CLI did not resolve model aliases; update Claude Code and retry.');
    if (seen.has(id)) continue;
    seen.add(id);
    const slug = provider === 'claude' && !id.startsWith('claude-') ? `claude-${id}` : id;
    const model = { slug, displayName: name, provider, model: id, discovered: true };
    if (typeof entry.description === 'string') model.description = entry.description;
    const efforts = provider === 'grok' ? entry._meta?.reasoningEfforts?.map((effort) => effort.value ?? effort.id) : entry.supportedEffortLevels;
    if (efforts !== undefined) {
      if (!Array.isArray(efforts) || efforts.some((effort) => !EFFORTS.includes(effort) || (provider === 'grok' && effort === 'max'))) throw new Error('CLI returned unsupported model capabilities.');
      model.reasoningEfforts = [...new Set(efforts)];
    } else if (entry.supportsEffort === false) model.reasoningEfforts = [];
    const context = entry._meta?.totalContextTokens;
    if (Number.isSafeInteger(context) && context > 0) model.contextWindow = context;
    models.push(model);
  }
  if (!models.length) throw new Error('CLI returned no selectable models.');
  return models;
}

/** Reads the CLI's own model catalog, using its existing login without inference. */
export async function discoverProvider(provider, executable, options = {}) {
  try {
    if (provider === 'claude') {
      const auth = await probe(executable, ['auth', 'status'], options);
      if (auth?.loggedIn !== true) throw new Error('CLI is not logged in.');
      const models = await probe(executable, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}', '--setting-sources', 'user'], options, (message, _send, finish) => {
        if (message.type !== 'control_response' || message.response?.request_id !== 'catalog') return;
        if (message.response.subtype !== 'success') return finish(new Error('CLI model initialization failed.'));
        finish(null, message.response.response?.models);
      }, { type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize', hooks: {} } });
      return normalizeModels(provider, models);
    }
    if (provider !== 'grok') throw new Error('Unsupported provider.');
    let models;
    return await probe(executable, ['agent', '--no-leader', 'stdio'], options, (message, send, finish) => {
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error) return finish(new Error('CLI cached login failed.'));
      if (message.id === 1) {
        if (message.result?.protocolVersion !== 1 || !message.result.authMethods?.some((method) => method.id === 'cached_token')) return finish(new Error('CLI does not support cached-login discovery.'));
        models = normalizeModels(provider, message.result._meta?.modelState?.availableModels);
        send({ jsonrpc: '2.0', id: 2, method: 'authenticate', params: { methodId: 'cached_token', _meta: { headless: true } } });
      } else finish(null, models);
    }, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codex-bridge-model-discovery', version: '1' } } });
  } catch (error) {
    throw new Error(`${LABELS[provider] ?? 'Provider'}: ${error.message} ${provider === 'claude' ? 'Run claude auth login if needed.' : 'Sign in with the Grok CLI if needed.'}`);
  }
}

function findExecutable(provider, config, options) {
  const env = options.env ?? process.env;
  const override = env[`CODEX_CLAUDE_BRIDGE_${provider.toUpperCase()}`];
  const home = options.home ?? os.homedir();
  const candidates = override ? [override] : [config[`${provider}Path`], ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, provider)), path.join(home, provider === 'grok' ? '.grok/bin/grok' : '.local/bin/claude')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return path.resolve(candidate); } catch { /* Try the next known location. */ }
  }
  return null;
}

/** Validates and prepares an installation without changing installed files. */
export async function prepareInstallation(configFile, port, options = {}) {
  let config = {}, exists = false;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read bridge config.json; repair its JSON before installing.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected a bridge configuration object.');
  const previous = modelsFromConfig(config);
  const results = await Promise.all(['claude', 'grok'].map(async (provider) => {
    const executable = findExecutable(provider, config, options);
    if (!executable) return { provider, warning: `${LABELS[provider]} CLI not found; skipped.` };
    try { return { provider, executable, models: await discoverProvider(provider, executable, options) }; }
    catch (error) { return { provider, warning: error.message }; }
  }));
  const available = results.filter((result) => result.models);
  if (!available.length) throw new Error(`No provider is ready. Install and sign in to Claude Code or Grok, then rerun the installer. ${results.map((result) => result.warning).join(' ')}`);
  const providers = new Set(available.map((result) => result.provider));
  // Existing implicit defaults are real routes too. Retain them during migration;
  // on a fresh Grok-only installation don't invent a visible Claude catalog.
  const models = (exists || config.models !== undefined ? previous : previous.filter((model) => providers.has(model.provider ?? 'claude'))).map((model) => ({ ...model, ...(config.models === undefined ? { discovered: true } : {}) }));
  for (const model of models) if (model.discovered) model.discoveryHidden = true;
  for (const result of available) {
    config[`${result.provider}Path`] = result.executable;
    for (const model of result.models) {
      const matches = models.filter((old) => (old.provider ?? 'claude') === model.provider && (old.model ?? old.claudeModel) === model.model);
      if (matches.length) {
        for (const old of matches) if (old.discovered) {
          // Keep manual labels, hidden flags and defaults; refresh capabilities
          // and availability only on routes owned by automatic discovery.
          delete old.discoveryHidden;
          for (const key of ['reasoningEfforts', 'contextWindow']) {
            delete old[key];
            if (model[key] !== undefined) old[key] = model[key];
          }
          old.model = model.model;
        }
      } else {
        if (models.some((old) => old.slug === model.slug)) throw new Error(`Model slug collision (${model.slug}); rename the existing manual route before installing.`);
        models.push(model);
      }
    }
  }
  config.port = port;
  config.models = models;
  modelsFromConfig(config);
  return { config, warnings: results.filter((result) => result.warning).map((result) => result.warning), providers: available.map((result) => ({ provider: result.provider, count: result.models.length, executable: result.executable })) };
}

async function main() {
  const [configFile, port, home] = process.argv.slice(2);
  const result = await prepareInstallation(configFile, Number(port), { home });
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  const temporary = `${configFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(result.config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, configFile);
  } finally { fs.rmSync(temporary, { force: true }); }
  for (const warning of result.warnings) console.error(warning);
  for (const { provider, count } of result.providers) console.error(`${LABELS[provider]}: discovered ${count} models.`);
  process.stdout.write([...new Set(result.providers.map(({ executable }) => path.dirname(executable)))].join(path.delimiter));
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
