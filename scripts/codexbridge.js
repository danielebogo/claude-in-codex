#!/usr/bin/env node
// Failure modes: missing install, unavailable providers, invalid commands, moved
// checkouts, and an unrelated executable already using the requested command name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { prepareInstallation, writeModelConfig } from './discover-models.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MARKER = '# Managed by codexbridge.';
const HELP = `Usage:
  codexbridge install     Install or reinstall the bridge service
  codexbridge add         Discover newly installed providers and refresh models
  codexbridge uninstall   Remove the bridge service and restore the Codex route
  codexbridge --help      Show this help

Run add after installing and signing in to a supported CLI (Claude Code or Grok).
It updates model configuration without reinstalling or restarting the service.
`;

/** Installs a user-owned launcher, preserving any unrelated command of that name. */
export function installCommand(directory = path.join(os.homedir(), '.local/bin')) {
  const destination = path.resolve(directory);
  const file = path.join(destination, 'codexbridge');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || !fs.readFileSync(file, 'utf8').startsWith(`#!/bin/sh\n${MARKER}\n`)) throw new Error(`An unrelated command already exists at ${file}; choose a different command directory.`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(destination, { recursive: true });
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = `#!/bin/sh\n${MARKER}\nexec ${quote(process.execPath)} ${quote(path.join(ROOT, 'scripts/codexbridge.js'))} "$@"\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, launcher, { mode: 0o755, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  console.log(`Command installed: ${file}`);
  if (!(process.env.PATH || '').split(path.delimiter).includes(destination)) console.log(`Add this directory to your shell PATH:\n  export PATH=${quote(destination)}:"$PATH"`);
}

function runScript(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(ROOT, 'scripts', `${command}.sh`)], { stdio: 'inherit' });
    child.on('error', () => reject(new Error(`Cannot start bridge ${command}; check the checkout at ${ROOT}.`)));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const [command = '--help', ...args] = process.argv.slice(2);
  // setup is also used by install.sh before any service or Codex-route mutation.
  if (command === 'setup' && args.length <= 1) { installCommand(args[0]); return; }
  if (args.length) throw new Error(HELP);
  if (['--help', '-h', 'help'].includes(command)) { console.log(HELP); return; }
  if (['install', 'uninstall'].includes(command)) { process.exitCode = await runScript(command); return; }
  if (command !== 'add') throw new Error(`Unknown command: ${command}\n${HELP}`);
  const home = process.env.CODEX_CLAUDE_BRIDGE_HOME || path.join(os.homedir(), '.codex-claude-bridge');
  const configFile = path.join(home, 'config.json');
  if (!fs.existsSync(configFile)) throw new Error('Bridge configuration not found. Run codexbridge install first.');
  const result = await prepareInstallation(configFile);
  writeModelConfig(configFile, result.config);
  for (const warning of result.warnings) console.error(warning);
  for (const { provider, count } of result.providers) console.log(`${provider}: discovered ${count} models.`);
  console.log('Model catalog updated. Changes apply when Codex refreshes its model list.');
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
