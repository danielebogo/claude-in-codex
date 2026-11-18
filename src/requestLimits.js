import * as zlib from 'node:zlib';
import { ResourceBudget, defaultBufferBudget } from './resourceBudget.js';
import { RequestError } from './requestError.js';
export { RequestError } from './requestError.js';

export const DEFAULT_LIMITS = Object.freeze({
  // Provider input sizes differ from the Codex envelope. These are optional
  // operator caps, not imposed conversation limits; memory admission is shared.
  maxBodyBytes: null,
  maxDecodedBytes: null,
  maxWebSocketPayloadBytes: null,
  maxWebSocketQueueBytes: null,
  maxBufferedBytes: defaultBufferBudget(),
  bodyTimeoutMs: 30000,
  maxConcurrentRequests: 32,
  maxWebSocketQueueMessages: 64,
  maxWebSockets: 64,
});

// Failure modes: explicit byte caps, exhausted shared memory budget, stalled or
// aborted input, and terminal stream errors. Never dispatch rejected input.
export function readBody(req, { maxBytes, timeoutMs = DEFAULT_LIMITS.bodyTimeoutMs, lease } = {}) {
  const ownLease = !lease;
  lease ??= new ResourceBudget().acquire();
  return new Promise((resolve, reject) => {
    let chunks = [], bytes = 0, settled = false, timer;
    const byteLimit = maxBytes ?? Infinity;
    function cleanupBody() {
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAborted);
    }
    function cleanupTerminal() { req.off('error', onError); req.off('close', onClose); }
    function fail(error) {
      if (settled) return;
      settled = true;
      req.pause(); cleanupBody(); chunks = [];
      if (ownLease) lease.release();
      // Keep terminal error handlers until close: aborted sockets can error later.
      reject(error);
    }
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length > byteLimit - bytes) return fail(new RequestError(413, `Request body exceeds the configured ${byteLimit}-byte limit.`));
      try { lease.grow(buffer.length); } catch (error) { return fail(error); }
      bytes += buffer.length; chunks.push(buffer);
    }
    function onEnd() {
      if (settled) return;
      try {
        // Concatenation briefly retains both the chunks and the final buffer.
        lease.grow(bytes);
        const body = Buffer.concat(chunks, bytes);
        chunks = []; lease.shrink(bytes);
        settled = true; cleanupBody(); cleanupTerminal();
        if (ownLease) lease.release();
        resolve(body);
      } catch (error) { fail(error); }
    }
    function onAborted() { fail(new RequestError(400, 'Request body was aborted before it finished.')); }
    function onError(error) { fail(new RequestError(400, `Request body could not be read: ${error.message}`)); }
    function onClose() { fail(new RequestError(400, 'Request body connection closed before it finished.')); cleanupTerminal(); }
    req.on('error', onError); req.on('close', onClose);
    const length = Number(req.headers?.['content-length']);
    if (length > byteLimit) return fail(new RequestError(413, `Request Content-Length ${length} exceeds the configured ${byteLimit}-byte limit.`));
    if (Number.isFinite(length) && length > lease.remaining()) return fail(new RequestError(503, 'Request exceeds available bridge buffering capacity; configure limits.maxBufferedBytes for this machine.'));
    timer = setTimeout(() => fail(new RequestError(408, `Request body did not finish within ${timeoutMs} ms.`)), timeoutMs);
    req.on('aborted', onAborted); req.on('end', onEnd); req.on('data', onData);
  });
}

/** Decompresses incrementally, charging actual output before retaining it. */
export async function decodeBody(raw, encoding, maxBytes, { lease } = {}) {
  const coding = String(encoding || '').toLowerCase().trim();
  const byteLimit = maxBytes ?? Infinity;
  if (!coding || coding === 'identity') {
    if (raw.length > byteLimit) throw new RequestError(413, `Decoded request body exceeds the configured ${byteLimit}-byte limit.`);
    return raw;
  }
  const decompressors = { gzip: zlib.createGunzip, br: zlib.createBrotliDecompress, deflate: zlib.createInflate, zstd: zlib.createZstdDecompress };
  if (!Object.hasOwn(decompressors, coding)) throw new RequestError(415, `Unsupported request Content-Encoding: ${coding}.`);
  if (!decompressors[coding]) throw new RequestError(500, 'This Node runtime cannot decode zstd requests. Use Node >= 22.15, or disable Codex request compression.');
  const ownLease = !lease;
  lease ??= new ResourceBudget().acquire(raw.length);
  const decoder = decompressors[coding]();
  try {
    return await new Promise((resolve, reject) => {
      let chunks = [], bytes = 0, settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true; chunks = []; decoder.destroy();
        reject(error instanceof RequestError ? error : new RequestError(400, `Invalid ${coding}-compressed request body: ${error.message}`));
      };
      decoder.on('error', fail);
      decoder.on('data', (chunk) => {
        if (chunk.length > byteLimit - bytes) return fail(new RequestError(413, `Decoded request body exceeds the configured ${byteLimit}-byte limit.`));
        try { lease.grow(chunk.length); } catch (error) { return fail(error); }
        bytes += chunk.length; chunks.push(chunk);
      });
      decoder.on('end', () => {
        if (settled) return;
        try {
          lease.grow(bytes);
          const body = Buffer.concat(chunks, bytes);
          chunks = []; lease.shrink(bytes); settled = true; resolve(body);
        } catch (error) { fail(error); }
      });
      decoder.end(raw);
    });
  } finally { if (ownLease) lease.release(); }
}
