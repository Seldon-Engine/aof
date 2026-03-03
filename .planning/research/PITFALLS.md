# Domain Pitfalls: Per-Task Workflow DAG Execution

**Domain:** Adding DAG-based workflow execution to filesystem-backed agent orchestration (AOF v1.2)
**Researched:** 2026-03-02
**Confidence:** HIGH (all pitfalls derived from direct source code analysis of existing scheduler, gate system, task store, and protocol router + domain expertise in DAG execution engines)

---

## Critical Pitfalls

Mistakes that cause state corruption, data loss, or require architectural rewrites.

### Pitfall 1: Parallel Hop Dispatch Race in Poll-Based Scheduler

**What goes wrong:** When a DAG hop completes and enables two or more parallel successor hops, the scheduler's single `poll()` cycle detects all eligible hops and dispatches them. The current scheduler dispatches actions sequentially within `executeActions()` (line 62 of `action-executor.ts`: `for (const action of actions)`). If two parallel hops target the same task's work directory for artifact handoff, or if one hop's dispatch failure triggers a rollback that corrupts the other hop's already-running state, the task enters an inconsistent state.

**Why it happens:** The current scheduler was designed for one-task-one-dispatch. It has no concept of "dispatch group" where multiple hops belong to the same DAG instance and must be tracked together. The `buildDispatchActions()` function in `task-dispatcher.ts` builds a flat list of `SchedulerAction[]` with no grouping metadata. The `SchedulerAction` type (line 71 of `scheduler.ts`) has a single `taskId` field -- it cannot represent "dispatch hop B of task X."

**Consequences:**
- Partial DAG execution: hop A dispatched, hop B fails, no awareness that they're related
- Artifact directory contention: parallel hops writing to the same task's `work/` directory
- State divergence: task frontmatter says "hop B failed" but hop A is still running with an active lease
- Impossible recovery: scheduler cannot determine which hops succeeded vs. failed without per-hop state tracking

**Prevention:**
- Model parallel hops as **independent sub-dispatches** with their own tracking, NOT as mutations to the parent task's status. Each hop gets its own lease, its own correlation ID, its own state entry in the task frontmatter.
- Add a `hopStatus` map to the task frontmatter (e.g., `hops: { "build": { status: "in-progress", lease: {...} }, "lint": { status: "in-progress", lease: {...} }, "test": { status: "waiting" } }`) so the scheduler can track parallel hop progress independently.
- Dispatch parallel hops in a "best-effort" mode: if hop B fails to dispatch, hop A continues. The DAG advancement logic on the next poll re-evaluates and retries hop B. Do NOT require atomic all-or-nothing dispatch of parallel hops -- this would block working hops when one has a transient failure.
- Give each hop its own subdirectory under the task's `work/` dir (e.g., `work/build/`, `work/lint/`) to eliminate filesystem contention.

**Detection:** Integration test where two parallel hops are dispatched and one spawn fails. Verify the other hop completes and the failed hop is retried on next poll without corrupting shared state.

**Phase to address:** DAG schema design phase (first). The hop tracking data model must be correct before any execution logic is written.

---

### Pitfall 2: Non-Atomic DAG State Updates on Filesystem

**What goes wrong:** The current task store uses `rename()` for atomic status transitions (line 182 of `task-mutations.ts`). DAG state is richer than a single status -- a hop completion may require updating: (1) the hop's entry in the hops map, (2) the task's routing to point to the next hop's agent, (3) the gate/hop history, (4) condition evaluation results for successor hops, (5) possibly the task-level status (if all hops are done). If the process crashes between writing the hop status update and the routing update, the task is in an inconsistent state: the hop is marked complete but the next hop's agent was never assigned.

**Why it happens:** The existing gate system performs all updates in a single `writeFileAtomic()` call in `applyGateTransition()` (gate-transition-handler.ts line 107). This works because the gate system is linear -- conceptually one thing changes at a time. The temptation with DAG state is to break updates across multiple writes for clarity or because different parts of the state are managed by different functions.

**Consequences:**
- Task file says hop A is "done" but routing still points to hop A's agent
- Scheduler re-dispatches hop A (already complete) because routing was not updated
- Orphaned state: hop A marked done, hop B never started, task stuck forever
- Manual intervention required (editing YAML frontmatter by hand)

**Prevention:**
- **All DAG state updates for a single hop completion MUST happen in one `writeFileAtomic()` call.** This is the existing pattern in `applyGateTransition()` -- extend it, do not replace it.
- Design the DAG evaluator as a pure function (following the pattern of `evaluateGateTransition()` in `gate-evaluator.ts` lines 104-177) that returns ALL updates as a single result object. The handler function applies them atomically.
- Never update hop status in one write and routing in another write.
- The DAG evaluator should compute the complete new frontmatter state and return it. The handler writes once.

