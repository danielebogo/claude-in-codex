// A metadata-only provider CLI: no prompts, sessions, credentials or real services.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const provider = path.basename(process.argv[1]);
const fixture = JSON.parse(process.env.DISCOVERY_FIXTURE || '{}');
const data = fixture[provider] || {};
const hasClaudeOverrides = Object.keys(process.env).some((key) => key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_CONFIG_DIR');
const loggedIn = data.loggedIn !== false && (!data.shellOnly || hasClaudeOverrides);
if (fixture.record) fs.appendFileSync(fixture.record, JSON.stringify({ provider, args: process.argv.slice(2), cwd: process.cwd(), apiKey: !!process.env.XAI_API_KEY, hasClaudeOverrides }) + '\n');
if (data.fail) { process.stderr.write('private-token-do-not-print'); process.exit(1); }
if (data.hang) { setInterval(() => {}, 1000); }
else if (process.argv[2] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn, authMethod: 'claude.ai' }));
  process.exit(loggedIn ? 0 : 1);
} else {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (data.malformed) return process.stdout.write('not-json\n');
    if (data.flood) return process.stdout.write('x'.repeat(2 * 1024 * 1024));
    if (provider === 'claude') {
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { models: data.models ?? [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['high', 'max'] }] } } }) + '\n');
    } else {
      const result = message.method === 'initialize'
        ? { protocolVersion: 1, authMethods: [{ id: 'cached_token' }], _meta: { modelState: { availableModels: data.models ?? [{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000, reasoningEfforts: [{ value: 'low' }, { value: 'high' }] } }] } } }
        : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(message.method === 'authenticate' && data.loggedIn === false ? { error: { code: -1, message: 'private-token-do-not-print' } } : { result }) }) + '\n');
    }
  });
}
