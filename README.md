# AOF — Agentic Ops Fabric

Deterministic orchestration for multi-agent systems.

## What is AOF?

AOF is an automation layer that turns an OpenClaw multi-agent setup into a **reliable, observable, restart-safe operating system for agent work**.

### Key Principles

- **Deterministic scheduler** — no LLM calls in the control plane
- **Filesystem-as-API** — task files are the single source of truth
- **Tasks as files** — Markdown + YAML frontmatter, atomic `rename()` transitions
- **Derived views** — Mailbox and Kanban are computed from canonical `tasks/`
- **Restart-safe** — lease-based locking with automatic recovery
- **Observable** — Prometheus metrics, JSONL event log

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Lint tasks
npx aof lint

# Scan tasks
npx aof scan
```

## Memory V2 (org-chart driven memory scoping + curation)

AOF governs memory **structure and lifecycle** — not retrieval. The host platform (OpenClaw) handles retrieval. AOF manages scoping, policy, and curation through its task dispatch pipeline.

Memory scoping is defined in the org chart under `memoryPools`:

- **hot**: single pool always indexed. `agents` defaults to `all`; accepts agent IDs or wildcards like `swe-*`.
- **warm**: list of pools with `id`, `path`, and `roles` selectors. `roles` supports agent IDs, wildcards, and `all`.
- **cold**: list of path substrings that must never appear in `memorySearch.extraPaths` (policy for lint/audit).

Memory curation is governed by adaptive policies that scale with datastore size (see [MEMORY-INTEGRATION-ARCHITECTURE.md](docs/MEMORY-INTEGRATION-ARCHITECTURE.md)).

### `aof memory generate`

Generate an OpenClaw memory config from the org chart.

```bash
npx aof memory generate [org-chart.yaml] --out <path> --vault-root <path>
```

**Flags**
- `--out` Output path for generated config (default: `org/generated/memory-config.json`)
- `--vault-root` Vault root used to resolve relative pool paths

**Env vars**
- `AOF_VAULT_ROOT` or `OPENCLAW_VAULT_ROOT` (used when `--vault-root` is omitted)

**Example output**
```
✅ Memory config generated: /.../org/generated/memory-config.json

Memory scope by agent:
  main
    hot: /Vault/Resources/OpenClaw/_Core (via all)
    warm: ops → /Vault/Resources/OpenClaw/Ops (via main)
```

### `aof memory audit`

Audit OpenClaw config against the org chart policy.

```bash
npx aof memory audit [org-chart.yaml] --config <path> --vault-root <path>
```

**Flags**
- `--config` Path to `openclaw.json` (default: `~/.openclaw/openclaw.json`)
- `--vault-root` Vault root used to resolve relative pool paths

**Env vars**
- `OPENCLAW_CONFIG` (override config path)
- `AOF_VAULT_ROOT` or `OPENCLAW_VAULT_ROOT` (used when `--vault-root` is omitted)

**Exit codes**
- `0` No drift detected
- `1` Drift detected or validation failed

**Example output**
```
Memory V2 Audit Report
======================
✗ swe-backend
  - /Vault/Resources/OpenClaw/Architecture

Summary:
  Agents with drift: 1
  Missing paths: 1
  Extra paths: 0
  Missing config: 0
```

### `aof memory curate`

Generate memory curation tasks based on adaptive thresholds.

```bash
npx aof memory curate [--policy <path>] [--org <path>] [--entries <count>] [--project <id>] [--dry-run]
```

**Flags**
- `--policy` Path to curation policy file (YAML). Falls back to `memoryCuration.policyPath` in org chart.
- `--org` Path to org chart (default: `org/org-chart.yaml`)
- `--entries` Manual entry count override (required for memory-lancedb backend)
- `--project` Project ID for task store (default: `_inbox`)
- `--dry-run` Preview tasks without creating

**Env vars**
- `AOF_VAULT_ROOT` or `OPENCLAW_VAULT_ROOT` (used to resolve pool paths)

**How it works**
1. Detects memory backend (memory-core, memory-lancedb, or filesystem)
2. Counts entries per pool or globally (depending on backend)
3. Applies curation policy thresholds to determine required tasks
4. Creates maintenance tasks and routes them to the org chart role specified in `memoryCuration.role`

**Example output**
```
📋 Curation Policy: org/curation-policy.yaml
   Strategy: adaptive
   Thresholds: 4

🔍 Memory Backend: memory-lancedb (openclaw config)

📊 Inventory:
   lancedb: 1,247 entries

📝 Tasks:
   ✓ Created task-curation-001.md → ready/
     - Scope: lancedb (1,247 entries)
     - Strategy: dedup+merge+expire
