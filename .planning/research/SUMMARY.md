# Project Research Summary

**Project:** AOF v1.2 Per-Task Workflow DAG Execution
**Domain:** DAG-based workflow engine for multi-agent orchestration plugin
**Researched:** 2026-03-02
**Confidence:** HIGH

## Executive Summary

AOF v1.2 replaces the linear gate-based workflow system with per-task workflow DAGs -- directed acyclic graphs of "hops" that support conditional branching and logical parallelism. This is not a greenfield build. The existing codebase has a complete gate evaluation system (schemas, evaluator, context builder, transition handler, timeout/escalation, protocol router integration) that serves as both the foundation and the backward-compatibility constraint. The work is a schema evolution and scheduler integration problem, not a "DAG library" problem. All four research tracks converge on the same conclusion: zero new runtime dependencies are needed. The existing Zod + TypeScript + filesystem task store + poll-based scheduler provides everything required. Topological sort is 30 lines; hop lifecycle is a lookup table; condition evaluation extends the existing sandboxed evaluator.

The recommended approach builds in strict dependency order: schemas first (everything depends on data shapes), pure DAG evaluator second (algorithmic core with no I/O, easy to test exhaustively), scheduler integration third (connects DAG to dispatch), completion handling fourth (closes the dispatch-complete-advance loop), and templates/API last (user-facing features on top of working machinery). A critical architectural decision constrains the entire design: OpenClaw does not support nested agent sessions. Each hop must be an independent scheduler dispatch. "Parallel" in the DAG means no ordering dependency, not simultaneous execution -- the scheduler serializes physical dispatch to one hop at a time per task. This simplifies the lease model and eliminates race conditions on task state, but means multi-branch DAGs execute branches sequentially.

The top risks are: (1) non-atomic DAG state updates on the filesystem causing task corruption if hop status and routing are written in separate calls -- mitigated by preserving the existing single-writeFileAtomic pattern from gate transitions; (2) backward compatibility breakage for in-flight gate-based tasks -- mitigated by a dual-mode evaluator that detects gate vs. DAG tasks and routes to the appropriate code path, keeping all gate code intact; (3) condition evaluation security when agents compose ad-hoc workflows with arbitrary JavaScript expressions -- mitigated by restricting agent-authored conditions to a safe JSON DSL while keeping full JavaScript evaluation only for admin-authored templates; and (4) DAG deadlocks from skipped conditional hops blocking join points -- mitigated by treating skipped hops as satisfied for dependency resolution.

## Key Findings

### Recommended Stack

No new npm dependencies. The entire v1.2 DAG engine builds on the existing stack. The decision to build in-house rather than adopt external libraries (graphlib, xstate, bull, temporal) is well-justified: AOF DAGs are small (5-20 hops), the filesystem-based store is incompatible with Redis-backed job queues, and the existing codebase already has the patterns needed (cycle detection, sandboxed eval, atomic writes, concurrency tracking).

**Core technologies (unchanged):**
- `zod` ^3.24.0: DAG schema definition with `.superRefine()` for cycle detection and reachability validation at parse time
- `yaml` ^2.7.0: Parse workflow templates from `project.yaml`
- `write-file-atomic` ^7.0.0: Atomic hop state updates preserving crash-safety guarantees
- `vitest` ^3.0.0: Unit tests for DAG evaluator, integration tests for scheduler; consider `fast-check` for property-based testing of DAG execution paths

**New modules to create (6 files):**
- `src/schemas/workflow-dag.ts` -- Hop + WorkflowDAG Zod schemas
- `src/schemas/dag-state.ts` -- HopState + DAGState runtime schemas
- `src/dispatch/dag-evaluator.ts` -- Pure DAG evaluation function (no I/O)
- `src/dispatch/dag-validator.ts` -- Cycle detection, reachability, orphan detection
- `src/dispatch/hop-context-builder.ts` -- Build agent context for hop dispatch
- `src/dispatch/dag-completion-handler.ts` -- DAG-aware completion processing

