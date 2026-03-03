# Feature Landscape: Per-Task Workflow DAGs

**Domain:** Multi-agent orchestration -- per-task workflow DAG execution (v1.2 milestone)
**Researched:** 2026-03-02
**Confidence:** MEDIUM-HIGH (patterns drawn from Temporal, Airflow, Step Functions, Prefect, Dagster; no live doc verification available for this session)

## Context

This is a SUBSEQUENT MILESTONE. AOF v1.1 shipped with linear gate-based workflows (ordered sequence of gates with conditional skipping, rejection loops, timeout/escalation). v1.2 replaces that linear model with per-task workflow DAGs -- a directed acyclic graph of "hops" where each hop is independently dispatched to a different agent by the scheduler. Hops can auto-advance or pause for review. The DAG supports conditional branching and parallel execution.

**Critical constraint from PROJECT.md:** OpenClaw does not support nested agent sessions. The scheduler must advance hops *between* independent sessions. Each hop is a standalone dispatch -- the agent completes, the scheduler reads the result, evaluates the DAG, and dispatches the next eligible hop(s).

Existing codebase already has:
- `WorkflowConfig` with ordered `gates[]`, `rejectionStrategy`, gate outcomes (complete/needs_review/blocked)
- `Gate` schema: `id`, `role`, `canReject`, `when` conditional, `timeout`, `escalateTo`, `requireHuman`
- `GateHistoryEntry` for audit trail, `ReviewContext` for rejection feedback, `GateTransition` for telemetry
- `evaluateGateTransition()` -- pure function, no I/O, handles complete/reject/blocked outcomes
- `handleGateTransition()` -- orchestrates load task, load workflow, evaluate, apply, emit events
- `buildDispatchActions()` -- scheduler builds assign actions for ready tasks with dependency gating
- Task `dependsOn[]` field with full DAG dependency resolution (transitive, circular detection)
- `RunArtifact` with `artifactPaths` (inputs/, work/, output/) for each task execution
- `HandoffRequestPayload` with acceptance criteria, expected outputs, context refs, constraints
- `CompletionReportPayload` with outcome, deliverables, test report, blockers, notes

**Key gap:** The existing system models workflows at the *project* level (one workflow per project). v1.2 models workflows at the *task* level (each task carries its own workflow DAG). Multiple tasks in the same project can have different workflows.

---

## Table Stakes

Features users expect from a per-task workflow DAG system. Missing = the system cannot replace what linear gates already provide.

### 1. Hop Schema (DAG Node Definition)

| Aspect | Detail |
|--------|--------|
| Why Expected | The fundamental unit of work in a DAG. Without it, nothing else works. Replaces the `Gate` schema. |
| Complexity | LOW |
| Depends On | Existing `Gate` schema (evolves from it), Zod schema infrastructure |

**What the ecosystem does:**

Every workflow engine has a "step" or "activity" primitive. In Temporal these are "activities," in Airflow they are "tasks" (confusing overlap with AOF tasks), in Step Functions they are "states," in Prefect they are "tasks," in Dagster they are "ops."

Common properties across all engines:
- **Identity**: Unique ID within the workflow (Temporal: activity type, Airflow: task_id, Step Functions: state name)
- **Executor routing**: Who/what runs this hop (Temporal: task queue, Airflow: operator/executor, Step Functions: resource ARN). In AOF, this maps to `role` from the org chart.
- **Retry policy**: How many times and with what backoff (all engines support this). AOF already has dispatch retry with jittered backoff.
- **Timeout**: Max execution time before escalation/failure (all engines support this). AOF already has gate timeouts.
- **Conditional activation**: Whether the hop runs based on upstream output (Airflow: BranchPythonOperator, Step Functions: Choice state, Prefect: conditional tasks). AOF already has `when` expressions.
- **Input/output contract**: What data flows in and out (Temporal: strongly typed, Step Functions: InputPath/OutputPath/ResultPath, Prefect: return values). AOF has `RunArtifact.artifactPaths` but no formal contract.

**What AOF's hop should look like:**

A hop is a gate that knows its position in a DAG (not just an ordered list). Key additions over Gate:
- `dependsOn`: Array of hop IDs this hop waits for (defines the DAG edges)
- `auto`: Boolean -- whether to auto-advance to this hop or pause for review (replaces `canReject` semantic)
- Inherits: `id`, `role`, `when`, `timeout`, `escalateTo`, `description`, `requireHuman`

The `dependsOn` field on hops is distinct from the task-level `dependsOn` (which tracks inter-task dependencies). Hop-level `dependsOn` tracks intra-workflow progression.

