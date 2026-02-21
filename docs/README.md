# AOF Documentation

**Agent Orchestration Framework (AOF)** — Multi-agent task orchestration with workflow gates, org charts, and deterministic routing.

---

## Contents

- [Getting Started](#getting-started)
- [Core Guides](#core-guides)
  - [Workflow Gates](#workflow-gates)
  - [Task Management](#task-management)
  - [Memory & Context](#memory--context)
  - [Protocols](#protocols)
  - [Notifications & SLA](#notifications--sla)
- [Operations](#operations)
- [Architecture & Design](#architecture--design)
- [Contributing](#contributing)
- [Quick Reference](#quick-reference)

---

## Getting Started

- **[Deployment Guide](DEPLOYMENT.md)** — Set up AOF as an OpenClaw plugin or standalone daemon
- **[Migration Guide](migration-guide.md)** — Upgrade from previous versions

For a 5-minute introduction, see the [Quick Start in the root README](../README.md#quick-start).

---

## Core Guides

### Workflow Gates

Multi-stage process enforcement with review gates, rejection loops, and conditional progression.

- **[Workflow Gates User Guide](WORKFLOW-GATES.md)** ⭐ — Complete guide to defining and using workflow gates
- **[Workflow Gates Design](design/WORKFLOW-GATES-DESIGN.md)** — Technical architecture and design decisions

**Example workflows:**

| File | Description |
|------|-------------|
| [simple-review.yaml](examples/simple-review.yaml) | Minimal 2-gate workflow for small teams |
| [swe-sdlc.yaml](examples/swe-sdlc.yaml) | Full 9-gate SWE workflow with conditionals |
| [sales-pipeline.yaml](examples/sales-pipeline.yaml) | Non-SWE example (demonstrates domain neutrality) |

### Task Management

- **[Task Format](task-format.md)** — Task file structure and frontmatter schema
- **[Definition of Done](DEFINITION-OF-DONE.md)** — What "complete" means for AOF tasks
- **[SLA Guide](SLA-GUIDE.md)** — SLA configuration, alerting, and tuning

### Memory & Context

- **[Memory Module](MEMORY-MODULE.md)** — HNSW vector search, embeddings, curation, and memory tools
- **[Memory Module Architecture Plan](architecture/MEMORY-MODULE-PLAN.md)** — Design decisions and implementation plan
- **[Tiered Memory Pipeline](memory-tier-pipeline.md)** — Hot/warm/cold tier curation pipeline
- **[Event Logs](event-logs.md)** — Date-rotated JSONL event stream and audit trail

### Protocols

- **[Protocols User Guide](PROTOCOLS-USER-GUIDE.md)** — How to use AOF inter-agent protocols (handoff, resume, status update, completion)
- **[Protocols Design](PROTOCOLS-DESIGN.md)** — Protocol envelope format and router design
- **[Protocols BDD Specs](PROTOCOLS-BDD-SPECS.md)** — Behavior-driven specifications

### Notifications & SLA

- **[Notification Policy](notification-policy.md)** — Channel routing, deduplication, storm batching
- **[SLA Guide](SLA-GUIDE.md)** — SLA tracking and alerting
- **[SLA Primitive Design](design/SLA-PRIMITIVE-DESIGN.md)** — SLA enforcement internals

---

## Operations

- **[Deployment Guide](DEPLOYMENT.md)** — Production deployment and configuration (plugin mode, daemon mode, Murmur)
- **[Recovery Runbook](RECOVERY-RUNBOOK.md)** — Troubleshooting and incident response
- **[CLI Recovery Reference](CLI-RECOVERY-REFERENCE.md)** — Quick reference for recovery CLI commands
- **[Known Issues](KNOWN-ISSUES.md)** — Current limitations and workarounds
- **[Release Checklist](RELEASE-CHECKLIST.md)** — Step-by-step process for cutting a public release

---

## Architecture & Design

| Document | Description |
|----------|-------------|
| [Agentic SDLC Design](design/AGENTIC-SDLC-DESIGN.md) | Reference multi-agent SDLC workflow built on AOF |
| [Daemon Watchdog Design](design/DAEMON-WATCHDOG-DESIGN.md) | Health monitoring and self-healing daemon |
| [SLA Primitive Design](design/SLA-PRIMITIVE-DESIGN.md) | SLA tracking and enforcement internals |
| [Adaptive Concurrency](design/adaptive-concurrency.md) | Platform limit detection and concurrency tuning |
| [E2E Test Harness Design](E2E-TEST-HARNESS-DESIGN.md) | End-to-end test harness architecture |
| [Security Remediation Design](SECURITY-REMEDIATION-DESIGN.md) | Protocol security hardening |
| [Memory Module Plan](architecture/MEMORY-MODULE-PLAN.md) | Memory v2 architecture (embeddings, SQLite-vec, tiered memory) |
| [Tiered Memory Pipeline](memory-tier-pipeline.md) | Tier-aware curation and retrieval pipeline |

---

## Contributing

- **[Dev Workflow](contributing/DEV-WORKFLOW.md)** — Fast-feedback loop for AOF contributors
- **[Dev Tooling Guide](DEV-TOOLING.md)** — Release automation, commit conventions, git hooks
- **[Engineering Standards](contributing/ENGINEERING-STANDARDS.md)** — Code quality and module structure rules
- **[Refactoring Protocol](contributing/REFACTORING-PROTOCOL.md)** — Mandatory protocol for safe incremental refactoring
- **[Agent Instructions](contributing/AGENTS.md)** — Task workflow for agents contributing to AOF

---

## Quick Reference

| Task | Document |
|------|----------|
| Set up AOF | [Deployment Guide](DEPLOYMENT.md) |
| Create a workflow | [Workflow Gates User Guide](WORKFLOW-GATES.md) |
| Understand task files | [Task Format](task-format.md) |
| Debug a stuck task | [Recovery Runbook](RECOVERY-RUNBOOK.md) |
| Send agent protocols | [Protocols User Guide](PROTOCOLS-USER-GUIDE.md) |
| Configure memory | [Memory Module](MEMORY-MODULE.md) |
| Cut a release | [Release Checklist](RELEASE-CHECKLIST.md) |
| Start contributing | [Dev Workflow](contributing/DEV-WORKFLOW.md) |

---

**Last Updated:** 2026-02-21