**Existing modules to extend (7 files):**
- `src/schemas/task.ts` -- Add `dagState` field to TaskFrontmatter
- `src/schemas/project.ts` -- Add `workflows` map for named DAG templates
- `src/dispatch/scheduler.ts` -- Add DAG hop dispatch step to poll cycle
- `src/protocol/router.ts` -- Branch completion handling for DAG vs. gate tasks
- `src/dispatch/assign-executor.ts` -- Inject hop context alongside gate context
- `src/dispatch/escalation.ts` -- Extend timeout checking for hops
- `src/schemas/event.ts` -- Add hop-level event types

### Expected Features

**Must have (table stakes -- required to replace linear gates):**
- Hop schema evolving from Gate (id, role, dependsOn, when, canReject, timeout, escalateTo)
- Per-task workflow DAG schema with inline definition and template reference modes
- DAG validation at creation time (cycles, reachability, role resolution, unique IDs)
- Scheduler DAG advancement (evaluate graph on hop completion, dispatch next eligible hops)
- Hop completion and outcome handling (complete, blocked, needs_review with same-hop rejection)
- Artifact handoff between hops via hop-scoped directories (outputs/<hopId>/)
- Pre-defined workflow templates in project.yaml (workflowTemplates map)
- Agent API for composing ad-hoc workflows at task creation (MCP tool extension)
- Workflow execution state tracking (per-hop status in task frontmatter)
- Backward-compatible migration from linear gates (dual-mode evaluator, gate code preserved)

**Should have (differentiators -- high value, implement if time allows):**
- Parallel hop execution with fork/join semantics (logical parallelism with serial dispatch)
- Conditional branching based on hop output (extend `when` context with hopResults)
- Workflow visualization in CLI (ASCII DAG with hop states)
- Hop-level retry with configurable backoff
- Per-hop and workflow-level SLA timeouts
- Completion-triggered DAG advancement (bypass poll latency for immediate hop chaining)

**Defer to v2+:**
- LLM-driven DAG evaluation (violates deterministic control plane constraint)
- Cross-task workflow orchestration (PROJECT.md defers to v2)
- Workflow versioning per task (always use latest, detect drift)
- Visual DAG editor (CLI-only for v1)
- Workflow inheritance/composition (keep templates flat and explicit)
- Event-driven hop triggers (AOF is poll-based)
- Nested workflows / sub-workflows (flatten the DAG; use separate tasks with dependsOn)
- Dynamic hop insertion into running workflows (agents define full DAG at creation time)

### Architecture Approach

The architecture preserves AOF's existing patterns while adding DAG capability as a parallel code path. The DAG evaluator is a pure function (no I/O, deterministic, testable) that takes task state + workflow definition + completion event and returns all state updates as a single result object. The handler applies updates atomically via writeFileAtomic. DAG tasks stay in `in-progress` status throughout their workflow execution; individual hops cycle through pending -> ready -> dispatched -> complete within the task's dagState frontmatter. The scheduler dispatches one hop at a time per task (OpenClaw no-nested-sessions constraint), picking the highest-priority ready hop on each poll cycle.

**Major components:**
1. **WorkflowDAG schema** (`workflow-dag.ts`) -- Zod schema defining hops with adjacency-list edges (dependsOn on each hop), validated with .superRefine() for cycle detection and reachability
2. **DAGState schema** (`dag-state.ts`) -- Per-hop runtime state (pending/ready/dispatched/complete/rejected/blocked/skipped) stored in task frontmatter
3. **DAG evaluator** (`dag-evaluator.ts`) -- Pure function: input is (task, workflow, event), output is (hop updates, ready hops, optional task status change). Core algorithm: apply event, evaluate conditionals, propagate readiness, handle rejection with downstream reset, check DAG completion
4. **DAG validator** (`dag-validator.ts`) -- Topological sort via Kahn's algorithm for cycle detection; reachability check; orphan detection; role resolution against org chart
5. **Hop context builder** (`hop-context-builder.ts`) -- Builds agent dispatch context including hop description, role, predecessor output paths
6. **DAG completion handler** (`dag-completion-handler.ts`) -- Wired into protocol router; detects dagState on task, calls evaluator, applies updates atomically, releases lease
7. **Scheduler DAG dispatch** (modifications to `scheduler.ts`) -- New step in poll cycle scanning dagState.hops for ready hops on in-progress DAG tasks