**Detection:** Crash-injection test: kill the process during `writeFileAtomic()` and verify the task file is either fully updated or fully unchanged. `write-file-atomic` guarantees this on POSIX via rename-of-temp-file, but only if ALL changes go through a single call.

**Phase to address:** Hop execution handler phase. The `applyGateTransition()` pattern MUST be preserved and extended.

---

### Pitfall 3: Cycle Detection That Misses DAG-Internal Cycles

**What goes wrong:** The existing scheduler has O(n+e) DFS cycle detection at lines 169-209 of `scheduler.ts` that checks `task.frontmatter.dependsOn`. This operates on **inter-task** dependencies. The new per-task workflow DAG introduces **intra-task** hop dependencies (hop A -> hop B within one task). If the DAG schema allows hop-level edges or conditional branching that can create cycles (e.g., hop A -> hop B -> hop A via a loopback condition), the existing cycle detector will not catch it because it only examines task-level dependencies.

**Why it happens:** Two separate dependency graphs coexist: (1) task-to-task deps (existing `dependsOn` array in frontmatter), (2) hop-to-hop deps (new DAG edges within a task). Teams forget to validate the second graph because the first graph already "has cycle detection."

**Consequences:**
- Infinite loop: scheduler dispatches hop A, which completes, advances to hop B, which completes, advances back to hop A
- Scheduler CPU spike on every poll as it re-evaluates the stuck DAG
- Task never reaches terminal state, consumes concurrency slots forever
- The existing `maxHops` or similar safety valve does not exist yet

**Prevention:**
- Validate the hop DAG at **template registration time** (when `project.yaml` is loaded) and at **task creation time** (when ad-hoc workflows are composed by agents). Reject any workflow that contains a cycle.
- Use topological sort to validate: if the sort cannot produce a complete ordering, the DAG has a cycle. Store the topological order in the workflow definition for efficient advancement.
- Add a `maxHopTransitions` safety limit per task (e.g., 50). If a task has executed more than `maxHopTransitions` hop completions, deadletter it with a "suspected cycle or runaway workflow" reason. This catches both true cycles and accidental infinite retry loops.
- Keep the existing inter-task cycle detection completely untouched. It operates on a different graph and should not be aware of hop-level dependencies.

**Detection:** Unit test: create a workflow with hop A -> hop B -> hop A. Schema validation must reject it at creation time. Integration test: create a workflow with conditional branches that, under all possible condition combinations, cannot cycle -- verify execution completes.

**Phase to address:** DAG schema validation phase (first phase, alongside schema design).

---

### Pitfall 4: Condition Evaluation Security with Agent-Composed Workflows

**What goes wrong:** The existing `evaluateGateCondition()` in `gate-conditional.ts` uses `new Function()` to evaluate `when` clauses (line 94). This was designed for admin-authored conditions in `project.yaml`. The v1.2 feature introduces **agent-composed ad-hoc workflows** -- agents create workflow DAGs at task creation time via the `aof_dispatch` tool. If agents can inject arbitrary JavaScript expressions into hop conditions, the `Function` constructor sandbox can be escaped (it prevents direct `require()` but allows access to `this`, constructor chains, and prototype pollution).

**Why it happens:** The existing condition evaluator was designed for a trust model where conditions come from `project.yaml`, which is human-reviewed. Agent-composed workflows change the trust model -- conditions now come from potentially untrusted agent output.

**Consequences:**
- Agent-injected condition like `this.constructor.constructor("return process")().exit()` crashes the scheduler daemon
- Prototype pollution: `metadata.__proto__.polluted = true` taints all subsequent evaluations in the process
- Information leak: conditions can read scheduler process environment variables via constructor chain
- Denial of service: infinite loop in condition expression (the timeout check at line 113 runs AFTER execution, so it cannot stop a while(true) loop)

**Prevention:**
- **Do NOT allow arbitrary JavaScript in agent-composed workflow conditions.** Use a restricted condition format:
  - **Recommended:** JSON-based condition DSL (e.g., `{"op": "has_tag", "value": "security"}` or `{"op": "metadata_gt", "key": "dealSize", "value": 50000}`). This is safe, extensible, and easy to validate at schema level with Zod discriminated unions.
  - Keep the existing `evaluateGateCondition()` JavaScript eval ONLY for template workflows loaded from `project.yaml` (admin-authored, trusted).
  - Agent-composed workflows validate conditions against the JSON DSL schema at creation time. Reject any condition that does not match.
- The existing timeout check (line 113 of `gate-conditional.ts`) is post-hoc -- it cannot stop infinite loops. Fix this independently by wrapping evaluation in a `vm.createContext()` with `vm.runInContext()` and a real timeout, or by moving to the JSON DSL which has no eval at all.
- Freeze context objects before passing to eval: `Object.freeze(context.tags)`, `Object.freeze(context.metadata)`.

**Detection:** Security test: attempt to break out of condition sandbox with known payloads (constructor chain, prototype pollution, process access, infinite loop). All must return `false` without side effects. Test the JSON DSL rejects arbitrary strings.

