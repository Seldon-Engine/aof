# Phase 07: Projects - Research

**Researched:** 2026-02-26
**Domain:** Multi-project isolation, dispatch filtering, memory pool separation, CLI/tool wiring
**Confidence:** HIGH

## Summary

The AOF codebase already has substantial project infrastructure built across `src/projects/`, `src/schemas/project.ts`, `src/service/aof-service.ts`, and `src/cli/`. Project creation, discovery, manifest parsing, migration, linting, and multi-project polling all exist and are tested. The `TaskContext` interface already carries `projectId`, `projectRoot`, and `taskRelpath` fields, and the task schema already has a `project` field. The `ITaskStore` interface exposes `projectId` and `projectRoot`.

**What's missing** are the specific gaps the requirements call out: (1) ToolContext doesn't yet pass `projectId` through to tool operations so tools can auto-scope, (2) task dispatch doesn't filter agents by the project's `participants` list, (3) memory uses a single global HNSW index + SQLite DB rather than per-project isolated indexes, (4) no `aof project list` or `aof project add-participant` CLI commands exist, (5) no OpenClaw tools for project management operations, and (6) no integration test that exercises the full create-project-dispatch-verify-isolation cycle.

**Primary recommendation:** Layer the six requirements onto the existing infrastructure rather than rebuilding. The architecture is sound -- the gaps are surgical: add participant filtering in `buildDispatchActions()`, add `projectId` to `ToolContext`, create per-project memory DB initialization in `registerMemoryModule()`, add CLI commands + OpenClaw tools, and write an integration test.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Full structure upfront for project scaffold: manifest + empty task directory + memory config + README template
- YAML manifest format (consistent with existing org-chart.yaml pattern)
- Interactive CLI wizard for humans (prompts for name, description, initial participants)
- Must also expose project operations as OpenClaw tools so agents can create/manage projects programmatically through the plugin
- Companion skill (`.agents/skills/projects/SKILL.md` or similar) should provide clear, concise instructions on how agents leverage project tools
- `aof project list` shows ALL projects on the instance -- project isolation applies to tasks and memory, not project awareness
- Participant list lives in the project manifest (project.yaml `participants:` field)
- Agents can be in multiple projects simultaneously
- Unassigned agents have global access -- projects are opt-in isolation, not mandatory
- `aof project add-participant <project> <agent>` CLI command + matching OpenClaw tool for agents
- Tasks without a project ID land in the existing global task store -- backward compatible, any agent can pick them up
- Separate HNSW index per project for memory isolation -- complete storage-level separation, no chance of cross-contamination
- Memory search requires specifying a project context -- agents must choose which project's memory to query
- ToolContext auto-populates `projectId` from the task being executed -- tools scope operations automatically without agents needing to pass it explicitly
- The interactive wizard should follow the same pattern as the installer wizard from Phase 6
- Agent tools for project management must go through the OpenClaw plugin interface -- same mechanism existing AOF tools use
- The companion skill is important: agents should understand project context without needing human instruction

