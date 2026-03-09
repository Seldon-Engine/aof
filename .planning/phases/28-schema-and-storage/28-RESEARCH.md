# Phase 28: Schema and Storage - Research

**Researched:** 2026-03-09
**Domain:** Zod schema definition + crash-safe filesystem persistence (TypeScript/Node.js)
**Confidence:** HIGH

## Summary

This phase creates the data model and persistence layer for task subscriptions. The codebase already has well-established patterns for every aspect of this work: Zod schemas with `z.infer<>` type derivation (see `src/schemas/task.ts`, `src/schemas/trace.ts`), atomic file writes via `write-file-atomic` (used in 36+ source files), co-located JSON files in task directories (trace-writer pattern), and functional-style file operations with injected dependencies (task-file-ops pattern).

The implementation is straightforward because it follows existing conventions exactly. The subscription schema is a new Zod schema in `src/schemas/`. The SubscriptionStore is a new module in `src/store/` following the `task-file-ops.ts` pattern of standalone functions that accept store method references. Persistence uses `subscriptions.json` in the task directory (`tasks/<status>/<task-id>/subscriptions.json`), written atomically with `write-file-atomic`.

**Primary recommendation:** Follow existing codebase patterns exactly -- new Zod schema file, standalone functional store module, `write-file-atomic` for persistence. No new dependencies needed.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Storage location: Co-located `subscriptions.json` file alongside the task `.md` file in the task directory
- NOT in task frontmatter -- keeps subscription state separate from task metadata
- Uses `write-file-atomic` for crash-safe writes (same as all other AOF file operations)
- Tasks with subscriptions use the directory model: `tasks/<status>/<id>/subscriptions.json`
- Always create the task directory when a subscription is added (promote bare .md to directory)
- subscriptions.json moves with the task directory during status transitions (rename() handles it)
- Follows existing pattern: task directories already hold inputs/, outputs/, work/ subdirs
- subscriptions.json travels with the task -- archive/delete removes subscriptions too
- Delivered/failed subscriptions stay in the file as audit trail
- No separate cleanup needed -- task lifecycle governs subscription lifecycle

### Claude's Discretion
- Subscription identity scheme (UUID, agent+task combo, or other)
- SubscriptionStore API shape (standalone class vs functions like task-file-ops.ts)
- Zod schema field details beyond what research specified (subscriberId, granularity, status, timestamps)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SUB-04 | Subscription data persists in task frontmatter with Zod schema validation | Schema pattern from `src/schemas/task.ts` and `src/schemas/trace.ts`; persistence pattern from `trace-writer.ts` and `task-file-ops.ts`; atomic writes via `write-file-atomic`. Note: CONTEXT.md overrides "frontmatter" -- storage is in co-located `subscriptions.json`, not frontmatter. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | ^3.24.0 | Schema validation and TypeScript type derivation | Already used across all AOF schemas; `z.infer<>` pattern is canonical |
| write-file-atomic | ^7.0.0 | Crash-safe file writes | Already used in 36+ source files; project standard for all file persistence |
| node:crypto | built-in | UUID generation via `crypto.randomUUID()` | Node 22+ (project minimum); no external dependency needed |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:fs/promises | built-in | readFile, mkdir, readdir | Reading subscriptions.json, creating task directories |
| node:path | built-in | join, resolve | Path construction for task directories |
| vitest | ^3.0.0 | Testing | All tests use vitest with describe/it/expect pattern |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| crypto.randomUUID() | nanoid | Adds dependency; crypto.randomUUID() is built-in on Node 22+ |
| Standalone functions | Class-based store | Codebase uses both patterns; class recommended here for encapsulation of subscription file path logic |
| Separate subscriptions.json | Task frontmatter field | User explicitly decided against frontmatter -- separate file keeps concerns clean |

**Installation:**
```bash
# No new dependencies needed -- all libraries already in package.json
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── schemas/
│   └── subscription.ts       # TaskSubscription Zod schema + types
├── store/
│   └── subscription-store.ts # SubscriptionStore CRUD operations
└── store/__tests__/
    └── subscription-store.test.ts # Unit tests
```

