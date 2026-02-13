# OpenClaw Container Test Environment (AOF)

This directory provides a containerized OpenClaw gateway for QA to validate the **real** plugin API behavior before any production deployment.

## Prerequisites
- Docker + Docker Compose
- AOF built locally (`npm run build` from repo root)

## Quick Start
```bash
# From repo root
npm run build

# Start the containerized gateway
cd tests/integration/openclaw
docker compose up --build
```

Gateway will listen on `http://localhost:19003` with token `test-token-12345`.

## Run Integration Tests
```bash
# From repo root (after container is up)
npm run test:integration:plugin
```

This runs the full integration test suite against the containerized OpenClaw gateway.

## Manual Smoke Checks (Optional)
```bash
# Status endpoint should return 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:19003/aof/status

# Metrics endpoint should return 200 (Prometheus format)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:19003/aof/metrics

# View status details
curl -s http://localhost:19003/aof/status | jq .
```

## Environment Variables
Set via `docker-compose.yml` or `docker compose run -e`:

- `OPENCLAW_PROFILE` (default: `aof-container`)
- `OPENCLAW_PORT` (default: `19003`)
- `OPENCLAW_TOKEN` (default: `test-token-12345`)
- `OPENCLAW_ENABLE_MOCK_PROVIDER` (default: `true`)
- `AOF_DATA_DIR` (default: `/opt/openclaw/.openclaw-<profile>/aof-test-data`)
- `AOF_POLL_INTERVAL_MS` (default: `1000`)
- `AOF_DEFAULT_LEASE_TTL_MS` (default: `30000`)
- `AOF_DRY_RUN` (default: `false`)

## Notes
- The container reads AOF build artifacts from the host repo (`/workspace/dist` and `/workspace/openclaw.plugin.json`).
- If `dist/plugin.js` is missing, the container will fail fast with an error.
- This environment is **required** for QA sign-off before any production deployment.

## Cleanup
```bash
docker compose down -v
```