### Claude's Discretion
- Exact manifest fields beyond name, description, participants
- Directory structure naming conventions
- Integration test design and assertion patterns
- How existing project code in the codebase maps to these decisions
- Memory index file naming/location per project

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PROJ-01 | ToolContext includes `projectId` field, tools scope operations to active project | `ToolContext` in `src/tools/aof-tools.ts` currently has `store` and `logger` but no `projectId`. `TaskContext` in `src/dispatch/executor.ts` already has `projectId`. The `assign-executor.ts` already sets `context.projectId = store.projectId` when building TaskContext. Need to propagate this into ToolContext used by tool execute() handlers in `src/openclaw/adapter.ts`. |
| PROJ-02 | Task dispatch passes project ID to task store, tasks land in correct project directory | Already partially working: `AOFService.initializeProjects()` creates per-project `FilesystemTaskStore` instances keyed by project ID. Tasks created through those stores land in `Projects/<id>/tasks/`. The gap is that tools registered in `adapter.ts` use a single global `store` rather than resolving the correct project store. Need project-scoped store resolution in tool execute handlers. |
| PROJ-03 | Dispatcher filters eligible agents by project participants list | `buildDispatchActions()` in `src/dispatch/task-dispatcher.ts` currently assigns tasks based on `routing.agent/team/role` without checking the project manifest's `participants` array. The `ProjectManifest` schema already has `participants: z.array(z.string())`. Need to load the manifest for the task's project and check if the target agent is in the participants list (or if participants is empty, treat as unrestricted). |
| PROJ-04 | Memory search respects project pool isolation (no cross-project results) | Currently `registerMemoryModule()` in `src/memory/index.ts` creates a single `memory.db` + single HNSW index in `dataDir`. Per-project isolation requires either: (a) separate SQLite DB + HNSW index per project, or (b) a `project_id` column in the chunks table with query-time filtering. The CONTEXT.md decision is "Separate HNSW index per project" -- so option (a), creating `Projects/<id>/memory/memory.db` and `memory-hnsw.dat` per project. |
| PROJ-05 | `aof project create --template` scaffolds project directory with manifest, task dirs, and memory config | `createProject()` in `src/projects/create.ts` already scaffolds directories and writes `project.yaml`. Gaps: (a) no `--template` flag, (b) no interactive wizard, (c) no README template generation, (d) no memory config file, (e) no `aof project list` command, (f) no `aof project add-participant` command. Need to extend CLI and add OpenClaw tools. |
| PROJ-06 | Integration tests verify end-to-end project routing (create project, create task, dispatch, verify isolation) | `src/service/__tests__/multi-project-polling.test.ts` tests multi-project discovery and dispatch but doesn't verify participant filtering or memory isolation. Need a comprehensive integration test that creates a project with specific participants, creates tasks, dispatches them, and verifies (a) only participant agents receive tasks, (b) memory queries are isolated. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | (existing) | Schema validation for project manifest | Already used for `ProjectManifest` schema |
| yaml | (existing) | Parse/write project.yaml manifests | Already used throughout for YAML config |
| better-sqlite3 | (existing) | Per-project memory database | Already used for global memory DB |
| hnswlib-node | (existing) | Per-project vector index | Already used for global HNSW index |
| sqlite-vec | (existing) | Vector search extension | Already loaded in global memory DB |
| commander | (existing) | CLI command registration | Already used for all CLI commands |
| vitest | 4.0.18 | Test framework | Already standard for all tests |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| write-file-atomic | (existing) | Crash-safe file writes | Task state transitions |
| readline | (node:readline) | Interactive wizard prompts | Project creation wizard |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Separate DB per project | Single DB with project_id column | Single DB is simpler but violates "complete storage-level separation" decision |
| Readline for wizard | inquirer/prompts | External dep vs. Node built-in; existing wizard uses readline pattern |

## Architecture Patterns

### Existing Project Structure (already in codebase)
```
<vaultRoot>/
  Projects/
    _inbox/           # Default project (auto-created)
      project.yaml    # Manifest
      tasks/          # Task state directories
        backlog/
        ready/
        in-progress/
        done/
        blocked/
        review/
        deadletter/
      artifacts/      # Bronze/Silver/Gold tiers
      state/
      views/
      cold/
    <project-id>/     # User-created project
      project.yaml
      tasks/
      artifacts/
      ...
```

### Per-Project Memory Structure (NEW -- needs implementation)
```
<vaultRoot>/
  Projects/
    <project-id>/
      memory/
        memory.db          # SQLite DB with chunks + vec_chunks tables
        memory-hnsw.dat    # HNSW index file
```

### Pattern 1: ToolContext Project Propagation
**What:** Add `projectId` to ToolContext so tools auto-scope operations
**When to use:** Every tool execute() handler that accesses the task store
**Example:**
```typescript
// Source: src/tools/aof-tools.ts (CURRENT)
export interface ToolContext {
  store: ITaskStore;
  logger: EventLogger;
}

// PROPOSED: projectId flows from TaskContext into ToolContext
export interface ToolContext {
  store: ITaskStore;
  logger: EventLogger;
  projectId?: string;  // Auto-populated from active task
}
```

The key integration point is in `src/openclaw/adapter.ts` where tools are registered. Currently all tools use a single `store` instance. For multi-project support, the tool execute handler needs to resolve the correct project store:

```typescript
// In adapter.ts tool registration
execute: async (_id: string, params: Record<string, unknown>) => {
  // Resolve the correct project store based on actor's active task
  const projectStore = resolveProjectStore(params, projectStores, defaultStore);
  const result = await aofDispatch({ store: projectStore, logger }, params as any);
  return wrapResult(result);
},
```

