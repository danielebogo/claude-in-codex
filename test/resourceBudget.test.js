import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { constants as bufferConstants } from 'node:buffer';
import { ResourceBudget, defaultBufferBudget, webSocketResourceCeiling } from '../src/resourceBudget.js';
import { readBody, decodeBody } from '../src/requestLimits.js';

test('shared reservations reject aggregate pressure and recover after idempotent release', () => {
  const budget = new ResourceBudget(100);
  const first = budget.acquire(60), second = budget.acquire(30);
  assert.throws(() => second.grow(11), { status: 503 });
  assert.equal(budget.used, 90);
  first.release(); first.release();
  second.grow(40);
  assert.equal(budget.used, 70);
  second.release();
  assert.equal(budget.used, 0);
  assert.throws(() => first.grow(1), /released/);
});

test('default resource capacity follows runtime constraints rather than a conversation size', () => {
  assert.equal(defaultBufferBudget({ heapBytes: 8000, memoryBytes: 32000, constrainedBytes: Infinity }), 2000);
  assert.equal(defaultBufferBudget({ heapBytes: 8000, memoryBytes: 32000, constrainedBytes: 4000 }), 500);
  assert.equal(webSocketResourceCeiling(1024, null), 256);
  assert.equal(webSocketResourceCeiling(1024, 80), 80);
  assert.ok(webSocketResourceCeiling(Number.MAX_SAFE_INTEGER, null) <= 0x7fffffff);
  assert.ok(webSocketResourceCeiling(Number.MAX_SAFE_INTEGER, null) <= bufferConstants.MAX_STRING_LENGTH);
});

test('HTTP memory admission differs from an explicit per-request byte cap', async () => {
  for (const [maxBytes, status] of [[null, 503], [32, 413]]) {
    const req = new PassThrough(); req.headers = { 'content-length': '101' };
    const budget = new ResourceBudget(100), lease = budget.acquire();
    await assert.rejects(readBody(req, { maxBytes, lease }), { status });
    assert.equal(req.listenerCount('data'), 0);
    lease.release(); req.destroy();
    assert.equal(budget.used, 0);
  }
});

test('streaming decompression admits retained output through the same resource budget', async () => {
  const raw = zlib.gzipSync(Buffer.alloc(8192, 65));
  const budget = new ResourceBudget(1024), lease = budget.acquire(raw.length);
  await assert.rejects(decodeBody(raw, 'gzip', null, { lease }), { status: 503 });
  lease.release();
  assert.equal(budget.used, 0);
});

test('a resumed handler returning immediately retains memory until its response closes', async () => {
  const { EventEmitter } = await import('node:events');
  const { withResponseLease } = await import('../src/resourceBudget.js');
  const budget = new ResourceBudget(100), lease = budget.acquire(80);
  const response = new EventEmitter();
  await withResponseLease(response, lease, async () => {});
  assert.throws(() => budget.acquire(30), { status: 503 });
  response.emit('close');
  const next = budget.acquire(100); next.release();
  assert.equal(budget.used, 0);
});

test('disconnecting does not release retained memory until handler cleanup settles', async () => {
  const { EventEmitter } = await import('node:events');
  const { withResponseLease } = await import('../src/resourceBudget.js');
  const budget = new ResourceBudget(100), lease = budget.acquire(80);
  const response = new EventEmitter();
  let finish;
  const operation = withResponseLease(response, lease, () => new Promise((resolve) => { finish = resolve; }));
  response.emit('close');
  assert.throws(() => budget.acquire(30), { status: 503 });
  finish(); await operation;
  assert.equal(budget.used, 0);
});

test('memory pressure can evict optional cached data before refusing new work', () => {
  let cached;
  const budget = new ResourceBudget(100, { onPressure: () => cached.release() });
  cached = budget.acquire(80);
  const request = budget.acquire(50);
  assert.equal(budget.used, 50);
  request.release();
  assert.equal(budget.used, 0);
});