**Phase to address:** Schema design phase (define the condition format) AND hop execution phase (enforce restrictions at runtime).

---

### Pitfall 5: Backward Compatibility -- Linear Gates to DAG Migration

**What goes wrong:** Existing tasks in production have `gate`, `gateHistory`, and `reviewContext` fields in their frontmatter (defined in `schemas/task.ts` lines 115-118). The existing gate evaluation system is deeply wired into the codebase:
- `gate-evaluator.ts` reads `task.frontmatter.gate.current` (line 108)
- `gate-transition-handler.ts` orchestrates gate transitions and calls `evaluateGateTransition()`
- `gate-context-builder.ts` builds context for agents using gate fields
- `assign-executor.ts` injects `gateContext` into `TaskContext` (lines 148-166)
- `scheduler.ts` calls `checkGateTimeouts()` (line 244)
- The protocol router processes completion reports by calling `handleGateTransition()`

If the new DAG system replaces gate fields with hop fields, in-flight tasks (currently mid-workflow with `gate.current = "review"`) will break: the scheduler tries to advance them using DAG logic, but they have no `hops` field, causing a crash or silent drop.

**Why it happens:** A naive replacement that removes gate-related code and adds hop-related code will crash on any task that still has the old format. Even if no tasks are mid-workflow at migration time, the gate schemas, validation functions, and evaluators are embedded in the Zod schemas, the scheduler, and the protocol router.

**Consequences:**
- In-flight tasks stuck: mid-gate tasks cannot advance because the gate evaluator was removed or modified incompatibly
- Schema validation failures: old tasks fail Zod parse if gate fields are removed from the schema
- Data loss: gateHistory (audit trail) lost if not preserved during migration
- Silent failures: scheduler skips tasks it cannot evaluate, they rot in `in-progress` forever with active leases

**Prevention:**
- **Phase 1: Make the DAG schema a superset of the gate schema.** Keep `gate`, `gateHistory`, `reviewContext` as valid (optional) fields in `TaskFrontmatter`. Add new `workflow` (inline DAG definition), `hopStatus` (per-hop state map), and `currentHops` (active hop IDs) fields alongside them. Zod validates both old and new formats.
- **Phase 2: Dual-mode evaluator.** The scheduler and protocol router check: if task has inline `workflow` with `hopStatus`, use DAG evaluator. If task has `gate` field but no `workflow`, use existing `evaluateGateTransition()`. If neither, use simple completion (task -> done). This is a simple if/else at the callsite, not a complex abstraction.
- **Phase 3: Migration tool (optional, deferred).** A CLI command `aof migrate-gates` that converts linear gate workflows to equivalent DAG workflows (each gate becomes a sequential hop). Run manually after confirming no tasks are mid-flight. Not required for v1.2 -- the dual-mode evaluator handles coexistence.
- **Never delete the gate evaluator code during v1.2.** Mark it as legacy with JSDoc annotations but keep it fully functional.
- The existing `WorkflowConfig` schema (schemas/workflow.ts) defines the PROJECT-level workflow template. The new per-task inline workflow is a DIFFERENT thing -- a task-level DAG definition. Use a different field name to avoid confusion (`workflow` vs the existing `routing.workflow` string reference).

**Detection:** Integration test: create a task with old-format gate fields, run the new scheduler, verify it evaluates correctly using the legacy path. Create a task with new DAG fields, verify it uses the new path. Create both types, run scheduler, verify both advance correctly in the same poll cycle.

**Phase to address:** MUST be addressed in the schema design phase (first phase) by making schemas backward-compatible. The dual-mode evaluator goes in the scheduler integration phase.

---

## Moderate Pitfalls

Issues that cause bugs, performance problems, or significant rework but not data loss.

### Pitfall 6: Poll-Based Advancement Latency for Multi-Hop DAGs

**What goes wrong:** The current scheduler polls at 30-second intervals. In a linear gate workflow, a task with 3 gates takes at minimum 3 poll cycles to complete (90 seconds) even if each gate's agent completes instantly. A DAG with 5 sequential hops takes 5 poll cycles (2.5 minutes minimum). For complex DAGs with 10+ sequential hops, the minimum end-to-end latency becomes unacceptable.

**Why it happens:** The poll-based scheduler was designed for task lifecycle management (backlog -> ready -> in-progress -> done), where each transition happens at human timescales (hours between stages). Workflow hops happen at agent timescales (seconds to minutes per hop). The 30-second poll interval was appropriate for the original use case but creates artificial latency when hops should chain immediately.

**Consequences:**
- A 5-sequential-hop workflow takes 2.5+ minutes even when all agents complete in seconds
- Users perceive the system as slow and unresponsive
- Agents idle waiting for the next poll to dispatch them their next piece of work
- Temptation to reduce poll interval globally, increasing filesystem I/O for ALL tasks