### File Layout on Disk (Runtime)
```
tasks/<status>/<task-id>/
├── <task-id>.md              # Task file (existing)
├── inputs/                   # Existing
├── outputs/                  # Existing
├── work/                     # Existing
├── subtasks/                 # Existing
└── subscriptions.json        # NEW: subscription data
```

### Pattern 1: Zod Schema with Type Derivation
**What:** Define schema as Zod object, derive TypeScript type with `z.infer<>`
**When to use:** All data models in AOF
**Example:**
```typescript
// Source: Established pattern in src/schemas/task.ts, src/schemas/trace.ts
import { z } from "zod";

export const SubscriptionGranularity = z.enum(["completion", "all"]);
export type SubscriptionGranularity = z.infer<typeof SubscriptionGranularity>;

export const SubscriptionStatus = z.enum(["active", "delivered", "failed", "cancelled"]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

export const TaskSubscription = z.object({
  id: z.string().uuid().describe("Unique subscription identifier"),
  subscriberId: z.string().min(1).describe("Agent ID of the subscriber"),
  granularity: SubscriptionGranularity.describe("When to fire callbacks"),
  status: SubscriptionStatus.default("active"),
  createdAt: z.string().datetime().describe("ISO-8601 creation timestamp"),
  updatedAt: z.string().datetime().describe("ISO-8601 last update timestamp"),
  deliveredAt: z.string().datetime().optional().describe("When callback was delivered"),
  failureReason: z.string().optional().describe("Why delivery failed"),
});
export type TaskSubscription = z.infer<typeof TaskSubscription>;

export const SubscriptionsFile = z.object({
  version: z.literal(1).describe("Schema version for future migration"),
  subscriptions: z.array(TaskSubscription).default([]),
});
export type SubscriptionsFile = z.infer<typeof SubscriptionsFile>;
```

### Pattern 2: Functional Store with Injected Dependencies
**What:** Standalone functions or class that accepts store methods as parameters
**When to use:** File operations that need task store context
**Example:**
```typescript
// Source: Pattern from src/store/task-file-ops.ts and src/store/task-lifecycle.ts
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import writeFileAtomic from "write-file-atomic";
import { SubscriptionsFile, TaskSubscription, SubscriptionGranularity } from "../schemas/subscription.js";

export class SubscriptionStore {
  constructor(
    private readonly taskDirResolver: (taskId: string) => Promise<string>,
  ) {}

  async create(taskId: string, subscriberId: string, granularity: SubscriptionGranularity): Promise<TaskSubscription> {
    const dir = await this.taskDirResolver(taskId);
    const filePath = join(dir, "subscriptions.json");
    const file = await this.readFile(filePath);
    const now = new Date().toISOString();
    const sub: TaskSubscription = {
      id: randomUUID(),
      subscriberId,
      granularity,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    file.subscriptions.push(sub);
    await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
    return sub;
  }
  // ... read, list, delete methods follow same pattern
}
```

### Pattern 3: Atomic Read-Modify-Write
**What:** Read JSON file, modify in memory, write atomically
**When to use:** All subscription mutations
**Example:**
```typescript
// Source: Pattern from src/trace/trace-writer.ts (lines 149-152)
// and src/store/task-mutations.ts (line 97)
const data = await this.readFile(filePath);
// ... modify data ...
await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
```

### Anti-Patterns to Avoid
- **Writing subscriptions to task frontmatter:** User explicitly decided against this. Subscriptions are separate from task metadata.
- **Using fs.writeFile instead of write-file-atomic:** Never use bare writeFile for data that must survive crashes. Every write in AOF uses write-file-atomic.
- **Creating a new npm dependency for UUIDs:** `crypto.randomUUID()` is built into Node 22+, which is the project minimum.
- **Deeply coupling SubscriptionStore to FilesystemTaskStore:** Use dependency injection (taskDirResolver) to keep modules loosely coupled, following task-file-ops.ts pattern.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Crash-safe file writes | Custom temp-file-then-rename logic | `write-file-atomic` | Already handles edge cases (permissions, symlinks, cleanup); project standard |
| Schema validation | Manual type guards or if-chains | Zod schemas with `.parse()` / `.safeParse()` | Project standard; generates TypeScript types; descriptive error messages |
| UUID generation | Custom ID generators | `crypto.randomUUID()` | Built into Node 22+; RFC 4122 compliant; zero dependencies |
| Task directory resolution | Hardcoded path construction | TaskStore's `taskDir()` method via injection | Encapsulates `tasks/<status>/<id>/` logic; already handles all edge cases |

