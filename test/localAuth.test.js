import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareLocalAuth, readLocalAuth, authenticatedPath, healthProof, verifyHealthProof } from '../src/localAuth.js';

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('local capability persists privately while installation identity rotates', (t) => {
  const dir = directory(t);
  fs.chmodSync(dir, 0o755);

  const first = prepareLocalAuth(dir);
  const second = prepareLocalAuth(dir, { newInstallation: true });

  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal(first.token, second.token);
  assert.notEqual(first.installationId, second.installationId);
  assert.deepEqual(readLocalAuth(dir), second);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'local-auth.json')).mode & 0o777, 0o600);
});

test('authentication requires an exact secret path segment', () => {
  const token = 'a'.repeat(64);

  assert.equal(authenticatedPath(`/${token}/backend-api/codex/responses`, token), '/backend-api/codex/responses');
  for (const pathname of ['/backend-api/codex/responses', `/${token}x/backend-api/codex`, `/%61${token.slice(1)}/backend-api/codex`, `/${'b'.repeat(64)}/health`]) {
    assert.equal(authenticatedPath(pathname, token), null);
  }
});

test('health proof binds challenge, port and fresh installation without sending the token', () => {
  const auth = { token: 'a'.repeat(64), installationId: 'b'.repeat(32) };
  const challenge = 'c'.repeat(64);

  const response = healthProof(auth, challenge, 18787);

  assert.equal(verifyHealthProof(auth, challenge, 18787, response), true);
  assert.equal(JSON.stringify(response).includes(auth.token), false);
  assert.equal(verifyHealthProof(auth, 'd'.repeat(64), 18787, response), false);
  assert.equal(verifyHealthProof(auth, challenge, 18888, response), false);
  assert.equal(verifyHealthProof({ ...auth, installationId: 'e'.repeat(32) }, challenge, 18787, response), false);
  for (const forged of [{ ok: true }, { ...response, proof: '0'.repeat(64) }, null]) {
    assert.equal(verifyHealthProof(auth, challenge, 18787, forged), false);
  }
});

test('local auth refuses symlinks, readable credentials and malformed stored state', (t) => {
  const dir = directory(t);
  const auth = prepareLocalAuth(dir);
  const file = path.join(dir, 'local-auth.json');
  fs.chmodSync(file, 0o644);
  assert.throws(() => readLocalAuth(dir), /private|permission/i);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, '{}');
  assert.throws(() => readLocalAuth(dir), /invalid/i);
  fs.unlinkSync(file);
  const outside = path.join(dir, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify(auth), { mode: 0o600 });
  fs.symlinkSync(outside, file);
  assert.throws(() => readLocalAuth(dir));
  assert.throws(() => prepareLocalAuth(dir));
});
