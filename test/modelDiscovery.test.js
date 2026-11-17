import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverProvider, prepareInstallation } from '../scripts/discover-models.js';
import { claudeEntries } from '../src/catalog.js';

function fixture(t, providers = ['claude', 'grok'], data = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-discovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  for (const provider of providers) fs.writeFileSync(path.join(bin, provider), `#!${process.execPath}\n${fs.readFileSync(new URL('./fixtures/discovery-cli.js', import.meta.url), 'utf8')}`, { mode: 0o755 });
  const configFile = path.join(directory, 'config.json');
  const record = path.join(directory, 'calls.jsonl');
  const options = { home: directory, env: { PATH: bin, DISCOVERY_FIXTURE: JSON.stringify({ ...data, record }), XAI_API_KEY: 'must-be-removed' }, timeoutMs: 5000 };
  return { directory, bin, configFile, record, options, prepare: () => prepareInstallation(configFile, 18787, options) };
}

test('test_discovery_bothProviders_returnsPinnedModelsAndNativeCapabilitiesWithoutPrompts', async (t) => {
  const f = fixture(t);

  const result = await f.prepare();

  assert.equal(result.config.claudePath, path.join(f.bin, 'claude'));
  assert.equal(result.config.grokPath, path.join(f.bin, 'grok'));
  assert.equal(result.config.models.find((m) => m.slug === 'claude-opus-5-5').model, 'claude-opus-5-5');
  const grok = result.config.models.find((m) => m.slug === 'grok-4.7');
  assert.deepEqual(grok.reasoningEfforts, ['low', 'high']);
  assert.equal(grok.contextWindow, 256000);
  assert.equal(fs.existsSync(f.configFile), false, 'prepare does not change installed configuration');
  const calls = fs.readFileSync(f.record, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.some((call) => call.args.includes('session/prompt')), false);
  assert.equal(calls.filter((call) => call.provider === 'grok').some((call) => call.apiKey), false);
  assert.equal(calls.every((call) => call.cwd !== process.cwd()), true);
});

for (const provider of ['claude', 'grok']) test(`test_discovery_${provider}Only_doesNotRequireOtherProvider`, async (t) => {
  const f = fixture(t, [provider]);

  const result = await f.prepare();

  const visible = result.config.models.filter((m) => !m.hidden && !m.discoveryHidden);
  assert.ok(visible.length);
  assert.equal(visible.every((m) => (m.provider ?? 'claude') === provider), true);
});

test('test_discovery_noProviders_failsBeforeChangingConfiguration', async (t) => {
  const f = fixture(t, []);

  await assert.rejects(f.prepare(), /Claude Code|Grok/);

  assert.equal(fs.existsSync(f.configFile), false);
});

for (const data of [{ loggedIn: false }, { fail: true }, { malformed: true }, { models: [] }, { models: 'invalid' }, { models: [{}] }, { flood: true }, { hang: true }]) {
  test(`test_discovery_grokFailure_${Object.keys(data)[0]}_isBoundedAndPrivate`, async (t) => {
    const f = fixture(t, ['grok'], { grok: data });

    await assert.rejects(discoverProvider('grok', path.join(f.bin, 'grok'), { ...f.options, timeoutMs: data.hang ? 100 : 5000 }), (error) => {
      assert.doesNotMatch(error.message, /private-token|must-be-removed/);
      assert.match(error.message, /Grok/);
      return true;
    });
  });
}

for (const failed of ['claude', 'grok']) test(`test_discovery_${failed}Unavailable_installsOtherProviderAndReportsLogin`, async (t) => {
  const f = fixture(t, ['claude', 'grok'], { [failed]: { loggedIn: false } });

  const result = await f.prepare();

  assert.ok(result.warnings.some((warning) => warning.includes(failed === 'claude' ? 'Claude' : 'Grok')));
  assert.ok(result.config.models.filter((m) => !m.hidden && !m.discoveryHidden).every((m) => (m.provider ?? 'claude') !== failed));
});

test('test_discovery_reinstall_preservesManualModelsSettingsAndHiddenHistoricalRoutes', async (t) => {
  const f = fixture(t);
  const manual = { slug: 'my-opus', displayName: 'My Opus', claudeModel: 'claude-opus-5-5', hidden: true, priority: 42, defaultEffort: 'max' };
  fs.writeFileSync(f.configFile, JSON.stringify({ models: [manual], extraSystemPrompt: 'keep', hiddenModels: ['gpt-old'], grokPath: path.join(f.bin, 'grok') }));

  const first = await f.prepare();
  fs.writeFileSync(f.configFile, JSON.stringify(first.config));
  const second = await f.prepare();

  assert.deepEqual(second.config.models.find((m) => m.slug === 'my-opus'), manual);
  assert.equal(second.config.models.some((m) => m.slug === 'claude-opus-5-5'), false);
  assert.equal(second.config.extraSystemPrompt, 'keep');
  assert.deepEqual(second.config.hiddenModels, ['gpt-old']);
  assert.deepEqual(second.config, first.config);
});