**Key insight:** Every building block for this phase already exists in the codebase. The only new code is the subscription-specific schema and the thin CRUD layer.

## Common Pitfalls

### Pitfall 1: Forgetting to Create Task Directory
**What goes wrong:** Writing subscriptions.json fails because the task directory does not exist (task is a bare `.md` file, not yet promoted to directory model).
**Why it happens:** Tasks start as flat files (`tasks/backlog/TASK-ID.md`). The directory (`tasks/backlog/TASK-ID/`) is only created when needed (e.g., when inputs/outputs are added).
**How to avoid:** Always call `mkdir(taskDir, { recursive: true })` before writing `subscriptions.json`. The `recursive: true` flag is idempotent -- safe if directory already exists.
**Warning signs:** ENOENT errors when writing subscriptions.json.

### Pitfall 2: Race Conditions on Concurrent Writes
**What goes wrong:** Two concurrent subscription creates could read the same file, each add a subscription, and one write overwrites the other.
**Why it happens:** Read-modify-write is not atomic across operations.
**How to avoid:** For Phase 28 (single-process daemon), this is acceptable. The scheduler is single-threaded event loop. Document the limitation. If needed later, use a file lock or serialization queue.
**Warning signs:** Missing subscriptions after concurrent dispatches.

### Pitfall 3: Schema Version Without Migration Path
**What goes wrong:** Adding a `version` field to subscriptions.json but never checking or migrating it.
**Why it happens:** Version field is forward-thinking but useless without migration code.
**How to avoid:** Include `version: 1` in the schema. On read, validate with Zod `safeParse`. For now, reject unknown versions with a clear error. Migration logic can be added in a future phase if the schema evolves.
**Warning signs:** Silent data corruption when schema changes.

### Pitfall 4: subscriptions.json with Empty Array vs Missing File
**What goes wrong:** Code treats missing file and empty subscriptions array differently, leading to inconsistent behavior.
**Why it happens:** Not handling the "file doesn't exist yet" case uniformly.
**How to avoid:** On read, catch ENOENT and return `{ version: 1, subscriptions: [] }` as default. Never distinguish between "no file" and "empty subscriptions" at the API level.
**Warning signs:** Errors when querying subscriptions for tasks that never had any.

## Code Examples

### Reading subscriptions.json with Fallback
```typescript
// Source: Pattern derived from trace-writer.ts readdir() fallback (lines 96-104)
private async readFile(filePath: string): Promise<SubscriptionsFile> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = SubscriptionsFile.parse(JSON.parse(raw));
    return parsed;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return { version: 1, subscriptions: [] };
    }
    throw err;
  }
}
```

### Task Directory Resolution via Store
```typescript
// Source: task-store.ts lines 157-159
// The SubscriptionStore needs to resolve: tasks/<status>/<task-id>/
// Two options for the taskDirResolver:

// Option A: Wrap store methods (recommended)
const store = new SubscriptionStore(async (taskId: string) => {
  const task = await taskStore.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  // taskDir is private, but we can reconstruct: join(tasksDir, status, taskId)
  return join(taskStore.tasksDir, task.frontmatter.status, taskId);
});

// Option B: Add a public taskDir() method to ITaskStore interface
```