**Prevention:**
- **Do NOT reduce the global poll interval.** It would increase filesystem scan load for all tasks, including ones with no DAG at all.
- Implement **completion-triggered advancement**: when an agent completes a hop (calls `aof_task_complete` or the protocol router processes a completion report), the completion handler immediately evaluates the DAG and dispatches the next hop(s) without waiting for the next poll. The poll cycle becomes a **fallback safety net** that catches missed advancements.
- This is architecturally straightforward: `handleGateTransition()` in `gate-transition-handler.ts` is already called synchronously on completion (not during poll). The new `handleHopCompletion()` function can follow the same pattern: evaluate DAG -> determine next hops -> dispatch immediately.
- Keep the poll as a safety net: it catches cases where the completion-triggered path fails (e.g., process crash between hop completion write and next hop dispatch).
- The `executeAssignAction()` function in `assign-executor.ts` is already callable outside the poll cycle -- it just needs to be wired into the completion handler.

**Detection:** Latency test: measure end-to-end time for a 5-hop sequential workflow. With poll-only advancement, expect ~150s. With completion-triggered advancement, expect ~5-10s (agent processing time only).

**Phase to address:** Hop execution/advancement phase. Design the completion handler to do immediate advancement, with poll as fallback.

---

### Pitfall 7: Template vs. Ad-Hoc Workflow Schema Divergence

**What goes wrong:** Templates (defined in `project.yaml` via the existing `WorkflowConfig` schema) and ad-hoc workflows (composed by agents at task creation time, stored inline in task frontmatter) use different code paths for validation and storage. Over time, templates get features that ad-hoc workflows don't support (or vice versa), creating a behavioral split. Agents composing ad-hoc workflows hit validation errors that templates don't, or templates support condition types that ad-hoc workflows silently ignore.

**Why it happens:** Templates are validated at project load time via `validateWorkflow()` (schemas/workflow.ts line 77). Ad-hoc workflows would be validated at task creation time via the `aof_dispatch` tool. Different validation timing + different code paths + different storage locations = different behavior over time.

**Consequences:**
- Agent creates an ad-hoc workflow that works, then someone creates a template with the same structure that fails validation (or vice versa)
- Bug reports about "inconsistent workflow behavior" that are actually validation differences
- Feature additions require updating two validation paths and two storage paths

**Prevention:**
- **One Zod schema, one validation function.** Both templates and ad-hoc workflows MUST use the identical Zod schema (a new `WorkflowDAG` schema) and the same validation function.
- Templates are stored in `project.yaml` and referenced by name in `routing.workflow`. Ad-hoc workflows are stored inline in the task's frontmatter. But the schema is the same.
- The `aof_dispatch` tool should accept a `workflow` parameter that is either: (a) a string template name (resolved from project.yaml), or (b) an inline workflow DAG object (validated against the same `WorkflowDAG` schema).
- At dispatch time, if a template name is provided, resolve it to the full DAG definition and embed it in the task frontmatter. The scheduler only ever reads the embedded definition -- it never goes back to `project.yaml` to resolve templates. This means template changes don't affect in-flight tasks.

**Detection:** Schema conformance test: generate valid workflow DAG objects, verify they pass validation whether used as a template or as an inline definition. Verify error messages are identical.

**Phase to address:** Schema design phase. Define one schema used for both paths.

---

### Pitfall 8: Artifact Handoff Filesystem Contention Between Hops

**What goes wrong:** The design specifies "artifact handoff via task work directory." The existing task store creates `inputs/`, `work/`, `outputs/` subdirectories per task (task-store.ts lines 138-142 in `ensureTaskDirs()`). Teams assume hop B can read hop A's outputs by reading files from the shared `work/` directory. Problems: (1) parallel hops share the same `work/` directory, causing filename collisions, (2) hop A might still be writing when hop B starts reading, (3) there is no convention for which subdirectory each hop uses, (4) large artifacts accumulate in the task directory across all hops.

**Why it happens:** The current `inputs/`/`work/`/`outputs/` convention was designed for a single agent working on a single task. It has no concept of per-hop artifact namespacing. The `ensureTaskDirs()` function creates flat directories with no hop-scoped structure.

**Consequences:**
- Race conditions: hop B reads partial files that hop A is still writing
- Name collisions: parallel hops A and B both write `results.json` to `work/`, last writer wins
- Wrong directory: hop B looks in `work/` but hop A wrote to `outputs/`
- Directory bloat: every hop's artifacts accumulate forever

**Prevention:**
- Define a clear artifact contract per hop:
  - Each hop writes to `work/<hop-id>/outputs/`
  - The DAG advancement logic (not the agent) copies or symlinks predecessor outputs to successor's `work/<hop-id>/inputs/`
  - Each hop reads from `work/<hop-id>/inputs/`
