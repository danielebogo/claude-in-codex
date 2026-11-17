import * as zlib from 'node:zlib';

export const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: 32 * 1024 * 1024,
  maxDecodedBytes: 64 * 1024 * 1024,
  bodyTimeoutMs: 30000,
  maxConcurrentRequests: 32,
  maxWebSocketPayloadBytes: 32 * 1024 * 1024,
  maxWebSocketQueueBytes: 32 * 1024 * 1024,
  maxWebSocketQueueMessages: 64,
  maxWebSockets: 64,
});

/** A request failure that can be returned directly as an HTTP error response. */
export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

// Failure modes: oversized declared/streamed input, stalled body, aborted input,
// stream errors, and premature close. A rejected body remains paused so the
// caller can send its error response before closing the connection.
export function readBody(req, { maxBytes = DEFAULT_LIMITS.maxBodyBytes, timeoutMs = DEFAULT_LIMITS.bodyTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let bytes = 0;
    let settled = false;
    let timer;

    function cleanupBody() {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
    }

    function cleanupTerminal() {
      req.off('error', onError);
      req.off('close', onClose);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      req.pause();
      cleanupBody();
      chunks = [];
      // IncomingMessage can emit an error after aborted; retain the error
      // handler until close, when the caller has finished its response.
      reject(error);
    }

    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length > maxBytes - bytes) {
        fail(new RequestError(413, `Request body exceeds the ${maxBytes}-byte limit.`));
        return;
      }
      bytes += buffer.length;
      chunks.push(buffer);
    }

    function onEnd() {
      if (settled) return;
      settled = true;
      cleanupBody();
      cleanupTerminal();
      const body = Buffer.concat(chunks, bytes);
      chunks = [];
      resolve(body);
    }

    function onAborted() {
      fail(new RequestError(400, 'Request body was aborted before it finished.'));
    }

    function onError(error) {
      fail(new RequestError(400, `Request body could not be read: ${error.message}`));
    }

    function onClose() {
      fail(new RequestError(400, 'Request body connection closed before it finished.'));
      cleanupTerminal();
    }

    req.on('error', onError);
    req.on('close', onClose);
    const contentLength = req.headers?.['content-length'];
    if (contentLength != null && Number(contentLength) > maxBytes) {
      fail(new RequestError(413, `Request Content-Length exceeds the ${maxBytes}-byte limit.`));
      return;
    }
    timer = setTimeout(() => fail(new RequestError(408, `Request body did not finish within ${timeoutMs} ms.`)), timeoutMs);
    req.on('aborted', onAborted);
    req.on('end', onEnd);
    req.on('data', onData);
  });
}

// Failure modes: unsupported coding, unavailable zstd support, malformed
// compressed data, and decompression expansion past the output byte limit.
export async function decodeBody(raw, encoding, maxBytes = DEFAULT_LIMITS.maxDecodedBytes) {
  const coding = String(encoding || '').toLowerCase().trim();
  if (!coding || coding === 'identity') {
    if (raw.length > maxBytes) throw new RequestError(413, `Decoded request body exceeds the ${maxBytes}-byte limit.`);
    return raw;
  }

  const decompressors = {
    gzip: zlib.gunzip,
    br: zlib.brotliDecompress,
    deflate: zlib.inflate,
    zstd: zlib.zstdDecompress,
  };
  if (!Object.hasOwn(decompressors, coding)) throw new RequestError(415, `Unsupported request Content-Encoding: ${coding}.`);
  const decompress = decompressors[coding];
  if (coding === 'zstd' && !decompress) {
    throw new RequestError(500, 'This Node runtime cannot decode zstd requests. Use Node >= 22.15, or set `[features] enable_request_compression = false` in ~/.codex/config.toml.');
  }
  try {
    return await new Promise((resolve, reject) => {
      decompress(raw, { maxOutputLength: maxBytes }, (error, decoded) => {
        if (error) reject(error);
        else resolve(decoded);
      });
    });
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new RequestError(413, `Decoded request body exceeds the ${maxBytes}-byte limit.`);
    }
    throw new RequestError(400, `Invalid ${coding}-compressed request body: ${error.message}`);
  }
}