### Deleting a Subscription (Soft Delete via Status)
```typescript
// Source: Following audit trail decision from CONTEXT.md
async cancel(taskId: string, subscriptionId: string): Promise<TaskSubscription> {
  const dir = await this.taskDirResolver(taskId);
  const filePath = join(dir, "subscriptions.json");
  const file = await this.readFile(filePath);
  const sub = file.subscriptions.find(s => s.id === subscriptionId);
  if (!sub) throw new Error(`Subscription not found: ${subscriptionId}`);
  sub.status = "cancelled";
  sub.updatedAt = new Date().toISOString();
  await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
  return sub;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Store subscriptions in frontmatter | Store in co-located JSON file | Phase 28 design decision | Cleaner separation of concerns; subscriptions travel with task directory |
| Custom ID generation | `crypto.randomUUID()` | Node 19+ (stable), project requires Node 22+ | No dependency needed |
| Manual type definitions | Zod `z.infer<>` | Established project pattern since v1.0 | Single source of truth for schema + types |

**Deprecated/outdated:**
- SUB-04 requirement text says "frontmatter" but CONTEXT.md overrides this to co-located JSON file. The requirement is still fulfilled -- data persists with schema validation -- just not in frontmatter.

## Open Questions

1. **Should SubscriptionStore be a class or standalone functions?**
   - What we know: `task-file-ops.ts` uses standalone functions; `FilesystemTaskStore` is a class. Both patterns exist.
   - What's unclear: Which is better for this case.
   - Recommendation: Use a class. SubscriptionStore has enough internal state (taskDirResolver) and enough methods (create, get, list, delete) that a class provides cleaner encapsulation. The class should accept a taskDirResolver in its constructor.

2. **Should we expose taskDir() publicly on ITaskStore?**
   - What we know: `taskDir()` is currently `private` on FilesystemTaskStore. SubscriptionStore needs to resolve task directories.
   - What's unclear: Whether adding to ITaskStore interface is too invasive for this phase.
   - Recommendation: Reconstruct the path from public properties (`tasksDir` + status + taskId) rather than modifying the interface. Keep the surface area of this phase minimal.

3. **Should "delete" be a hard delete (remove from array) or soft delete (set status to cancelled)?**
   - What we know: CONTEXT.md says "Delivered/failed subscriptions stay in the file as audit trail."
   - Recommendation: The CRUD "delete" operation should set status to "cancelled" (soft delete). The `list` method should accept a filter for active-only vs all.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^3.0.0 |
| Config file | `vitest.config.ts` (exists at project root) |
| Quick run command | `npx vitest run src/store/__tests__/subscription-store.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SUB-04a | TaskSubscription Zod schema validates correct data | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "schema"` | No - Wave 0 |
| SUB-04b | TaskSubscription Zod schema rejects invalid data | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "schema"` | No - Wave 0 |
| SUB-04c | subscriptions.json persisted in task directory | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "persist"` | No - Wave 0 |
| SUB-04d | Writes are atomic (write-file-atomic used) | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "atomic"` | No - Wave 0 |
| SUB-04e | CRUD create works | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "create"` | No - Wave 0 |
| SUB-04f | CRUD read works | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "read"` | No - Wave 0 |
| SUB-04g | CRUD list works | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "list"` | No - Wave 0 |
| SUB-04h | CRUD delete (cancel) works | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "delete"` | No - Wave 0 |
| SUB-04i | Missing file returns empty subscriptions | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "missing"` | No - Wave 0 |
| SUB-04j | Task directory created on first subscription | unit | `npx vitest run src/store/__tests__/subscription-store.test.ts -t "directory"` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/store/__tests__/subscription-store.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/store/__tests__/subscription-store.test.ts` -- covers all SUB-04 sub-requirements
- [ ] `src/schemas/subscription.ts` -- schema file (implementation, not test gap, but must exist before tests run)

## Sources

### Primary (HIGH confidence)
- `src/schemas/task.ts` -- Zod schema pattern with preprocess, superRefine, describe, z.infer
- `src/schemas/trace.ts` -- Simpler Zod schema pattern for JSON file storage
- `src/store/task-file-ops.ts` -- Functional store pattern with injected dependencies
- `src/store/task-mutations.ts` -- Transition logic showing how task directories move via rename()
- `src/store/task-store.ts` -- taskDir(), ensureTaskDirs(), statusDir() implementations
- `src/trace/trace-writer.ts` -- Co-located JSON file write pattern with write-file-atomic
- `vitest.config.ts` -- Test configuration and patterns
- `src/store/__tests__/task-store-directory.test.ts` -- Test patterns for directory-based operations

### Secondary (MEDIUM confidence)
- Node.js crypto.randomUUID() documentation -- built-in since Node 19, stable in Node 22+

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in use, no new dependencies
- Architecture: HIGH -- follows established codebase patterns exactly
- Pitfalls: HIGH -- derived from direct code analysis of existing patterns

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable domain, established patterns)