- Alternative simpler approach: pass artifacts by reference, not by value. The task body includes file paths; agents read/write to those paths. The DAG advancement logic does not copy files, it just updates the task body with the paths from the previous hop's outputs. This avoids filesystem management complexity.
- Either way: the task's top-level `outputs/` directory receives the final hop's outputs only. Intermediate hop outputs stay in `work/<hop-id>/`.

**Detection:** Integration test: parallel hops A and B each write to `work/<hop-id>/outputs/`. Verify no filename collision. Successor hop C reads from `work/C/inputs/` and finds artifacts from both A and B.

**Phase to address:** Artifact handoff design (sub-phase of execution logic).

---

### Pitfall 9: DAG Deadlock from Skipped Conditional Hops

**What goes wrong:** A DAG with conditional branches can create implicit deadlocks. Example: hop C depends on both hop A and hop B. Hop A has condition `when: metadata.type === 'backend'`. Hop B has condition `when: metadata.type === 'frontend'`. For a task where `metadata.type === 'backend'`, hop B's condition is false so it is skipped. But hop C still waits for both A and B to complete. Since B will never run, hop C deadlocks.

**Why it happens:** Cycle detection (topological sort) verifies there are no circular dependencies, but it does NOT verify that all dependency paths are satisfiable under all condition combinations. This is a **reachability problem**, not a cycle problem. The existing gate system avoids this because gates are linear -- a skipped gate just advances to the next one (gate-evaluator.ts lines 205-220). DAGs with parallel branches and join points introduce this new failure mode.

**Consequences:**
- Task permanently stuck: hop C waits for hop B which was skipped and will never complete
- Scheduler reports no errors (no cycle detected, no timeout yet)
- Only discovered after SLA violation fires hours later
- Manual intervention: someone must edit the task frontmatter to mark hop B as "skipped"

**Prevention:**
- When a hop is skipped (condition evaluates to false), the DAG advancement logic MUST **propagate the skip through the dependency graph**. If hop B is skipped, all downstream hops that depend on B should treat B's dependency as satisfied (skipped = done for dependency purposes).
- Implement this rule: a hop is eligible for dispatch when all of its predecessors are either "done" or "skipped".
- Document this clearly in the workflow spec: "Skipped hops are treated as completed for dependency resolution."
- Add a "stuck DAG" detector in the scheduler: if a task has active hops but no hop has advanced in the last N poll cycles, and no hop is currently in-progress, emit an alert. This catches deadlocks that the skip-propagation logic misses.
- For template validation: verify that for each possible condition combination, at least one path from start to end is satisfiable. This is exponential in the number of conditions, so limit to templates with fewer than 12 conditional hops (covers practical use cases).

**Detection:** Unit test: DAG with a conditional skip that creates a dependency deadlock. Verify the advancement logic resolves it by treating the skipped hop as satisfied. Test both direct dependency (C depends on skipped B) and transitive dependency (D depends on C which depends on skipped B).

**Phase to address:** DAG advancement logic phase. The skip-propagation rule is core to correct DAG execution.

---

### Pitfall 10: Scheduler Poll Scan Cost Scaling with DAG Complexity

**What goes wrong:** The current `poll()` function calls `store.list()` which scans ALL status directories and reads + parses EVERY `.md` task file (task-store.ts lines 241-288, full directory scan with `readdir()` + `readFile()` per file). For each task with a DAG workflow, the scheduler must now also evaluate the DAG to determine which hops are eligible for dispatch. With 100 tasks, each having a 10-hop DAG, the scheduler is potentially evaluating 1000 hop eligibility checks per poll cycle, on top of the filesystem I/O.

**Why it happens:** `store.list()` has no caching, no indexing, no incremental scanning. The current system works because task counts are modest (dozens). DAG evaluation adds per-task compute overhead on top of per-task I/O.

**Consequences:**
- Poll cycles exceed 30s, causing overlapping polls (the daemon does not have a guard against this)
- Filesystem I/O spikes every 30 seconds
- Scheduler latency increases linearly with (number of tasks * average hops per task)
- On slow filesystems (network mounts, encrypted volumes), severe degradation

**Prevention:**
- **Do NOT evaluate DAGs inside the hot poll path for tasks that have not changed.** Only evaluate DAGs for tasks whose `updatedAt` timestamp changed since last poll evaluation. Cache the last-seen `updatedAt` per task ID across poll cycles.
- The existing `allTasks` list is fetched once at the top of `poll()` (line 130). Use this cached list for all DAG evaluations within the cycle. Do not call additional `store.get()` calls during DAG evaluation.
- For the completion-triggered advancement path (Pitfall 6 mitigation), most DAG evaluations happen outside the poll cycle entirely, dramatically reducing poll-time work.
- Do not evaluate DAGs for tasks in terminal states (`done`, `cancelled`, `deadletter`). These are scanned by `store.list()` but should be filtered out before DAG evaluation.
- Long-term (v2): consider a filesystem watcher (fsevents/inotify) for incremental change detection instead of full directory scans. But this is out of scope for v1.2.

