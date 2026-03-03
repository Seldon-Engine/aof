---
title: "Workflow DAGs: User Guide"
description: "Define and use DAG-based workflows with parallel hops, conditions, rejection, and escalation."
---

**Version:** 1.2
**Last Updated:** 2026-03-03

---

## Overview

**Workflow DAGs** is AOF's system for orchestrating multi-stage processes as directed acyclic graphs. Each node in the graph is a **hop** -- a discrete unit of work assigned to a role. Edges between hops are defined by `dependsOn` references, enabling parallel execution, conditional branching, and flexible join semantics.

DAG workflows replace the earlier linear gate-based system (v1.0) with a strictly more expressive model:

| Feature | Gates (v1.0) | DAGs (v1.2) |
|---------|-------------|-------------|
| Execution order | Sequential only | Parallel + sequential |
| Branching | Conditional skip | True conditional paths |
| Conditions | JavaScript `when` string | JSON DSL (no eval) |
| Join semantics | N/A (linear) | AND-join / OR-join |
| Rejection | Loop to first gate | Origin or predecessors strategy |
| Artifacts | Global | Per-hop directories |

### Key Concepts

- **Hop**: A node in the workflow DAG. Each hop has an `id`, a `role` (who does the work), and optional `dependsOn` edges to predecessor hops.
- **Edge**: Defined by listing predecessor hop IDs in a hop's `dependsOn` array. A hop with empty `dependsOn` is a **root hop** and starts immediately.
- **Condition**: A JSON DSL expression that determines whether a hop executes or is skipped. Uses structured operators instead of arbitrary code.
- **Parallel execution**: Hops that share no dependency edges execute concurrently.
- **Join type**: When a hop has multiple predecessors, `joinType: "all"` (AND-join, default) waits for all; `joinType: "any"` (OR-join) proceeds when any predecessor completes.

---

## Quick Start: Your First DAG Workflow

Create a minimal 2-hop workflow: implement then review.

### Step 1: Define the Workflow Template

In your `project.yaml`, add a `workflowTemplates` section:

```yaml
workflowTemplates:
  simple-review:
    name: simple-review
    hops:
      - id: implement
        role: developer
        description: "Implement the feature with tests"

      - id: review
        role: reviewer
        dependsOn: [implement]
        canReject: true
        description: "Review code quality and correctness"
```

### Step 2: Create a Task with the Workflow

```bash
bd task create "Add user authentication" --workflow simple-review
```

AOF resolves the template, validates the DAG structure, initializes hop states, and creates the task. The `implement` hop starts as `ready` (it has no dependencies).

### Step 3: Observe Execution

The scheduler automatically dispatches the `implement` hop to an agent with the `developer` role. When the agent completes:

1. The `implement` hop transitions to `complete`
2. The evaluator checks downstream hops
3. The `review` hop becomes `ready` (its only dependency is satisfied)
4. The scheduler dispatches `review` to an agent with the `reviewer` role

If the reviewer rejects, the workflow resets to the origin (implement) and the cycle repeats.

### Step 4: Inspect Status

```bash
bd task show TASK-ID --workflow
```

This displays the current hop statuses, which hops are ready, dispatched, or complete.

---

## Hop Properties Reference

Each hop in the `hops` array supports these fields:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `id` | string | (required) | Unique identifier within the workflow (e.g., `"implement"`, `"review"`) |
| `role` | string | (required) | Org chart role responsible for this hop |
| `dependsOn` | string[] | `[]` | Predecessor hop IDs. Empty = root hop (starts immediately) |
| `joinType` | `"all"` \| `"any"` | `"all"` | How to handle multiple predecessors. `"all"` = AND-join, `"any"` = OR-join |
| `autoAdvance` | boolean | `true` | Whether to advance automatically on completion. `false` = wait for review |
| `condition` | ConditionExpr | (none) | JSON DSL expression; if false, hop is skipped |
| `canReject` | boolean | `false` | Whether this hop can reject work back |
| `rejectionStrategy` | `"origin"` \| `"predecessors"` | `"origin"` | Where rejected work loops back to |
| `description` | string | (none) | Human-readable purpose of the hop |
| `timeout` | string | (none) | Max duration before escalation (e.g., `"1h"`, `"30m"`, `"2d"`) |
| `escalateTo` | string | (none) | Role to escalate to when timeout fires |

---

## Condition DSL Reference

Conditions use a JSON DSL with structured operators. This is safer than arbitrary JavaScript -- no `eval()` or `new Function()` is ever used.

