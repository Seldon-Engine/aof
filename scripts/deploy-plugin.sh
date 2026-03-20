#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${AOF_EXTENSION_DIR:-${1:-$HOME/.openclaw/extensions/aof}}"

if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
  echo "[deploy-plugin] node_modules missing. Run 'npm ci' first." >&2
  exit 1
fi

if [[ ! -f "${ROOT_DIR}/openclaw.plugin.json" ]]; then
  echo "[deploy-plugin] openclaw.plugin.json missing at repo root." >&2
  exit 1
fi

echo "[deploy-plugin] Building AOF..."
( cd "${ROOT_DIR}" && npm run build )

echo "[deploy-plugin] Syncing dist output to ${EXT_DIR}..."
mkdir -p "${EXT_DIR}"
rsync -a --delete "${ROOT_DIR}/dist/" "${EXT_DIR}/"

if [[ ! -f "${EXT_DIR}/plugin.js" ]]; then
  echo "[deploy-plugin] plugin.js not found in build output (did you add src/plugin.ts?)" >&2
  exit 1
fi

echo "[deploy-plugin] Copying manifest (rewriting main for flattened layout)..."
node - "${ROOT_DIR}" "${EXT_DIR}" <<'MANIFEST'
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const ext = process.argv[3];
const manifest = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"));
manifest.main = "plugin.js";
fs.writeFileSync(path.join(ext, "openclaw.plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
MANIFEST

TMP_PKG="$(mktemp)"
node - "${ROOT_DIR}" "${TMP_PKG}" <<'NODE'
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const out = process.argv[3];
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.main = "plugin.js";
pkg.openclaw = pkg.openclaw ?? {};
pkg.openclaw.extensions = ["plugin.js"];
fs.writeFileSync(out, JSON.stringify(pkg, null, 2));
NODE

mv "${TMP_PKG}" "${EXT_DIR}/package.json"
cp "${ROOT_DIR}/package-lock.json" "${EXT_DIR}/package-lock.json"

echo "[deploy-plugin] Syncing node_modules..."
rsync -a --delete "${ROOT_DIR}/node_modules/" "${EXT_DIR}/node_modules/"

echo "[deploy-plugin] Validating output..."
[[ -f "${EXT_DIR}/plugin.js" ]]
[[ -f "${EXT_DIR}/openclaw.plugin.json" ]]
[[ -f "${EXT_DIR}/package.json" ]]

echo "[deploy-plugin] Done. (No gateway restart performed.)"