```

## Project Structure

```
AOF/
├── src/                    # TypeScript source
│   ├── cli/                # CLI entry point
│   ├── types/              # Type definitions (task, org-chart, event)
│   ├── tasks/              # Task parser, scanner, linter
│   ├── events/             # JSONL event logger
│   ├── dispatch/           # Scheduler (Phase 0.3)
│   ├── org/                # Org chart loader + linter (Phase 1)
│   ├── memory/             # Memory V2 (scoping, audit, curation)
│   │   ├── generator.ts            # Memory config generation
│   │   ├── audit.ts                # Memory drift detection
│   │   ├── curation-policy.ts      # Curation policy schema + loader
│   │   ├── host-detection.ts       # Memory backend detection
│   │   └── curation-generator.ts   # Curation task generator
│   ├── views/              # Mailbox + Kanban generators (Phase 2)
│   ├── metrics/            # Prometheus exporter (Phase 2)
│   ├── config/             # CLI config management (Phase 1)
│   ├── comms/              # Agent communication adapter (Phase 2)
│   └── recovery/           # Restart recovery (Phase 2)
├── tasks/                  # Canonical task store (SSOT)
│   ├── backlog/
│   ├── ready/
│   ├── in-progress/
│   ├── review/
│   ├── done/
│   ├── blocked/
│   └── deadletter/
├── org/                    # Org chart YAML
├── events/                 # JSONL event logs
├── views/                  # Derived views (mailbox, kanban)
├── agents/                 # Per-agent state
├── tests/                  # Unit + integration tests
└── docs/                   # Documentation
```

## Architecture

- **Task Store** (`tasks/`): Single source of truth. Status = directory.
- **Org Chart** (`org/org-chart.yaml`): Canonical topology, routing, memory scoping, curation policy.
- **Event Log** (`events/YYYY-MM-DD.jsonl`): Append-only audit trail.
- **Views**: Computed from task store — never edited directly.
  - Mailbox view: `Agents/<agent>/{inbox,processing,outbox}` (see `docs/mailbox-view.md`).
- **Memory Governance**: AOF generates config, audits drift, and dispatches curation tasks. Host platform handles retrieval.

## Stack

- Node.js 22+ / TypeScript (ESM, strict mode)
- No database (filesystem-first)
- Prometheus metrics export
- JSONL event log

## Testing

![E2E Tests](https://github.com/xspriet/AOF/actions/workflows/e2e-tests.yml/badge.svg)

### Unit & Integration Tests

```bash
npm test                 # Run unit/integration tests
npm run test:watch       # Watch mode
```

**Coverage:** 682 tests across 67 files, all passing.

### E2E Tests

```bash
npm run test:e2e         # Run end-to-end tests
npm run test:e2e:watch   # Watch mode
npm run test:e2e:verbose # With detailed logs
```

**Coverage:** 133 tests across 10 suites, ~7 second runtime.

E2E tests verify core AOF functionality through library-level integration:
- ✅ TaskStore operations (CRUD, transitions, lease management)
- ✅ Event logging (JSONL format, daily rotation)
- ✅ Tool execution (aof_task_update, aof_task_complete, aof_status_report)
- ✅ Dispatch flows (task assignment, completion workflows)
- ✅ View updates (mailbox, Kanban board)
- ✅ Context engineering (task context generation)
- ✅ Metrics export (Prometheus format)
- ✅ Gateway handlers (/metrics, /aof/status endpoints)
- ✅ Concurrent dispatch (lease management, race conditions)
- ✅ Drift detection (org chart vs live agents)

**Documentation:** See [tests/e2e/README.md](tests/e2e/README.md) for detailed test documentation, troubleshooting guide, and debugging tips.

### All Tests

```bash
npm run test:all         # Run unit + E2E tests
```

**CI/CD:** All tests run automatically on every PR via GitHub Actions.

## Status

**Phase 0 — Foundations** (near complete)
- [x] Zod schemas (task, org-chart, event, config)
- [x] Task store (status subdirectories, CRUD, transitions)
- [x] Lease management (acquire, renew, release, expire with TTL)
- [x] Scheduler dry-run mode (scan, expired lease detection, routing)
- [x] JSONL event logger (append-only, daily rotation)
- [x] Prometheus metrics exporter (all 8 FR-7.1 metrics)
- [x] Org chart loader + Zod validation
- [x] Org chart linter (9 referential integrity rules)
- [x] Config manager (get/set/validate, atomic writes, dry-run)
- [x] CLI: lint, scan, scheduler run, task create, org validate/lint/show, config get/set/validate
- [x] 682 unit tests + 133 E2E tests passing
- [ ] Active dispatch mode (spawn agents via OpenClaw)
- [ ] Metrics HTTP server daemon integration
- [ ] Scheduler daemon loop (continuous poll)

## License

MIT