**Detection:** Performance benchmark: create 100 tasks with 10-hop DAGs in various states. Measure poll cycle duration. Target: under 5 seconds (leaving 25s headroom within the 30s interval).

**Phase to address:** Scheduler integration phase. Efficiency must be designed in from the start.

---

### Pitfall 11: Lease System Is Per-Task, Not Per-Hop

**What goes wrong:** The current lease system tracks a single lease per task: `lease?: TaskLease` in the TaskFrontmatter schema (schemas/task.ts line 100). `TaskLease` has one `agent` field (line 41). When parallel hops run, multiple agents work on the same task simultaneously. Each agent needs its own lease to prevent the scheduler from reclaiming the task, but the schema only allows one lease.

**Why it happens:** The lease system was designed for the one-task-one-agent model. `acquireLease()` in `store/lease.ts` transitions the task to `in-progress` and sets a single lease. `isLeaseActive()` in `lease-manager.ts` checks the single lease. `startLeaseRenewal()` renews the single lease. None of these functions are hop-aware.

**Consequences:**
- When parallel hop B's agent acquires a lease, it overwrites hop A's lease. Hop A's heartbeat renewal fails because the lease agent no longer matches.
- When the scheduler checks for expired leases, it sees hop B's lease and considers hop A's agent as having no lease. Hop A gets reclaimed (requeued to ready) while still running.
- `isLeaseActive()` returns true for hop B's agent but false for hop A's, causing duplicate dispatches.

**Prevention:**
- Extend the lease model to support per-hop leases. Two options:
  - **Option A (recommended):** Add a `hopId` field to `TaskLease` and change `lease?: TaskLease` to `leases?: TaskLease[]` (array). Each hop dispatch creates a lease entry with the hop ID. Lease renewal, expiry, and cleanup all filter by hop ID. This is a schema change but preserves the existing lease infrastructure.
  - **Option B:** Do not modify the task-level lease at all. Instead, store hop leases in the task's `metadata` field (e.g., `metadata.hopLeases: { "build": { agent: "swe-backend", expiresAt: "..." } }`). This avoids a schema change but puts lease state in an untyped bag.
- **Option A is cleaner** because it keeps lease operations type-safe and avoids scattering lease logic across metadata. The existing `acquireLease()` / `releaseLease()` / `isLeaseActive()` functions get a `hopId` parameter (optional for backward compatibility -- omitting it means task-level lease, matching current behavior).
- The task-level `status` should only transition to `in-progress` when the FIRST hop is dispatched, and only transition out of `in-progress` when ALL active hops are complete or the task is explicitly blocked/cancelled.

**Detection:** Integration test: dispatch two parallel hops for the same task. Verify both agents have active leases. Verify neither agent's lease expiry triggers reclaim of the other agent's hop.

**Phase to address:** Schema design phase (lease model extension) and hop execution phase (lease function modifications).

---

## Minor Pitfalls

Issues that cause developer friction, test failures, or minor user-facing bugs.

### Pitfall 12: Event Schema Bloat in JSONL Logs

**What goes wrong:** Each hop transition emits a `gate_transition` event (gate-transition-handler.ts line 194). A 10-hop DAG emits 10+ transition events per task execution. With 50 tasks/day, that is 500+ events/day just for hop transitions, on top of existing `scheduler.poll`, `dispatch.matched`, `sla.violation`, and other events. Daily JSONL files grow significantly, and event replay for state recovery becomes slower.

**Prevention:**
- Use compact event payloads for hop transitions. Include only the delta (`fromHop`, `toHop`, `outcome`), not the full DAG state.
- Emit a single `workflow.completed` summary event when the entire DAG finishes, with the full hop execution history embedded. Individual `hop.transition` events are operational detail; the summary is the semantic record.
- Use new event type names (`hop.transition`, `hop.dispatched`, `workflow.completed`, `workflow.failed`) to distinguish from the existing gate events (`gate_transition`). Do not reuse gate event names for different semantics.

**Phase to address:** Event design (part of schema phase). Define event shapes before implementing handlers.

---

### Pitfall 13: Test Explosion from DAG Execution Path Combinatorics

**What goes wrong:** A DAG with N hops and C conditional hops has O(2^C) possible execution paths. Writing explicit test cases for every path is infeasible for DAGs with more than 5 conditions. Teams either (a) under-test and miss edge cases in condition/skip logic, or (b) spend excessive time writing repetitive tests.

**Prevention:**
- Use property-based testing (vitest has no built-in property testing, but `fast-check` integrates easily): generate random valid DAGs, execute them through the evaluator, verify invariants:
  - No hop can be "in-progress" without a lease
  - No hop can be "done" without all predecessors "done" or "skipped"
  - All hops eventually reach a terminal state (done, skipped, or failed)
  - The DAG completes in at most N hop transitions (where N is the total number of hops)
