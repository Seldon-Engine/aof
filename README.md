# AOF — Agentic Ops Fabric

AOF lets you run teams of AI agents the way you'd run teams of people. Define your org structure, assign roles, and set up workflows. AOF handles the rest: routing tasks, enforcing review stages, recovering from crashes, and making sure nothing falls through the cracks.

It works for any domain where agents collaborate — software engineering, RevOps, sales, marketing, research, whatever. If your process has steps, AOF can govern it.

---

## What It Does

- **Org-chart-driven orchestration.** Model agents, teams, and hierarchies in a YAML org chart. Work gets routed by capability, team, and priority.
- **Workflow DAGs.** Define multi-stage pipelines with review loops, conditional branches, and parallel fan-out. Agents follow the process — no skipping steps, no dropped handoffs.
- **Shared memory.** Agents build on each other's knowledge through semantic memory with HNSW vector search and tiered curation.
- **Works for any domain.** SWE (implement → review → QA → deploy), RevOps (qualify → enrich → handoff), sales pipelines, research workflows. If it has a process, it fits.
- **Nothing gets dropped.** Filesystem-first task store with atomic state transitions, lease-based locking, and deadletter recovery. Tasks survive crashes, restarts, and API failures.

---

## Quick Start

### Prerequisites

- **Node.js >= 22** (LTS recommended)
- **OpenClaw gateway** running ([openclaw.dev](https://openclaw.dev))

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh
```

### Set up and run

```bash
aof init              # Configure OpenClaw integration
aof daemon install    # Start the background daemon
aof task create "My first task" --agent main-agent
aof daemon status     # Verify it's running
```

See the **[Getting Started Guide](docs/guide/getting-started.md)** for a complete zero-to-working walkthrough.

---

## Key Features

| Feature | Description | Docs |
|---------|-------------|------|
| Org chart governance | YAML org charts define agents, teams, routing rules, and memory scopes | [Configuration](docs/guide/configuration.md) |
| DAG workflows | Multi-stage pipelines with rejection loops and parallel fan-out | [Workflow DAGs](docs/guide/workflow-dags.md) |
| Protocol system | Typed inter-agent messages: handoff, resume, status update, completion | [Protocols](docs/guide/protocols.md) |
| Semantic memory | HNSW vector index with hybrid search and tiered curation | [Memory](docs/guide/memory.md) |
| Recovery-first | Deadletter queue, task resurrection, lease expiration, drift detection | [Recovery](docs/guide/recovery.md) |
| Observability | Prometheus metrics, JSONL events, Kanban board | [Event Logs](docs/guide/event-logs.md) |

---

## Documentation

### For Users

- **[Getting Started](docs/guide/getting-started.md)** — Install, configure, and orchestrate your first agent team
- **[Configuration Reference](docs/guide/configuration.md)** — Org chart schema, AOF config, OpenClaw plugin wiring
- **[CLI Reference](docs/guide/cli-reference.md)** — Complete command reference (auto-generated)
- **[Full User Guide](docs/README.md)** — All user-facing docs

### For Contributors

- **[Architecture Overview](docs/dev/architecture.md)** — System diagram, subsystem descriptions, key interfaces
- **[Dev Workflow](docs/dev/dev-workflow.md)** — Development setup and fast-feedback loop
- **[Full Developer Guide](docs/README.md)** — All contributor and design docs

---

## License

MIT — see [LICENSE](LICENSE).