### Comparison Operators

| Operator | Fields | Description | Example |
|----------|--------|-------------|---------|
| `eq` | `field`, `value` | Field equals value | `{ op: "eq", field: "task.priority", value: "high" }` |
| `neq` | `field`, `value` | Field not equal to value | `{ op: "neq", field: "task.status", value: "blocked" }` |
| `gt` | `field`, `value` | Field greater than number | `{ op: "gt", field: "hops.implement.result.coverage", value: 80 }` |
| `gte` | `field`, `value` | Field greater than or equal | `{ op: "gte", field: "hops.qualify.result.score", value: 7 }` |
| `lt` | `field`, `value` | Field less than number | `{ op: "lt", field: "task.metadata.risk", value: 3 }` |
| `lte` | `field`, `value` | Field less than or equal | `{ op: "lte", field: "hops.review.result.issues", value: 0 }` |
| `in` | `field`, `value` (array) | Field value is in array | `{ op: "in", field: "task.priority", value: ["high", "critical"] }` |

### Special Operators

| Operator | Fields | Description | Example |
|----------|--------|-------------|---------|
| `has_tag` | `value` | Task has the specified tag | `{ op: "has_tag", value: "security" }` |
| `hop_status` | `hop`, `status` | Check a hop's current status | `{ op: "hop_status", hop: "review", status: "complete" }` |

### Logical Operators

| Operator | Fields | Description | Example |
|----------|--------|-------------|---------|
| `and` | `conditions` (array) | All conditions must be true | `{ op: "and", conditions: [...] }` |
| `or` | `conditions` (array) | Any condition must be true | `{ op: "or", conditions: [...] }` |
| `not` | `condition` (single) | Negate a condition | `{ op: "not", condition: {...} }` |

### Literal Operators

| Operator | Description |
|----------|-------------|
| `true` | Always true (useful for testing) |
| `false` | Always false (disable a hop without removing it) |

### YAML Condition Examples

Skip security review unless the task is tagged `security` or `auth`:

```yaml
- id: security-review
  role: security
  dependsOn: [implement]
  condition:
    op: or
    conditions:
      - op: has_tag
        value: security
      - op: has_tag
        value: auth
```

Only deploy if the review hop completed (not skipped):

```yaml
- id: deploy
  role: sre
  dependsOn: [review]
  condition:
    op: hop_status
    hop: review
    status: complete
```

Complex condition with nesting:

```yaml
- id: perf-test
  role: sre
  dependsOn: [implement]
  condition:
    op: and
    conditions:
      - op: has_tag
        value: performance
      - op: not
        condition:
          op: eq
          field: task.priority
          value: low
```

### Complexity Limits

To prevent runaway conditions:
- **Max nesting depth**: 5 levels
- **Max total nodes**: 50 nodes per expression

These limits are enforced by `validateDAG()` at workflow creation time.

### Field Resolution

Condition fields use dot-path resolution against a context object:
- `task.status`, `task.priority`, `task.tags` -- task metadata
- `hops.<hopId>.result.<field>` -- output from a completed hop

Missing fields resolve to `undefined`. For `eq`, this means the comparison returns false. For `neq`, it returns true. For numeric operators (`gt`, `lt`, etc.), missing fields return false.

---

## Timeout and Escalation

Hops can enforce time limits with automatic escalation to senior roles.

### Configuration

```yaml
- id: code-review
  role: architect
  dependsOn: [implement]
  timeout: 2h
  escalateTo: tech-lead
```

### Duration Format

- `"30m"` = 30 minutes
- `"2h"` = 2 hours
- `"1d"` = 1 day (24 hours)

### Escalation Behavior

When a hop exceeds its timeout:

1. The hop is force-completed by the timeout handler
2. A new session is spawned for the `escalateTo` role
3. The `escalated` flag is set on the hop state (prevents re-escalation)
4. A `dag.hop_escalated` event is logged

If the escalation spawn fails, the hop is set back to `ready` with `escalated: true` for poll-based retry.

---

## Rejection and Recovery

### Enabling Rejection

Set `canReject: true` on hops that should be able to send work back:

```yaml
- id: review
  role: reviewer
  dependsOn: [implement]
  canReject: true
  rejectionStrategy: origin
```

### Rejection Strategies

