import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceBudget } from '../src/resourceBudget.js';
import { reserveContinuation } from '../src/continuationBudget.js';

// Failure modes:
// - Admission cannot reserve the complete continuation allowance before a native turn.
// - Ordinary global work consumes capacity promised to an accepted continuation.
// - Closing a native turn releases bytes still retained by a response or send queue.
// - Failed growth partially changes child or parent accounting.
// - Released credit cannot be reacquired by late response work after native cleanup.

test('continuation admission rejects unavailable credit before starting a native turn', () => {
  const parent = new ResourceBudget(1200);
  const original = parent.acquire(900);

  assert.throws(() => reserveContinuation(parent, 301), { status: 503 });

  assert.equal(parent.used, 900);
  original.release();
  assert.equal(parent.used, 0);
});

test('reserved continuation credit admits full history even when global work fills remaining capacity', () => {
  const parent = new ResourceBudget(2400);
  const original = parent.acquire(900);
  const continuation = reserveContinuation(parent, 1125);
  const ordinary = parent.acquire(375);

  assert.throws(() => parent.acquire(1), { status: 503 });
  const history = continuation.budget.acquire(900);

  assert.equal(continuation.budget.capacity, parent.capacity);
  assert.equal(parent.used, 2400);
  continuation.close();
  assert.equal(parent.used, 2175);
  history.release();
  ordinary.release();
  original.release();
  assert.equal(parent.used, 0);
});

test('closing the native turn retains live child bytes until response leases release', () => {
  const parent = new ResourceBudget(2400);
  const original = parent.acquire(900);
  const continuation = reserveContinuation(parent, 1125);
  const response = continuation.budget.acquire(900);

  continuation.close();
  continuation.close();
  original.release();

  assert.equal(parent.used, 900);
  response.release();
  response.release();
  assert.equal(parent.used, 0);
});

test('child growth beyond reserved credit charges the parent and rejects atomically', () => {
  const parent = new ResourceBudget(2400);
  const original = parent.acquire(900);
  const continuation = reserveContinuation(parent, 1125);
  const child = continuation.budget.acquire(1000);

  child.grow(300);

  assert.equal(parent.used, 2200);
  assert.equal(child.bytes(), 1300);
  assert.throws(() => child.grow(201), { status: 503 });
  assert.equal(parent.used, 2200);
  assert.equal(continuation.budget.used, 1300);
  assert.equal(child.bytes(), 1300);
  child.grow(200);
  assert.equal(parent.used, 2400);
  continuation.close();
  child.release();
  original.release();
  assert.equal(parent.used, 0);
});

test('child shrink and release restore the reserved floor until the native turn closes', () => {
  const parent = new ResourceBudget(2400);
  const original = parent.acquire(900);
  const continuation = reserveContinuation(parent, 1125);
  const child = continuation.budget.acquire(1400);

  child.shrink(200);

  assert.equal(parent.used, 2100);
  child.shrink(200);
  assert.equal(parent.used, 2025);
  child.release();
  assert.equal(continuation.budget.used, 0);
  assert.equal(parent.used, 2025);
  continuation.close();
  assert.equal(parent.used, 900);
  original.release();
  assert.equal(parent.used, 0);
});

test('growth after close reacquires released parent credit and remains atomic', () => {
  const parent = new ResourceBudget(1200);
  const continuation = reserveContinuation(parent, 900);
  const child = continuation.budget.acquire();

  continuation.close();
  const ordinary = parent.acquire(1100);

  assert.equal(parent.used, 1100);
  assert.throws(() => child.grow(101), { status: 503 });
  assert.equal(child.bytes(), 0);
  assert.equal(continuation.budget.used, 0);
  assert.equal(parent.used, 1100);
  child.grow(100);
  assert.equal(parent.used, 1200);
  child.shrink(100);
  assert.equal(parent.used, 1100);
  child.grow(50);
  assert.equal(parent.used, 1150);
  continuation.close();
  assert.equal(parent.used, 1150);
  child.release();
  ordinary.release();
  assert.equal(parent.used, 0);
});
