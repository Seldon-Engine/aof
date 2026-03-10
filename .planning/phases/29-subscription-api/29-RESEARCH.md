# Phase 29: Subscription API - Research

**Researched:** 2026-03-09
**Domain:** MCP tool registration, Zod schema composition, SubscriptionStore integration
**Confidence:** HIGH

## Summary

Phase 29 adds three MCP tool operations for task notification subscriptions: subscribe-at-dispatch (a `subscribe` param on `aof_dispatch`), standalone subscribe (`aof_task_subscribe`), and unsubscribe (`aof_task_unsubscribe`). All infrastructure is already in place from Phase 28 -- the `SubscriptionStore` class with full CRUD, the Zod schemas (`TaskSubscription`, `SubscriptionGranularity`, `SubscriptionsFile`), and the MCP tool registration pattern. This phase is purely about wiring: adding tool handlers, registering them, and extending the dispatch handler.

The main integration challenge is plumbing `SubscriptionStore` into `AofMcpContext` so tool handlers can access it. The store needs a `taskDirResolver` function that looks up a task's current status directory -- this requires the `ITaskStore` to resolve the task first (get its status), then compute the directory path. The existing `taskDir` method on `FilesystemTaskStore` is private, so the resolver must be built from public interface methods (`get()` + `tasksDir` property).

**Primary recommendation:** Wire SubscriptionStore into AofMcpContext, add three handler functions following the exact pattern of existing tools (Zod input/output schemas, `handleAof*` functions, `registerTool` calls), and add idempotent duplicate detection in the subscribe handler.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- `subscribe` param on aof_dispatch accepts a granularity string: `"completion"` or `"all"`
- Omitting `subscribe` = no subscription (opt-in only, fully backward compatible)
- Subscribe is atomic with dispatch -- if subscription creation fails, dispatch also fails
- Response adds `subscriptionId` field alongside existing `taskId` (lightweight, no full subscription object)
- Subscriber is always the dispatching agent (whoever called aof_dispatch)
- Standalone subscribe: `aof_task_subscribe` (matches aof_task_update, aof_task_complete pattern)
- Unsubscribe: `aof_task_unsubscribe`
- aof_task_subscribe response: subscriptionId, taskId, granularity, status ("active"), taskStatus (current task status), createdAt
- aof_task_unsubscribe requires both taskId and subscriptionId, returns subscriptionId and status: "cancelled"
- subscriberId is an explicit param on aof_task_subscribe (required), free-form non-empty string
- For subscribe-at-dispatch: subscriber is inferred as the dispatching agent, no separate param needed
- Idempotent: if identical active subscription exists (same subscriberId + taskId + granularity), return the existing one

### Claude's Discretion
- Error handling patterns (what errors to throw, error messages)
- How to wire SubscriptionStore into AofMcpContext
- Test structure and organization
- Internal implementation of duplicate detection

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SUB-01 | Agent can subscribe to task outcomes at dispatch time via `subscribe` param on `aof_dispatch` | Extend `dispatchInputSchema` with optional `subscribe` field; create subscription atomically after task creation but before return; roll back on failure |
| SUB-02 | Agent can subscribe to an existing task's outcomes via `aof_task_subscribe` tool | New handler `handleAofTaskSubscribe` + tool registration; uses SubscriptionStore.create() with duplicate detection |
| SUB-03 | Agent can cancel a subscription via `aof_task_unsubscribe` tool | New handler `handleAofTaskUnsubscribe` + tool registration; uses SubscriptionStore.cancel() |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | ^3.x | Input/output schema validation for MCP tools | Already used for all tool schemas in src/mcp/tools.ts |
| @modelcontextprotocol/sdk | existing | McpError, ErrorCode for error handling | Already used for all error throwing in tool handlers |
| write-file-atomic | existing | Crash-safe subscription file writes | Already used by SubscriptionStore |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| vitest | ^3.0.0 | Unit tests | Test new tool handlers |

### Alternatives Considered
None -- all libraries are already established in the codebase.

## Architecture Patterns

### Recommended Project Structure
```
src/
  mcp/
    shared.ts           # Add subscriptionStore to AofMcpContext
    tools.ts            # Add 3 handlers + registration; extend dispatch handler
  mcp/__tests__/
    tools.test.ts       # Add tests for new tools
```

