# AOF -- Agentic Ops Fabric

**Orchestrate teams of agents like you'd orchestrate teams of people.** AOF is a multi-team agent orchestration platform -- define orgs, teams, individual agents, and teams of teams, then enforce gated workflows across any domain: software engineering, RevOps, operations, sales and marketing, research, and more. Agents collaborate through shared memories, tasks, and protocols, with the same organizational primitives a human team would use. Nothing gets dropped -- tasks survive gateway restarts, API failures, rate limits, and agent crashes, always resuming and completing end-to-end.

---

## What It Does

- **Multi-team agent orchestration** -- Model orgs, teams, individual agents, and hierarchies of teams with declarative YAML org charts; route work by capability, team, and priority
- **Domain-agnostic workflows** -- Enforce gated processes for any domain: SWE (implement, review, QA, deploy), RevOps (qualify, enrich, handoff), sales pipelines, marketing campaigns, research workflows -- if it has a process, AOF can govern it
- **Collaborative primitives** -- Agents share memories, tasks, and context the way human teams do; semantic memory with HNSW vector search and tiered curation lets agents build on each other's knowledge
- **Workflow enforcement** -- Multi-stage gates with rejection loops ensure agents follow the process; no skipping steps, no dropped handoffs
- **Resilient task fabric** -- Filesystem-first kanban with atomic state transitions, lease-based locking, deadletter recovery, and event sourcing; tasks survive crashes and always resume

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
| Org chart governance | Declarative YAML defines agents, teams, teams of teams, routing rules, and memory scopes | [Configuration](docs/guide/configuration.md) |
| Workflow gates | Multi-stage review gates with rejection loops | [Workflow Gates](docs/guide/workflow-gates.md) |
| Protocol system | Typed inter-agent messages: handoff, resume, status update, completion | [Protocols](docs/guide/protocols.md) |
| Semantic memory | HNSW vector index with hybrid search and tiered curation | [Memory](docs/guide/memory.md) |
| Recovery-first | Deadletter queue, task resurrection, lease expiration, drift detection | [Recovery](docs/guide/recovery.md) |
| Observability | Prometheus metrics, JSONL events, Kanban board, real-time views | [Event Logs](docs/guide/event-logs.md) |

---

## Documentation

### For Users

- **[Getting Started](docs/guide/getting-started.md)** -- Install, configure, and orchestrate your first agent team
- **[Configuration Reference](docs/guide/configuration.md)** -- Org chart schema, AOF config, OpenClaw plugin wiring
- **[CLI Reference](docs/guide/cli-reference.md)** -- Complete command reference (auto-generated)
- **[Full User Guide](docs/README.md)** -- All user-facing docs

### For Contributors

- **[Architecture Overview](docs/dev/architecture.md)** -- System diagram, subsystem descriptions, key interfaces
- **[Dev Workflow](docs/dev/dev-workflow.md)** -- Development setup and fast-feedback loop
- **[Full Developer Guide](docs/README.md)** -- All contributor and design docs

---

## License

MIT -- see [LICENSE](LICENSE).
