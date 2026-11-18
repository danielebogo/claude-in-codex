import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import * as zlib from 'node:zlib';
import { RequestError, DEFAULT_LIMITS, readBody, decodeBody } from '../src/requestLimits.js';

function request() {
  const req = new PassThrough();
  req.headers = {};
  return req;
}

test('readBody collects a bounded body and releases its listeners', async () => {
  const req = request();
  const body = readBody(req, { maxBytes: 5, timeoutMs: 1000 });
  req.write(Buffer.from('he'));
  req.end(Buffer.from('llo'));
  assert.deepEqual(await body, Buffer.from('hello'));
  for (const event of ['data', 'end', 'aborted', 'error', 'close']) assert.equal(req.listenerCount(event), 0, event);
});

test('RequestError preserves HTTP status and default limits are explicit', () => {
  const error = new RequestError(413, 'Too large');
  assert.ok(error instanceof Error);
  assert.equal(error.status, 413);
  assert.equal(error.message, 'Too large');
  for (const key of ['maxBodyBytes', 'maxDecodedBytes', 'maxWebSocketPayloadBytes', 'maxWebSocketQueueBytes', 'maxWebSockets']) assert.equal(DEFAULT_LIMITS[key], null);
  assert.ok(Number.isSafeInteger(DEFAULT_LIMITS.maxBufferedBytes) && DEFAULT_LIMITS.maxBufferedBytes > 0);
});

test('readBody rejects streaming overflow before the request finishes without destroying it', async () => {
  const req = request();
  const body = readBody(req, { maxBytes: 4, timeoutMs: 1000 });
  req.write(Buffer.from('abc'));
  req.write(Buffer.from('de'));
  await assert.rejects(body, { status: 413 });
  assert.equal(req.readableEnded, false);
  assert.equal(req.destroyed, false);
  assert.equal(req.isPaused(), true);
  assert.equal(req.listenerCount('data'), 0);
  req.destroy();
});

test('readBody measures UTF-8 data in bytes', async () => {
  const req = request();
  req.setEncoding('utf8');
  const body = readBody(req, { maxBytes: 3, timeoutMs: 1000 });
  req.write('éé');
  await assert.rejects(body, { status: 413 });
  req.destroy();
});

test('readBody rejects excessive Content-Length without reading data', async () => {
  const req = request();
  req.headers['content-length'] = '6';
  await assert.rejects(readBody(req, { maxBytes: 5, timeoutMs: 1000 }), { status: 413 });
  assert.equal(req.listenerCount('data'), 0);
  assert.equal(req.destroyed, false);
  req.destroy();
});

test('readBody applies an absolute deadline even while data keeps arriving', { timeout: 2000 }, async () => {
  const req = request();
  const keepWriting = setInterval(() => req.write('a'), 5);
  try {
    await assert.rejects(readBody(req, { maxBytes: 10000, timeoutMs: 35 }), { status: 408 });
    assert.equal(req.isPaused(), true);
    assert.equal(req.listenerCount('data'), 0);
    assert.equal(req.listenerCount('aborted'), 0);
  } finally {
    clearInterval(keepWriting);
    req.destroy();
  }
});

test('readBody releases aborted input and handles its subsequent stream error', async () => {
  const req = request();
  const body = readBody(req, { maxBytes: 10, timeoutMs: 1000 });
  req.write('part');
  req.emit('aborted');
  await assert.rejects(body, { status: 400 });
  assert.equal(req.listenerCount('data'), 0);
  assert.equal(req.listenerCount('aborted'), 0);
  const closed = new Promise((resolve) => req.once('close', resolve));
  req.destroy(new Error('connection reset'));
  await closed;
  assert.equal(req.listenerCount('error'), 0);
});

test('readBody rejects stream errors and premature close with HTTP errors', async () => {
  for (const event of ['error', 'close']) {
    const req = request();
    const body = readBody(req, { maxBytes: 10, timeoutMs: 1000 });
    req.emit(event, new Error('read failed'));
    await assert.rejects(body, { status: 400 });
    req.destroy();
  }
});

test('decodeBody returns bounded identity input', async () => {
  const input = Buffer.from('hello');
  for (const encoding of [undefined, '', 'identity', ' IDENTITY ']) {
    assert.deepEqual(await decodeBody(input, encoding, 5), input);
    await assert.rejects(decodeBody(input, encoding, 4), { status: 413 });
  }
});

for (const [encoding, compress] of [
  ['gzip', zlib.gzipSync],
  ['br', zlib.brotliCompressSync],
  ['deflate', zlib.deflateSync],
  ['zstd', zlib.zstdCompressSync],
]) {
  test(`decodeBody decodes bounded ${encoding} asynchronously`, { skip: !compress }, async () => {
    const input = Buffer.from('a'.repeat(1024));
    const compressed = compress(input);
    assert.deepEqual(await decodeBody(compressed, encoding, 1024), input);
    await assert.rejects(decodeBody(compressed, encoding, 16), { status: 413 });
    await assert.rejects(decodeBody(Buffer.from('malformed compressed body'), encoding, 1024), { status: 400 });
  });
}

test('decodeBody rejects unsupported content encodings', async () => {
  for (const encoding of ['unknown', 'gzip, br', '__proto__', 'constructor', 'toString']) {
    await assert.rejects(decodeBody(Buffer.from('data'), encoding, 10), { status: 415 });
  }
});
