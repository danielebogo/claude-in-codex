import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDebugDumper } from '../src/debugDumps.js';

const ownedName = (index) => `bridge-debug-1000-${String(index).padStart(32, '0')}.json`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-dumps-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, 'dumps') };
}

test('test_dump_sensitiveRecursiveInput_recordsOnlyFixedStructuralMetadata', (t) => {
  const { directory } = fixture(t);
  const secret = 'SECRET_PROMPT_TOKEN_PATH_IMAGE';
  const input = { [secret]: secret, model: secret, instructions: [secret], images: [{ data: secret }], tools: [{ arguments: secret, result: secret }], number: 123456789, flag: true };
  input.cycle = input;
  Object.defineProperty(input, 'getter', { enumerable: true, get() { throw new Error('must not access input getter'); } });
  const file = createDebugDumper(directory)(secret, input);
  const serialized = fs.readFileSync(file, 'utf8');
  const result = JSON.parse(serialized);
  assert.doesNotMatch(serialized, /SECRET|instructions|images|arguments|result|123456789/);
  assert.equal(result.kind, 'other');
  assert.ok(result.structure.strings >= 5);
  assert.equal(result.structure.cycles, 1);
  assert.equal(result.structure.accessors, 1);
});

test('test_dump_permissiveExistingPermissions_makesDirectoryAndFilesPrivate', (t) => {
  const { directory } = fixture(t);
  fs.mkdirSync(directory, { mode: 0o777 });
  fs.chmodSync(directory, 0o777);
  const existing = path.join(directory, ownedName(1));
  fs.writeFileSync(existing, '{}', { mode: 0o666 });
  fs.chmodSync(existing, 0o666);
  const previous = process.umask(0);
  let file;
  try {
    file = createDebugDumper(directory)('request', {});
  } finally {
    process.umask(previous);
  }
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(existing).mode & 0o777, 0o600);
});

test('test_dump_symlinkDirectory_rejectsWithoutWritingTarget', (t) => {
  const { root, directory } = fixture(t);
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, directory);
  assert.throws(() => createDebugDumper(directory)('request', {}), /symlink|regular|directory/i);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('test_dump_ownedSymlinkOrHardlink_rejectsWithoutModifyingTarget', (t) => {
  const { root, directory } = fixture(t);
  fs.mkdirSync(directory);
  const target = path.join(root, 'target');
  fs.writeFileSync(target, 'private-target', { mode: 0o644 });
  const owned = path.join(directory, ownedName(1));
  fs.symlinkSync(target, owned);
  const dump = createDebugDumper(directory);
  assert.throws(() => dump('request', {}), /symlink|regular/i);
  fs.unlinkSync(owned);
  fs.linkSync(target, owned);
  assert.throws(() => dump('request', {}), /link|regular/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'private-target');
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
});

test('test_dump_preexistingFiles_prunesAgeCountAndAggregateBytesOnlyForOwnedNames', (t) => {
  const { directory } = fixture(t);
  fs.mkdirSync(directory);
  const unrelated = path.join(directory, 'request-old.json');
  fs.writeFileSync(unrelated, 'keep');
  for (let i = 1; i <= 4; i++) {
    const file = path.join(directory, ownedName(i));
    fs.writeFileSync(file, 'x'.repeat(400));
    const time = new Date(Date.now() - (i === 1 ? 120_000 : i * 1000));
    fs.utimesSync(file, time, time);
  }
  createDebugDumper(directory, { maxFiles: 2, maxBytes: 700, maxAgeMs: 60_000 })('request', {});
  const files = fs.readdirSync(directory).filter((name) => name.startsWith('bridge-debug-'));
  assert.ok(files.length <= 2);
  assert.ok(files.reduce((total, file) => total + fs.statSync(path.join(directory, file)).size, 0) <= 700);
  assert.ok(!fs.existsSync(path.join(directory, ownedName(1))));
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
});

test('test_dump_legacyRawFiles_removesOnlyRecognizedBridgeDumps', (t) => {
  const { directory } = fixture(t);
  fs.mkdirSync(directory);
  const legacy = ['1800000000000-request.json', '1800000000001-claude-prompt.json'];
  for (const name of legacy) fs.writeFileSync(path.join(directory, name), 'old-sensitive-prompt');
  const unrelated = path.join(directory, '1800000000000-user-notes.json');
  fs.writeFileSync(unrelated, 'keep');
  createDebugDumper(directory)('request', {});
  for (const name of legacy) assert.ok(!fs.existsSync(path.join(directory, name)));
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
});

test('test_dump_sameMillisecond_usesExclusiveDistinctFilenames', (t) => {
  const { directory } = fixture(t);
  const dump = createDebugDumper(directory, { maxFiles: 30 });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const paths = Array.from({ length: 25 }, () => dump('claude-prompt', { prompt: 'secret' }));
  assert.equal(new Set(paths).size, 25);
  for (const file of paths) {
    assert.match(path.basename(file), new RegExp(`^bridge-debug-${now}-[a-f0-9]{32}\\.json$`));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).kind, 'claude-prompt');
  }
});

test('test_dump_filenameCollision_retriesWithoutOverwritingExistingFile', (t) => {
  const { directory } = fixture(t);
  const dump = createDebugDumper(directory);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const first = dump('request', {});
  const original = fs.readFileSync(first, 'utf8');
  const token = path.basename(first).match(/-([a-f0-9]{32})\.json$/)[1];
  const randomBytes = crypto.randomBytes;
  let calls = 0;
  t.mock.method(crypto, 'randomBytes', (size) => calls++ === 0 ? Buffer.from(token, 'hex') : randomBytes(size));
  const second = dump('request', { nested: [null] });
  assert.notEqual(first, second);
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(first, 'utf8'), original);
});

test('test_dump_hugeCyclicInput_boundsTraversalAndSerializedSize', (t) => {
  const { directory } = fixture(t);
  let input = {};
  for (let i = 0; i < 20_000; i++) input = { child: input };
  const file = createDebugDumper(directory, { maxBytes: 700 })('request', input);
  const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(summary.structure.truncated);
  assert.ok(fs.statSync(file).size <= 700);
});

test('test_createDebugDumper_invalidLimitsAndTooSmallBudget_throwsActionableErrors', (t) => {
  const { directory } = fixture(t);
  for (const limits of [{ maxFiles: 0 }, { maxFiles: 1.5 }, { maxBytes: -1 }, { maxAgeMs: Infinity }]) {
    assert.throws(() => createDebugDumper(directory, limits), /maxFiles|maxBytes|maxAgeMs/);
  }
  assert.throws(() => createDebugDumper(directory, { maxBytes: 1 })('request', {}), /maxBytes|budget/i);
});