### Pattern 2: Participant Filtering in Dispatch
**What:** Check project manifest participants before assigning tasks
**When to use:** In `buildDispatchActions()` before creating assign actions
**Example:**
```typescript
// In src/dispatch/task-dispatcher.ts, before creating assign action:
const projectId = task.frontmatter.project;
if (projectId) {
  const manifest = await loadProjectManifest(store, projectId);
  if (manifest?.participants && manifest.participants.length > 0) {
    if (!manifest.participants.includes(targetAgent)) {
      actions.push({
        type: "alert",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: `Agent ${targetAgent} is not a participant in project ${projectId}`,
      });
      continue;
    }
  }
}
```

### Pattern 3: Per-Project Memory Initialization
**What:** Create separate SQLite DB + HNSW index per project
**When to use:** During `registerMemoryModule()` or on project creation
**Example:**
```typescript
// Per-project memory DB initialization
function initProjectMemory(projectRoot: string, dimensions: number) {
  const memoryDir = join(projectRoot, "memory");
  mkdirSync(memoryDir, { recursive: true });

  const dbPath = join(memoryDir, "memory.db");
  const hnswPath = join(memoryDir, "memory-hnsw.dat");

  const db = initMemoryDb(dbPath, dimensions);
  const hnsw = new HnswIndex(dimensions);

  // Load or rebuild HNSW (same pattern as global memory init)
  if (existsSync(hnswPath)) {
    try { hnsw.load(hnswPath); } catch { rebuildHnswFromDb(db, hnsw); }
  } else {
    rebuildHnswFromDb(db, hnsw);
  }

  return { db, hnsw, vectorStore: new VectorStore(db, hnsw, hnswPath) };
}
```

### Pattern 4: OpenClaw Tool Registration for Project Management
**What:** Register project CRUD tools through the plugin interface
**When to use:** In `registerAofPlugin()` alongside existing task tools
**Example:**
```typescript
api.registerTool({
  name: "aof_project_create",
  description: "Create a new project with standard directory structure and manifest.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Project ID (lowercase, hyphens, underscores)" },
      title: { type: "string", description: "Human-readable project title" },
      type: { type: "string", enum: ["swe", "ops", "research", "admin", "personal", "other"] },
      participants: { type: "array", items: { type: "string" }, description: "Initial participant agent IDs" },
    },
    required: ["id"],
  },
  execute: async (_id: string, params: Record<string, unknown>) => {
    const result = await createProject(params.id as string, {
      vaultRoot,
      title: params.title as string,
      type: params.type as any,
      participants: params.participants as string[],
    });
    return wrapResult(result);
  },
});
```

### Anti-Patterns to Avoid
- **Global store for project-scoped operations:** Never use the default `store` variable in tool handlers when the task belongs to a specific project. Always resolve the project-specific store.
- **Filtering memory at query time when separate DBs are expected:** The decision is separate HNSW indices, not a shared index with project column. Do not add a `project_id` column to the global DB.
- **Checking participants against team names:** The `participants` array contains agent IDs, not team names. The `owner.team` field is separate and used for memory enrollment (existing behavior in `generator.ts`).
- **Breaking backward compatibility:** Tasks without a `project` field must continue to work in the global task store. Project isolation is opt-in.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| YAML manifest I/O | Custom parser/serializer | Existing `yaml` package + `buildProjectManifest()` | Already handles all manifest fields with sensible defaults |
| Project directory scaffolding | Custom mkdir chains | Existing `bootstrapProject()` + `createProject()` | Already creates all required dirs and writes manifest |
| Project discovery | Custom filesystem scanner | Existing `discoverProjects()` | Handles hierarchy, validation, archived filtering |
| Task store per project | Custom store factory | Existing `FilesystemTaskStore` with `projectId` option | Already supports project-scoped stores |
| Interactive prompts | Complex readline wrapper | Node's `readline/promises` (same as installer wizard) | Matches Phase 6 wizard pattern |
| Memory DB initialization | Custom SQLite setup | Existing `initMemoryDb()` + `HnswIndex` + `VectorStore` | Phase 4 hardened these with auto-resize, parity checks |

**Key insight:** 80% of the project infrastructure already exists. The implementation is about wiring existing pieces together and filling specific gaps, not building from scratch.

## Common Pitfalls