### Pattern 1: Tool Handler Pattern (Established)
**What:** Each tool has a Zod input schema, a Zod output schema, an async `handleAof*` handler function, and a `server.registerTool()` call.
**When to use:** Always -- this is the only pattern used for MCP tools.
**Example:**
```typescript
// Input schema
const taskSubscribeInputSchema = z.object({
  taskId: z.string(),
  subscriberId: z.string().min(1),
  granularity: z.enum(["completion", "all"]),
});

// Output schema
const taskSubscribeOutputSchema = z.object({
  subscriptionId: z.string(),
  taskId: z.string(),
  granularity: z.string(),
  status: z.string(),
  taskStatus: z.string(),
  createdAt: z.string(),
});

// Handler
export async function handleAofTaskSubscribe(
  ctx: AofMcpContext,
  input: z.infer<typeof taskSubscribeInputSchema>,
) {
  // 1. Resolve task (validates it exists)
  const task = await resolveTask(ctx.store, input.taskId);
  // 2. Duplicate detection (check existing active subs)
  // 3. Create or return existing subscription
  // 4. Return response with task status snapshot
}

// Registration (inside registerAofTools)
server.registerTool("aof_task_subscribe", {
  description: "Subscribe to task outcome notifications",
  inputSchema: taskSubscribeInputSchema,
}, async (input) => ({
  content: [{ type: "text" as const, text: JSON.stringify(
    await handleAofTaskSubscribe(ctx, input), null, 2
  )}],
}));
```

### Pattern 2: Context Wiring Pattern (Established)
**What:** Add new stores/services to `AofMcpContext` interface, initialize in `createAofMcpContext()`.
**When to use:** When tool handlers need access to a new store.
**Example:**
```typescript
// In shared.ts - extend interface
export interface AofMcpContext {
  // ... existing fields
  subscriptionStore: SubscriptionStore;
}

// In createAofMcpContext() - build the taskDirResolver from the store
const taskDirResolver = async (taskId: string): Promise<string> => {
  const task = await store.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const status = task.frontmatter.status;
  return join(store.tasksDir, status, taskId);
};
const subscriptionStore = new SubscriptionStore(taskDirResolver);
```

### Pattern 3: Dispatch Extension Pattern
**What:** Add optional parameter to `dispatchInputSchema`, handle it after task creation.
**When to use:** For subscribe-at-dispatch (SUB-01).
**Example:**
```typescript
// Extend dispatchInputSchema
const dispatchInputSchema = z.object({
  // ... existing fields
  subscribe: z.enum(["completion", "all"]).optional(),
});

// In handleAofDispatch, after task creation:
let subscriptionId: string | undefined;
if (input.subscribe) {
  const subscriberId = input.actor ?? "mcp";  // dispatching agent
  const sub = await ctx.subscriptionStore.create(
    task.frontmatter.id, subscriberId, input.subscribe
  );
  subscriptionId = sub.id;
}

// Extend return value
return {
  // ... existing fields
  ...(subscriptionId && { subscriptionId }),
};
```

### Pattern 4: Idempotent Subscription Detection
**What:** Before creating, check for existing active subscription with same (subscriberId, taskId, granularity).
**When to use:** Both subscribe-at-dispatch and standalone subscribe.
**Example:**
```typescript
async function findOrCreateSubscription(
  subStore: SubscriptionStore,
  taskId: string,
  subscriberId: string,
  granularity: SubscriptionGranularity,
): Promise<TaskSubscription> {
  const existing = await subStore.list(taskId, { status: "active" });
  const duplicate = existing.find(
    s => s.subscriberId === subscriberId && s.granularity === granularity
  );
  if (duplicate) return duplicate;
  return subStore.create(taskId, subscriberId, granularity);
}
```

