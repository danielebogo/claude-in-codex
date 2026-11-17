import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ownedFilename = /^bridge-debug-\d{1,16}-[a-f0-9]{32}\.json$/;
const legacyFilename = /^\d{1,16}-(request|claude-prompt)\.json$/;
const kinds = new Set(['request', 'claude-prompt']);
const maxNodes = 10_000;
const maxDepth = 64;

// Failure modes:
// - Invalid budgets or a summary larger than the complete disk budget.
// - Unsafe directory, symlink, hardlink, ownership, or nonregular dump file.
// - Filesystem permission, space, concurrent deletion, or filename collision errors.
// All failures propagate to the caller; raw input is never a fallback format.

/** Writes bounded structural metadata to private files; throws on unsafe paths or IO failure. */
export function createDebugDumper(directory, { maxFiles = 20, maxBytes = 1024 * 1024, maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('Debug dump directory must be a nonempty path');
  for (const [name, value] of Object.entries({ maxFiles, maxBytes, maxAgeMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Debug dump ${name} must be a positive safe integer`);
  }
  const target = path.resolve(directory);

  return function dump(kind, input) {
    const payload = `${JSON.stringify({ schemaVersion: 1, kind: kinds.has(kind) ? kind : 'other', structure: summarize(input) })}\n`;
    const bytes = Buffer.byteLength(payload);
    if (bytes > maxBytes) throw new RangeError(`Debug dump metadata requires ${bytes} bytes; increase maxBytes above ${maxBytes}`);

    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const directoryInfo = fs.lstatSync(target);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Debug dump directory must be a real directory, not a symlink');
    assertOwner(directoryInfo);
    const directoryFd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      assertSameFile(directoryInfo, fs.fstatSync(directoryFd));
      fs.fchmodSync(directoryFd, 0o700);
      const files = fs.readdirSync(target)
        .filter((name) => ownedFilename.test(name) || legacyFilename.test(name))
        .map((name) => ({ ...inspectFile(path.join(target, name)), legacy: legacyFilename.test(name) }));
      files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
      const now = Date.now();
      let remainingBytes = files.reduce((total, file) => total + file.size, 0);
      let remainingFiles = files.length;
      for (const file of files) {
        if (file.legacy || now - file.mtimeMs > maxAgeMs || remainingFiles >= maxFiles || remainingBytes + bytes > maxBytes) {
          assertSameFile(file, fs.lstatSync(file.file));
          fs.unlinkSync(file.file);
          remainingBytes -= file.size;
          remainingFiles--;
        }
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        const file = path.join(target, `bridge-debug-${now}-${crypto.randomBytes(16).toString('hex')}.json`);
        let fd;
        try {
          fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        } catch (error) {
          if (error.code === 'EEXIST') continue;
          throw error;
        }
        try {
          fs.fchmodSync(fd, 0o600);
          fs.writeFileSync(fd, payload);
        } catch (error) {
          fs.closeSync(fd);
          fs.unlinkSync(file);
          throw error;
        }
        fs.closeSync(fd);
        return file;
      }
      throw new Error('Debug dump could not allocate a unique filename after 10 attempts');
    } finally {
      fs.closeSync(directoryFd);
    }
  };
}

function assertOwner(info) {
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Debug dump path must belong to the current user');
}

function assertSameFile(expected, actual) {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) throw new Error('Debug dump path changed during filesystem access');
}

function inspectFile(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Debug dump file must be a regular file without symlinks or hardlinks');
  assertOwner(info);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    assertSameFile(info, opened);
    if (opened.nlink !== 1) throw new Error('Debug dump file must not have hardlinks');
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return { file, ...info };
}

/** Counts types without retaining property names, primitive values, or executing getters. */
function summarize(input) {
  const counts = { objects: 0, arrays: 0, strings: 0, numbers: 0, booleans: 0, nulls: 0, other: 0, accessors: 0, cycles: 0, truncated: false };
  const seen = new WeakSet();
  let visited = 0;
  let inspected = 0;
  function visit(value, depth) {
    if (visited >= maxNodes || depth > maxDepth) {
      counts.truncated = true;
      return;
    }
    visited++;
    if (value === null) { counts.nulls++; return; }
    if (typeof value === 'string') { counts.strings++; return; }
    if (typeof value === 'number') { counts.numbers++; return; }
    if (typeof value === 'boolean') { counts.booleans++; return; }
    if (typeof value !== 'object') { counts.other++; return; }
    if (seen.has(value)) { counts.cycles++; return; }
    seen.add(value);
    if (Array.isArray(value)) counts.arrays++;
    else counts.objects++;
    for (const key in value) {
      if (visited >= maxNodes || inspected++ >= maxNodes) { counts.truncated = true; break; }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if ('value' in descriptor) visit(descriptor.value, depth + 1);
      else { counts.accessors++; visited++; }
    }
  }
  visit(input, 0);
  return counts;
}