**Confidence:** HIGH -- this is a direct evolution of the existing Gate schema with well-understood patterns.

---

### 2. Per-Task Workflow DAG Schema

| Aspect | Detail |
|--------|--------|
| Why Expected | Tasks must carry their own workflow definition. This is the core schema change. |
| Complexity | MEDIUM |
| Depends On | Hop schema (table stakes #1), existing `TaskFrontmatter` |

**What the ecosystem does:**

Two models exist in the wild:
1. **Workflow-as-code** (Temporal, Prefect, Dagster): Workflows are defined in code (Python/Go/Java). The DAG is implicit in the control flow.
2. **Workflow-as-config** (Airflow, Step Functions, n8n): Workflows are defined declaratively (YAML/JSON). The DAG is explicit in the configuration.

AOF uses workflow-as-config (YAML). This is correct for AOF because:
- Deterministic control plane (no LLM calls) means config is evaluable
- Agents should not need to understand workflow internals
- YAML is human-readable, auditable, version-controlled

**Two authoring modes required:**

1. **Template reference**: Task points to a named template defined in project config. `workflow: "research-implement-test"` in task frontmatter resolves to a pre-defined DAG.
2. **Inline/ad-hoc**: Agent composes the workflow at task creation time. The full DAG definition lives in the task frontmatter itself.

This dual mode is how Step Functions (state machine definition vs. Express workflow) and Airflow (DAG file vs. SubDagOperator) handle it. Template reference is the common case; inline is for agent-composed pipelines.

**Schema structure:**

```yaml
# Task frontmatter
workflow:
  template: "research-implement-test"   # OR inline definition below
  # --- OR ---
  hops:
    - id: research
      role: researcher
      description: "Research the problem space"
    - id: implement
      role: backend
      dependsOn: [research]
      description: "Implement based on research findings"
    - id: test
      role: qa
      dependsOn: [implement]
      description: "Validate implementation"
  currentHop: research                  # Active hop(s)
  hopHistory: [...]                     # Audit trail (same shape as gateHistory)
```

**Migration path from gates:** The existing `gate`, `gateHistory`, `reviewContext` fields become `workflow.currentHop`, `workflow.hopHistory`, and hop-level review context. A migration function converts old gate-based tasks to the new schema.

**Confidence:** HIGH -- direct evolution of existing schema, well-understood config-as-DAG pattern.

---

### 3. DAG Validation (Cycle Detection, Reachability, Role Resolution)

| Aspect | Detail |
|--------|--------|
| Why Expected | Invalid DAGs cause silent failures or infinite loops. Validation is a safety gate. |
| Complexity | LOW |
| Depends On | Hop schema, existing `validateWorkflow()` function |

**What the ecosystem does:**

Every engine validates DAGs at definition time:
- **Airflow**: Detects cycles at DAG parse time, fails loudly. Checks that all task IDs are unique, all upstream references resolve.
- **Step Functions**: Validates JSON against ASL spec. Checks reachability (all states must be reachable from start), terminal states exist.
- **Prefect**: Validates at flow registration. Detects cycles, unreachable tasks.
- **Dagster**: Validates at repository load time. Strong type checking on inputs/outputs between ops.

**What AOF must validate:**

1. **No cycles**: Topological sort must succeed. AOF already has cycle detection for inter-task `dependsOn` (DFS in scheduler.ts). Same algorithm applies to intra-workflow hop dependencies.
2. **All dependsOn references resolve**: Every hop ID referenced in another hop's `dependsOn` must exist in the workflow.
3. **At least one root hop**: The DAG must have at least one hop with no `dependsOn` (the entry point).
4. **All hops reachable**: Every hop must be reachable from at least one root hop.
5. **Roles resolve to org chart**: Every hop's `role` must map to at least one active agent (same validation as existing gate role checks).
6. **Unique hop IDs**: No duplicates within a workflow.
7. **Template resolution**: If task references a template, the template must exist in project config.

**Implementation:** Extend `validateWorkflow()` to handle DAG validation. Pure function, no I/O. Run at task creation time and at scheduler evaluation time (defensive).

**Confidence:** HIGH -- AOF already has cycle detection logic; extending it to hop-level DAGs is straightforward.

---

### 4. Scheduler DAG Advancement (Evaluate Graph on Completion, Dispatch Next Hops)

| Aspect | Detail |
|--------|--------|
| Why Expected | The core runtime. Without this, the DAG is just documentation. This is where the scheduler reads completion signals and dispatches the next eligible hop(s). |
| Complexity | HIGH |
| Depends On | Hop schema, DAG validation, existing scheduler poll loop, existing `evaluateGateTransition()` |

**What the ecosystem does:**

The critical distinction is **who drives the DAG forward**:
- **Temporal**: The workflow worker drives progression. Activities are dispatched to task queues. The workflow function (user code) determines what to do next.
- **Airflow**: The scheduler drives progression. On each heartbeat, it scans all DAG runs, checks if upstream tasks are complete, and marks downstream tasks as ready.
- **Step Functions**: The service drives progression. On each state completion, the service evaluates transitions and invokes the next state.
- **Prefect**: The orchestrator drives progression. On task completion, evaluates downstream readiness.

AOF follows the **Airflow/Step Functions pattern** -- the scheduler drives progression. This is correct because:
- No nested sessions means the scheduler must be the coordinator
- Each hop is an independent dispatch (agent session starts, works, completes, exits)
- The scheduler already polls on an interval, checks task states, and dispatches

**What the scheduler must do on each poll cycle:**

1. For each task with an active workflow DAG:
   a. Check which hops have completed (via completion report / run result)
   b. For each completed hop, evaluate downstream hops:
      - Are all `dependsOn` hops complete?
      - Does the `when` conditional evaluate to true?
      - Is the hop set to `auto: true` (auto-advance) or does it need manual trigger?
   c. For eligible hops: update task workflow state, set routing to hop's role, transition task to ready for dispatch
   d. If all hops complete: mark task done

2. For parallel execution (multiple hops eligible simultaneously):
   - Each hop becomes an independent dispatch. The task stays in `in-progress` with a "current hops" array.
   - The scheduler tracks which hops are active, which are complete, which are pending.
   - **Key challenge**: A single task file cannot be "dispatched" to two agents simultaneously. Two approaches:
     - **Approach A (recommended)**: Each hop spawns as a *sub-dispatch* with its own lease. The parent task tracks hop states. The scheduler dispatches each hop independently.
     - **Approach B**: Split into child tasks. Each parallel hop becomes a child task with `parentId` pointing to the workflow task. This leverages existing `dependsOn` and parent-child machinery.

   **Recommendation: Approach A** -- hop-level dispatch within a single task. Approach B creates task proliferation and makes the workflow harder to reason about. The task is the unit of work; hops are stages within that work.

**How this differs from current gate evaluation:**

Current `evaluateGateTransition()` is a pure function that takes a task + workflow + outcome and returns the next gate. The DAG version must:
- Track multiple concurrent active hops (not just one `gate.current`)
- Evaluate all downstream hops on each completion (not just "next in list")
- Handle partial completion (some parallel hops done, others still running)
- Handle mixed outcomes (one parallel hop completes, another blocks)

**Confidence:** MEDIUM-HIGH -- the pattern is well-understood from Airflow/Step Functions, but the parallel dispatch within a single task is novel for AOF's filesystem-based store.

---

### 5. Hop Completion and Outcome Handling

| Aspect | Detail |
|--------|--------|
| Why Expected | Agents must be able to signal hop outcomes (complete, blocked, needs_review) and the scheduler must handle each. Direct evolution of gate outcomes. |
| Complexity | MEDIUM |
| Depends On | Hop schema, DAG advancement, existing `CompletionReportPayload` |

**What the ecosystem does:**

- **Temporal**: Activities return results or throw errors. The workflow function handles both. Retries are configured per-activity.
- **Airflow**: Tasks succeed, fail, or are marked upstream_failed (cascading failure). The scheduler handles retries.
- **Step Functions**: States succeed, fail, timeout, or catch errors. The state machine handles routing.
- **Prefect**: Tasks return results or raise exceptions. The orchestrator handles state transitions.

**What AOF hop outcomes mean:**

| Outcome | Hop Behavior | DAG Impact |
|---------|-------------|------------|
| `complete` | Hop done, output available | Evaluate downstream hops for readiness |
| `blocked` | External dependency blocking | Hop paused, downstream hops cannot start. Task stays active. Scheduler checks on next poll. |
| `needs_review` | Work needs revision | Depends on hop config: either re-dispatch same hop or route to a review hop |

**Rejection in a DAG context:**

Linear gates had "rejection strategy: origin" (always loop back to first gate). DAGs need more nuance:
- **Re-execute same hop**: The simplest rejection. Agent gets same hop again with review feedback.
- **Route to predecessor**: Send back to the hop that produced the input (the immediate upstream hop).
- **Route to specific hop**: Named target for the rejection (e.g., "always send rejections to the implement hop").

For v1.2, **re-execute same hop** is the right default. It is the simplest, matches most real-world cases (reviewer rejects, same implementer fixes), and avoids complexity of multi-hop rejection routing.

**Confidence:** HIGH -- direct evolution of existing outcome handling.

---

### 6. Artifact Handoff Between Hops

| Aspect | Detail |
|--------|--------|
| Why Expected | Hops in a pipeline produce output that downstream hops consume. Without artifact handoff, each hop starts from scratch. |
| Complexity | MEDIUM |
| Depends On | Existing `RunArtifact.artifactPaths`, task work directory, hop schema |

**What the ecosystem does:**

- **Temporal**: Activities pass data via serialized payloads (protobuf/JSON). The workflow function passes results between activities.
- **Airflow**: XCom (cross-communication) -- key/value store for passing small data between tasks. For large data, external storage (S3, GCS). XCom is frequently cited as a major pain point at scale.
- **Step Functions**: ResultPath/OutputPath filter state output, InputPath filters state input. Data flows through a JSON document.
- **Prefect**: Task results are Python objects. Persisted to configured result storage.
- **Dagster**: IOManagers handle data transfer between ops. Strong typing on inputs/outputs.

**What AOF should do:**

AOF already has `RunArtifact.artifactPaths` with `inputs/`, `work/`, `output/` directories per task execution. The natural extension:

1. **Output directory convention**: When a hop completes, its outputs land in `output/` within the task's work directory, namespaced by hop ID: `tasks/<status>/<task-id>/hops/<hop-id>/output/`
2. **Input linking**: When a downstream hop starts, the scheduler populates its `inputs/` by symlinking (or copying) the upstream hop's `output/` directory.
3. **Manifest file**: Each hop's output directory contains a `manifest.json` listing what was produced (files, summaries, data). This is what downstream hops consume.

**The key constraint:** Agents write to the filesystem. They produce files (code, documents, test results). The handoff mechanism must work with files, not serialized payloads. This is a strength -- files are human-readable, debuggable, and survive restarts.

**What NOT to do:**
- Do NOT try to serialize agent output into task frontmatter. Agent outputs are large (code files, documents, test results).
- Do NOT create a separate XCom-like store. The filesystem IS the store.
- Do NOT require agents to understand the handoff mechanism. The scheduler sets up the directory structure; agents just read from `inputs/` and write to `output/`.

**Confidence:** MEDIUM -- the pattern is clear but filesystem-based artifact handoff between hops has not been implemented in AOF yet. The directory structure needs careful design for parallel hops (two hops writing output simultaneously).

---

### 7. Pre-Defined Workflow Templates

| Aspect | Detail |
|--------|--------|
| Why Expected | Most tasks follow standard patterns. Defining the full DAG inline for every task is tedious. Templates enable reuse. |
| Complexity | LOW |
| Depends On | Per-task DAG schema (table stakes #2), project manifest schema |

**What the ecosystem does:**

- **Airflow**: DAG files are templates. Parameters customize each run.
- **Step Functions**: State machine definitions are templates. Input parameters customize execution.
- **Prefect**: Flow definitions are reusable. Parameters customize each run.
- **n8n**: Workflow templates shared via template library.

**What AOF should do:**

Templates live in `project.yaml` under a `workflowTemplates` map:

```yaml
workflowTemplates:
  research-implement-test:
    hops:
      - id: research
        role: researcher
        description: "Research the problem space"
      - id: implement
        role: backend
        dependsOn: [research]
        description: "Implement based on research"
      - id: test
        role: qa
        dependsOn: [implement]
        description: "Test the implementation"

  simple-review:
    hops:
      - id: implement
        role: backend
        description: "Implement the feature"
      - id: review
        role: architect
        dependsOn: [implement]
        canReject: true
        description: "Review code quality"
```

Tasks reference templates by name:

```yaml
routing:
  workflow: research-implement-test
```

When the scheduler encounters a task with `routing.workflow` pointing to a template name, it resolves the template from the project manifest and uses it for DAG evaluation. The task does NOT need to carry the full DAG definition -- it references the template and tracks execution state (current hops, hop history).

**Migration from existing system:** The existing `workflow` field in `ProjectManifest` is a single `WorkflowConfig` (one workflow per project). v1.2 changes this to `workflowTemplates` (a map of named workflows). Backward compatibility: if only `workflow` exists (old format), treat it as a single template named by `workflow.name`.

**Confidence:** HIGH -- straightforward schema extension, well-understood pattern.

---

### 8. Agent API for Composing Ad-Hoc Workflows

| Aspect | Detail |
|--------|--------|
| Why Expected | Agents need to create tasks with custom workflows that do not match any template. This enables dynamic orchestration. |
| Complexity | MEDIUM |
| Depends On | Per-task DAG schema (table stakes #2), MCP tool definitions |

**What the ecosystem does:**

- **Temporal**: Workflows are defined in code. A parent workflow can compose child workflows with different step sequences.
- **Prefect**: Flows can dynamically create subflows based on runtime data.
- **Step Functions**: Express workflows can be created programmatically via API.

**What AOF should do:**

The MCP tool for task creation (`aof_task_create` or equivalent) accepts an inline workflow definition:

```typescript
// Agent calls:
aof_task_create({
  title: "Implement feature X",
  workflow: {
    hops: [
      { id: "research", role: "researcher" },
      { id: "implement", role: "backend", dependsOn: ["research"] },
      { id: "test", role: "qa", dependsOn: ["implement"] }
    ]
  }
})
```

The scheduler validates the inline workflow (cycle detection, role resolution) at creation time and rejects invalid definitions with clear error messages.

**Agent ergonomics matter:** Agents should not need to understand DAG theory. The tool description should include examples of common patterns (linear pipeline, fan-out/fan-in, conditional branching). The validation error messages should be actionable ("hop 'test' depends on 'implementation' which does not exist -- did you mean 'implement'?").

**Confidence:** HIGH -- this is just an alternative authoring path for the same schema.

---

### 9. Workflow Execution State Tracking

| Aspect | Detail |
|--------|--------|
| Why Expected | The scheduler needs to know which hops are running, which are done, which are pending. Operators need to see workflow progress. |
| Complexity | MEDIUM |
| Depends On | Hop schema, DAG advancement, existing task frontmatter |

**What the ecosystem does:**

- **Airflow**: DAG Run tracks state per task instance (none, scheduled, queued, running, success, failed, upstream_failed, skipped). Visible in the grid/graph view.
- **Step Functions**: Execution history tracks each state's input, output, start time, end time, status.
- **Temporal**: Workflow execution history tracks each activity's start, completion, failure, retry.
- **Prefect**: Flow run tracks each task run's state transitions with timestamps.

**What AOF should track per hop:**

```yaml
hopState:
  research:
    status: done              # pending | active | done | blocked | skipped | failed
    agent: researcher-1       # Agent that executed this hop
    startedAt: "2026-03-02T10:00:00Z"
    completedAt: "2026-03-02T11:30:00Z"
    outcome: complete         # complete | blocked | needs_review
    attempts: 1               # Number of execution attempts
  implement:
    status: active
    agent: backend-1
    startedAt: "2026-03-02T11:31:00Z"
    attempts: 1
  test:
    status: pending
```

**Key states:**

| State | Meaning | Scheduler Behavior |
|-------|---------|-------------------|
| `pending` | Not yet eligible (upstream incomplete) | Skip during dispatch |
| `active` | Currently being executed by an agent | Monitor via heartbeat/lease |
| `done` | Completed successfully | Evaluate downstream hops |
| `blocked` | External dependency preventing progress | Re-check on next poll |
| `skipped` | Conditional evaluated to false | Treat as done for dependency resolution |
| `failed` | Exhausted retries | Block downstream hops, may deadletter |

**Where state lives:** In task frontmatter under `workflow.hopState`. This keeps the single-file-per-task model intact and makes state visible to anyone reading the task file.

**Concern about frontmatter bloat:** For workflows with many hops, `hopState` + `hopHistory` can grow large. Mitigation: keep `hopState` as current state only (not a history), keep `hopHistory` as an append-only log (archive to companion file when it exceeds ~50 entries, same as gateHistory).

**Confidence:** HIGH -- direct mapping from existing gate state tracking.

---

### 10. Backward-Compatible Migration from Linear Gates

| Aspect | Detail |
|--------|--------|
| Why Expected | Existing deployments use linear gates. The migration must be seamless -- no data loss, no manual intervention. |
| Complexity | MEDIUM |
| Depends On | All above schemas, existing task store migration infrastructure |

**What needs to migrate:**

1. **Project-level workflow config**: `project.yaml` `workflow` (single WorkflowConfig) becomes `workflowTemplates` (map of named workflows). The existing workflow becomes a template.
2. **Task frontmatter**: `gate` / `gateHistory` / `reviewContext` fields migrate to `workflow.hopState` / `workflow.hopHistory` / hop-level review context.
3. **In-flight tasks**: Tasks currently in a gate must be mapped to the equivalent hop. The linear gate sequence becomes a linear DAG (each hop depends on the previous).

**Migration strategy:**

- **Schema version bump**: Increment `schemaVersion` from 1 to 2.
- **Lazy migration**: When the scheduler encounters a v1 task (has `gate` field, no `workflow.hopState`), it auto-migrates in place.
- **Project manifest migration**: On first scheduler run after upgrade, convert `workflow` to `workflowTemplates`.
- **Rollback safety**: The migration must be reversible. Keep the old fields alongside new ones during a transition period.

**Confidence:** MEDIUM -- migration is always risky. The lazy migration approach minimizes blast radius but requires careful handling of edge cases (task in mid-gate-transition during upgrade).

---

## Differentiators

Features that set per-task workflow DAGs apart from basic linear workflows. Not required for v1.2 MVP, but high value.

| Feature | Value Proposition | Complexity | Depends On | Notes |
|---------|-------------------|------------|------------|-------|
| **Parallel hop execution (fork/join)** | Multiple hops run simultaneously (research + security audit in parallel). Reduces workflow wall-clock time. | HIGH | DAG advancement, hop state tracking | The existing gate design doc (section 11.4) explicitly deferred this to v2. v1.2 should implement it because it is a primary motivation for DAGs over linear gates. Without parallelism, DAGs are just a different syntax for the same linear flow. |
| **Conditional branching based on hop output** | "If research finds risk > threshold, add security review hop." Enables dynamic workflow adaptation. | MEDIUM | Hop schema with `when` conditionals, artifact handoff | Existing `when` expressions evaluate task metadata. Extension: evaluate against upstream hop output (e.g., `hops.research.output.riskLevel > 3`). Requires hop outputs to be structured (JSON manifest). |
| **Workflow visualization in CLI** | `aof workflow status TASK-xxx` shows ASCII DAG with hop states (done/active/pending). Gives operators immediate understanding of where a workflow is. | LOW | Hop state tracking | No external dependency. Render DAG topology as ASCII art with status coloring. Every mature workflow engine has a visual DAG view. |
| **Hop-level retry with backoff** | Individual hops retry on transient failure before escalating. | LOW | Hop schema, existing jittered backoff in failure-tracker.ts | Airflow, Temporal, Prefect all support per-task retries. AOF already has dispatch-level retry. Extend to hop level. |
| **Hop SLA (per-hop timeout)** | Individual hops have independent timeouts. A research hop gets 4 hours; a test hop gets 30 minutes. | LOW | Hop schema, existing SLA checker | Already have gate-level timeout. Direct port to hop schema. |
| **Workflow-level SLA** | Total wall-clock time from first hop to last. Separate from per-hop SLAs. | LOW | Workflow state tracking, existing SLA checker | Step Functions has this. Useful for end-to-end guarantees. |
| **Dynamic hop insertion** | An agent can add hops to a running workflow (e.g., "I discovered we need a migration step"). | MEDIUM | Ad-hoc workflow API, DAG validation | Temporal supports this via signals. Useful for agent autonomy. Requires re-validation of the DAG after insertion. |

---

## Anti-Features

Features that seem related to per-task workflow DAGs but should NOT be built.

| Anti-Feature | Why Requested | Why Avoid | What to Do Instead |
|--------------|---------------|-----------|-------------------|
| **LLM-driven DAG evaluation** | "Let the AI decide what hop comes next" | Violates AOF's core constraint: deterministic control plane, no LLM calls in scheduling/routing/state management. DAG evaluation must be pure TypeScript. | Agents can compose ad-hoc DAGs at creation time (using their LLM), but the scheduler evaluates the DAG deterministically. |
| **Workflow versioning per task** | "Pin each task to a specific workflow version" | Design doc section 11.7 explicitly decided: tasks always use latest workflow. Version pinning creates sprawl. | Detect drift (workflow hash in frontmatter), migrate to nearest valid hop if workflow changes under a running task. |
| **Cross-task workflow orchestration** | "A workflow that spans multiple tasks" | Per PROJECT.md, this is "large task orchestration / agent subtask creation" and is deferred to v2. v1.2 workflows are per-task. | Use task `dependsOn[]` for inter-task dependencies. Workflows are intra-task. |
| **Visual DAG editor** | "Drag-and-drop workflow builder UI" | Per PROJECT.md, UI/dashboard is explicitly out of scope for v1. | CLI-based workflow definition (YAML). `aof workflow validate` for testing. |
| **Workflow inheritance/composition** | "Template A extends template B, adds hops" | Excessive complexity for v1.2. Composition of workflow templates creates indirection and debugging difficulty. | Copy-paste templates. Define each workflow completely. Keep them small and readable. |
| **Event-driven hop triggers** | "Hop triggers when an external event fires (webhook, file change, cron)" | AOF is poll-based (scheduler polls on interval). Adding event-driven triggers changes the fundamental execution model. | Hops activate based on upstream completion. External triggers change task metadata, which the `when` conditional can evaluate. |
| **Nested workflows (workflow-in-a-hop)** | "A hop can be a sub-workflow with its own DAG" | Extreme complexity. Temporal supports this (child workflows) but it requires a sophisticated execution engine. AOF's filesystem store is not designed for nested state tracking. | Flatten the DAG. If a hop is complex enough to need sub-hops, it should be a separate task with its own workflow and a `dependsOn` relationship. |

---

## Feature Dependencies

```
[Hop Schema] (table stakes #1)
    evolves -> [Gate schema] (replaces it)
    enables -> [Per-Task DAG Schema] (table stakes #2)
    enables -> [DAG Validation] (table stakes #3)

[Per-Task DAG Schema] (table stakes #2)
    requires -> [Hop Schema]
    enables -> [Scheduler DAG Advancement] (table stakes #4)
    enables -> [Templates] (table stakes #7)
    enables -> [Ad-hoc API] (table stakes #8)

[DAG Validation] (table stakes #3)
    requires -> [Hop Schema]
    requires -> [existing cycle detection from scheduler.ts]
    enables -> [Ad-hoc workflow safety]

[Scheduler DAG Advancement] (table stakes #4)
    requires -> [Per-Task DAG Schema]
    requires -> [DAG Validation]
    requires -> [Hop Completion Handling] (table stakes #5)
    requires -> [Workflow State Tracking] (table stakes #9)
    requires -> [existing scheduler poll loop]
    enables -> [Parallel hop execution] (differentiator)

[Hop Completion Handling] (table stakes #5)
    requires -> [Hop Schema]
    requires -> [existing CompletionReportPayload]
    enables -> [Artifact Handoff] (table stakes #6)

[Artifact Handoff] (table stakes #6)
    requires -> [Hop Completion Handling]
    requires -> [existing RunArtifact.artifactPaths]
    enables -> [Conditional branching based on hop output] (differentiator)

[Templates] (table stakes #7)
    requires -> [Per-Task DAG Schema]
    requires -> [existing ProjectManifest]
    enables -> [Standard workflow patterns]

[Ad-hoc API] (table stakes #8)
    requires -> [Per-Task DAG Schema]
    requires -> [DAG Validation]
    requires -> [existing MCP tool definitions]
    enables -> [Agent-composed workflows]

[Workflow State Tracking] (table stakes #9)
    requires -> [Hop Schema]
    requires -> [existing gateHistory pattern]
    enables -> [Scheduler DAG Advancement]
    enables -> [Workflow visualization] (differentiator)

[Migration] (table stakes #10)
    requires -> [All new schemas defined]
    requires -> [existing task store migration infrastructure]
    blocks -> [Deployment to existing installations]
```

### Dependency Notes

- **Hop Schema is the foundation**: Everything else depends on the hop definition. Build this first.
- **DAG Validation before Scheduler**: Never let the scheduler operate on an invalid DAG. Validate at creation time and defensively at evaluation time.
- **Parallel execution is the whole point**: If DAGs only support linear chains, they add complexity without value over linear gates. Parallel execution (fork/join) should be part of v1.2, not deferred further. The design doc (section 11.4) deferred it because the linear gate system could not support it -- the DAG system can.
- **Artifact handoff enables conditional branching**: Without structured output from hops, downstream `when` conditionals can only evaluate task-level metadata. With hop output manifests, conditionals can evaluate what upstream hops produced.
- **Migration must happen last**: All schemas must be stable before migrating existing data. The migration is the "point of no return."

---

## MVP Recommendation

### Phase Ordering (based on dependencies and risk):

**Phase 1: Schema Foundation**
- Define Hop schema (evolve from Gate)
- Define per-task workflow DAG schema (inline + template reference)
- Define workflow execution state schema (hopState, hopHistory)
- Implement DAG validation (cycles, reachability, role resolution)
- Rationale: Everything depends on schemas. Get them right before building runtime.

**Phase 2: Linear DAG Execution (Scheduler Integration)**
- Implement scheduler DAG advancement for linear DAGs (each hop depends on previous)
- Implement hop completion handling (complete, blocked, needs_review)
- Implement hop-level dispatch (scheduler routes to hop's role)
- Implement workflow state tracking in task frontmatter
- Rationale: Proves the end-to-end flow works before adding parallelism. Linear DAGs are a strict superset of linear gates. This is the minimum viable replacement.

**Phase 3: Templates + Ad-Hoc API**
- Implement `workflowTemplates` in project manifest
- Implement template resolution in scheduler
- Implement inline workflow definition in MCP task creation tool
- Rationale: Enables real usage. Until this phase, workflows must be manually defined in task frontmatter.

**Phase 4: Parallel Execution (Fork/Join)**
- Implement parallel hop dispatch (multiple hops active simultaneously)
- Implement join semantics (all-complete, any-complete, majority-complete)
- Implement mixed-outcome handling (one hop blocks while another completes)
- Rationale: The differentiating capability. Without this, DAGs are just syntax sugar over linear gates.

**Phase 5: Artifact Handoff + Migration**
- Implement hop-level directory structure (hops/<hop-id>/output/)
- Implement input linking from upstream hop outputs
- Implement output manifest convention
- Implement backward-compatible migration from v1.1 gate format
- Rationale: Artifact handoff is important but not blocking for the core DAG execution. Migration is last because schemas must be stable.

### Prioritize (must have for v1.2):
1. Hop schema + DAG schema -- without this, nothing works
2. DAG validation -- safety gate, prevents invalid workflows
3. Scheduler DAG advancement (linear first) -- proves the runtime works
4. Workflow state tracking -- operators must see progress
5. Templates + ad-hoc API -- enables real usage
6. Parallel execution -- the primary value over linear gates

### Defer if time-constrained:
- Artifact handoff between hops (agents can read task body/description for context)
- Conditional branching based on hop output (can branch on task metadata only)
- Dynamic hop insertion (agents define full DAG at creation time)
- Workflow visualization in CLI (can inspect task frontmatter directly)
- Workflow-level SLA (per-hop SLA is sufficient)

---

## Sources

- AOF gate evaluator source: `/Users/xavier/Projects/aof/src/dispatch/gate-evaluator.ts` -- HIGH confidence (examined directly, pure function with complete/reject/blocked outcomes)
- AOF workflow schema: `/Users/xavier/Projects/aof/src/schemas/workflow.ts` -- HIGH confidence (examined directly, current WorkflowConfig with linear gates)
- AOF gate schema: `/Users/xavier/Projects/aof/src/schemas/gate.ts` -- HIGH confidence (examined directly, Gate/GateHistoryEntry/ReviewContext/GateTransition)
- AOF task schema: `/Users/xavier/Projects/aof/src/schemas/task.ts` -- HIGH confidence (examined directly, TaskFrontmatter with gate, gateHistory, reviewContext fields)
- AOF scheduler: `/Users/xavier/Projects/aof/src/dispatch/scheduler.ts` -- HIGH confidence (examined directly, poll loop with DAG dependency gating)
- AOF workflow gates design doc: `/Users/xavier/Projects/aof/docs/dev/workflow-gates-design.md` -- HIGH confidence (examined directly, section 11.4 explicitly defers parallel gates to v2, section 12 outlines future work)
- AOF project manifest: `/Users/xavier/Projects/aof/src/schemas/project.ts` -- HIGH confidence (examined directly, single `workflow` field in ProjectManifest)
- AOF run artifact schema: `/Users/xavier/Projects/aof/src/schemas/run.ts` -- HIGH confidence (examined directly, RunArtifact with artifactPaths)
- AOF protocol schemas: `/Users/xavier/Projects/aof/src/schemas/protocol.ts` -- HIGH confidence (examined directly, CompletionReportPayload, HandoffRequestPayload)
- Temporal workflow patterns (training data) -- MEDIUM confidence (well-established patterns: activities, task queues, child workflows, signals, retries)
- Apache Airflow DAG execution model (training data) -- MEDIUM confidence (well-established patterns: DAG Run, task instance states, XCom, scheduling)
- AWS Step Functions state machine model (training data) -- MEDIUM confidence (well-established patterns: ASL, Choice/Parallel/Map states, InputPath/OutputPath)
- Prefect flow execution model (training data) -- MEDIUM confidence (well-established patterns: task runs, state transitions, result persistence)
- Dagster op execution model (training data) -- MEDIUM confidence (well-established patterns: ops, IOManagers, asset materialization)

---
*Feature research for: AOF v1.2 Per-Task Workflow DAGs*
*Researched: 2026-03-02*