### Critical Pitfalls

1. **Non-atomic DAG state updates corrupt tasks** -- A hop completion requires updating hop status, routing, and potentially task status. If these happen in separate writeFileAtomic calls, a crash between writes leaves the task inconsistent. Prevention: the DAG evaluator returns ALL updates as a single result object; the handler writes once. Preserve the existing `applyGateTransition()` single-write pattern.

2. **Backward compatibility breakage for in-flight gate tasks** -- The gate evaluator, transition handler, context builder, and scheduler timeout checker are deeply wired into the codebase. Removing or modifying them for DAG support breaks existing tasks mid-workflow. Prevention: dual-mode evaluator (detect dagState vs. gate field); keep all gate code intact as legacy; new DAG code in separate files; mutual exclusivity enforced at schema level (task has dagState OR gate, never both).

3. **Condition evaluation security with agent-composed workflows** -- The existing `new Function()` evaluator was designed for admin-authored conditions from project.yaml. Agent-composed workflows change the trust model. Prevention: restrict agent-authored conditions to a JSON-based DSL validated by Zod discriminated unions; keep JavaScript eval only for admin-authored template conditions; freeze context objects before eval.

4. **DAG deadlock from skipped conditional hops** -- When a conditional hop evaluates to false and is skipped, join points that depend on it deadlock forever. Prevention: treat skipped hops as satisfied (equivalent to complete) for dependency resolution. Add a "stuck DAG" detector: if no hop has advanced in N poll cycles, emit alert.

5. **Poll-based advancement latency for multi-hop DAGs** -- A 5-sequential-hop workflow takes 2.5+ minutes at 30-second poll intervals even when agents complete instantly. Prevention: implement completion-triggered advancement where the hop completion handler immediately evaluates the DAG and dispatches the next hop. Keep the poll cycle as a safety-net fallback.

## Implications for Roadmap

Based on research, the build order follows a strict dependency chain. Each phase is independently testable and delivers incremental value.

### Phase 1: Schema Foundation

**Rationale:** Everything depends on data shapes. Schema changes are additive (optional fields on existing types) and low-risk. Getting schemas right before building runtime logic prevents rework. DAG validation belongs here because invalid DAGs must be rejected at creation time, not at runtime.

**Delivers:** Complete type definitions for hops, workflow DAGs, DAG execution state, and hop lifecycle. Validated backward compatibility with existing gate-based tasks. DAG cycle detection and reachability checking.