- Test the DAG evaluator (pure function, no I/O) exhaustively with property-based tests. Test the handler (I/O integration) with a handful of representative DAGs (linear, diamond, wide-parallel, deep-conditional).
- Define core invariants as runtime assertions that run in the DAG evaluator during development/testing mode but are no-ops in production.

**Phase to address:** Testing strategy, defined alongside schema design, implemented alongside execution phases.

---

### Pitfall 14: OpenClaw No-Nested-Sessions Constraint Leaks Into DAG Design

**What goes wrong:** OpenClaw does not support nested agent sessions. The scheduler must advance hops between **independent, sequential sessions** (one session per hop dispatch). Teams designing the DAG system may inadvertently assume agents can spawn sub-agents or call into other agents' sessions to do hop handoffs. This creates a dependency on functionality that does not exist in the OpenClaw gateway.

**Prevention:**
- Treat each hop as a completely independent agent session. The ONLY communication channel between hops is the task file (frontmatter + body + work directory). No in-session IPC, no agent-to-agent calls, no shared session state.
- The scheduler (not any agent) is responsible for hop advancement. Agents call `aof_task_complete` with their hop outcome. The scheduler evaluates the DAG and dispatches the next hop.
- Document this constraint prominently in the workflow design spec and in the agent-facing API documentation.
- The `GatewayAdapter.spawnSession()` interface (executor.ts) spawns exactly one session for one hop. The DAG advancement logic calls `spawnSession()` once per eligible hop.

**Phase to address:** Architecture design (documented constraint) and execution phase (enforced in protocol router).

---

### Pitfall 15: Workflow Name Collision Between Templates and Inline Definitions

**What goes wrong:** A template in `project.yaml` is named "deploy-pipeline". An agent creates an ad-hoc inline workflow and the task's `routing.workflow` field says `"deploy-pipeline"`. When the scheduler resolves the workflow, which definition wins -- the project template or the inline definition?

**Prevention:**
- Clear resolution rule: **inline workflow definitions in task frontmatter always take precedence over template references.** If a task has both an inline workflow and a `routing.workflow` string, the inline definition is used.
- Template resolution happens at dispatch time, not at execution time. When `aof_dispatch` is called with a template name, the template is resolved from `project.yaml`, expanded into the full DAG definition, and embedded inline in the task frontmatter. After that point, the task carries its own workflow definition and the template name is metadata only.
- This means template changes do NOT affect in-flight tasks (a task created with template v1 keeps v1 even if the template is updated to v2).

**Phase to address:** Schema design phase. Define the resolution rule in the schema spec.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation | Severity |
|-------------|---------------|------------|----------|
| DAG schema design | Pitfall 3 (cycle detection), Pitfall 5 (backward compat), Pitfall 7 (schema divergence), Pitfall 11 (lease model) | Validate DAG at creation; superset schema; one schema for all; per-hop leases | CRITICAL |
| Hop execution handler | Pitfall 2 (non-atomic writes), Pitfall 1 (parallel dispatch race) | Single writeFileAtomic per hop completion; per-hop state tracking in frontmatter | CRITICAL |
| Scheduler DAG advancement | Pitfall 6 (poll latency), Pitfall 9 (deadlock from skipped hops), Pitfall 10 (scan cost) | Completion-triggered advancement; skip = done for deps; cache task state across polls | MODERATE |
| Condition evaluation | Pitfall 4 (security with agent-composed conditions) | JSON DSL for agent conditions; keep JS eval only for admin templates | CRITICAL |
| Artifact handoff | Pitfall 8 (directory contention) | Per-hop subdirectories under work/; explicit input/output contract | MODERATE |
| Backward compatibility | Pitfall 5 (gate-to-DAG migration) | Dual-mode evaluator; keep gate code as legacy; CLI migration tool (optional) | CRITICAL |
| Event logging | Pitfall 12 (JSONL bloat) | Compact hop events; summary event on DAG completion; new event type names | MINOR |
| Testing | Pitfall 13 (combinatorial explosion) | Property-based testing with fast-check; invariant assertions | MINOR |

---

## AOF-Specific Integration Concerns

These are specific to how the DAG system must integrate with AOF's existing modules.

### Concern A: ITaskStore Contract Does Not Model Hop State

The `ITaskStore` interface (store/interfaces.ts) has no methods for hop-level operations. All state changes go through `update()` (metadata patch), `transition()` (status change), or raw `writeFileAtomic()` in handlers.

**Mitigation:** Hop state lives in the task frontmatter, managed via `update()` or direct writes in the hop transition handler. Do NOT add hop-specific methods to `ITaskStore` -- this would expand the interface for a feature-specific concern. Instead, the DAG handler reads the task, computes new state, and writes the full task atomically. The store is a dumb persistence layer.

### Concern B: VALID_TRANSITIONS State Machine vs. Hop States