### Anti-Patterns to Avoid
- **Modifying SubscriptionStore internals:** The store is complete from Phase 28. All new code should use its public API (create, get, list, cancel).
- **Separate handler file:** All existing tool handlers live in `src/mcp/tools.ts`. Do not create a separate file for subscription tool handlers -- follow the established pattern.
- **Embedding subscriber logic in aof-dispatch.ts:** The low-level dispatch function should not know about subscriptions. Subscribe-at-dispatch belongs in `handleAofDispatch` in tools.ts, which is the MCP-layer handler.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Subscription CRUD | Custom file operations | `SubscriptionStore` (Phase 28) | Already handles atomic writes, schema validation, directory creation |
| Task resolution | Manual file lookup | `resolveTask(ctx.store, taskId)` | Handles prefix matching, throws McpError on not found |
| Error responses | Custom error objects | `throw new McpError(ErrorCode.*, message)` | MCP SDK standard, consistent with all other tools |
| UUID generation | Custom ID logic | `SubscriptionStore.create()` handles it | Uses `crypto.randomUUID()` internally |

**Key insight:** Phase 28 built all the storage infrastructure. Phase 29 is pure wiring -- connecting existing store operations to MCP tool endpoints.

## Common Pitfalls

### Pitfall 1: TaskDirResolver Stale Path After Status Transition
**What goes wrong:** Subscription file is written to the task directory based on current status, but if the task transitions (e.g., ready -> in-progress), the subscription file stays in the old directory.
**Why it happens:** `taskDirResolver` resolves to `tasks/{status}/{taskId}/` which is status-dependent.
**How to avoid:** This is a known characteristic of the filesystem store. The subscription file co-locates with the task's companion directory. When `FilesystemTaskStore.transition()` moves files, it must also move the companion directory. Verify this is the case in Phase 28's implementation. If not, the subscription file could be orphaned.
**Warning signs:** Tests pass when task stays in one status but fail when task transitions between states.

### Pitfall 2: Dispatch Output Schema Mismatch
**What goes wrong:** Adding `subscriptionId` to dispatch return value without updating `dispatchOutputSchema` causes Zod validation errors.
**Why it happens:** The output schema is used for response validation.
**How to avoid:** Add `subscriptionId: z.string().optional()` to `dispatchOutputSchema`.

### Pitfall 3: Actor/SubscriberId Confusion for Subscribe-at-Dispatch
**What goes wrong:** Using an empty or undefined `actor` as the subscriberId.
**Why it happens:** `input.actor` is optional and defaults to "mcp".
**How to avoid:** Use `input.actor ?? "mcp"` consistently. This mirrors how existing tools set createdBy.

### Pitfall 4: Forgetting to Validate Task Exists Before Subscribe
**What goes wrong:** Subscription created for a non-existent task ID.
**Why it happens:** SubscriptionStore.create() creates directories without checking task existence.
**How to avoid:** Always call `resolveTask(ctx.store, input.taskId)` first in the handler. This is the established pattern in all other tool handlers.

## Code Examples

### Unsubscribe Handler
```typescript
const taskUnsubscribeInputSchema = z.object({
  taskId: z.string(),
  subscriptionId: z.string(),
});

const taskUnsubscribeOutputSchema = z.object({
  subscriptionId: z.string(),
  status: z.literal("cancelled"),
});

export async function handleAofTaskUnsubscribe(
  ctx: AofMcpContext,
  input: z.infer<typeof taskUnsubscribeInputSchema>,
) {
  // Verify task exists
  await resolveTask(ctx.store, input.taskId);

  try {
    const cancelled = await ctx.subscriptionStore.cancel(
      input.taskId, input.subscriptionId
    );
    return {
      subscriptionId: cancelled.id,
      status: "cancelled" as const,
    };
  } catch (err) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Subscription not found: ${input.subscriptionId}`,
    );
  }
}
```

### AofMcpContext Extension
```typescript
// In shared.ts
import { SubscriptionStore } from "../store/subscription-store.js";