**Addresses:** Table stakes: Hop schema (#1), Per-task DAG schema (#2), DAG validation (#3), Workflow state tracking schema (#9)

**Avoids:** Pitfall 3 (cycle detection), Pitfall 5 (backward compat -- superset schema), Pitfall 7 (template/ad-hoc schema divergence -- one Zod schema for both), Pitfall 11 (lease model -- define per-hop lease extension), Pitfall 15 (naming collision -- define resolution rule)

**Stack elements:** Zod .superRefine(), discriminated unions, Kahn's algorithm for topological sort

### Phase 2: DAG Evaluator (Pure Logic)

**Rationale:** The algorithmic core has zero I/O dependencies and can be tested exhaustively in isolation with fixture DAGs. Building and proving correctness of the pure evaluation logic before wiring it into the scheduler eliminates the hardest debugging problem (is the bug in the algorithm or the integration?).

**Delivers:** Pure function that evaluates DAG state transitions: readiness propagation, conditional evaluation, skip propagation, rejection with downstream reset, DAG completion detection, circuit breaker for rejection loops.

**Addresses:** Core of table stakes #4 (Scheduler DAG advancement logic), skip-as-satisfied semantics, rejection routing

**Avoids:** Pitfall 9 (deadlock from skipped hops -- skip propagation rule), Pitfall 4 (condition security -- JSON DSL for agent conditions alongside JS eval for admin templates)

**Test strategy:** Property-based testing with fast-check: generate random valid DAGs, execute through evaluator, verify invariants (no hop complete without predecessors done/skipped, all hops eventually terminal, DAG completes in at most N transitions). Fixture DAGs: linear, diamond, wide-parallel, deep-conditional, single-hop, all-skipped.

### Phase 3: Scheduler Integration and Hop Dispatch

**Rationale:** Depends on schemas (Phase 1) and evaluator (Phase 2). This connects the DAG engine to the live scheduler. The scheduler gains a new step in its poll cycle: scanning dagState.hops for ready hops on in-progress tasks. The assign executor gains hop context injection.

**Delivers:** Working end-to-end flow for linear DAGs: task creation with workflow reference -> scheduler initializes dagState -> dispatches root hop -> agent completes -> scheduler advances DAG -> dispatches next hop -> DAG completes -> task transitions to review/done.

**Addresses:** Table stakes #4 (Scheduler DAG advancement), table stakes #5 (Hop completion handling)

**Avoids:** Pitfall 2 (non-atomic writes -- single writeFileAtomic per hop completion), Pitfall 1 (parallel dispatch race -- serial dispatch, one hop at a time), Pitfall 10 (scan cost -- only evaluate DAGs for tasks with changed updatedAt), Pitfall 14 (no-nested-sessions -- each hop is independent dispatch)

**Architecture component:** dag-dispatcher.ts, dag-completion-handler.ts, modifications to scheduler.ts, protocol/router.ts, assign-executor.ts

### Phase 4: Timeout, Escalation, and Rejection Handling

**Rationale:** Edge cases built on the working happy path from Phases 1-3. Rejection is the most complex flow: it must reset the target hop AND all downstream hops to pending, increment the circuit breaker counter, and handle the case where a rejected hop has parallel siblings still running.

**Delivers:** Per-hop timeout detection and escalation. Rejection with configurable target (same hop, origin, named predecessor). Downstream hop reset on rejection. Circuit breaker that deadletters after N rejection cycles. Hop-level retry with backoff.

**Addresses:** Table stakes #5 (rejection/blocked handling), differentiators (hop-level retry, per-hop SLA, workflow-level SLA)

**Avoids:** Pitfall 9 (deadlock -- already handled in Phase 2 evaluator, verified here in integration)

### Phase 5: Templates, Ad-Hoc API, and Artifact Handoff

**Rationale:** User-facing features built on the complete internal machinery. Templates require the project manifest schema extension. Ad-hoc API requires MCP tool modifications. Artifact handoff requires the hop-scoped directory convention. These are independent of each other and can be built in parallel.

**Delivers:** workflowTemplates map in project.yaml with named DAG templates. Template resolution at dispatch time (expand template into task frontmatter). Inline workflow definition via MCP task creation tool. Per-hop artifact directories (outputs/<hopId>/). Predecessor output path injection into hop context.

**Addresses:** Table stakes #6 (artifact handoff), #7 (templates), #8 (ad-hoc API)

**Avoids:** Pitfall 7 (schema divergence -- same Zod schema validates both templates and inline), Pitfall 8 (directory contention -- per-hop subdirectories under work/)

### Phase 6: Migration, Completion-Triggered Advancement, and Polish

**Rationale:** Migration is last because all schemas must be stable. Completion-triggered advancement is an optimization that bypasses poll latency. CLI visualization is polish.

**Delivers:** Gate-to-DAG conversion utility (CLI command). Lazy migration for in-flight gate tasks. Completion-triggered hop advancement (bypass 30s poll latency). Workflow status CLI command with ASCII DAG visualization. Event schema for hop lifecycle events.

**Addresses:** Table stakes #10 (migration), differentiators (completion-triggered advancement, CLI visualization)

**Avoids:** Pitfall 5 (migration -- lazy migration with dual-mode evaluator already in place from Phase 3), Pitfall 6 (poll latency -- completion-triggered advancement), Pitfall 12 (event bloat -- compact hop events with summary on DAG completion)

### Phase Ordering Rationale

- **Schemas first** because every other phase depends on the data shapes. A wrong schema discovered in Phase 4 forces rework of Phases 2-3.
- **Pure evaluator second** because it is the algorithmic heart with zero integration risk. Testing it exhaustively before integration eliminates the hardest class of bugs.
- **Scheduler integration third** because it proves the end-to-end flow works. Linear DAGs exercised here are a strict superset of what linear gates provide, proving the replacement works.
- **Rejection/timeout fourth** because these are edge cases on the happy path. Building them after the happy path works means failures in this phase do not block forward progress.
- **Templates/API/artifacts fifth** because these are user-facing features that should only ship when the engine underneath is proven correct.
- **Migration last** because schemas must be stable and the dual-mode evaluator must be proven before migrating any production data.

### Research Flags

Phases likely needing deeper research during planning:

- **Phase 3 (Scheduler Integration):** The interaction between DAG hop dispatch and existing concurrency tracking (maxConcurrentDispatches, inProgressByTeam) needs careful design. How does a hop dispatch count against concurrency limits? Does each hop consume one slot? Research needed on the specific scheduler poll code paths to confirm the integration points.
- **Phase 4 (Rejection Handling):** Rejection with downstream reset when parallel siblings are still running is a complex state transition. The evaluator must handle: hop A and hop B both depend on hop C; hop A completes; hop B rejects to hop C; hop A's completion is now stale. Need to verify the exact semantics (does hop A re-run too?).
- **Phase 5 (Artifact Handoff):** The hop-scoped directory convention (outputs/<hopId>/) interacts with the existing RunArtifact.artifactPaths structure. Need to verify whether the existing task store's ensureTaskDirs and writeTaskOutput methods can be extended or need wrapping.

Phases with standard patterns (skip research-phase):

- **Phase 1 (Schema Foundation):** Zod schema design with .superRefine() is well-documented. Topological sort is textbook. Backward-compatible schema extension via optional fields is a standard pattern already used throughout AOF.
- **Phase 2 (DAG Evaluator):** Pure function evaluation with fixture-based testing is a well-established pattern. The existing gate-evaluator.ts provides the exact template to follow.
- **Phase 6 (Migration):** Lazy migration with schema version detection is the pattern already used in the codebase. The dual-mode evaluator from Phase 3 handles coexistence.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Zero new dependencies needed; all capabilities confirmed from existing installed packages; Zod .superRefine() and discriminated unions verified available in ^3.24.0 |
| Features | MEDIUM-HIGH | Table stakes derived from direct codebase analysis (existing gate system) plus ecosystem patterns (Temporal, Airflow, Step Functions). Differentiator priority (parallel execution as primary DAG value) is a judgment call, not a verified requirement. |
| Architecture | HIGH | All integration points mapped at file/method level from direct source code analysis. Build order respects verified dependency chains. The pure-evaluator + handler pattern replicates the proven gate-evaluator + gate-transition-handler split. |
| Pitfalls | HIGH | All critical pitfalls derived from direct source code analysis with specific file/line references. Mitigation strategies map to existing patterns already proven in the gate system. |

**Overall confidence:** HIGH

### Gaps to Address

- **Parallel dispatch semantics under OpenClaw constraint:** The no-nested-sessions constraint forces serial hop dispatch within a task. This means "parallel" DAG branches execute sequentially. The research is clear on this constraint, but the user-facing documentation must make this explicit to avoid confusion. During Phase 3 planning, decide whether to name this "logical parallelism" or find a term that sets correct expectations.

- **Hop-level lease model details:** The research identifies that the current single-lease-per-task model needs extension for DAG tasks, but the exact implementation (leases array vs. metadata bag vs. simplified single-lease-with-hopId) needs to be decided during Phase 1 schema design. The ARCHITECTURE.md recommends keeping one active hop at a time, which simplifies this to a single lease with a hopId field.

- **Condition evaluation trust boundary:** The research recommends a JSON DSL for agent-authored conditions and JavaScript eval for admin-authored template conditions. The exact JSON DSL operators and schema need to be defined during Phase 1. This is a design decision, not a research gap -- the operators should match what `when` expressions currently evaluate (tag checks, metadata comparisons, hop result status checks).

- **Artifact handoff implementation detail:** The research proposes hop-scoped directories (outputs/<hopId>/), but the exact interaction with the existing RunArtifact.artifactPaths structure and the ITaskStore.writeTaskOutput method is unconfirmed. Phase 5 planning should read these methods to determine the exact extension needed.

- **Rejection semantics for parallel branches:** When a hop rejects back to a predecessor and parallel sibling branches have already completed, should those siblings re-run? The ARCHITECTURE.md says "reset ALL downstream hops to pending," which implies yes. This needs explicit confirmation during Phase 4 planning because it affects how much work is repeated on a rejection.

## Sources

### Primary (HIGH confidence -- direct source code analysis)
- `src/schemas/workflow.ts` -- existing WorkflowConfig with linear gate sequences
- `src/schemas/gate.ts` -- Gate, GateHistoryEntry, ReviewContext, GateTransition types
- `src/schemas/task.ts` -- TaskFrontmatter with gate, gateHistory, reviewContext, VALID_TRANSITIONS
- `src/schemas/project.ts` -- ProjectManifest with workflow field
- `src/dispatch/scheduler.ts` -- poll loop, dependency gating, concurrency tracking, cycle detection
- `src/dispatch/gate-evaluator.ts` -- pure function gate evaluation pattern
- `src/dispatch/gate-conditional.ts` -- sandboxed condition evaluation via Function constructor
- `src/dispatch/gate-transition-handler.ts` -- atomic gate state application via writeFileAtomic
- `src/dispatch/task-dispatcher.ts` -- dispatch action building
- `src/dispatch/assign-executor.ts` -- agent session spawning, lease acquisition, correlation IDs
- `src/dispatch/action-executor.ts` -- sequential action execution loop
- `src/store/task-store.ts` -- filesystem task CRUD, ensureTaskDirs
- `src/store/task-mutations.ts` -- atomic transition via rename()
- `src/store/interfaces.ts` -- ITaskStore contract
- `src/protocol/router.ts` -- completion report handling
- `src/schemas/run.ts` -- RunArtifact with artifactPaths
- `src/schemas/protocol.ts` -- CompletionReportPayload, HandoffRequestPayload
- `docs/dev/workflow-gates-design.md` -- existing design doc (section 11.4 defers parallel to v2)

### Secondary (MEDIUM confidence -- domain expertise from training data)
- Apache Airflow DAG execution model -- scheduler-driven DAG advancement, task instance states, XCom
- AWS Step Functions -- ASL, Choice/Parallel states, InputPath/OutputPath
- Temporal workflow patterns -- activities, task queues, child workflows, retries
- Prefect flow execution -- task runs, state transitions, result persistence
- Dagster op execution -- ops, IOManagers, asset materialization
- Kahn's algorithm for topological sort -- standard O(V+E) DAG processing
- BPMN join semantics -- AND-join (all), OR-join (any) patterns

---
*Research completed: 2026-03-02*
*Ready for roadmap: yes*
