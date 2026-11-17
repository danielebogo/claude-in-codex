#!/bin/bash
# Installs the Codex native-provider bridge on macOS:
#  - background service (LaunchAgent) on 127.0.0.1:18787
#  - points Codex at it with one line in ~/.codex/config.toml (backed up first)
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${CODEX_CLAUDE_BRIDGE_PORT:-18787}"
LABEL="com.codex-claude-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BRIDGE_HOME="$HOME/.codex-claude-bridge"
CODEX_CONFIG="$HOME/.codex/config.toml"
LOG="$HOME/Library/Logs/codex-claude-bridge.log"
TAG="# codex-claude-bridge"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "CODEX_CLAUDE_BRIDGE_PORT must be an integer from 1 to 65535."

# --- find Node (login shell so nvm/homebrew PATHs are loaded) ----------------
NODE="$(command -v node || true)"
[ -z "$NODE" ] && NODE="$(zsh -lic 'command -v node' 2>/dev/null | tail -1 || true)"
[ -x "$NODE" ] || die "node not found. Install Node 22+ (brew install node)."
# `node` on PATH may be a shell shim (nvm/volta/fnm wrapper) rather than the real
# binary. launchd should exec the real binary: a shim that sources nvm.sh on every
# start is slow, depends on the shim's own environment, and is a needless failure
# point for a KeepAlive service. process.execPath is always the actual executable.
NODE="$("$NODE" -p 'process.execPath')"
[ -x "$NODE" ] || die "could not resolve the real node binary (got '$NODE')."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $("$NODE" -v) is too old; need 20+."
HAS_ZSTD="$("$NODE" -p 'typeof require("zlib").zstdDecompressSync === "function"')"

say "node: $NODE ($("$NODE" -v))"

# The bridge inspects each WebSocket message so a GPT-prewarmed side chat can
# switch to Claude without sending that Claude request to OpenAI.
command -v npm >/dev/null 2>&1 || die "npm not found. Install npm alongside Node.js."
npm ci --omit=dev --prefix "$DIR"

# Reject unsupported routes before changing a service or its configuration.
mkdir -p "$(dirname "$CODEX_CONFIG")"
touch "$CODEX_CONFIG"
"$NODE" "$DIR/scripts/configure-route.js" "$CODEX_CONFIG" "http://127.0.0.1:$PORT/backend-api/codex" check

# Discover before stopping a service or changing Codex's route. An unavailable
# optional provider must not block another provider that is ready to use.
PROVIDER_PATHS="$("$NODE" "$DIR/scripts/discover-models.js" "$BRIDGE_HOME/config.json" "$PORT" "$HOME")"
say "updated detected providers and model catalog in $BRIDGE_HOME/config.json"
mkdir -p "$BRIDGE_HOME" "$(dirname "$PLIST")" "$(dirname "$LOG")"
"$NODE" "$DIR/scripts/bridge-endpoint.js" prepare "$BRIDGE_HOME"

# --- LaunchAgent -------------------------------------------------------------
SERVICE_PATH="$(dirname "$NODE"):$PROVIDER_PATHS:$HOME/.grok/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
"$NODE" --input-type=module - "$PLIST" "$LABEL" "$NODE" "$DIR/src/server.js" "$SERVICE_PATH" "$HOME" "$LOG" <<'JS'
import fs from 'node:fs';
const [file, label, node, server, servicePath, home, log] = process.argv.slice(2);
const xml = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(server)}</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(servicePath)}</string>
    <key>HOME</key><string>${xml(home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`, { mode: 0o600 });
JS
# Unload any previous copy of the service. `bootout` returns before launchd has
# actually finished tearing the job down, and a `bootstrap` issued while the old
# registration is still draining fails with "Bootstrap failed: 5: Input/output
# error" (seen on re-install). So poll until the label is really gone instead of
# relying on a fixed sleep.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for i in $(seq 1 40); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.25
done
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  die "could not unload the previous $LABEL service; run: launchctl bootout gui/$(id -u)/$LABEL"
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $PORT is already used by: $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | awk 'NR==2{print $1" (pid "$2")"}'). Re-run with CODEX_CLAUDE_BRIDGE_PORT=<free port>."
fi
# One retry: even after the label disappears from `launchctl print`, a bootstrap
# that lands in the same instant can still hit the transient EIO above.
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || die "launchctl bootstrap failed; see $LOG"
fi
say "service started (logs: $LOG)"

for i in $(seq 1 20); do
  if "$NODE" "$DIR/scripts/bridge-endpoint.js" verify "$BRIDGE_HOME" "$PORT" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
"$NODE" "$DIR/scripts/bridge-endpoint.js" verify "$BRIDGE_HOME" "$PORT" || die "bridge identity could not be verified; Codex route unchanged; see $LOG"
say "bridge healthy on http://127.0.0.1:$PORT"

# --- Codex config ------------------------------------------------------------------
mkdir -p "$(dirname "$CODEX_CONFIG")"
touch "$CODEX_CONFIG"
"$NODE" "$DIR/scripts/configure-route.js" "$CODEX_CONFIG" "http://127.0.0.1:$PORT/backend-api/codex" local "$BRIDGE_HOME"
say "configured selected Codex provider"

if [ "$HAS_ZSTD" != "true" ] && ! grep -q "enable_request_compression" "$CODEX_CONFIG"; then
  # This Node can't decode Codex's zstd request bodies, so ask Codex not to compress.
  if grep -q '^\[features\]' "$CODEX_CONFIG"; then
    /usr/bin/sed -i '' "/^\[features\]/a\\
enable_request_compression = false $TAG
" "$CODEX_CONFIG"
  else
    printf '\n[features] %s\nenable_request_compression = false %s\n' "$TAG" "$TAG" >> "$CODEX_CONFIG"
  fi
  say "disabled Codex request compression (Node $("$NODE" -v) has no zstd)"
fi

say "Done. Quit and reopen the Codex app, then choose a detected Claude or Grok model in the model picker."