| Strategy | Behavior |
|----------|----------|
| `origin` (default) | Reset ALL hops back to initial state. Root hops become `ready`, others become `pending`. The entire workflow restarts. |
| `predecessors` | Reset only the rejected hop and its immediate `dependsOn` predecessors. Other hops retain their state. |

### Circuit Breaker

To prevent infinite rejection loops, a circuit breaker triggers after **3 consecutive rejections** of the same hop. When triggered:

1. The hop is permanently set to `failed`
2. All downstream hops are cascade-skipped
3. The DAG enters `failed` status
4. A `dag.circuit_breaker` event is logged

The rejection count persists across rejection cascades and is stored on the hop state.

---

## Template Workflows

Define reusable workflows in `project.yaml` under `workflowTemplates`:

```yaml
workflowTemplates:
  simple-review:
    name: simple-review
    hops:
      - id: implement
        role: developer
      - id: review
        role: reviewer
        dependsOn: [implement]
        canReject: true

  full-sdlc:
    name: full-sdlc
    hops:
      - id: implement
        role: developer
      - id: code-review
        role: architect
        dependsOn: [implement]
        canReject: true
      - id: qa
        role: qa
        dependsOn: [code-review]
        canReject: true
      - id: deploy
        role: sre
        dependsOn: [qa]
```

Reference templates when creating tasks:

```bash
bd task create "Build feature X" --workflow simple-review
```

The CLI resolves the template from `project.yaml`, validates the DAG, and embeds the full definition on the task. The `templateName` field preserves traceability but the embedded definition is the source of truth.

---

## Ad-hoc Workflows

For one-off workflows, define the DAG inline in task YAML frontmatter:

```yaml
---
id: TASK-custom-001
title: "Custom review process"
status: ready
workflow:
  definition:
    name: custom-review
    hops:
      - id: implement
        role: developer
      - id: peer-review
        role: developer
        dependsOn: [implement]
        canReject: true
      - id: lead-review
        role: tech-lead
        dependsOn: [peer-review]
        canReject: true
  state:
    status: pending
    hops:
      implement: { status: ready }
      peer-review: { status: pending }
      lead-review: { status: pending }
---
```

Ad-hoc workflows are validated by `validateDAG()` at task creation time, the same as template workflows.

---

## Parallel Hops

Hops execute in parallel when they share no dependency edges. Use `dependsOn` to express which hops must complete before others can start.

### Fan-Out Pattern

Multiple hops depend on the same predecessor:

```yaml
hops:
  - id: implement
    role: developer

  - id: code-review
    role: architect
    dependsOn: [implement]

  - id: security-review
    role: security
    dependsOn: [implement]
    condition:
      op: has_tag
      value: security

  # Both reviews run in parallel after implement completes
```

### Fan-In Pattern (Join)

A hop depends on multiple predecessors:

```yaml
  - id: deploy
    role: sre
    dependsOn: [code-review, security-review]
    joinType: all   # Wait for ALL predecessors (default)
```

### Join Types

- **`all` (AND-join, default)**: The hop becomes ready when ALL predecessors are `complete` or `skipped`, with at least one `complete`. If all predecessors are skipped/failed, the hop is cascade-skipped.
- **`any` (OR-join)**: The hop becomes ready when ANY predecessor is `complete`. Useful for "first-one-wins" patterns.

---

## Artifact Handoff

Each hop gets its own artifact directory at `<task-dir>/work/<hop-id>/`. When a hop is dispatched, the agent receives an `artifactPaths` map in its context containing paths to completed predecessor hop directories.

```
task-dir/
  work/
    implement/     # Artifacts from implement hop
    code-review/   # Artifacts from code-review hop
    deploy/        # Artifacts from deploy hop
```

Downstream hops can read upstream artifacts via the `artifactPaths` map provided in `HopContext`:

```typescript
// In the agent's hop context:
{
  hopId: "deploy",
  artifactPaths: {
    "implement": "/path/to/task/work/implement",
    "code-review": "/path/to/task/work/code-review"
  }
}
```

Only completed predecessor hops appear in `artifactPaths` (not skipped or failed ones).

---

## Best Practices

### Keep DAGs Shallow

Prefer wide, shallow DAGs over deep chains. A DAG with 3-4 levels of depth is easy to reason about. A DAG with 10+ levels may indicate over-engineering.

### Use Meaningful Hop IDs

Hop IDs appear in logs, events, conditions, and artifact paths. Use descriptive IDs like `security-review`, not `step-4`.

### Limit Condition Complexity

The DSL enforces a max depth of 5 and max node count of 50, but aim for much simpler conditions. Most real-world conditions need 1-3 operators.