test('test_discovery_refresh_hidesRemovedAutomaticModelsButKeepsManualVisibility', async (t) => {
  const f = fixture(t, ['grok']);
  const first = await f.prepare();
  first.config.models.push({ slug: 'manual', displayName: 'Manual', provider: 'grok', model: 'grok-custom' });
  fs.writeFileSync(f.configFile, JSON.stringify(first.config));
  f.options.env.DISCOVERY_FIXTURE = JSON.stringify({ grok: { models: [{ modelId: 'grok-new', name: 'Grok New' }] } });

  const second = await f.prepare();

  assert.equal(second.config.models.find((m) => m.slug === 'grok-4.7').discoveryHidden, true);
  assert.equal(second.config.models.find((m) => m.slug === 'manual').discoveryHidden, undefined);
  fs.writeFileSync(f.configFile, JSON.stringify(second.config));
  f.options.env.DISCOVERY_FIXTURE = JSON.stringify({});
  const third = await f.prepare();
  assert.equal(third.config.models.find((m) => m.slug === 'grok-4.7').discoveryHidden, undefined);
});

test('test_discovery_existingDefaultCatalog_retainsRetiredHiddenRouteOnGrokOnlyMigration', async (t) => {
  const f = fixture(t, ['grok']);
  fs.writeFileSync(f.configFile, JSON.stringify({ logLevel: 'debug' }));

  const result = await f.prepare();

  assert.equal(result.config.models.find((m) => m.slug === 'claude-fable-5-1').hidden, true);
  assert.equal(result.config.models.find((m) => m.slug === 'claude-opus-5-5').discoveryHidden, true);
});

for (const original of ['not-json', '[]', '{"models":{}}', '{"models":[{"slug":"bad"}]}']) test('test_discovery_invalidConfiguration_failsWithoutWriting', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.configFile, original);

  await assert.rejects(f.prepare(), /config|model/i);

  assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
  assert.equal(fs.existsSync(f.record), false);
});

test('test_discovery_slugCollision_neverReassignsManualRoute', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.configFile, JSON.stringify({ models: [{ slug: 'grok-4.7', displayName: 'Manual Claude', model: 'claude-manual' }] }));

  await assert.rejects(f.prepare(), /collision/i);
});

test('test_catalog_discoveredCapabilitiesAndRetirement_areAdvertisedAccurately', () => {
  const entries = claudeEntries({ models: [{ slug: 'grok-4.5', provider: 'grok', displayName: 'Grok 4.5', reasoningEfforts: ['low', 'medium', 'high'], contextWindow: 256000, discoveryHidden: true }] }, { contextWindow: () => null });

  assert.deepEqual(entries[0].supported_reasoning_levels.map((level) => level.effort), ['low', 'medium', 'high']);
  assert.equal(entries[0].visibility, 'hide');
});

test('test_discovery_claudeAliasWithoutResolvedModel_requestsCLIUpdateInsteadOfMutableRoute', async (t) => {
  const f = fixture(t, ['claude'], { claude: { models: [{ value: 'opus', displayName: 'Opus' }] } });

  await assert.rejects(f.prepare(), /update/i);
});

test('test_catalog_modelWithoutEffort_hasNoReasoningChoices', () => {
  const entries = claudeEntries({ models: [{ slug: 'claude-fast', displayName: 'Fast', reasoningEfforts: [] }], defaultContextWindow: 200000 }, { contextWindow: () => null });

  assert.deepEqual(entries[0].supported_reasoning_levels, []);
  assert.equal(entries[0].default_reasoning_level, 'none');
});

test('test_discovery_shellOnlyClaudeCredentials_doNotAdvertiseAnUnauthenticatedService', async (t) => {
  const f = fixture(t, ['claude'], { claude: { shellOnly: true } });
  Object.assign(f.options.env, { ANTHROPIC_API_KEY: 'private-key', CLAUDE_CODE_OAUTH_TOKEN: 'private-token', CLAUDE_CONFIG_DIR: '/shell-only-login' });

  await assert.rejects(f.prepare(), /login|log.*in/);

  assert.equal(fs.existsSync(f.configFile), false);
});

test('test_discovery_persistedClaudeLogin_ignoresShellOnlyOverrides', async (t) => {
  const f = fixture(t, ['claude']);
  Object.assign(f.options.env, { ANTHROPIC_API_KEY: 'private-key', ANTHROPIC_BASE_URL: 'https://shell-only.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'private-token', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/shell-only-login' });

  const result = await f.prepare();

  assert.ok(result.providers.some((provider) => provider.provider === 'claude'));
  const calls = fs.readFileSync(f.record, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.some((call) => call.hasClaudeOverrides), false);
});
