import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Failure modes: unsafe ownership/modes or symlinks, malformed auth state,
// missing/stale capability, and a health responder impersonating this installation.
const AUTH_FILE = 'local-auth.json';
const TOKEN = /^[a-f0-9]{64}$/;
const INSTALLATION = /^[a-f0-9]{32}$/;

export function validateLocalAuth(auth) {
  if (!TOKEN.test(auth?.token) || !INSTALLATION.test(auth?.installationId)) {
    throw new Error('Invalid local bridge authentication; run scripts/install.sh to prepare private credentials.');
  }
  return auth;
}

function ownedPrivate(stat, directory = false) {
  const privateOwner = typeof process.getuid !== 'function' || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
  return (directory ? stat.isDirectory() : stat.isFile()) && privateOwner && (directory || stat.nlink === 1);
}

export function readLocalAuth(directory) {
  if (!ownedPrivate(fs.lstatSync(directory), true)) throw new Error('Bridge authentication directory must be owner-only (0700), without symlinks.');
  const fd = fs.openSync(path.join(directory, AUTH_FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!ownedPrivate(stat) || stat.size > 4096) throw new Error('Bridge authentication file must be private (0600), owned by this user and smaller than 4 KiB.');
    return validateLocalAuth(JSON.parse(fs.readFileSync(fd, 'utf8')));
  } finally {
    fs.closeSync(fd);
  }
}

/** Prepares a private capability, retaining it on reinstall so existing client routes stay valid. */
export function prepareLocalAuth(directory, { newInstallation = false } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Bridge authentication directory must be owned by this user, without symlinks.');
  fs.chmodSync(directory, 0o700);
  let auth;
  try {
    auth = readLocalAuth(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    auth = { token: crypto.randomBytes(32).toString('hex'), installationId: crypto.randomBytes(16).toString('hex') };
    fs.writeFileSync(path.join(directory, AUTH_FILE), `${JSON.stringify(auth)}\n`, { flag: 'wx', mode: 0o600 });
  }
  if (newInstallation) {
    auth = { ...auth, installationId: crypto.randomBytes(16).toString('hex') };
    const temporary = path.join(directory, `.${AUTH_FILE}-${crypto.randomUUID()}`);
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(auth)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, path.join(directory, AUTH_FILE));
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return auth;
}

/** Removes only an exact capability segment; request roles and OpenAI credentials never authenticate the bridge. */
export function authenticatedPath(pathname, token) {
  const candidate = pathname.slice(1, 65);
  if (!TOKEN.test(candidate) || pathname[65] !== '/') return null;
  if (!crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token))) return null;
  return pathname.slice(65);
}

/** Proves possession without sending the secret to a potentially spoofed listener. */
export function healthProof(auth, challenge, port) {
  const message = JSON.stringify(['ccb-health-v1', challenge, Number(port), auth.installationId]);
  return { installationId: auth.installationId, proof: crypto.createHmac('sha256', auth.token).update(message).digest('hex') };
}

export function verifyHealthProof(auth, challenge, port, response) {
  if (response?.installationId !== auth.installationId || !TOKEN.test(response?.proof)) return false;
  return crypto.timingSafeEqual(Buffer.from(response.proof), Buffer.from(healthProof(auth, challenge, port).proof));
}
