import os from 'node:os';
import v8 from 'node:v8';
import { constants as bufferConstants } from 'node:buffer';
import { RequestError } from './requestError.js';

/** Leaves headroom for the native harness, JSON objects and the rest of the app. */
export function defaultBufferBudget({ heapBytes = v8.getHeapStatistics().heap_size_limit, memoryBytes = os.totalmem(), constrainedBytes = process.constrainedMemory?.() || Infinity } = {}) {
  return Math.max(1, Math.floor(Math.min(heapBytes / 4, memoryBytes / 8, constrainedBytes / 8)));
}

/** Shared admission for retained input, parse estimates, context and send queues. */
export class ResourceBudget {
  constructor(capacity = defaultBufferBudget(), { onGrow = () => {}, onRelease = () => {}, onPressure = () => {} } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('maxBufferedBytes must be a positive safe integer.');
    this.capacity = capacity;
    this.used = 0;
    this.onGrow = onGrow;
    this.onRelease = onRelease;
    this.onPressure = onPressure;
  }

  acquire(bytes = 0) {
    let held = 0;
    let released = false;
    const grow = (amount) => {
      if (released) throw new Error('Cannot grow a released resource reservation.');
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Resource bytes must be a non-negative safe integer.');
      if (amount > this.capacity - this.used) this.onPressure(amount);
      if (amount > this.capacity - this.used) throw new RequestError(503, `Bridge buffering capacity reached (${this.capacity} bytes); retry after other requests finish or configure limits.maxBufferedBytes for this machine.`);
      this.onGrow(amount);
      this.used += amount;
      held += amount;
    };
    const lease = {
      grow,
      bytes: () => held,
      budget: this,
      remaining: () => this.capacity - this.used,
      shrink: (amount) => {
        if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Resource bytes must be a non-negative safe integer.');
        const freed = Math.min(held, amount); held -= freed; this.used -= freed; this.onRelease(this.used);
      },
      release: () => { if (released) return; released = true; this.used -= held; held = 0; this.onRelease(this.used); },
    };
    grow(bytes);
    return lease;
  }
}

/** ws uses signed 32-bit lengths; retain receiver headroom and never pass zero. */
export function webSocketResourceCeiling(capacity, explicitLimit) {
  return Math.max(1, Math.min(Math.floor(capacity / 4), explicitLimit ?? Infinity, bufferConstants.MAX_STRING_LENGTH, 0x7fffffff));
}

/** Keeps admitted data charged until both its handler and response are finished. */
export async function withResponseLease(response, lease, operation) {
  let closed = Boolean(response.destroyed || response.writableEnded);
  let settled = false;
  const release = () => {
    if (!closed || !settled) return;
    response.off('close', onClose);
    lease.release();
  };
  const onClose = () => { closed = true; release(); };
  if (!closed) response.once('close', onClose);
  try { return await operation(); }
  finally { settled = true; release(); }
}