### Start Simple, Add Complexity

Begin with a linear 2-hop workflow (implement -> review). Add parallel hops, conditions, and rejection as your process matures.

### Tag Consistently

Establish a tagging vocabulary for condition-based routing:
- `security` -- trigger security review
- `api` -- trigger documentation update
- `performance` -- trigger load testing
- `skip-qa` -- bypass QA for trivial changes

### Set Realistic Timeouts

Base timeout values on historical data. Start conservative and tighten as you measure actual cycle times.

---

## Monitoring

### Event Logs

Every hop transition is logged as a structured event:

- `dag.hop_dispatched` -- hop assigned to agent
- `dag.hop_completed` -- hop finished (with outcome)
- `dag.hop_rejected` -- hop rejected work back
- `dag.hop_escalated` -- hop escalated on timeout
- `dag.circuit_breaker` -- rejection circuit breaker triggered

### Hop Status Inspection

Check workflow status via the CLI:

```bash
# Show full workflow state
bd task show TASK-ID --workflow

# List all tasks with active workflows
bd task list --status in_progress --has-workflow
```

### Hop Status Lifecycle

```
pending -> ready -> dispatched -> complete
                               -> failed
                               -> skipped
```

- **pending**: Predecessors not yet satisfied
- **ready**: All predecessors complete/skipped, eligible for dispatch
- **dispatched**: Agent session spawned, work in progress
- **complete**: Hop finished successfully
- **failed**: Hop failed (agent error, timeout, circuit breaker)
- **skipped**: Condition evaluated to false, or cascade-skipped from upstream failure

---

## Troubleshooting

### Cycle Detection Error

**Symptom**: `"Cycle detected involving hops: X, Y"` on task creation

**Cause**: The `dependsOn` edges form a cycle. Hop A depends on B, B depends on A.

**Fix**: Review `dependsOn` references. DAGs must be acyclic -- every hop must eventually trace back to a root hop with no dependencies.

### Condition Parsing Error

**Symptom**: `"Hop X condition exceeds max nesting depth"` or `"exceeds max node count"`

**Cause**: Condition expression is too complex (depth > 5 or nodes > 50).

**Fix**: Simplify the condition. Break complex logic into separate hops with simpler conditions.

### Hop Stuck in Dispatched

**Symptom**: Hop stays `dispatched` indefinitely

**Cause**: Agent session completed but completion event was lost, or agent crashed.

**Fix**: The scheduler's poll fallback detects stale dispatched hops. If a timeout is configured, escalation triggers automatically. Check event logs for dispatch/completion events.

### All Hops Skipped

**Symptom**: DAG completes immediately with all hops skipped

**Cause**: Root hops have conditions that evaluate to false, cascading skips to all downstream hops.

**Fix**: Ensure at least one root hop has no condition or a condition that evaluates to true.

### Rejection Loop

**Symptom**: Task keeps cycling between implement and review

**Cause**: Reviewer keeps rejecting, developer keeps resubmitting without fixing issues.

**Fix**: The circuit breaker triggers after 3 rejections, failing the hop permanently. Review the rejection feedback in event logs.

---

## Examples

See the `examples/` directory for complete workflow samples:

- **[simple-review.yaml](../examples/simple-review.yaml)** -- Minimal 2-hop workflow
- **[swe-sdlc.yaml](../examples/swe-sdlc.yaml)** -- Full multi-hop SDLC with conditions
- **[sales-pipeline.yaml](../examples/sales-pipeline.yaml)** -- Non-SWE domain example
- **[parallel-review.yaml](../examples/parallel-review.yaml)** -- Fan-out/fan-in parallel pattern
- **[conditional-branching.yaml](../examples/conditional-branching.yaml)** -- Conditional path selection

---

## Further Reading

- **[Developer Design Document](../dev/workflow-dag-design.md)** -- Architecture, evaluator internals, extension points
- **[Task Format](./task-format.md)** -- Task file structure and frontmatter schema

---

## Changelog

### 1.2 (2026-03-03)
- DAG-based workflows replace gate-based workflows
- Parallel hop execution with AND/OR joins
- JSON DSL conditions (replaces JavaScript `when` expressions)
- Per-hop artifact directories
- Rejection strategies: origin and predecessors
- Circuit breaker on rejection loops
- Timeout escalation with one-shot flag

### 1.0 (2026-02-16)
- Initial release (gate-based, now superseded)