### Pitfall 1: Race condition on project store resolution
**What goes wrong:** Tool execute handlers resolve project stores concurrently; if AOFService hasn't finished `initializeProjects()`, stores may not be in the map yet.
**Why it happens:** Service startup is async; tools could be called before initialization completes.
**How to avoid:** Gate tool execution on service startup completion. The existing `AOFService.start()` already calls `initializeProjects()` before the first poll. Ensure project store map is populated before tool registration resolves stores from it.
**Warning signs:** "Project store not found" errors on first tool call after gateway restart.

### Pitfall 2: Empty participants list means unrestricted access
**What goes wrong:** If `participants: []` in a project manifest, filtering would block ALL agents.
**Why it happens:** Treating empty array as "no one is allowed" instead of "everyone is allowed."
**How to avoid:** Explicitly check `participants.length > 0` before filtering. Empty participants = global access (matches the decision: "Unassigned agents have global access -- projects are opt-in isolation").
**Warning signs:** Tasks stuck in ready state with "agent not a participant" alerts when no participants configured.

### Pitfall 3: Memory DB file locking across concurrent polls
**What goes wrong:** Multiple poll cycles try to write to the same project's memory DB simultaneously.
**Why it happens:** SQLite has single-writer locking; concurrent writes from different poll handlers will throw SQLITE_BUSY.
**How to avoid:** Use the existing VectorStore mutex pattern (already implemented in `src/memory/store/vector-store.ts`). One VectorStore instance per project DB, reused across polls.
**Warning signs:** SQLITE_BUSY errors in logs during memory store operations.

### Pitfall 4: Manifest not reloaded after participant changes
**What goes wrong:** Agent added via `aof project add-participant` but dispatch still uses cached manifest.
**Why it happens:** `loadProjectManifest()` in `assign-executor.ts` reads from disk each time, but if results are cached in the scheduler cycle, stale data persists until next poll.
**How to avoid:** Always read manifest fresh from disk in the dispatch path (current pattern already does this -- `loadProjectManifest()` reads file each call). Don't add caching.
**Warning signs:** Participant changes not taking effect until service restart.

### Pitfall 5: Breaking the global task store backward compatibility
**What goes wrong:** Tasks created before project migration stop being discovered.
**Why it happens:** Changing the default task store path from `~/.openclaw/aof/tasks/` to `Projects/_inbox/tasks/`.
**How to avoid:** The migration system (`src/projects/migration.ts`) already handles this. Legacy tasks at `~/.openclaw/aof/tasks/` should continue to work when `vaultRoot` is not set (single-store fallback mode).
**Warning signs:** Tasks disappear after upgrade; `aof task list` shows zero tasks.

## Code Examples

### Creating a project-scoped task store
```typescript
// Source: src/cli/project-utils.ts (existing pattern)
import { FilesystemTaskStore } from "../store/task-store.js";
import { resolveProject } from "../projects/resolver.js";

const resolution = await resolveProject("my-project", vaultRoot);
const store = new FilesystemTaskStore(resolution.projectRoot, {
  projectId: resolution.projectId,
  logger: eventLogger,
});
await store.init();
```

### Registering a project management CLI command
```typescript
// Source: src/cli/commands/project.ts (existing pattern)
program
  .command("create-project <id>")
  .description("Create a new project with standard directory structure")
  .option("--title <title>", "Project title (defaults to ID)")
  .action(async (id: string, opts: { title?: string }) => {
    const { createProject } = await import("../../projects/create.js");
    const root = program.opts()["root"] as string;
    const result = await createProject(id, { vaultRoot: root, title: opts.title });
    console.log(`Project created: ${id}`);
  });
```

### Multi-project polling (existing pattern)
```typescript
// Source: src/service/aof-service.ts (existing)
private async initializeProjects(): Promise<void> {
  this.projects = await discoverProjects(this.vaultRoot!);
  for (const project of this.projects) {
    if (project.error) continue;
    const store = new FilesystemTaskStore(project.path, {
      projectId: project.id,
      hooks: this.createStoreHooks(project.path),
      logger: this.logger,
    });
    await store.init();
    this.projectStores.set(project.id, store);
  }
}
```