The `VALID_TRANSITIONS` map in `schemas/task.ts` (lines 137-146) defines task-level status transitions. Hop states (waiting, in-progress, done, skipped, failed) are a SEPARATE state machine that should NOT be conflated with task-level status.

**Mitigation:** Hop status lives in the task's frontmatter `hopStatus` map, NOT in the filesystem directory structure. Task-level directory moves (`rename()`) only happen for task-level transitions:
- First hop dispatched: `ready -> in-progress` (directory move)
- All hops complete: `in-progress -> done` (directory move, or `in-progress -> review` if there's a review hop)
- Task blocked: `in-progress -> blocked` (directory move)
- Hop-level state changes: frontmatter write only (NO directory move)

This preserves the existing state machine and filesystem layout while adding DAG state as frontmatter metadata.

### Concern C: Protocol Router Completion Path Needs Hop Awareness

The protocol router in `src/protocol/router.ts` processes completion reports from agents. Currently it calls `handleGateTransition()` for gate-enabled tasks. For DAG-enabled tasks, it must call a new `handleHopCompletion()` function. The router needs to distinguish between the two.

**Mitigation:** In the protocol router's completion handling:
1. Read the task
2. If task has `hopStatus` field (inline DAG), call `handleHopCompletion()`
3. Else if task has `gate` field, call `handleGateTransition()` (existing legacy path)
4. Else, call simple completion (task -> done)

The completion report from the agent must include the `hopId` so the handler knows which hop completed. Add `hopId?: string` to the completion report schema.

### Concern D: GatewayAdapter.spawnSession TaskContext Needs Hop Metadata

The `TaskContext` interface in `executor.ts` currently has `taskId`, `taskPath`, `agent`, `priority`, `routing`, `projectId`, `projectRoot`, `taskRelpath`, and `gateContext`. For DAG hops, the spawned agent needs to know which hop it's executing and what the hop's specific instructions/role are.

**Mitigation:** Add `hopId?: string` and `hopContext?: { role: string; description?: string; predecessors: string[] }` to `TaskContext`. The `assign-executor.ts` code that builds `TaskContext` (lines 136-145) adds this when dispatching a hop. The `gateContext` field is preserved for backward compatibility with the legacy gate path.

### Concern E: The `routing.workflow` Field Already Exists

The `TaskRouting` schema (schemas/task.ts line 67) already has `workflow: z.string().optional()` which is used to reference a template workflow name from `project.yaml`. The new inline DAG definition needs a DIFFERENT field name.

**Mitigation:** Use `workflowDef` (or `pipeline`, or `dag`) for the inline DAG definition in the task frontmatter. Keep `routing.workflow` as the template name reference. At dispatch time, if `routing.workflow` is set and `workflowDef` is not, resolve the template and populate `workflowDef`. After dispatch, the scheduler only reads `workflowDef`.

---

## Sources

All pitfalls derived from direct source code analysis of the AOF codebase at `/Users/xavier/Projects/AOF/src/`:

- `dispatch/scheduler.ts` -- poll cycle, cycle detection, gate timeout checks (HIGH confidence)
- `dispatch/gate-evaluator.ts` -- pure gate evaluation, role enforcement, condition skip logic (HIGH confidence)
- `dispatch/gate-transition-handler.ts` -- gate I/O orchestration, atomic writes (HIGH confidence)
- `dispatch/gate-conditional.ts` -- condition evaluation via Function constructor, timeout model (HIGH confidence)
- `dispatch/gate-context-builder.ts` -- gate context injection for agents (HIGH confidence)
- `dispatch/task-dispatcher.ts` -- dispatch action building, throttle checks (HIGH confidence)
- `dispatch/action-executor.ts` -- sequential action execution loop (HIGH confidence)
- `dispatch/assign-executor.ts` -- agent session spawning, lease acquisition, correlation IDs (HIGH confidence)
- `store/task-store.ts` -- filesystem task CRUD, ensureTaskDirs, directory layout (HIGH confidence)
- `store/task-mutations.ts` -- atomic transition via rename(), writeFileAtomic pattern (HIGH confidence)
- `store/interfaces.ts` -- ITaskStore contract (HIGH confidence)
- `schemas/task.ts` -- task frontmatter schema, valid transitions, gate/lease fields (HIGH confidence)
- `schemas/gate.ts` -- gate types, history entries, review context (HIGH confidence)
- `schemas/workflow.ts` -- workflow config schema, validation function (HIGH confidence)

Domain expertise on DAG execution engines, filesystem atomicity guarantees, and workflow scheduler design patterns (MEDIUM confidence -- training data, not verified against external sources for this specific combination of constraints).

---

*Pitfalls research for: AOF v1.2 per-task workflow DAG execution*
*Researched: 2026-03-02*
*Supersedes: v1.1 pitfalls (those remain valid for their respective subsystems; this document covers v1.2 DAG-specific pitfalls)*
