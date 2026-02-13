#!/usr/bin/env bash
set -euo pipefail

PROFILE="${OPENCLAW_PROFILE:-aof-container}"
PORT="${OPENCLAW_PORT:-19003}"
TOKEN="${OPENCLAW_TOKEN:-test-token-12345}"
ENABLE_MOCK_PROVIDER="${OPENCLAW_ENABLE_MOCK_PROVIDER:-true}"

SRC_DIR="${AOF_SRC_DIR:-/workspace}"
BUILD_DIR="/opt/aof-plugin"
EXT_BASE_DIR="${HOME}/.openclaw/extensions"
EXT_DIR="${EXT_BASE_DIR}/aof"
PROFILE_DIR="${HOME}/.openclaw-${PROFILE}"
DATA_DIR="${AOF_DATA_DIR:-${PROFILE_DIR}/aof-test-data}"

POLL_INTERVAL_MS="${AOF_POLL_INTERVAL_MS:-1000}"
DEFAULT_LEASE_TTL_MS="${AOF_DEFAULT_LEASE_TTL_MS:-30000}"
DRY_RUN="${AOF_DRY_RUN:-false}"

if [[ ! -f "${SRC_DIR}/dist/plugin.js" ]]; then
  echo "[openclaw-container] Missing ${SRC_DIR}/dist/plugin.js. Run 'npm run build' on host first." >&2
  exit 1
fi

if [[ ! -f "${SRC_DIR}/openclaw.plugin.json" ]]; then
  echo "[openclaw-container] Missing ${SRC_DIR}/openclaw.plugin.json. Ensure it exists in repo root." >&2
  exit 1
fi

mkdir -p "${BUILD_DIR}" "${EXT_BASE_DIR}" "${PROFILE_DIR}" "${DATA_DIR}"

# Stage AOF build + manifests (inside container, not host)
rm -rf "${BUILD_DIR}/dist" "${BUILD_DIR}/node_modules"
mkdir -p "${BUILD_DIR}/dist"
cp -R "${SRC_DIR}/dist/." "${BUILD_DIR}/dist/"
cp "${SRC_DIR}/openclaw.plugin.json" "${BUILD_DIR}/openclaw.plugin.json"
cp "${SRC_DIR}/package.json" "${SRC_DIR}/package-lock.json" "${BUILD_DIR}/"

# Install prod dependencies (container-local)
if [[ ! -d "${BUILD_DIR}/node_modules" ]]; then
  npm ci --omit=dev --prefix "${BUILD_DIR}"
fi

# Assemble extension directory
rm -rf "${EXT_DIR}"
mkdir -p "${EXT_DIR}"
cp -R "${BUILD_DIR}/dist/." "${EXT_DIR}/"
cp "${BUILD_DIR}/openclaw.plugin.json" "${EXT_DIR}/openclaw.plugin.json"
cat > "${EXT_DIR}/package.json" <<JSON
{
  "name": "aof",
  "version": "0.1.0",
  "type": "module",
  "main": "plugin.js"
}
JSON
ln -s "${BUILD_DIR}/node_modules" "${EXT_DIR}/node_modules"

if [[ "${ENABLE_MOCK_PROVIDER}" == "true" ]]; then
  cat > "${PROFILE_DIR}/openclaw.json" <<JSON
{
  "version": "2026.2.6",
  "gateway": {
    "mode": "local",
    "bind": "0.0.0.0",
    "port": ${PORT},
    "auth": "token"
  },
  "plugins": {
    "enabled": true,
    "allow": ["aof"],
    "entries": {
      "aof": {
        "enabled": true,
        "config": {
          "dataDir": "${DATA_DIR}",
          "pollIntervalMs": ${POLL_INTERVAL_MS},
          "defaultLeaseTtlMs": ${DEFAULT_LEASE_TTL_MS},
          "dryRun": ${DRY_RUN}
        }
      }
    }
  },
  "models": {
    "providers": {
      "mock-test": {
        "type": "mock",
        "responses": {
          "default": "Task acknowledged.",
          "tool_calls": true
        }
      }
    }
  },
  "agents": {
    "test-agent-1": {
      "model": "mock-test/default",
      "tools": ["aof_task_update", "aof_status_report", "aof_task_complete"],
      "workspace": "${PROFILE_DIR}/workspace-agent-1"
    },
    "test-agent-2": {
      "model": "mock-test/default",
      "tools": ["aof_task_update", "aof_status_report", "aof_task_complete"],
      "workspace": "${PROFILE_DIR}/workspace-agent-2"
    },
    "test-agent-3": {
      "model": "mock-test/default",
      "tools": ["aof_task_update", "aof_status_report", "aof_task_complete"],
      "workspace": "${PROFILE_DIR}/workspace-agent-3"
    }
  }
}
JSON
else
  cat > "${PROFILE_DIR}/openclaw.json" <<JSON
{
  "version": "2026.2.6",
  "gateway": {
    "mode": "local",
    "bind": "0.0.0.0",
    "port": ${PORT},
    "auth": "token"
  },
  "plugins": {
    "enabled": true,
    "allow": ["aof"],
    "entries": {
      "aof": {
        "enabled": true,
        "config": {
          "dataDir": "${DATA_DIR}",
          "pollIntervalMs": ${POLL_INTERVAL_MS},
          "defaultLeaseTtlMs": ${DEFAULT_LEASE_TTL_MS},
          "dryRun": ${DRY_RUN}
        }
      }
    }
  }
}
JSON
fi

echo "[openclaw-container] Starting OpenClaw gateway on :${PORT} (profile=${PROFILE})"
exec openclaw --profile "${PROFILE}" gateway run --port "${PORT}" --token "${TOKEN}" --bind 0.0.0.0
