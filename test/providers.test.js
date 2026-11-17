import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerForModel, providerState, nativeRuntime } from '../src/providers.js';
import { State } from '../src/state.js';

test('legacy Claude routes keep their runtime while Grok has an explicit adapter', () => {
  assert.equal(providerForModel({ claudeModel: 'claude-test' }), 'claude');
  assert.equal(providerForModel({ provider: 'grok', model: 'grok-4.7' }), 'grok');
  const config = { claudePath: '/test/claude', grokPath: '/test/grok' };
  const claude = nativeRuntime(config, { claudeModel: 'claude-test' });
  assert.equal(claude.config.claudePath, '/test/claude');
  const grok = nativeRuntime(config, { provider: 'grok', model: 'grok-4.7' });
  assert.match(grok.config.claudePath, /grokBridgeCli\.js$/);
  assert.equal(grok.config.nativeEnvironment.CODEX_BRIDGE_GROK_PATH, '/test/grok');
  assert.equal(grok.modelCfg.claudeModel, 'grok-4.7');
  assert.throws(() => providerForModel({ provider: 'unknown' }), /Unsupported provider/);
});

test('the same native session ID has separate ownership and acknowledgements per provider', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-provider-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const base = new State(path.join(directory, 'state.json'));
  t.after(() => { clearTimeout(base.timer); clearTimeout(base.catalogTimer); });
  const claude = providerState(base, 'claude');
  const grok = providerState(base, 'grok');
  assert.equal(claude, base);

  claude.recordTurn('same-session', 'claude-turn', 'claude-thread', ['claude-message']);
  grok.recordTurn('same-session', 'grok-turn', 'grok-thread', ['grok-message']);
  grok.recordAgentMessageIds('same-session', ['grok-delivery']);

  assert.equal(claude.ownerThread('same-session'), 'claude-thread');
  assert.equal(grok.ownerThread('same-session'), 'grok-thread');
  assert.equal(claude.isLatestTurn('same-session', 'grok-turn'), false);
  assert.equal(grok.isLatestTurn('same-session', 'claude-turn'), false);
  assert.equal(grok.isLatestTurn('same-session', 'grok-turn'), true);
  assert.deepEqual(claude.agentMessageIds('same-session'), ['claude-message']);
  assert.deepEqual(grok.agentMessageIds('same-session'), ['grok-delivery']);
  grok.setContextWindow('grok-test', 256000);
  assert.equal(base.contextWindow('grok-test'), 256000);
  assert.ok(base.timer, 'shared context changes must use the owning state save timer');
  assert.equal(Object.hasOwn(grok, 'timer'), false);
});