### Project manifest schema (existing)
```typescript
// Source: src/schemas/project.ts (existing)
export const ProjectManifest = z.object({
  id: z.string().regex(PROJECT_ID_REGEX),
  title: z.string(),
  status: ProjectStatus.default("active"),
  type: ProjectType,
  owner: ProjectOwner,
  participants: z.array(z.string()).default([]),
  parentId: z.string().optional(),
  routing: ProjectRouting.default({}),
  memory: ProjectMemory.default({}),
  links: ProjectLinks.default({}),
  sla: ProjectSLA.optional(),
  workflow: WorkflowConfig.optional(),
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single `~/.openclaw/aof/tasks/` directory | Per-project `Projects/<id>/tasks/` directories | v1.0 migration system | Tasks isolated by project, backward compat via `_inbox` |
| Single global task store in `registerAofPlugin()` | Multi-project store map in `AOFService` | TASK-069 | Scheduler polls all projects, aggregates stats |
| No project field in task frontmatter | `project: z.string()` in task schema | Pre-v1.1 | Tasks carry their project ID |
| No participant concept | `participants: z.array(z.string())` in manifest | Pre-v1.1 | Schema supports it, dispatch doesn't filter yet |

**Not yet implemented (gaps this phase closes):**
- Per-project memory DB + HNSW index (currently single global)
- Dispatch participant filtering (schema exists, logic doesn't)
- ToolContext project propagation (TaskContext has it, ToolContext doesn't)
- CLI commands: `aof project list`, `aof project add-participant`
- OpenClaw tools for project CRUD
- Companion skill documentation

## Open Questions

1. **Memory initialization timing**
   - What we know: Global memory is initialized once in `registerMemoryModule()` during plugin registration. Per-project memory would need initialization for each discovered project.
   - What's unclear: Should per-project memory be initialized eagerly (at startup) or lazily (on first access)? Eager is simpler but adds startup cost for projects that may not use memory.
   - Recommendation: Lazy initialization on first memory operation, with a project memory store cache. This avoids startup overhead for projects that don't actively use memory.

2. **Wizard interactive mode detection**
   - What we know: The installer wizard uses `interactive` boolean flag. TTY detection before progress bars is already a pattern (Phase 4 decision).
   - What's unclear: How to detect when `aof project create` is called from a tool execute handler (non-interactive) vs. CLI (potentially interactive).
   - Recommendation: The wizard function should accept an explicit `interactive` flag. CLI defaults to `process.stdout.isTTY`, tool handlers always pass `false`.

3. **Companion skill location**
   - What we know: Skills live at `~/.openclaw/skills/` (runtime, not source). The CONTEXT.md mentions `.agents/skills/projects/SKILL.md`.
   - What's unclear: Whether this should be an AOF source-bundled skill or a runtime-generated skill.
   - Recommendation: Create the skill as a source file at `src/skills/projects/SKILL.md` and include it in the build output. The installer can copy it to `~/.openclaw/skills/aof/projects/` during setup.

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of `~/Projects/AOF/src/` (all source files read directly)
- `src/projects/` module: registry.ts, create.ts, manifest.ts, bootstrap.ts, resolver.ts, migration.ts, lint.ts
- `src/schemas/project.ts`: Full ProjectManifest Zod schema
- `src/dispatch/task-dispatcher.ts`, `assign-executor.ts`: Dispatch and assignment logic
- `src/service/aof-service.ts`: Multi-project service layer
- `src/memory/index.ts`, `src/memory/store/`: Memory DB initialization and vector store
- `src/openclaw/adapter.ts`: Plugin registration and tool wiring
- `src/tools/aof-tools.ts`: ToolContext interface
- `src/dispatch/executor.ts`: TaskContext interface (with projectId)
- `src/cli/commands/project.ts`: Existing CLI commands
- Existing tests: `src/projects/__tests__/`, `src/service/__tests__/multi-project-polling.test.ts`, `src/cli/__tests__/project-cli.test.ts`

### Secondary (MEDIUM confidence)
- `.planning/codebase/ARCHITECTURE.md`, `CONVENTIONS.md`, `TESTING.md`, `STRUCTURE.md` -- codebase analysis docs

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries are already in the project, no new dependencies needed
- Architecture: HIGH -- patterns are extensions of existing infrastructure, all verified via source reading
- Pitfalls: HIGH -- identified from actual codebase patterns and existing test edge cases
- Requirements mapping: HIGH -- every requirement traced to specific source files and gap analysis

**Research date:** 2026-02-26
**Valid until:** 2026-03-26 (stable codebase, no external dependency changes expected)
