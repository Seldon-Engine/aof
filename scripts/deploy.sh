#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# AOF Deploy Script
# =============================================================================
#
# Deploys AOF to two locations with distinct responsibilities:
#
#   ~/.aof/dist/          AOF core (daemon, CLI, plugin, all compiled JS).
#                         The launchd plist points here. This is the canonical
#                         installed location — everything runs from here.
#
#   ~/.aof/node_modules/  Runtime npm dependencies. Node resolves these from
#                         ~/.aof/dist/ via standard upward traversal.
#
#   ~/.openclaw/extensions/aof  →  symlink to ~/.aof/dist/
#                         OpenClaw plugin discovery. The gateway scans this
#                         directory for plugins. A symlink avoids duplicating
#                         the dist — the plugin.js entry point and manifest
#                         live physically in ~/.aof/dist/.
#
# Why the split:
#   AOF is a standalone system. The daemon, CLI, and task store all live under
#   ~/.aof/ and work without OpenClaw. The OpenClaw plugin is one integration
#   surface, not the owner of AOF's code. Coupling AOF's dist to the OpenClaw
#   extensions directory meant the daemon couldn't start without OpenClaw, and
#   upgrades/uninstalls of either system could break the other.
#
# Usage:
#   npm run deploy          # build + deploy core + link plugin
#   npm run deploy:core     # build + deploy core only (no plugin symlink)
#   scripts/deploy.sh       # same as npm run deploy
# =============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AOF_HOME="${AOF_HOME:-$HOME/.aof}"
AOF_DIST="${AOF_HOME}/dist"
OPENCLAW_EXT="${OPENCLAW_EXTENSIONS_DIR:-$HOME/.openclaw/extensions}"
PLUGIN_LINK="${OPENCLAW_EXT}/aof"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
  echo "[deploy] node_modules missing. Run 'npm ci' first." >&2
  exit 1
fi

if [[ ! -f "${ROOT_DIR}/openclaw.plugin.json" ]]; then
  echo "[deploy] openclaw.plugin.json missing at repo root." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Build
# ---------------------------------------------------------------------------

echo "[deploy] Building AOF..."
( cd "${ROOT_DIR}" && npm run build )

# ---------------------------------------------------------------------------
# Step 2: Deploy core → ~/.aof/dist/
# ---------------------------------------------------------------------------
# All compiled JS goes here. The daemon plist, CLI, and plugin all reference
# this path. Runtime state (tasks/, logs/, projects/) lives in ~/.aof/ at the
# top level — dist/ is exclusively build output.

echo "[deploy] Syncing dist → ${AOF_DIST}/"
mkdir -p "${AOF_DIST}"
rsync -a --delete "${ROOT_DIR}/dist/" "${AOF_DIST}/"

if [[ ! -f "${AOF_DIST}/plugin.js" ]]; then
  echo "[deploy] plugin.js not found in build output." >&2
  exit 1
fi

# Fix index.ts entry point: the build copies it from the project root where it
# references ./dist/plugin.js, but inside dist/ that path is wrong. Rewrite to
# ./plugin.js so OpenClaw's extension loader resolves the plugin correctly.
if [[ -f "${AOF_DIST}/index.ts" ]]; then
  sed -i '' 's|"./dist/plugin.js"|"./plugin.js"|g' "${AOF_DIST}/index.ts"
fi

# Manifest: rewrite 'main' for flat dist layout (dist/plugin.js, not dist/dist/plugin.js)
echo "[deploy] Writing manifest to ${AOF_DIST}/"
node - "${ROOT_DIR}" "${AOF_DIST}" <<'MANIFEST'
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const dest = process.argv[3];
const manifest = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"));
manifest.main = "plugin.js";
fs.writeFileSync(path.join(dest, "openclaw.plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
MANIFEST

# Package files: needed for Node module resolution from dist/
TMP_PKG="$(mktemp)"
node - "${ROOT_DIR}" "${TMP_PKG}" <<'NODE'
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const out = process.argv[3];
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
pkg.main = "plugin.js";
pkg.openclaw = pkg.openclaw ?? {};
pkg.openclaw.extensions = ["plugin.js"];
fs.writeFileSync(out, JSON.stringify(pkg, null, 2));
NODE
mv "${TMP_PKG}" "${AOF_HOME}/package.json"
cp "${ROOT_DIR}/package-lock.json" "${AOF_HOME}/package-lock.json"

# ---------------------------------------------------------------------------
# Step 3: Sync node_modules → ~/.aof/node_modules/
# ---------------------------------------------------------------------------
# Lives at ~/.aof/node_modules/ (one level above dist/) so Node's upward
# resolution from ~/.aof/dist/**/*.js finds them automatically.

echo "[deploy] Syncing node_modules → ${AOF_HOME}/node_modules/"
rsync -a --delete "${ROOT_DIR}/node_modules/" "${AOF_HOME}/node_modules/"

# ---------------------------------------------------------------------------
# Step 4: Link plugin for OpenClaw discovery
# ---------------------------------------------------------------------------
# OpenClaw scans ~/.openclaw/extensions/ for plugins. Rather than copying the
# dist a second time, we symlink so there's one copy of the code. OpenClaw
# loads plugin.js from the symlink target (= ~/.aof/dist/plugin.js), and all
# relative imports resolve within ~/.aof/dist/.

if [[ "${1:-}" == "--core-only" ]]; then
  echo "[deploy] Skipping plugin symlink (--core-only)"
else
  echo "[deploy] Linking plugin: ${PLUGIN_LINK} → ${AOF_DIST}"
  mkdir -p "${OPENCLAW_EXT}"
  # Remove existing (file, dir, or stale symlink) before creating fresh link
  if [[ -e "${PLUGIN_LINK}" || -L "${PLUGIN_LINK}" ]]; then
    rm -rf "${PLUGIN_LINK}"
  fi
  ln -s "${AOF_DIST}" "${PLUGIN_LINK}"
fi

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

echo "[deploy] Validating..."
[[ -f "${AOF_DIST}/plugin.js" ]]
[[ -f "${AOF_DIST}/openclaw.plugin.json" ]]
[[ -f "${AOF_DIST}/daemon/index.js" ]]
[[ -f "${AOF_HOME}/package.json" ]]
[[ -d "${AOF_HOME}/node_modules" ]]

echo "[deploy] Done."
echo ""
echo "  Core:   ${AOF_DIST}/"
echo "  Plugin: ${PLUGIN_LINK} → ${AOF_DIST}"
echo ""
echo "  Next: restart BOTH processes to pick up the new code."
echo "    - Daemon:  launchctl kickstart -k \"gui/\$(id -u)/ai.openclaw.aof\""
echo "    - Gateway: launchctl kickstart -k \"gui/\$(id -u)/ai.openclaw.gateway\""
echo "  (Restarting only the gateway leaves the daemon on the old version, so"
echo "   any new IPC routes return 404 until the daemon is also restarted.)"
echo ""
echo "  To update the daemon plist itself (rare): aof daemon install"