export interface AofMcpContext {
  dataDir: string;
  vaultRoot: string;
  store: ITaskStore;
  subscriptionStore: SubscriptionStore;  // NEW
  logger: EventLogger;
  executor?: GatewayAdapter;
  orgChartPath: string;
  projectConfig?: ProjectManifest;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No subscription support | SubscriptionStore CRUD (Phase 28) | Phase 28 (just completed) | Storage layer ready, needs MCP wiring |

## Open Questions

1. **Task directory migration on status transition**
   - What we know: `FilesystemTaskStore` moves task files between status directories on `transition()`. Companion directories (inputs/, outputs/, work/) are co-located.
   - What's unclear: Whether `subscriptions.json` in the companion directory is also moved during transitions. If the store moves the entire companion directory, it's fine. If it only moves the `.md` file, subscriptions.json gets orphaned.
   - Recommendation: Verify in implementation. The `taskDir` method and `ensureTaskDirs` suggest companion directories are handled, but test with a transition to confirm. This is a Phase 28 concern but affects Phase 29 correctness.

2. **Subscribe-at-dispatch subscriberId derivation**
   - What we know: CONTEXT.md says "subscriber is inferred as the dispatching agent, no separate param needed". The `actor` field on dispatch serves this purpose.
   - What's unclear: If `actor` is omitted, should subscriberId be "mcp" (the default actor) or should subscribe-at-dispatch require actor to be set?
   - Recommendation: Use `input.actor ?? "mcp"` -- consistent with how `createdBy` is set. An agent that cares about its subscriberId will set `actor`.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^3.0.0 |
| Config file | vitest.config.ts (or inline in package.json) |
| Quick run command | `npx vitest run src/mcp/__tests__/tools.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SUB-01 | subscribe param on aof_dispatch creates subscription atomically | unit | `npx vitest run src/mcp/__tests__/tools.test.ts -t "dispatch.*subscribe"` | Needs new tests |
| SUB-01 | dispatch returns subscriptionId when subscribe is set | unit | `npx vitest run src/mcp/__tests__/tools.test.ts -t "subscriptionId"` | Needs new tests |
| SUB-01 | omitting subscribe has no effect (backward compat) | unit | `npx vitest run src/mcp/__tests__/tools.test.ts -t "dispatch"` | Existing tests cover this |
| SUB-02 | aof_task_subscribe creates subscription and returns response | unit | `npx vitest run src/mcp/__tests__/tools.test.ts -t "aof_task_subscribe"` | Needs new tests |
| SUB-02 | idempotent duplicate returns existing subscription | unit | `npx vitest run src/mcp/__tests__/tools.test.ts -t "idempotent"` | Needs new tests |
| SUB-02 | subscribe to non-existent task throws McpError | unit | `npx vitest run src/mcp/__tests__/tools.test.ts -t "not found"` | Needs new tests |
| SUB-03 | aof_task_unsubscribe cancels and returns confirmation | unit | `npx vitest run src/mcp/__tests__/tools.test.ts -t "aof_task_unsubscribe"` | Needs new tests |
| SUB-03 | unsubscribe non-existent subscription throws McpError | unit | `npx vitest run src/mcp/__tests__/tools.test.ts -t "unsubscribe.*not found"` | Needs new tests |

### Sampling Rate
- **Per task commit:** `npx vitest run src/mcp/__tests__/tools.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before /gsd:verify-work

### Wave 0 Gaps
- [ ] New test cases in `src/mcp/__tests__/tools.test.ts` -- covers SUB-01, SUB-02, SUB-03
- [ ] Test helper: `createAofMcpContext` calls must include SubscriptionStore (update `beforeEach`)

## Sources

### Primary (HIGH confidence)
- Source code review: `src/mcp/tools.ts` -- all existing tool handler patterns, registration, schema definitions
- Source code review: `src/mcp/shared.ts` -- AofMcpContext interface, createAofMcpContext factory
- Source code review: `src/store/subscription-store.ts` -- SubscriptionStore CRUD API
- Source code review: `src/schemas/subscription.ts` -- Zod schemas for subscriptions
- Source code review: `src/mcp/adapter.ts` -- Server wiring and startup
- Source code review: `src/mcp/__tests__/tools.test.ts` -- Existing test patterns
- Source code review: `src/store/task-store.ts` -- taskDir resolution (private method, lines 157-158)

### Secondary (MEDIUM confidence)
- CONTEXT.md decisions -- locked user choices for API design

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries already in use, no new dependencies
- Architecture: HIGH - Exact patterns copied from 10+ existing tool handlers in tools.ts
- Pitfalls: HIGH - Identified from direct code review of integration points

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable internal codebase, no external dependency risk)
