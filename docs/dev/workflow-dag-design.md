---
title: "Workflow DAG Design"
description: "Architecture and design decisions for the DAG-based workflow engine."
---

# Workflow DAG Design

This document describes the architecture of the DAG-based workflow engine that replaced the linear gate-based workflow system.

## Core Components

- **Schema** (`src/schemas/workflow-dag.ts`): Zod types for hops, conditions, state, and validation
- **Evaluator** (`src/dag/evaluate-dag.ts`): Stateless DAG evaluation with condition evaluation and hop advancement
- **Scheduler** (`src/scheduler/`): Dispatches ready hops to agents, handles completion and failure
- **Migration** (`src/migration/gate-to-dag.ts`): Lazy gate-to-DAG migration on task load

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Per-hop `dependsOn` array | Mirrors task `dependsOn` pattern for consistency |
| JSON DSL conditions | Safe agent-authored conditions without eval/new Function |
| Standalone `validateDAG()` | Avoids slow parse on every task load |
| Hop state as map by ID | O(1) lookup for status checks |
| One hop dispatched at a time | OpenClaw no-nested-sessions constraint |
| Atomic state via writeFileAtomic | Crash-safe state persistence |

## Extension Points

- Add new condition operators to `ConditionExpr` discriminated union
- Add new hop fields (backward compatible via Zod defaults)
- Template registry for reusable workflow definitions
